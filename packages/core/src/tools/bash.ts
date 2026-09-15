/**
 * bash — chạy lệnh shell (M5).
 *
 * Tool nguy hiểm nhất trong bộ. Bốn ràng buộc, không cái nào là tuỳ chọn:
 *
 *   1. Chạy qua `ctx.sandbox`, không tự spawn. Không có sandbox = không chạy.
 *   2. KHÔNG BAO GIỜ tự động được duyệt. Ràng buộc đó cưỡng chế ở
 *      PermissionManager.ALWAYS_ASK, ở tầng core, không phải ở nút bấm.
 *   3. Output là dữ liệu KHÔNG TIN CẬY. `curl` hay `cat` một file lạ đều đưa
 *      nội dung người khác viết vào context — nó phải được bọc delimiter và
 *      quét injection y như nội dung file.
 *   4. Chặn sẵn vài mẫu lệnh phá hoại rõ ràng. Đây là lưới an toàn cho người
 *      dùng bấm duyệt vội, KHÔNG phải rào chắn: ai muốn vòng qua thì vòng được
 *      trong ba giây. Rào chắn thật là container.
 */
import { z } from 'zod';
import type { Tool, ToolContext, ToolIntent, ToolResult } from './Tool.js';
import { describeEscapes, scanEscapes } from '../security/workspaceEscape.js';
import { exitCodeHint } from './execHint.js';

const schema = z.object({
  command: z.string().min(1).describe('Lệnh shell cần chạy'),
  description: z
    .string()
    .optional()
    .describe('Một câu nói lệnh này làm gì, để người dùng duyệt nhanh'),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .optional()
    .describe('Trần thời gian, ms. Mặc định 120000 (chạy nền: 30 phút).'),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      'true = chạy nền, trả về ngay một task_id thay vì chờ lệnh xong. ' +
        'Dùng cho việc chạy lâu (test, build, dev server) để làm việc khác ' +
        'trong lúc chờ. Lấy kết quả bằng task_status.',
    ),
});

const DEFAULT_TIMEOUT = 120_000;
/** Trần ký tự trả về model. Cắt ở tool để history không phình. */
const MAX_OUTPUT = 30_000;

/**
 * Mẫu lệnh bị chặn thẳng. Cố ý ngắn: danh sách dài tạo ảo giác an toàn và
 * khuyến khích người ta coi nó là lớp bảo vệ chính. Nó không phải.
 */
const BLOCKED: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f?\s+\/(?:\s|$)/, why: 'xoá đệ quy từ gốc hệ thống' },
  { re: /\b(mkfs|fdisk|diskpart)\b/, why: 'thao tác phân vùng đĩa' },
  { re: /\bdd\s+[^|]*of=\/dev\//, why: 'ghi thẳng vào thiết bị khối' },
  { re: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/, why: 'fork bomb' },
  { re: /\bchmod\s+(-[a-zA-Z]+\s+)*777\s+\/(?:\s|$)/, why: 'mở toàn quyền cho gốc hệ thống' },
  {
    re: /\bcurl\b[^|;&]*\|\s*(sudo\s+)?(ba)?sh\b/,
    why: 'tải script từ mạng rồi chạy thẳng — không ai đọc được nó làm gì',
  },
  { re: /\/var\/run\/docker\.sock/, why: 'chạm docker socket là thoát sandbox' },
  { re: /\bsudo\b|\bdoas\b/, why: 'chạy bằng quyền quản trị — AstraCode không sửa máy người dùng, dùng install_package nếu cần thêm thư viện cho project' },
  {
    re: /\b(?:apt|apt-get|yum|dnf|pacman|brew|choco|winget)\s+install\b/,
    why: 'cài phần mềm cấp hệ thống — ngoài phạm vi thư mục project',
  },
];

/**
 * Cờ cài đặt TOÀN CỤC — `npm i -g`, `pip install --user`, `pnpm add --global`.
 * KHÔNG chặn (người dùng vẫn có quyền tự làm việc này), chỉ CẢNH BÁO: xem
 * `describe()`. Regex lỏng cố ý — bắt đúng cờ, không cần biết trước lệnh nào.
 */
const GLOBAL_INSTALL_FLAG = /(?:^|\s)(-g\b|--global\b|--user\b)/;

export function findGlobalInstallFlag(command: string): string | undefined {
  return GLOBAL_INSTALL_FLAG.exec(command)?.[1];
}

export function checkBlocked(command: string): string | undefined {
  for (const b of BLOCKED) {
    if (b.re.test(command)) return b.why;
  }
  return undefined;
}

