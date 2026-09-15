/**
 * Sandbox — nơi lệnh shell của agent thực sự chạy (mốc M5).
 *
 * Trừu tượng này tồn tại vì một lý do bảo mật, không phải vì tính linh hoạt:
 * tool `bash` KHÔNG được biết nó đang chạy ở đâu. Nếu tool tự spawn tiến trình
 * thì việc "chạy trong Docker" chỉ là một nhánh if, và mọi nhánh if đều có
 * ngày bị bỏ qua. Ở đây tool chỉ có một cách chạy lệnh: `ctx.sandbox`.
 *
 * Hai bản cài đặt, KHÔNG tương đương nhau về an toàn:
 *
 *   DockerSandbox — biện pháp thật. Container không mạng, rootfs chỉ đọc, bỏ
 *                   hết capability, chỉ mount workspace (xem sandbox/).
 *   HostSandbox   — chạy thẳng trên máy người dùng. KHÔNG phải sandbox, chỉ là
 *                   đường lui khi không có Docker. Không bao giờ được tự động
 *                   chuyển sang nó.
 */

export type NetworkProfile = 'none' | 'restricted' | 'full';

export interface ExecOptions {
  /** Thư mục làm việc, đường dẫn HOST. Sandbox tự dịch sang đường container. */
  cwd?: string;
  /** Trần thời gian chạy, ms. Hết giờ thì tiến trình bị giết. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Biến môi trường thêm. Sandbox KHÔNG kế thừa env của host. */
  env?: Record<string, string>;
}

export interface OutputChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface ExecResult {
  exitCode: number;
  /** Bị giết vì quá giờ chứ không phải tự kết thúc. */
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

export interface SandboxInfo {
  kind: 'docker' | 'host';
  /** Câu mô tả cho UI: "Docker · không mạng". */
  label: string;
  network: NetworkProfile;
  /** Đây có phải cách ly thật không. HostSandbox trả false. */
  isolated: boolean;
  /**
   * Shell mà lệnh thật sự chạy trong đó.
   *
   * Phải khai ra vì tool tên là `bash` còn trên Windows nó chạy `powershell.exe`
   * — và model viết `&&` theo phản xạ. Windows PowerShell 5.1 không có toán tử
   * đó, nên lệnh chết ở bước parse với một thông báo mà model không đoán ra
   * nguyên nhân, rồi nó thử lại bằng `;` và nhận một lỗi khác. Nói trước tên
   * shell rẻ hơn nhiều so với hai lượt hỏng.
   */
  shell: ShellKind;
}

/** `powershell` = Windows PowerShell 5.1 (`powershell.exe`), không phải pwsh 7. */
export type ShellKind = 'bash' | 'powershell';

export interface Sandbox {
  info(): SandboxInfo;
  /** Có dùng được không (Docker đã cài và daemon đang chạy chưa). */
  isAvailable(): Promise<boolean>;
  /**
   * Chạy lệnh, phát output theo dòng khi nó chảy ra. Kết quả cuối lấy qua
   * `result` sau khi vòng lặp kết thúc.
   */
  exec(command: string, opts?: ExecOptions): AsyncIterable<OutputChunk> & {
    result: Promise<ExecResult>;
  };
  dispose(): Promise<void>;
}

export class SandboxUnavailableError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

/**
 * Dịch đường dẫn host ↔ container.
 *
 * Không phải chuyện thẩm mỹ. Model thấy `/workspace/src/a.ts` trong output của
 * lệnh rồi gọi `read_file("/workspace/src/a.ts")` — mà trên host đường đó không
 * tồn tại. Không dịch thì agent sẽ loanh quanh sửa nhầm file suốt cả phiên.
 */
export class PathTranslator {
  private readonly hostRootLower: string;

  constructor(
    private readonly hostRoot: string,
    private readonly containerRoot = '/workspace',
  ) {
    this.hostRootLower = hostRoot.toLowerCase().replace(/[\\/]+$/, '');
  }

  /** `C:\Work\repo\src\a.ts` → `/workspace/src/a.ts` */
  toContainer(hostPath: string): string {
    const p = hostPath.replace(/[\\/]+$/, '');
    if (!p.toLowerCase().startsWith(this.hostRootLower)) return hostPath;
    const rest = p.slice(this.hostRootLower.length).replace(/\\/g, '/').replace(/^\/+/, '');
    return rest ? `${this.containerRoot}/${rest}` : this.containerRoot;
  }

  /** `/workspace/src/a.ts` → `C:\Work\repo\src\a.ts` */
  toHost(containerPath: string): string {
    if (!containerPath.startsWith(this.containerRoot)) return containerPath;
    const rest = containerPath.slice(this.containerRoot.length).replace(/^\/+/, '');
    if (!rest) return this.hostRoot;
    const sep = this.hostRoot.includes('\\') ? '\\' : '/';
    return this.hostRoot.replace(/[\\/]+$/, '') + sep + rest.split('/').join(sep);
  }

  /**
   * Đổi mọi đường dẫn container trong một khối text về đường host.
   * Chạy trên output của lệnh trước khi đưa cho model.
   */
  rewriteOutput(text: string): string {
    const re = new RegExp(`${escapeRegExp(this.containerRoot)}(/[^\\s:"'\`)]*)?`, 'g');
    return text.replace(re, (m) => this.toHost(m));
  }

  /** Đổi đường dẫn host trong lệnh về đường container trước khi gửi vào. */
  rewriteCommand(command: string): string {
    if (!this.hostRootLower) return command;
    const re = new RegExp(escapeRegExp(this.hostRoot).replace(/\\\\/g, '[\\\\/]'), 'gi');
    return command.replace(re, this.containerRoot);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
