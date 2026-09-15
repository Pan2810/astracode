/**
 * python — chạy script hoặc mã Python.
 *
 * Cùng mô hình bảo mật với bash: chạy qua `ctx.sandbox`, KHÔNG tự spawn. Ba
 * ràng buộc, không cái nào tuỳ chọn:
 *
 *   1. Chạy qua `ctx.sandbox`, không tự spawn. Không có sandbox = không chạy.
 *   2. KHÔNG BAO GIỜ tự động được duyệt — ràng buộc cưỡng chế ở PermissionManager.
 *   3. Output là dữ liệu KHÔNG TIN CẬY: bọc delimiter và quét injection y như
 *      nội dung file.
 *
 * Khác bash ở một điểm: chọn `python3` rồi tới `python`, và mã inline đi qua
 * `python3 -c '…'` với shell-quote đầy đủ để không vỡ bởi dấu nháy đơn trong mã.
 */
import { z } from 'zod';
import type { Tool, ToolContext, ToolIntent, ToolResult } from './Tool.js';
import { PathGuardError } from '../security/pathGuard.js';
import { describeEscapes, scanEscapes } from '../security/workspaceEscape.js';
import { exitCodeHint } from './execHint.js';

const schema = z.object({
  /** Script Python cần chạy. Có thể là mã inline hoặc đường dẫn file `.py`. */
  script: z.string().min(1).describe('Mã Python hoặc đường dẫn file .py cần chạy'),
  /** Đối số truyền cho script — vào `sys.argv[1:]`. */
  args: z
    .array(z.string())
    .optional()
    .describe('Đối số dòng lệnh truyền cho script Python (vào sys.argv[1:])'),
  description: z
    .string()
    .optional()
    .describe('Một câu nói script này làm gì, để người dùng duyệt nhanh'),
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
      'true = chạy nền, trả về ngay một task_id thay vì chờ script xong. ' +
        'Dùng cho script chạy lâu. Lấy kết quả bằng task_status.',
    ),
});

const DEFAULT_TIMEOUT = 120_000;
/** Trần ký tự trả về model. Cắt ở tool để history không phình. */
const MAX_OUTPUT = 30_000;

/**
 * Shell-quote một chuỗi bằng dấu nháy đơn. Dấu nháy đơn trong chuỗi thoát bằng
 * `'\''` (đóng nháy, thoát, mở lại) — cách duy nhất an toàn cho mọi nội dung.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** `script` là file `.py` nếu có phần mở rộng và KHÔNG chứa xuống dòng. */
function isFilePath(script: string): boolean {
  return /\.[a-z0-9]+$/i.test(script) && !script.includes('\n');
}

/**
 * Dựng lệnh shell. Sandbox nhận MỘT chuỗi rồi tự đưa vào shell của container,
 * nên mọi đối số phải được shell-quote để không sinh injection.
 */
function buildCommand(script: string, args: string[]): string {
  const argv = args.map(shellQuote).join(' ');
  if (isFilePath(script)) {
    return `python3 ${shellQuote(script)}${argv ? ' ' + argv : ''}`;
  }
  // Mã inline: `python3 -c '…'`. shellQuote xử lý mọi ký tự trong mã, kể cả
  // dấu nháy đơn, nên mã nhiều dòng và có nháy đều an toàn.
  return `python3 -c ${shellQuote(script)}${argv ? ' ' + argv : ''}`;
}

/**
 * Nội dung thật sự sắp chạy: mã inline thì là chính nó, file thì là NỘI DUNG
 * file — cùng đường dẫn của file.
 *
 * Vì sao phải đọc file ra: `python3 tools/cleanup.py` không nói lên điều gì.
 * Thứ chạy là ba chục dòng bên trong, và ba chục dòng ấy mới là chỗ có
 * `shutil.rmtree(os.path.expanduser('~'))`. Quét mỗi dòng lệnh là quét cái vỏ.
 *
 * File nằm ngoài workspace thì `pathGuard` ném, và đó là câu trả lời đúng: một
 * script ở ngoài thư mục đang mở không phải thứ agent được đem ra chạy.
 */
