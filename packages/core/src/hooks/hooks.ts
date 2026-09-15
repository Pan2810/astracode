/**
 * Hooks — script ngoài chạy quanh mỗi lời gọi tool (mốc M8).
 *
 * Đây là tính năng NGUY HIỂM NHẤT trong toàn bộ AstraCode, và cần nói thẳng vì
 * sao: một hook là "chạy lệnh tuỳ ý, tự động, không hỏi". Nếu nó đọc được từ
 * repo mà không có rào, thì mở một thư mục lên trong VS Code là đủ để chạy mã
 * của người viết repo đó — đúng nghĩa RCE, không phải rủi ro lý thuyết.
 *
 * Nên có ba rào, và cả ba đều bắt buộc:
 *
 *   1. **Workspace trust.** Repo chưa tin cậy thì `.astra/hooks.json` không
 *      được đọc, chứ không phải đọc rồi lọc.
 *   2. **Người dùng duyệt NỘI DUNG, không phải duyệt tên file.** Duyệt được ghi
 *      theo hash của chính lệnh sẽ chạy. Sửa một ký tự trong lệnh là hash đổi
 *      là phải duyệt lại — nếu không thì "duyệt một lần" biến thành giấy phép
 *      vĩnh viễn cho mọi nội dung sau này.
 *   3. **Chạy qua đúng một cửa spawn** (core/sandbox/process.ts), không kế thừa
 *      env của extension host, có timeout, có trần output.
 *
 * `preToolUse` thoát khác 0 = CHẶN tool. Đó là điểm mạnh thật của hooks: nó cho
 * đội dự án cài luật riêng ("không được sửa file trong infra/") mà không phải
 * sửa AstraCode.
 */
import { z } from 'zod';
import type { FileSystem } from '../fs/FileSystem.js';
import type { Logger } from '../telemetry/logger.js';
import { runToCompletion } from '../sandbox/process.js';
import { compileSafeRegex } from '../security/safeRegex.js';

export type HookEvent = 'preToolUse' | 'postToolUse' | 'stop';

export const HookSchema = z.object({
  /** Regex khớp tên tool. Bỏ trống = mọi tool. Với `stop` thì bỏ qua. */
  match: z.string().default(''),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().max(120_000).default(15_000),
  /** Mô tả cho hộp duyệt — người dùng đọc cái này để quyết định. */
  description: z.string().default(''),
});

export type HookSpec = z.infer<typeof HookSchema>;

export const HooksConfigSchema = z.object({
  preToolUse: z.array(HookSchema).default([]),
  postToolUse: z.array(HookSchema).default([]),
  stop: z.array(HookSchema).default([]),
});

export type HooksConfig = z.infer<typeof HooksConfigSchema>;

export const EMPTY_HOOKS: HooksConfig = HooksConfigSchema.parse({});

export type HookSource = 'user' | 'project';

export interface LoadedHook extends HookSpec {
  event: HookEvent;
  source: HookSource;
  path: string;
  /** Vân tay của chính lệnh sẽ chạy — đơn vị để duyệt. */
  fingerprint: string;
}

export interface LoadHooksOptions {
  fs: FileSystem;
  workspaceRoot?: string;
  homeDir?: string;
  /** Đọc `.astra/hooks.json` của repo. Mặc định FALSE. Xem rào #1 đầu file. */
  allowProjectHooks?: boolean;
}

export interface LoadHooksResult {
  hooks: LoadedHook[];
  /** Lý do một nguồn bị bỏ qua — UI phải nói ra được. */
  rejections: string[];
}

export async function loadHooks(opts: LoadHooksOptions): Promise<LoadHooksResult> {
  const hooks: LoadedHook[] = [];
  const rejections: string[] = [];

  if (opts.homeDir) {
    await readFile(opts.fs, join(opts.homeDir, '.astra', 'hooks.json'), 'user', hooks, rejections);
  }

  if (opts.workspaceRoot) {
    const p = join(opts.workspaceRoot, '.astra', 'hooks.json');
    if (opts.allowProjectHooks) {
      await readFile(opts.fs, p, 'project', hooks, rejections);
    } else if (await exists(opts.fs, p)) {
      rejections.push(
        'Repo có .astra/hooks.json nhưng workspace chưa được tin cậy — không nạp. ' +
          'Hook là lệnh chạy tự động; mở một thư mục lên không được phép là đủ để chạy nó.',
      );
    }
  }

  return { hooks, rejections };
}

