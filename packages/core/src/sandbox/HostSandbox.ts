/**
 * HostSandbox — chạy lệnh THẲNG trên máy người dùng (M5).
 *
 * Tên có chữ "sandbox" nhưng nó KHÔNG PHẢI sandbox. Lệnh chạy ở đây có đúng
 * quyền của người dùng: đọc được `~/.ssh`, gọi được mạng, xoá được mọi thứ họ
 * xoá được. Lớp này tồn tại vì không phải máy nào cũng có Docker, và một agent
 * không chạy được test thì mất nửa giá trị.
 *
 * Ba ràng buộc đi kèm, đừng gỡ cái nào:
 *
 *   1. `isolated: false`. UI đọc cờ này để hiện cảnh báo đỏ.
 *   2. Người dùng phải TỰ CHỌN. Không có đường code nào tự rơi từ Docker sang
 *      đây khi Docker hỏng — hỏng thì báo lỗi, không âm thầm hạ mức bảo vệ.
 *   3. Quyền duyệt vẫn y nguyên: bash không bao giờ tự động được duyệt
 *      (PermissionManager.ALWAYS_ASK).
 */
import type {
  ExecOptions,
  ExecResult,
  NetworkProfile,
  OutputChunk,
  Sandbox,
  SandboxInfo,
} from './Sandbox.js';
import * as nodePath from 'node:path';
import { runProcess } from './process.js';
import { isWithin } from '../security/pathGuard.js';
import type { Logger } from '../telemetry/logger.js';

/**
 * Ép PowerShell in ra UTF-8 trước khi lệnh của model chạy.
 *
 * `process.ts` decode stdout bằng UTF-8, nhưng PowerShell in theo **codepage
 * của console** — trên máy locale Nhật là CP932, locale Việt là CP1258. Lệch
 * nhau thì mọi thông báo lỗi về tới nơi dưới dạng `�����ꏊ`, và hỏng ở đây
 * nặng hơn một lỗi hiển thị: MODEL cũng đọc đúng chuỗi đó. Nó không hiểu lệnh
 * vừa sai chỗ nào nên đoán mò rồi thử lại, và người dùng ngồi xem agent gõ sai
 * ba lần liên tiếp vì một hằng số encoding.
 *
 * Đặt cả hai biến: `OutputEncoding` là thứ PowerShell dùng để **đọc** stdout
 * của exe ngoài (git, npm, pnpm — phần lớn output agent nhận), còn
 * `$OutputEncoding` là thứ nó dùng khi **ghi** sang pipe.
 *
 * Giới hạn đã biết: lỗi ở bước PARSE (ví dụ `&&` trên PS 5.1) xảy ra trước khi
 * dòng này chạy, nên nó vẫn về dưới dạng mojibake. Thứ chặn trường hợp đó không
 * phải encoding mà là nói cho model biết nó đang ở shell nào — xem `SandboxInfo.shell`.
 */
const UTF8_PROLOGUE =
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ';

export interface HostSandboxOptions {
  workspaceRoot: string;
  logger: Logger;
  /** Biến môi trường cho lệnh. Không truyền = gần như không có gì ngoài PATH. */
  env?: Record<string, string>;
}

/**
 * Đưa lệnh về workspace TRƯỚC KHI nó chạy, bằng một lệnh `cd` thật.
 *
 * `runProcess` đã nhận `cwd`, nên về mặt tiến trình dòng này thừa. Nó tồn tại
 * vì `cwd` chỉ đặt thư mục cho TIẾN TRÌNH SHELL, còn thứ chạy bên trong shell
 * ấy vẫn có thể bắt đầu ở chỗ khác: profile của PowerShell, một `.bat` gọi
 * `pushd`, một `npm run` lồng nhau. `cd` viết thẳng vào đầu chuỗi thì dòng lệnh
 * của model luôn xuất phát từ workspace, bất kể thứ gì chạy trước nó.
 *
 * Nó KHÔNG hiện trong hộp duyệt quyền: bản xem trước ở đó là dòng lệnh gốc do
 * `bash.describe()` soạn, và cố ý như vậy — tool không biết sandbox nào sẽ chạy
 * nó, mà đường dẫn thì khác nhau giữa host và container (`PathTranslator`).
 *
 * Cũng không phải rào chắn: lệnh vẫn tự `cd` đi chỗ khác được ngay sau đó. Rào
 * chắn là container; thứ NHÌN RA việc đi chỗ khác là `security/workspaceEscape.ts`,
 * và nó chạy trước, ở hộp duyệt quyền.
 */
function anchorToWorkspace(command: string, cwd: string, powershell: boolean): string {
  return powershell
    ? `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ${command}`
    : `cd '${cwd.replace(/'/g, `'\\''`)}' && ${command}`;
}

export class HostSandbox implements Sandbox {
  constructor(private readonly opts: HostSandboxOptions) {}

  info(): SandboxInfo {
    return {
      kind: 'host',
      // Nhãn nói NƠI CHẠY, không phải một lời cảnh báo thường trực. Câu cảnh
      // báo cũ ("NO isolation") từng treo suốt trên khung chat; nó đúng nhưng
      // không bao giờ đổi, nên mắt bỏ qua nó kể cả đúng lúc cần đọc. Việc báo
      // động giờ thuộc về từng lệnh — xem `security/workspaceEscape.ts`.
      label: 'Runs on your machine, inside this workspace folder',
      // Không có sandbox thì cũng không có giới hạn mạng nào để nói.
      network: 'full' as NetworkProfile,
      isolated: false,
      shell: process.platform === 'win32' ? 'powershell' : 'bash',
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  exec(
    command: string,
    opts: ExecOptions = {},
  ): AsyncIterable<OutputChunk> & { result: Promise<ExecResult> } {
    this.opts.logger.warn('chạy lệnh KHÔNG cách ly trên máy host', {
      // Chỉ ghi độ dài, không ghi nội dung lệnh: lệnh hay chứa token dán tay.
      commandLength: command.length,
    });

    // Thư mục làm việc KHÔNG được nằm ngoài workspace. Người gọi duy nhất hiện
    // nay truyền đúng workspaceRoot, nên nhánh này là để lần sau: một tool mới
    // nhận `cwd` từ model rồi chuyển thẳng xuống đây sẽ bị chặn ở tầng chạy
    // lệnh, chứ không phải bị phát hiện lúc đã chạy xong.
    const root = nodePath.resolve(this.opts.workspaceRoot);
    const cwd = opts.cwd ? nodePath.resolve(opts.cwd) : root;
    if (!isWithin(root, cwd)) {
      throw new Error(
        `Từ chối chạy lệnh với thư mục làm việc ngoài workspace: ${cwd} (workspace: ${root}).`,
      );
    }

    const powershell = process.platform === 'win32';
    const anchored = anchorToWorkspace(command, cwd, powershell);

    // Windows không có bash sẵn. PowerShell là thứ chắc chắn có, và `-Command`
    // nhận lệnh như MỘT đối số nên không có chuyện nối chuỗi sinh injection.
    const [file, args] = powershell
      ? ([
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', `${UTF8_PROLOGUE}${anchored}`],
        ] as const)
      : (['/bin/bash', ['-lc', anchored]] as const);

    return runProcess(file, [...args], {
      cwd,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      env: { ...this.opts.env, ...opts.env },
    });
  }

  async dispose(): Promise<void> {
    /* không có gì để dọn */
  }
}