async function scriptBody(
  script: string,
  ctx: ToolContext,
): Promise<{ text: string; path?: string; error?: string }> {
  if (!isFilePath(script)) return { text: script };
  try {
    const abs = await ctx.pathGuard.resolveExisting(script);
    return { text: await ctx.fs.readFile(abs), path: script };
  } catch (err) {
    if (err instanceof PathGuardError) {
      return {
        text: '',
        path: script,
        error:
          err.reason === 'not-found'
            ? `Không có file ${script} trong workspace.`
            : `Từ chối chạy ${script}: ${err.message}`,
      };
    }
    // Đọc hỏng vì lý do khác (quyền, file nhị phân): không chặn ở đây, để
    // execute báo lỗi thật. Nhưng cũng không quét được gì.
    return { text: '', path: script };
  }
}

export const pythonTool: Tool<typeof schema> = {
  name: 'python',
  description:
    'Chạy một script hoặc đoạn mã Python trong thư mục làm việc. ' +
    'Dùng để chạy tooling Python, xử lý dữ liệu, hoặc tự động hoá. ' +
    'KHÔNG dùng để đọc/tìm file — đã có read_file, glob, grep, chúng nhanh ' +
    'hơn và an toàn hơn. Mỗi lần chạy đều cần người dùng duyệt.',
  schema,
  readOnly: false,

  async describe(args, ctx: ToolContext): Promise<ToolIntent> {
    const argv = args.args ?? [];
    const body = await scriptBody(args.script, ctx);
    // Quét CẢ nội dung script lẫn đối số: `python3 clean.py ~/.ssh` giấu đường
    // dẫn ở argv chứ không ở trong file.
    const escapes = describeEscapes(
      scanEscapes([body.text, ...argv].join('\n'), { workspaceRoot: ctx.workspaceRoot }),
    );
    const plain = args.description
      ? `${args.description}`
      : `Run ${argv.length ? 'Python with args' : 'Python script'}`;
    return {
      // Hộp duyệt phải nói ra việc script chạy nền — xem chú thích cùng chỗ
      // trong bash.ts: đó là thứ người dùng không suy ra được từ dòng lệnh.
      summary: args.run_in_background === true ? `Run in background: ${plain}` : plain,
      preview: buildCommand(args.script, argv),
      // Đúng vì là lệnh thực sự sắp chạy, không phải diff.
      previewKind: 'command',
      ...(body.path ? { path: body.path } : {}),
      ...(body.error ? { warnings: [body.error] } : escapes.length ? { warnings: escapes } : {}),
    };
  },

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    // Script phải nằm TRONG workspace. Chặn ở đây chứ không chỉ cảnh báo: mọi
    // tool đọc/ghi file của AstraCode đều bị `pathGuard` giữ trong thư mục đang
    // mở, và một tool chạy được mã tuỳ ý mà lại lỏng hơn thì cái hàng rào kia
    // thành trang trí. Mã INLINE vẫn qua — nó do người dùng vừa nhìn thấy trong
    // hộp duyệt, không phải một file trên đĩa mà không ai đọc.
    if (isFilePath(args.script)) {
      try {
        await ctx.pathGuard.resolveExisting(args.script);
      } catch (err) {
        if (err instanceof PathGuardError) {
          return {
            content:
              `Từ chối chạy ${args.script}: ${err.message} ` +
              `Chỉ chạy được script nằm trong workspace đang mở. ` +
              `Nếu cần script này, hãy chép nó vào workspace trước rồi chạy lại.`,
            isError: true,
            untrusted: false,
          };
        }
        throw err;
      }
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

    const command = buildCommand(args.script, args.args ?? []);

    // Chạy nền: trả về ngay, script sống tách khỏi lượt chat. Cùng cơ chế và
    // cùng ràng buộc với bash — xem chú thích ở đó.
    if (args.run_in_background === true) {
      if (!ctx.jobs) {
        return {
          content: 'Phiên này không chạy nền được. Gọi lại không có run_in_background.',
          isError: true,
          untrusted: false,
        };
      }
      try {
        const job = ctx.jobs.start({
          sandbox: ctx.sandbox,
          command,
          ...(args.description ? { description: args.description } : {}),
          cwd: ctx.workspaceRoot,
          ...(args.timeout_ms ? { timeoutMs: args.timeout_ms } : {}),
        });
        return {
          content:
            `Đã bật tác vụ nền ${job.id}: ${command}\n` +
            `Nó chạy song song với bạn. Làm tiếp việc khác; khi cần kết quả thì ` +
            `gọi task_status (task_id: "${job.id}").`,
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

    const proc = ctx.sandbox.exec(command, {
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