async function readFile(
  fs: FileSystem,
  path: string,
  source: HookSource,
  out: LoadedHook[],
  rejections: string[],
): Promise<void> {
  let raw: string;
  try {
    if (!(await fs.exists(path))) return;
    raw = await fs.readFile(path);
  } catch (err) {
    rejections.push(`Không đọc được ${path}: ${messageOf(err)}`);
    return;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    rejections.push(`${path} không phải JSON hợp lệ: ${messageOf(err)}`);
    return;
  }

  const parsed = HooksConfigSchema.safeParse(json);
  if (!parsed.success) {
    rejections.push(
      `${path} sai schema: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
    return;
  }

  for (const event of ['preToolUse', 'postToolUse', 'stop'] as const) {
    for (const spec of parsed.data[event]) {
      // Regex đến từ file: một mẫu thảm hoạ (catastrophic backtracking) làm
      // treo extension host. Kiểm ngay lúc nạp, hỏng thì bỏ hook đó.
      if (spec.match && !isSafeRegex(spec.match)) {
        rejections.push(`${path}: mẫu "match" không dùng được — bỏ hook ${spec.command}`);
        continue;
      }
      out.push({
        ...spec,
        event,
        source,
        path,
        fingerprint: fingerprintOf(event, spec),
      });
    }
  }
}

/**
 * Vân tay của một hook = mọi thứ quyết định nó CHẠY GÌ.
 *
 * Cố ý không băm cả file: thêm một hook mới không nên làm mất hiệu lực duyệt
 * của các hook cũ, nhưng sửa lệnh của một hook thì PHẢI làm mất hiệu lực duyệt
 * của chính nó. Băm theo từng hook cho đúng cả hai vế.
 *
 * Hàm băm là FNV-1a: core không có `node:crypto` (một cửa duy nhất là fs và
 * spawn), và ở đây cần phát hiện THAY ĐỔI chứ không cần chống va chạm có chủ
 * đích — kẻ tấn công sửa được file hooks thì họ đã ở phía trong rào rồi.
 */
export function fingerprintOf(event: HookEvent, spec: HookSpec): string {
  const material = JSON.stringify([event, spec.command, spec.args, spec.match]);
  let h = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a-${h.toString(16).padStart(8, '0')}`;
}

/** Lệnh hiện cho người dùng đọc trong hộp duyệt. */
export function describeHook(hook: LoadedHook): string {
  return [
    `Sự kiện: ${hook.event}`,
    hook.match ? `Áp cho tool khớp: ${hook.match}` : 'Áp cho MỌI tool',
    `Lệnh: ${hook.command} ${hook.args.join(' ')}`,
    `Nguồn: ${hook.source === 'project' ? `repo (${hook.path})` : hook.path}`,
    hook.description ? `Mô tả (do file khai, chưa xác minh): ${hook.description}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Nơi lưu quyết định duyệt. Extension cài bằng globalState. */
export interface HookApprovalStore {
  isApproved(fingerprint: string): boolean;
  approve(fingerprint: string): Promise<void>;
}

/** Store trong bộ nhớ — dùng cho test và cho phiên không có nơi lưu. */
export class MemoryApprovalStore implements HookApprovalStore {
  private readonly approved = new Set<string>();
  constructor(initial: string[] = []) {
    for (const f of initial) this.approved.add(f);
  }
  isApproved(fingerprint: string): boolean {
    return this.approved.has(fingerprint);
  }
  async approve(fingerprint: string): Promise<void> {
    this.approved.add(fingerprint);
  }
}

export interface HookRunnerOptions {
  hooks: LoadedHook[];
  logger: Logger;
  approvals: HookApprovalStore;
  /**
   * Hỏi người dùng duyệt một hook chưa từng duyệt. Không truyền = hook chưa
   * duyệt thì KHÔNG CHẠY. Mặc định an toàn phải là mặc định.
   */
  ask?: (hook: LoadedHook) => Promise<boolean>;
  /** Thư mục chạy hook. Thường là workspace root. */
  cwd?: string;
  /** Trần ký tự output đọc từ hook. */
  maxOutputChars?: number;
}

export interface HookOutcome {
  /** `false` = chặn tool (chỉ có nghĩa với preToolUse). */
  allowed: boolean;
  /** Lý do gửi lại cho model khi bị chặn — lấy từ output của hook. */
  reason?: string;
  /** Hook đã chạy, để log và hiển thị. */
  ran: string[];
}

export class HookRunner {
  constructor(private readonly opts: HookRunnerOptions) {}

  has(event: HookEvent): boolean {
    return this.opts.hooks.some((h) => h.event === event);
  }

  /**
   * Chạy hook của một sự kiện.
   *
   * `preToolUse` thoát khác 0 → chặn, và output của hook trở thành lý do gửi
   * lại cho model. `postToolUse`/`stop` thì mã thoát chỉ được ghi log: chặn sau
   * khi tool đã chạy không hoàn tác được gì, chỉ làm model bối rối.
   */
  async run(input: {
    event: HookEvent;
    toolName?: string;
    args?: unknown;
    signal?: AbortSignal;
  }): Promise<HookOutcome> {
    const matched = this.opts.hooks.filter(
      (h) => h.event === input.event && matches(h, input.toolName),
    );
    if (matched.length === 0) return { allowed: true, ran: [] };

    const ran: string[] = [];

    for (const hook of matched) {
      if (!(await this.approved(hook))) {
        this.opts.logger.warn('bỏ qua hook chưa được duyệt', {
          hook: hook.command,
          event: hook.event,
        });
        continue;
      }

      let out: { stdout: string; stderr: string; exitCode: number };
      try {
        out = await runToCompletion(hook.command, hook.args, {
          ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
          timeoutMs: hook.timeoutMs,
          ...(input.signal ? { signal: input.signal } : {}),
          maxOutputChars: this.opts.maxOutputChars ?? 20_000,
          // Hook nhận ngữ cảnh qua env, KHÔNG qua argv: đối số do model sinh ra
          // mà nối vào dòng lệnh là đường tiêm lệnh kinh điển. env thì không đi
          // qua shell nào — process.ts luôn spawn với shell: false.
          env: {
            ASTRA_HOOK_EVENT: input.event,
            ASTRA_HOOK_TOOL: input.toolName ?? '',
            ASTRA_HOOK_ARGS: safeJson(input.args),
            ...(this.opts.cwd ? { ASTRA_HOOK_CWD: this.opts.cwd } : {}),
          },
        });
      } catch (err) {
        // Hook không chạy được (lệnh không tồn tại) KHÔNG chặn tool: một hook
        // hỏng làm agent đứng im hoàn toàn thì người dùng sẽ gỡ hết hooks đi,
        // và lúc đó cơ chế mất tác dụng thật sự.
        this.opts.logger.warn('hook không chạy được', {
          hook: hook.command,
          reason: messageOf(err),
        });
        continue;
      }

      ran.push(`${hook.command} → ${out.exitCode}`);

      if (input.event === 'preToolUse' && out.exitCode !== 0) {
        const reason =
          `${(out.stdout || out.stderr).trim().slice(0, 1000) ||
          `hook "${hook.command}" từ chối thao tác này`}`;
        this.opts.logger.info('hook chặn tool', {
          hook: hook.command,
          tool: input.toolName,
          exitCode: out.exitCode,
        });
        return {
          allowed: false,
          reason:
            `Bị chặn bởi hook của dự án: ${reason}. ` +
            'Đừng thử lại thao tác y hệt — hãy đổi cách làm hoặc hỏi người dùng.',
          ran,
        };
      }

      if (out.exitCode !== 0) {
        this.opts.logger.warn('hook thoát khác 0 (không chặn)', {
          hook: hook.command,
          event: input.event,
          exitCode: out.exitCode,
        });
      }
    }

    return { allowed: true, ran };
  }

  private async approved(hook: LoadedHook): Promise<boolean> {
    if (this.opts.approvals.isApproved(hook.fingerprint)) return true;
    if (!this.opts.ask) return false;

    const ok = await this.opts.ask(hook);
    if (!ok) return false;

    await this.opts.approvals.approve(hook.fingerprint);
    return true;
  }
}

function matches(hook: LoadedHook, toolName: string | undefined): boolean {
  if (hook.event === 'stop') return true;
  if (!hook.match) return true;
  if (!toolName) return false;
  try {
    return new RegExp(hook.match).test(toolName);
  } catch {
    return false;
  }
}

/**
 * Trần độ dài cho `match` của hook. Chặt hơn trần của `grep` (500) vì đây là
 * một mẫu khớp TÊN TOOL — dài nhất cũng chỉ là một danh sách tên nối bằng `|`.
 */
const HOOK_MAX_PATTERN = 200;

/**
 * Chặn regex không dùng được, và chặn cả regex có thể treo extension host.
 *
 * Trước đây hàm này chỉ kiểm độ dài và "có compile được không", trong khi
 * comment ở đầu file lại nói nó chống "mẫu thảm hoạ" — mà `(a+)+$` thì compile
 * được, và `match` được chạy TRƯỚC MỖI lời gọi tool. Phần quyết định nay nằm ở
 * `security/safeRegex.ts`, dùng chung với `tools/grep.ts` để hai bề mặt nhận
 * regex từ ngoài không lệch chuẩn nhau.
 */
function isSafeRegex(pattern: string): boolean {
  return compileSafeRegex(pattern, { maxLength: HOOK_MAX_PATTERN }).ok;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null).slice(0, 8000);
  } catch {
    return 'null';
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function exists(fs: FileSystem, path: string): Promise<boolean> {
  try {
    return await fs.exists(path);
  } catch {
    return false;
  }
}

function join(root: string, ...parts: string[]): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  return [base, ...parts].join(sep);
}
