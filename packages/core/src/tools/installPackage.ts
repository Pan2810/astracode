/**
 * install_package — cài thư viện vào chính project đang mở, không đụng máy
 * người dùng, không cần sudo.
 *
 * Mô hình đảo ngược so với bash: đường bash để agent tự soạn dòng lệnh, và mỗi
 * biến thể (`npm i -g`, `pip install --user`) là một mẫu regex phải đuổi
 * theo — đúng cái bẫy mà `security/workspaceEscape.ts` đã cảnh báo (quét theo
 * hình dạng chuỗi không chặn được người cố tình). Ở đây MODEL CHỈ CUNG CẤP TÊN
 * GÓI; dòng lệnh do chính tool dựng SAU KHI validate. Không có trường nào nhận
 * cờ hay chuỗi lệnh, nên không có chỗ để chèn shell injection.
 *
 * Ba ràng buộc, không cái nào tuỳ chọn:
 *   1. Package manager (node) suy từ lockfile ở gốc workspace — không hỏi model.
 *   2. Python luôn cài vào `.venv` của workspace: không bao giờ pip hệ thống,
 *      không bao giờ `--user`.
 *   3. Chạy qua `ctx.sandbox`, không tự spawn — không có sandbox thì không chạy,
 *      giống hệt bash/python. KHÔNG BAO GIỜ tự động được duyệt (ALWAYS_ASK).
 */
import { z } from 'zod';
import * as nodePath from 'node:path';
import type { Tool, ToolContext, ToolIntent, ToolResult } from './Tool.js';

const schema = z.object({
  ecosystem: z.enum(['node', 'python']).describe('Hệ sinh thái gói: "node" (npm/pnpm/yarn) hoặc "python" (pip)'),
  packages: z
    .array(
      z.object({
        name: z.string().min(1).describe('Tên gói, ví dụ "zod" hoặc "@scope/pkg"'),
        version: z
          .string()
          .optional()
          .describe('Version hoặc range cần cài, ví dụ "1.2.2", "^3.1.0", ">=2". Bỏ trống = mới nhất'),
      }),
    )
    .min(1)
    .max(5)
    .describe('Danh sách gói cần cài, tối đa 5 gói một lần gọi'),
  dev: z
    .boolean()
    .optional()
    .describe('Node: cài vào devDependencies (mặc định true). Không áp dụng cho python.'),
  reason: z.string().min(1).describe('Một câu ngắn: cài gói này để làm gì — hiện trong hộp duyệt quyền'),
});

/**
 * Validate TRƯỚC khi dựng lệnh — token không khớp thì TỪ CHỐI, không escape.
 * Đây là chốt injection thật sự: sau ba regex này, chuỗi ghép vào dòng lệnh
 * không thể chứa ký tự shell nào (`;`, `|`, `&`, backtick, `$`, khoảng trắng...).
 *
 * VERSION không bắt đầu bằng chữ/số như hai regex kia — semver range hợp lệ
 * thường mở đầu bằng `^`, `~`, `>=`: ép ký tự đầu là alnum sẽ từ chối nhầm
 * chính những version hợp lệ nhất (`^3.1.0`, `>=2`). Bộ ký tự cho phép vẫn
 * loại trừ mọi metachar shell — đó mới là ranh giới cần giữ.
 */
const NPM_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const PYPI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERSION = /^[\w.^~*+!<>=-]+$/;

const TIMEOUT_MS = 180_000;
/** Cài đặt hay in nhiều hơn build/test bình thường; trần rộng hơn bash một chút. */
const MAX_OUTPUT = 20_000;

interface ValidPkg {
  name: string;
  version?: string | undefined;
}

function validatePackages(
  ecosystem: 'node' | 'python',
  packages: Array<{ name: string; version?: string | undefined }>,
): { ok: true; packages: ValidPkg[] } | { ok: false; message: string } {
  const nameRe = ecosystem === 'node' ? NPM_NAME : PYPI_NAME;
  for (const p of packages) {
    if (!nameRe.test(p.name)) {
      return {
        ok: false,
        message: `Từ chối: tên gói không hợp lệ "${p.name}". Đây là chốt an toàn, không sửa được bằng cách viết lại tên khác đi kèm ký tự đặc biệt.`,
      };
    }
    if (p.version !== undefined && !VERSION.test(p.version)) {
      return {
        ok: false,
        message: `Từ chối: version không hợp lệ cho ${p.name}: "${p.version}".`,
      };
    }
  }
  return { ok: true, packages };
}

