/**
 * Slash command tự định nghĩa — `.astra/commands/*.md` (mốc M6).
 *
 * Khác skill (M8) ở chỗ ai quyết định dùng: command do NGƯỜI DÙNG gõ, skill do
 * MODEL tự nạp. Vì người dùng gõ nên nó là đường thoát khi model không tự nhận
 * ra việc cần làm — và cũng vì thế nó phải tất định, không qua phán đoán nào.
 *
 * Nguồn và mức tin cậy, giống ASTRA.md:
 *   `~/.astra/commands/`  — người dùng viết. Tin cậy.
 *   `<repo>/.astra/commands/` — đến từ repo. KHÔNG tin cậy, và phải có
 *     `allowProjectCommands` (workspace trusted) mới được nạp.
 *
 * Nội dung command trở thành tin nhắn người dùng gửi cho model. Nó KHÔNG nâng
 * quyền: mọi tool nó khiến agent gọi vẫn đi qua PermissionManager như thường.
 */
import type { FileSystem } from '../fs/FileSystem.js';
import { scanForInjection, type InjectionScanResult } from '../security/injectionScan.js';

/** Trần ký tự một command. Dài hơn thế thì nó nên là ASTRA.md hoặc skill. */
export const COMMAND_MAX_CHARS = 8000;

/**
 * Sâu tối đa khi quét thư mục command.
 *
 * Thư mục con thành namespace: `.claude/commands/speckit/plan.md` → `/speckit:plan`.
 * Trần 3 cấp là đủ cho mọi cách tổ chức thật gặp, và giữ cho một cây thư mục
 * sâu bất thường không biến việc mở ô gợi ý thành một lượt duyệt đĩa dài.
 */
export const COMMAND_MAX_DEPTH = 3;

export type CommandSource = 'user' | 'project';

/**
 * Thư mục được quét, theo thứ tự ưu tiên TĂNG dần (nạp sau ghi đè nạp trước).
 *
 * `.claude/commands/` đứng trước để command viết cho Claude Code chạy được
 * không phải sửa gì — cùng lý do và cùng thứ tự với `SKILL_DIRS` (ADR-008).
 * Khi trùng tên thì bản `.astra` thắng: người dùng đã chủ động viết bản riêng
 * cho AstraCode thì họ muốn dùng bản đó.
 */
export const COMMAND_DIRS: { parts: string[]; compat: boolean }[] = [
  { parts: ['.claude', 'commands'], compat: true },
  { parts: ['.astra', 'commands'], compat: false },
];

export interface SlashCommand {
  /** Tên gõ sau dấu `/`, đã chuẩn hoá về chữ thường. Có thể chứa `:` (namespace). */
  name: string;
  description: string;
  /** Gợi ý đối số hiện mờ bên cạnh tên trong ô gợi ý. Rỗng nếu không khai. */
  argumentHint: string;
  /** Thân prompt, chưa thay đối số. */
  body: string;
  source: CommandSource;
  /** Đến từ `.claude/commands/` thay vì `.astra/commands/`. */
  compat: boolean;
  path: string;
  scan: InjectionScanResult;
}

export interface LoadCommandsOptions {
  fs: FileSystem;
  workspaceRoot?: string;
  homeDir?: string;
  /**
   * Cho phép nạp command từ repo. Mặc định FALSE — repo lạ không được cấp một
   * đường chạy prompt tuỳ ý chỉ vì người dùng mở nó lên.
   */
  allowProjectCommands?: boolean;
  maxChars?: number;
}

