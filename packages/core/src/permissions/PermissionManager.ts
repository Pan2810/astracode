/**
 * PermissionManager — chỗ quyết định DUY NHẤT về việc agent được làm gì
 * (documents/SECURITY.md §4).
 *
 * Nằm ở core chứ không ở tầng UI, vì một lý do: nếu việc chặn chỉ là ẩn nút
 * trên webview thì nó không phải cơ chế bảo mật, chỉ là gợi ý giao diện. Model
 * gọi tool qua AgentLoop, không qua nút bấm — nên chốt chặn phải nằm trên
 * đường đi của AgentLoop.
 *
 * Ba chế độ:
 *   - `plan`        : chỉ đọc. Mọi tool có tác dụng phụ bị chặn TẠI ĐÂY.
 *   - `ask`         : hỏi người dùng trước mỗi tool có tác dụng phụ.
 *   - `acceptEdits` : tự duyệt việc sửa file trong workspace. KHÔNG bao giờ
 *                     tự duyệt bash — xem ALWAYS_ASK bên dưới.
 *
 * Và một cơ chế không có trong ba chế độ trên: HẠ CẤP THEO NGUỒN. Sau khi agent
 * nuốt phải nội dung không đáng tin, phiên tự rơi về `ask` dù người dùng đang
 * bật `acceptEdits`. Đây là chỗ cắt chuỗi "đọc nội dung độc → tự động ghi file
 * theo lời nội dung đó". Không có nó, acceptEdits biến mọi file trong repo
 * thành một kênh điều khiển agent.
 */
import type { Logger } from '../telemetry/logger.js';
import type { PreviewKind } from '../tools/Tool.js';

export type PermissionMode = 'plan' | 'ask' | 'acceptEdits';

/**
 * Tool KHÔNG BAO GIỜ được tự duyệt, bất kể chế độ hay cấu hình người dùng.
 * Đây là ràng buộc cứng ở tầng core — documents/SECURITY.md §4.1. Lệnh shell chạy
 * được bất cứ thứ gì, nên "nhớ quyết định cho lần sau" ở đây là vô nghĩa: hai
 * lần gọi bash giống tên nhau có thể làm hai việc hoàn toàn khác.
 */
export const ALWAYS_ASK = new Set(['bash', 'python', 'run_command', 'execute', 'install_package']);

export type PermissionDecision =
  /** Cho phép lần này thôi. */
  | 'allow_once'
  /** Cho phép và nhớ cho tool + đường dẫn tương tự trong phiên này. */
  | 'allow_always'
  | 'deny';

export interface PermissionRequest {
  tool: string;
  /** Câu mô tả cho người đọc: "Sửa src/auth.ts". */
  summary: string;
  /** Đường dẫn tương đối bị tác động, nếu có. */
  path?: string;
  /** Diff hoặc nội dung xem trước để người dùng quyết định có căn cứ. */
  preview?: string;
  /** `preview` là loại gì — UI tô theo cái này, không tự đoán. Mặc định `text`. */
  previewKind?: PreviewKind;
  /** Chế độ đang áp dụng lúc hỏi — UI hiện cho người dùng biết vì sao bị hỏi. */
  mode: PermissionMode;
  /** Lý do phiên bị hạ cấp, nếu đang bị hạ cấp. */
  downgradeReason?: string;
  /**
   * Điều đáng báo về CHÍNH thao tác này — thứ đã ép nó phải hỏi. Xem
   * `ToolIntent.warnings`.
   */
  warnings?: string[];
}

export type PermissionAsker = (req: PermissionRequest) => Promise<PermissionDecision>;

export interface PermissionCheck {
  allowed: boolean;
  /** Câu giải thích gửi LẠI CHO MODEL khi bị từ chối. */
  reason?: string;
  /** Người dùng đã bấm duyệt, hay được tự duyệt theo chế độ. */
  askedUser: boolean;
}

/** Một mục trong allowlist của phiên. */
interface Grant {
  tool: string;
  /** Tiền tố đường dẫn tương đối. Rỗng = áp cho mọi đường dẫn. */
  pathPrefix: string;
}

export interface PermissionManagerOptions {
  mode?: PermissionMode;
  logger: Logger;
  /** Hàm hỏi người dùng. Không truyền = mọi yêu cầu cần hỏi đều bị từ chối. */
  ask?: PermissionAsker;
}