export const bashTool: Tool<typeof schema> = {
  name: 'bash',
  description:
    'Chạy một lệnh shell trong thư mục làm việc. Dùng để chạy test, build, ' +
    'lint, hoặc lệnh git. KHÔNG dùng để đọc/tìm file — đã có read_file, glob, ' +
    'grep, chúng nhanh hơn và an toàn hơn. Mỗi lệnh đều cần người dùng duyệt.',
  schema,
  readOnly: false,

  async describe(args, ctx: ToolContext): Promise<ToolIntent> {
    // Lệnh chạy trong workspace là chuyện thường; lệnh với tay ra ngoài nó thì
    // không, và hộp duyệt phải nói ra bằng chứng thay vì để người dùng tự đọc
    // dò một dòng lệnh dài.
    const escapes = describeEscapes(scanEscapes(args.command, { workspaceRoot: ctx.workspaceRoot }));
    // Cờ cài đặt toàn cục không bị BLOCKED (người dùng vẫn có quyền tự làm),
    // nhưng phải NHÌN THẤY trước khi duyệt — xem GLOBAL_INSTALL_FLAG ở trên.
    const globalFlag = findGlobalInstallFlag(args.command);
    const warnings = [
      ...escapes,
      ...(globalFlag
        ? [`installs with ${globalFlag} — affects more than this project, not just node_modules/.venv`]
        : []),
    ];
    // Hộp duyệt PHẢI nói ra việc lệnh chạy nền: người dùng bấm Allow cho một
    // thứ vẫn còn chạy sau khi lượt chat kết thúc, và đó là khác biệt duy nhất
    // mà họ không suy ra được từ dòng lệnh.
    const background = args.run_in_background === true;
    return {
      summary: background
        ? `Run in background: ${args.description ?? 'a shell command'}`
        : args.description
          ? `${args.description}`
          : 'Run a shell command',
      preview: args.command,
      // KHÔNG phải diff: một script có dòng `-x` hay `+x` mà bị tô như diff
      // thì hộp duyệt đang mô tả sai thứ sắp chạy.
      previewKind: 'command',
      ...(warnings.length ? { warnings } : {}),
    };
  },

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const blocked = checkBlocked(args.command);
    if (blocked) {
      ctx.logger.warn('chặn lệnh nguy hiểm', { why: blocked });
      return {
        content:
          `Từ chối chạy: lệnh này ${blocked}. ` +
          `Nếu bạn thật sự cần, hãy giải thích cho người dùng và để họ tự chạy.`,
        isError: true,
        untrusted: false,
      };
    }

    if (!ctx.sandbox) {
      return {
        content:
          'Chưa có sandbox nào để chạy lệnh. Người dùng cần bật Docker Desktop, ' +
          'hoặc đổi cài đặt astra.sandbox sang "host" nếu chấp nhận chạy trực tiếp. ' +
          'Trong lúc đó hãy làm việc bằng các công cụ đọc file.',
        isError: true,
        untrusted: false,
      };
    }

    // ── Chạy nền ────────────────────────────────────────────────────────────
    // Trả về NGAY. Từ đây lệnh sống tách khỏi lượt chat: `ctx.signal` không
    // được truyền xuống, nên bấm Stop giữa lượt không giết một bản build đang
    // chạy dở. Muốn giết thì có task_kill, và đóng phiên thì giết tất.
    if (args.run_in_background === true) {
      if (!ctx.jobs) {
        return {
          content:
            'Phiên này không chạy nền được. Gọi lại lệnh không có run_in_background.',
          isError: true,
          untrusted: false,
        };
      }
      try {
        const job = ctx.jobs.start({
          sandbox: ctx.sandbox,
          command: args.command,
          ...(args.description ? { description: args.description } : {}),
          cwd: ctx.workspaceRoot,
          ...(args.timeout_ms ? { timeoutMs: args.timeout_ms } : {}),
        });
        return {
          content:
            `Đã bật tác vụ nền ${job.id}: ${args.command}\n` +
            `Nó chạy song song với bạn. Làm tiếp việc khác trong plan; khi cần ` +
            `kết quả thì gọi task_status (task_id: "${job.id}"), và đặt wait: true ` +
            `nếu không còn việc gì khác để làm trong lúc chờ.`,
          untrusted: false,
          meta: { background: true, taskId: job.id, sandbox: ctx.sandbox.info().kind },
        };
      } catch (err) {
        return {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
          untrusted: false,
        };
      }
    }

    const proc = ctx.sandbox.exec(args.command, {
      cwd: ctx.workspaceRoot,
      timeoutMs: args.timeout_ms ?? DEFAULT_TIMEOUT,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    let out = '';
    let truncated = false;
    try {
      for await (const chunk of proc) {
        // Đẩy ra UI ngay cả phần vượt trần: người dùng cần thấy lệnh đang chạy
        // tới đâu, còn trần MAX_OUTPUT là để giữ history của model không phình.
        ctx.onOutput?.(chunk.text);
        if (out.length >= MAX_OUTPUT) {
          truncated = true;
          continue;
        }
        out += chunk.text;
      }
    } catch (err) {
      return {
        content: `Không chạy được lệnh: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        untrusted: false,
      };
    }

    const result = await proc.result;
    if (out.length > MAX_OUTPUT) {
      out = out.slice(0, MAX_OUTPUT);
      truncated = true;
    }

    const head = result.timedOut
      ? `Lệnh bị giết sau ${Math.round(result.durationMs / 1000)}s vì quá giờ.`
      : result.aborted
        ? 'Lệnh bị người dùng dừng.'
        : `Kết thúc với mã ${result.exitCode} sau ${Math.round(result.durationMs / 1000)}s.`;

    const hasOutput = out.trim() !== '';
    const body = hasOutput ? out.trimEnd() : '(không có output)';
    const hint =
      !result.timedOut && !result.aborted ? exitCodeHint(result.exitCode, hasOutput) : '';

    return {
      content: `${head}\n\n${body}${truncated ? '\n… (output đã bị cắt)' : ''}${hint}`,
      // Output lệnh là nội dung do thứ khác sinh ra, không phải do người dùng
      // viết. Bọc delimiter và quét injection — xem đầu file.
      untrusted: true,
      isError: result.exitCode !== 0,
      meta: {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        sandbox: ctx.sandbox.info().kind,
      },
    };
  },
};