function pkgToken(p: ValidPkg, style: 'npm' | 'pip'): string {
  if (!p.version) return p.name;
  return style === 'pip' ? `${p.name}==${p.version}` : `${p.name}@${p.version}`;
}

// ── Node ────────────────────────────────────────────────────────────────

type NodeManager = 'pnpm' | 'npm' | 'yarn';

const NODE_INSTALL_CMD: Record<NodeManager, (pkgs: string, dev: boolean) => string> = {
  pnpm: (pkgs, dev) => `pnpm add ${dev ? '-D ' : ''}${pkgs}`,
  yarn: (pkgs, dev) => `yarn add ${dev ? '-D ' : ''}${pkgs}`,
  npm: (pkgs, dev) => `npm install ${dev ? '--save-dev' : '--save'} ${pkgs}`,
};

async function detectNodeManager(ctx: ToolContext): Promise<NodeManager | undefined> {
  const root = ctx.workspaceRoot;
  if (await ctx.fs.exists(nodePath.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await ctx.fs.exists(nodePath.join(root, 'package-lock.json'))) return 'npm';
  if (await ctx.fs.exists(nodePath.join(root, 'yarn.lock'))) return 'yarn';
  if (await ctx.fs.exists(nodePath.join(root, 'package.json'))) return 'npm';
  return undefined;
}

// ── Python ──────────────────────────────────────────────────────────────

/** Chạy một lệnh thăm dò ngắn, chỉ cần mã thoát — dùng để dò interpreter. */
async function probeExitCode(ctx: ToolContext, command: string): Promise<number | undefined> {
  if (!ctx.sandbox) return undefined;
  try {
    const proc = ctx.sandbox.exec(command, { cwd: ctx.workspaceRoot, timeoutMs: 10_000 });
    for await (const chunk of proc) void chunk;
    return (await proc.result).exitCode;
  } catch {
    return undefined;
  }
}

/** `python3` trước, rồi `python`, rồi `py` (launcher của Windows). */
async function detectPythonInterpreter(ctx: ToolContext): Promise<string | undefined> {
  for (const candidate of ['python3', 'python', 'py']) {
    if ((await probeExitCode(ctx, `${candidate} --version`)) === 0) return candidate;
  }
  return undefined;
}

function venvPipPath(workspaceRoot: string, shell: 'bash' | 'powershell'): string {
  return shell === 'powershell'
    ? nodePath.join(workspaceRoot, '.venv', 'Scripts', 'pip.exe')
    : nodePath.join(workspaceRoot, '.venv', 'bin', 'pip');
}

// ── Dựng kế hoạch cài đặt — dùng chung cho describe() và execute() ────────

interface InstallPlan {
  /** Một hoặc hai lệnh, chạy TUẦN TỰ theo đúng thứ tự này. */
  commands: string[];
  manager: string;
  target: string;
}

type PlanResult = { ok: true; plan: InstallPlan } | { ok: false; message: string };

async function planInstall(
  args: z.infer<typeof schema>,
  ctx: ToolContext,
): Promise<PlanResult> {
  const validated = validatePackages(args.ecosystem, args.packages);
  if (!validated.ok) return validated;

  if (args.ecosystem === 'node') {
    const manager = await detectNodeManager(ctx);
    if (!manager) {
      return {
        ok: false,
        message:
          'Không tìm thấy package.json ở gốc workspace — đây không phải một project Node. ' +
          'Không tự tạo package.json mới; hỏi người dùng nếu bạn nghĩ project này cần một cái.',
      };
    }
    const dev = args.dev !== false;
    const tokens = validated.packages.map((p) => pkgToken(p, 'npm')).join(' ');
    return {
      ok: true,
      plan: {
        commands: [NODE_INSTALL_CMD[manager](tokens, dev)],
        manager,
        target: dev ? 'devDependencies' : 'dependencies',
      },
    };
  }

  // ── python ──
  const shell = ctx.sandbox?.info().shell ?? 'bash';
  const pip = venvPipPath(ctx.workspaceRoot, shell);
  const commands: string[] = [];

  if (!(await ctx.fs.exists(pip))) {
    const interpreter = await detectPythonInterpreter(ctx);
    if (!interpreter) {
      return {
        ok: false,
        message:
          'Không tìm thấy Python nào trong PATH (đã thử python3, python, py). ' +
          'Môi trường hiện tại thiếu interpreter cần thiết.',
      };
    }
    commands.push(`${interpreter} -m venv .venv`);
  }

  const tokens = validated.packages.map((p) => pkgToken(p, 'pip')).join(' ');
  // Đường dẫn tuyệt đối tới pip trong venv — KHÔNG BAO GIỜ pip hệ thống,
  // KHÔNG BAO GIỜ `--user`.
  commands.push(`${quoteIfNeeded(pip)} install ${tokens}`);

  return { ok: true, plan: { commands, manager: 'pip (.venv)', target: '.venv' } };
}

function quoteIfNeeded(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

// ── Tool ───────────────────────────────────────────────────────────────

export const installPackageTool: Tool<typeof schema> = {
  name: 'install_package',
  description:
    'Cài một hoặc vài thư viện vào chính project đang mở (npm/pnpm/yarn cho Node, ' +
    'pip vào .venv cho Python). Dùng khi code cần một thư viện chưa có — KHÔNG gõ lệnh ' +
    'cài qua bash, và KHÔNG BAO GIỜ đề nghị sudo/apt-get/cài đặt lên máy người dùng. ' +
    'Cài xong vẫn cần người dùng duyệt như bash.',
  schema,
  readOnly: false,

  async describe(args, ctx: ToolContext): Promise<ToolIntent> {
    const result = await planInstall(args, ctx);
    const names = args.packages.map((p) => (p.version ? `${p.name}@${p.version}` : p.name)).join(', ');

    if (!result.ok) {
      return {
        summary: `Install ${names} — will fail: ${result.message}`,
        previewKind: 'text',
      };
    }

    return {
      summary: `Install ${names} into this project (${result.plan.manager}) — ${args.reason}`,
      preview: result.plan.commands.join('\n'),
      // Đúng vì đây là (những) lệnh thực sự sắp chạy, không phải diff.
      previewKind: 'command',
    };
  },

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.sandbox) {
      return {
        content:
          'Chưa có sandbox nào để cài đặt. Người dùng cần bật Docker Desktop, ' +
          'hoặc đổi cài đặt astra.sandbox sang "host" nếu chấp nhận chạy trực tiếp.',
        isError: true,
        untrusted: false,
      };
    }

    // Cài đặt cần mạng. Docker mặc định `network: none` — không kiểm trước thì
    // lệnh treo tới hết giờ 180s mà không ai hiểu vì sao.
    if (ctx.sandbox.info().network === 'none') {
      return {
        content:
          'Sandbox hiện không có mạng (astra.sandbox.network: "none"), nên cài đặt chắc chắn ' +
          'sẽ treo rồi hết giờ. Nhờ người dùng đổi astra.sandbox.network sang "restricted" — ' +
          'AstraCode không tự nâng quyền mạng của sandbox.',
        isError: true,
        untrusted: false,
      };
    }

    const planned = await planInstall(args, ctx);
    if (!planned.ok) {
      return { content: planned.message, isError: true, untrusted: false };
    }

    let combined = '';
    let lastExitCode = 0;
    for (const command of planned.plan.commands) {
      const proc = ctx.sandbox.exec(command, {
        cwd: ctx.workspaceRoot,
        timeoutMs: TIMEOUT_MS,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      let out = '';
      for await (const chunk of proc) {
        ctx.onOutput?.(chunk.text);
        if (out.length < MAX_OUTPUT) out += chunk.text;
      }
      const result = await proc.result;
      lastExitCode = result.exitCode;
      combined += `$ ${command}\n${out.trimEnd()}\n\n`;

      if (result.timedOut) {
        return {
          content: `${combined}Lệnh trên bị giết vì quá ${Math.round(TIMEOUT_MS / 1000)}s.`,
          isError: true,
          untrusted: true,
          meta: { ecosystem: args.ecosystem, manager: planned.plan.manager, exitCode: lastExitCode },
        };
      }
      if (result.exitCode !== 0) break;
    }

    const names = args.packages
      .map((p) => (p.version ? `${p.name}@${p.version}` : p.name))
      .join(', ');

    return {
      content:
        combined.length > MAX_OUTPUT
          ? `${combined.slice(0, MAX_OUTPUT)}\n… (output đã bị cắt)`
          : combined.trimEnd(),
      untrusted: true,
      isError: lastExitCode !== 0,
      meta: {
        ecosystem: args.ecosystem,
        manager: planned.plan.manager,
        packages: names,
        target: planned.plan.target,
        exitCode: lastExitCode,
      },
    };
  },
};