export interface PermissionState {
  mode: PermissionMode;
  /** Chế độ thực tế đang áp dụng sau khi tính cả hạ cấp. */
  effectiveMode: PermissionMode;
  downgraded: boolean;
  downgradeReason?: string;
  grants: number;
}

export type PermissionListener = (state: PermissionState) => void;

export class PermissionManager {
  private mode: PermissionMode;
  private grants: Grant[] = [];
  private downgradeReason: string | undefined;
  private asker: PermissionAsker | undefined;
  private readonly listeners = new Set<PermissionListener>();

  constructor(private readonly opts: PermissionManagerOptions) {
    this.mode = opts.mode ?? 'ask';
    this.asker = opts.ask;
  }

  /**
   * Gắn kênh hỏi sau khi dựng. Cần vì UI chat ra đời sau manager, và manager
   * phải tồn tại trước để status bar đọc được chế độ ngay lúc extension bật.
   * Không có kênh hỏi thì mọi yêu cầu cần duyệt bị TỪ CHỐI, không phải cho qua.
   */
  setAsker(ask: PermissionAsker | undefined): void {
    this.asker = ask;
  }

  getState(): PermissionState {
    return {
      mode: this.mode,
      effectiveMode: this.effectiveMode(),
      downgraded: this.downgradeReason !== undefined,
      ...(this.downgradeReason ? { downgradeReason: this.downgradeReason } : {}),
      grants: this.grants.length,
    };
  }

  /**
   * Chế độ thực tế. Bị hạ cấp thì `acceptEdits` rơi xuống `ask`; `plan` giữ
   * nguyên vì nó đã là chặt nhất.
   */
  effectiveMode(): PermissionMode {
    if (this.downgradeReason !== undefined && this.mode === 'acceptEdits') return 'ask';
    return this.mode;
  }