export async function loadCommands(opts: LoadCommandsOptions): Promise<SlashCommand[]> {
  const maxChars = opts.maxChars ?? COMMAND_MAX_CHARS;
  const found = new Map<string, SlashCommand>();

  // Nạp project TRƯỚC rồi mới tới user: khi trùng tên, bản của người dùng ghi
  // đè bản của repo. Nguồn tin cậy hơn phải thắng.
  if (opts.workspaceRoot && opts.allowProjectCommands) {
    for (const dir of COMMAND_DIRS) {
      for (const c of await readDir(
        opts.fs,
        join(opts.workspaceRoot, ...dir.parts),
        'project',
        dir.compat,
        maxChars,
      )) {
        found.set(c.name, c);
      }
    }
  }
  if (opts.homeDir) {
    for (const dir of COMMAND_DIRS) {
      for (const c of await readDir(
        opts.fs,
        join(opts.homeDir, ...dir.parts),
        'user',
        dir.compat,
        maxChars,
      )) {
        found.set(c.name, c);
      }
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function readDir(
  fs: FileSystem,
  dir: string,
  source: CommandSource,
  compat: boolean,
  maxChars: number,
  prefix: string[] = [],
): Promise<SlashCommand[]> {
  if (prefix.length >= COMMAND_MAX_DEPTH) return [];

  let entries;
  try {
    if (!(await fs.exists(dir))) return [];
    entries = await fs.readDir(dir);
  } catch {
    return [];
  }

  const out: SlashCommand[] = [];
  for (const entry of entries) {
    // Thư mục con thành namespace, giống Claude Code: `speckit/plan.md` được
    // gõ là `/speckit:plan`. Symlink bị bỏ qua — nó là đường ra khỏi thư mục
    // command, và ở đây không có pathGuard nào đứng chặn.
    if (entry.type === 'directory') {
      out.push(
        ...(await readDir(fs, join(dir, entry.name), source, compat, maxChars, [
          ...prefix,
          entry.name,
        ])),
      );
      continue;
    }
    if (entry.type !== 'file' || !entry.name.toLowerCase().endsWith('.md')) continue;

    const path = join(dir, entry.name);
    let raw: string;
    try {
      raw = await fs.readFile(path);
    } catch {
      continue;
    }

    const stem = entry.name.replace(/\.md$/i, '');
    const parsed = parseCommandFile(raw, [...prefix, stem].join(':'));
    if (!parsed) continue;

    out.push({
      ...parsed,
      body: parsed.body.slice(0, maxChars),
      source,
      compat,
      path,
      scan: scanForInjection(raw),
    });
  }
  return out;
}

/**
 * Frontmatter tối giản: `key: value` một cấp, giữa hai dòng `---`.
 *
 * Cố ý không kéo cả một parser YAML vào: đây là ba trường chuỗi, còn YAML đầy
 * đủ mang theo alias, anchor và merge key — những thứ chỉ tạo thêm bề mặt để
 * xử lý sai đối với file đến từ repo lạ.
 */
export function parseCommandFile(
  raw: string,
  fallbackName: string,
): { name: string; description: string; argumentHint: string; body: string } | undefined {
  let name = fallbackName;
  let description = '';
  let argumentHint = '';
  let body = raw;

  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (match) {
    body = raw.slice(match[0].length);
    for (const line of match[1]!.split(/\r?\n/)) {
      const kv = /^([a-zA-Z_-]+)\s*:\s*(.*)$/.exec(line.trim());
      if (!kv) continue;
      const value = kv[2]!.trim().replace(/^["']|["']$/g, '');
      const key = kv[1]!.toLowerCase();
      if (key === 'name' && value) name = value;
      if (key === 'description') description = value;
      if (key === 'argument-hint' || key === 'argument_hint') argumentHint = value;
    }
  }

  const normalized = normalizeName(name);
  if (!normalized || !body.trim()) return undefined;

  return {
    name: normalized,
    description: description || firstLine(body),
    argumentHint,
    body: body.trim(),
  };
}

/**
 * Tên command chỉ nhận `a-z0-9._:-`.
 *
 * Tên đến từ file trong repo. Không lọc thì một command tên `../../x` hay tên
 * chứa ký tự điều khiển sẽ đi thẳng vào danh sách gợi ý của UI.
 *
 * Dấu chấm được giữ vì đó là cách đặt tên có thật ngoài đời: spec-kit đời trước
 * sinh `.claude/commands/speckit.plan.md` và người dùng gõ `/speckit.plan`. Đổi
 * nó thành `-` thì tên hiện trong ô gợi ý khác tên trong tài liệu của chính
 * công cụ đó. Dấu `:` là ngăn cách namespace do thư mục con sinh ra.
 *
 * Chấm ở đầu/cuối bị cắt: tên `..` không mang thông tin gì và chỉ tổ trông như
 * một đường dẫn.
 */
function normalizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
}

function firstLine(body: string): string {
  const line = body.trim().split(/\r?\n/)[0] ?? '';
  return line.replace(/^#+\s*/, '').slice(0, 120);
}

/**
 * Thay đối số vào thân command.
 *
 * `$ARGUMENTS` = toàn bộ phần người dùng gõ sau tên command. `$1`…`$9` = từng
 * từ. Không có placeholder nào thì phần đối số được nối xuống cuối — nếu không,
 * người dùng gõ `/review src/auth.ts` sẽ thấy đường dẫn của mình bị nuốt mất.
 */
export function renderCommand(command: SlashCommand, args: string): string {
  return substituteArgs(command.body, args);
}

/**
 * Thay `$ARGUMENTS` / `$1`…`$9` vào một thân prompt bất kỳ.
 *
 * Tách khỏi `renderCommand` vì skill cần đúng phép thay này: SKILL.md do
 * spec-kit sinh ra có một khối ```text $ARGUMENTS``` và dặn model "MUST consider
 * the user input". Không thay thì model đọc được đúng bảy ký tự `$ARGUMENTS` và
 * phần người dùng gõ biến mất.
 */
export function substituteArgs(body: string, args: string): string {
  const trimmed = args.trim();
  const words = trimmed ? trimmed.split(/\s+/) : [];
  const hasPlaceholder = /\$(ARGUMENTS|[1-9])\b/.test(body);

  let out = body
    .replace(/\$ARGUMENTS\b/g, trimmed)
    .replace(/\$([1-9])\b/g, (_, d: string) => words[Number(d) - 1] ?? '');

  if (!hasPlaceholder && trimmed) out += `\n\n${trimmed}`;
  return out.trim();
}

/**
 * Tách `/tên phần còn lại` từ ô nhập. Không phải command thì trả undefined.
 *
 * Tên nhận cả `.` và `:` — xem `normalizeName`. Regex cũ dừng ở `[a-zA-Z0-9_-]`
 * nên `/speckit.plan` bị đọc thành tên `speckit` với đối số `.plan`: không khớp
 * command nào, mà cũng không báo lỗi đúng chỗ. Im lặng hiểu sai tệ hơn là
 * không hiểu.
 */
export function parseSlashInput(
  input: string,
): { name: string; args: string } | undefined {
  const match = /^\/([a-zA-Z0-9_.:-]+)\s*([\s\S]*)$/.exec(input.trim());
  if (!match) return undefined;
  return { name: match[1]!.toLowerCase().replace(/[-.]+$/, ''), args: match[2] ?? '' };
}

function join(root: string, ...parts: string[]): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  return [base, ...parts].join(sep);
}