  /**
   * Đổi chế độ. Người dùng chủ động chọn `acceptEdits` thì xoá cờ hạ cấp —
   * họ đã thấy cảnh báo và vẫn quyết định như vậy, đó là quyền của họ.
   */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
    if (mode === 'acceptEdits') this.downgradeReason = undefined;
    this.notify();
  }

  /**
   * Hạ cấp phiên vì agent vừa đọc nội dung không đáng tin.
   * Không thể tự gỡ: chỉ người dùng chọn lại chế độ mới xoá được.
   */
  downgrade(reason: string): void {
    if (this.downgradeReason !== undefined) return;
    this.downgradeReason = reason;
    // Quyết định đã nhớ trước đó cũng mất hiệu lực. Chúng được cấp khi phiên
    // còn sạch; sau khi nội dung lạ vào context, "y như lần trước" không còn
    // là cùng một tình huống nữa.
    this.grants = [];
    this.opts.logger.warn('hạ cấp quyền phiên', { reason });
    this.notify();
  }

  clearDowngrade(): void {
    if (this.downgradeReason === undefined) return;
    this.downgradeReason = undefined;
    this.notify();
  }

  /** Quên mọi quyết định đã nhớ. Gọi khi bắt đầu phiên chat mới. */
  reset(): void {
    this.grants = [];
    this.downgradeReason = undefined;
    this.notify();
  }

  /**
   * Kiểm tra một lời gọi tool. Tool chỉ đọc luôn được phép và không bao giờ
   * hỏi — hỏi mỗi lần đọc file sẽ khiến người dùng bấm Allow theo phản xạ, và
   * lúc đó lời hỏi mất hết giá trị.
   */
  async check(input: {
    tool: string;
    readOnly: boolean;
    summary: string;
    path?: string;
    preview?: string;
    /**
     * Phải đi cùng `preview` xuống tới `asker`. Bỏ nó ở đây thì hộp duyệt quyền
     * nhận diff mà không biết đó là diff, nên vẽ nguyên khối chữ trơn — dòng
     * thêm/xoá mất hẳn nền xanh/đỏ đúng lúc người dùng cần liếc để quyết định.
     */
    previewKind?: PreviewKind;
    /**
     * Cảnh báo về chính thao tác này. Có một dòng ở đây là thao tác BUỘC phải
     * đi qua mắt người dùng — xem `mustWarn` bên dưới.
     */
    warnings?: string[];
  }): Promise<PermissionCheck> {
    if (input.readOnly) return { allowed: true, askedUser: false };

    const mode = this.effectiveMode();

    if (mode === 'plan') {
      return {
        allowed: false,
        askedUser: false,
        reason:
          `Plan mode is on — read-only, nothing can be changed. ` +
          `Describe the changes you intend to make so the user can approve them, ` +
          `and do not call ${input.tool} again.`,
      };
    }

    /**
     * Thao tác có cảnh báo thì KHÔNG con đường tự duyệt nào áp dụng nữa.
     *
     * Đây là chỗ trả lời cho yêu cầu "báo cho người dùng dù họ đang ở chế độ
     * nào". `acceptEdits` là lời cho phép sửa file trong workspace — nó không
     * phải lời cho phép ghi một script đọc `~/.ssh`, và một "luôn cho phép" nhớ
     * từ mười phút trước lại càng không. Hai đường ấy được cấp cho những thao
     * tác NHÀM CHÁN; cái này vừa thôi nhàm chán.
     *
     * Chế độ `plan` phía trên vẫn thắng: nó chặt hơn, không có gì để nới.
     */
    const mustWarn = (input.warnings?.length ?? 0) > 0;
    const mustAsk = ALWAYS_ASK.has(input.tool) || mustWarn;

    if (mode === 'acceptEdits' && !mustAsk) {
      return { allowed: true, askedUser: false };
    }

    if (!mustAsk && this.isGranted(input.tool, input.path)) {
      return { allowed: true, askedUser: false };
    }

    if (!this.asker) {
      return {
        allowed: false,
        askedUser: false,
        reason: `This needs user approval but the session has no way to ask. Skipping ${input.tool}.`,
      };
    }

    const decision = await this.asker({
      tool: input.tool,
      summary: input.summary,
      mode,
      ...(input.path ? { path: input.path } : {}),
      ...(input.preview ? { preview: input.preview } : {}),
      ...(input.previewKind ? { previewKind: input.previewKind } : {}),
      ...(this.downgradeReason ? { downgradeReason: this.downgradeReason } : {}),
      ...(mustWarn ? { warnings: input.warnings } : {}),
    });

    if (decision === 'deny') {
      this.opts.logger.info('người dùng từ chối tool', { tool: input.tool, path: input.path });
      return {
        allowed: false,
        askedUser: true,
        reason:
          `The user denied ${input.tool}${input.path ? ` on ${input.path}` : ''}. ` +
          `Do not retry this operation — ask them what they want instead.`,
      };
    }

    // "Nhớ cho lần sau" không áp dụng cho tool trong ALWAYS_ASK, cũng không áp
    // dụng cho thao tác có cảnh báo — kể cả khi người dùng bấm nút đó. UI không
    // nên hiện nút, nhưng core vẫn phải chặn: một lần "được" cho một script
    // đọc ra ngoài workspace không phải lời cho phép mọi script sau đó.
    if (decision === 'allow_always' && !mustAsk) {
      this.grant(input.tool, input.path);
    }

    return { allowed: true, askedUser: true };
  }

  /**
   * Nhớ quyết định. Phạm vi là THƯ MỤC chứa file, không phải cả workspace:
   * duyệt sửa `src/api/user.ts` không có nghĩa là duyệt sửa `.github/workflows`.
   */
  private grant(tool: string, path: string | undefined): void {
    const pathPrefix = path ? dirnamePosix(path) : '';
    if (this.isGranted(tool, path)) return;
    this.grants.push({ tool, pathPrefix });
    this.opts.logger.debug('nhớ quyền trong phiên', { tool, pathPrefix });
    this.notify();
  }

  private isGranted(tool: string, path: string | undefined): boolean {
    return this.grants.some((g) => {
      if (g.tool !== tool) return false;
      if (g.pathPrefix === '') return true;
      if (path === undefined) return false;
      const p = normalizePosix(path);
      return p === g.pathPrefix || p.startsWith(`${g.pathPrefix}/`);
    });
  }

  onChange(listener: PermissionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const state = this.getState();
    for (const l of this.listeners) {
      try {
        l(state);
      } catch {
        /* bỏ qua có chủ ý */
      }
    }
  }
}

function normalizePosix(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function dirnamePosix(p: string): string {
  const n = normalizePosix(p);
  const i = n.lastIndexOf('/');
  return i <= 0 ? '' : n.slice(0, i);
}

/** Nhãn tiếng Việt cho UI. */
export function describeMode(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return 'Plan (read-only)';
    case 'ask':
      return 'Ask before editing';
    case 'acceptEdits':
      return 'Auto-approve file edits';
  }
}
