/**
 * Giao thức giữa extension host và webview chat.
 *
 * Từ v5 nó gánh cả phần cài đặt: chỉ còn MỘT webview, và bảng cài đặt là một
 * lớp phủ trong đó. Trước đây hai giao thức tách riêng vì hai webview có vòng
 * đời khác nhau — lý do đó biến mất cùng với webview thứ hai.
 */
import type { ChatModelOption } from './modelChoice.js';

export type { ChatModelOption };

export const CHAT_PROTOCOL_VERSION = 6;

/**
 * Lý do một lượt đã đóng ở tầng UI.
 *
 * Ba giá trị đầu đến từ kết quả bình thường của AgentLoop. `error` là lượt dừng
 * vì lỗi — từ 2026-09-07 nó đến từ `AgentRunResult.stoppedBy` chứ không còn là
 * một exception thoát ra ngoài (sổ nợ #10), nên lượt đó vẫn giữ được phần đã
 * làm. Không được gộp nó với `aborted`: webview dịch `aborted` thành
 * "cancelled", và một lỗi HTTP hiện thành "cancelled" là nói dối người dùng.
 */
export type TurnEndReason = 'answer' | 'iteration_limit' | 'aborted' | 'error';

/** Nhãn đặc biệt ở footer; lỗi đã có error box riêng nên không lặp lại ở đây. */
export function turnEndStatusLabel(reason: TurnEndReason): string | undefined {
  switch (reason) {
    case 'iteration_limit':
      return 'STOPPED AT THE ITERATION LIMIT';
    case 'aborted':
      return 'cancelled';
    case 'answer':
    case 'error':
      return undefined;
  }
}

export interface ChatModelInfo {
  id: string;
  toolCalling: 'native' | 'xml-fallback' | 'none';
  /**
   * `measured` = đã đo thật. `inferred` = chạy bằng năng lực giả định.
   *
   * `inferred` KHÔNG còn là trạng thái suy giảm: nó chỉ nói dữ liệu đến từ đâu.
   * Chỉ `measured` mới chặn được gì — "đã đo và kết luận không gọi được công
   * cụ" là lý do chặn hợp lệ, còn "chưa ai đo" thì không.
   */
  profileSource: 'measured' | 'inferred';
  contextWindow: number;
  compactAt?: number;
  warnAt?: number;
  /** Model đọc được ảnh không. Mặc định `true` khi chưa đo — xem INFERRED_DEFAULTS. */
  vision: boolean;
}

/** Ảnh người dùng dán/chọn, đi từ webview lên host. */
export interface ImageWire {
  /** Tên để hiện trên chip. Chỉ để đọc, không dùng làm đường dẫn. */
  name: string;
  mediaType: ImageMediaType;
  /** Base64 thuần, KHÔNG kèm `data:...;base64,`. */
  data: string;
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

/** Trần đính kèm ảnh, ép ở CẢ hai đầu (webview cắt sớm, host vẫn kiểm lại). */
export const MAX_IMAGES = 4;
/** ~4 MB nhị phân. Ảnh chụp màn hình bình thường nhỏ hơn nhiều. */
export const MAX_IMAGE_BASE64 = 5_600_000;

export interface MentionItem {
  /** Đường dẫn tương đối so với workspace root, dùng `/`. */
  path: string;
  /** Tên file để hiện nổi bật trong danh sách gợi ý. */
  name: string;
}

/**
 * Một pin đang gắn với hội thoại — file hoặc đúng một đoạn dòng, do người dùng
 * chọn từ editor (lệnh "AstraCode: Add to Chat"), KHÔNG do webview tự đọc.
 *
 * Host là nguồn sự thật DUY NHẤT: mỗi lượt host tự đọc lại nội dung (xem
 * `resolvePins`), nên `error`/`truncated` phản ánh đúng lần đọc gần nhất, kể
 * cả khi file bị xoá hay đổi giữa hai lượt.
 */
export interface PinnedItemWire {
  id: string;
  /** Đường dẫn tương đối so với workspace root, dùng `/`. */
  path: string;
  /** Tên file để hiện trên chip. */
  name: string;
  /** Có cả hai = pin một đoạn dòng. Vắng cả hai = pin cả file. */
  startLine?: number;
  endLine?: number;
  /** Không đọc được — denylist chặn, file đã xoá... Hiện cảnh báo trên chip. */
  error?: string;
  /** File dài hơn phần đã đọc (chạm trần 5000 dòng khi pin cả file). */
  truncated?: boolean;
}

/**
 * Gợi ý pin: người dùng vừa bôi đen một đoạn KHÔNG RỖNG trong editor. Khác
 * `PinnedItemWire` — đây chưa phải một pin, chỉ là lựa chọn hiện ra để bấm;
 * không có `id`/`error`/`truncated` vì chưa từng đọc file.
 */
export interface SelectionHintWire {
  /** Đường dẫn tương đối so với workspace root, dùng `/`. */
  path: string;
  /** Tên file để hiện trên gợi ý. */
  name: string;
  startLine: number;
  endLine: number;
}

export type PermissionModeWire = 'plan' | 'ask' | 'acceptEdits';

/** Vì sao một lần nén xảy ra. Quyết định giọng của thông báo, xem `compacting`. */
export type CompactTrigger = 'auto' | 'manual';

/** Hộp duyệt quyền đang chờ người dùng trả lời (M4). */
export interface PermissionPrompt {
  /** Id do host sinh — webview gửi lại đúng id này khi trả lời. */
  id: string;
  tool: string;
  summary: string;
  path?: string;
  /** Diff hoặc lệnh sắp chạy. Webview hiển thị dạng văn bản thuần, KHÔNG markdown. */
  preview?: string;
  /**
   * `preview` là loại gì, do chính tool khai (xem `ToolIntent.previewKind`).
   * Webview tô màu theo cái này thay vì đoán theo hình dạng chuỗi.
   */
  previewKind?: 'diff' | 'command' | 'text';
  mode: PermissionModeWire;
  downgradeReason?: string;
  /** Tool này không được phép nhớ quyết định (bash) — ẩn nút "luôn cho phép". */
  alwaysAsk: boolean;
  /**
   * Điều đáng báo về chính thao tác này: lệnh/script với tay ra ngoài
   * workspace. Có warning nghĩa là hộp duyệt này xuất hiện DÙ chế độ đang là
   * `acceptEdits` hay đã có "luôn cho phép" — xem `PermissionManager.check`.
   */
  warnings?: string[];
}

export interface AskUserOptionWire {
  label: string;
  // `| undefined` rõ ràng vì exactOptionalPropertyTypes: khớp kiểu suy ra từ
  // zod ở core (packages/core/src/tools/askUser.ts) khi chuyển tiếp nguyên
  // văn từ ChatController sang webview.
  description?: string | undefined;
}

export interface AskUserQuestionWire {
  header: string;
  question: string;
  options: AskUserOptionWire[];
  multiSelect?: boolean | undefined;
}

/** Hộp hỏi đang chờ người dùng chọn — chung khuôn với `PermissionPrompt`. */
export interface QuestionPrompt {
  /** Id do host sinh — webview gửi lại đúng id này khi trả lời. */
  id: string;
  questions: AskUserQuestionWire[];
}

export interface QuestionAnswerWire {
  header: string;
  selected: string[];
}

export interface SessionPermissionState {
  mode: PermissionModeWire;
  effectiveMode: PermissionModeWire;
  downgraded: boolean;
  downgradeReason?: string;
}

export interface SandboxState {
  kind: 'docker' | 'host' | 'none';
  label: string;
  isolated: boolean;
}

export interface TodoWire {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** Đồng hồ ngữ cảnh (M6). `level` quyết định UI im lặng hay cảnh báo. */
export interface ContextWire {
  used: number;
  usable: number;
  ratio: number;
  level: 'ok' | 'warn' | 'compact';
  label: string;
}

/** Slash command hiện trong gợi ý khi gõ `/` (M6). */
export interface CommandWire {
  name: string;
  description: string;
  /**
   * `builtin` = của AstraCode; `user` = ~/.astra; `project` = repo (kém tin
   * cậy); `org` = chuẩn của dự án, đến từ AstraWork.
   */
  source: 'builtin' | 'user' | 'project' | 'org';
}

/**
 * Vì sao chat bị khoá. Webview cần phân biệt để phản ứng khác nhau: thiếu đăng
 * nhập thì dựng cửa đăng nhập chắn ngang, còn những lý do khác chỉ cần một
 * dòng cảnh báo — chắn cả panel vì một model chưa chọn xong là thô bạo.
 */
/**
 * `config` tách khỏi `auth` có chủ ý: cả hai đều chắn cả panel, nhưng việc phải
 * làm tiếp thì khác hẳn. `config` = thiếu địa chỉ gateway, và lối ra DUY NHẤT là
 * bảng cài đặt. `auth` = chỉ cần bấm đăng nhập.
 */
export type BlockKind = 'workspace' | 'auth' | 'config' | 'model' | 'capability';

export interface SettingsModelRow {
  id: string;
  label: string;
  available: boolean;
  allowed: boolean;
  online: boolean;
  toolCalling: 'native' | 'xml-fallback' | 'none';
  contextWindow: number;
  injectionResistance: 'high' | 'medium' | 'low' | 'unknown';
  profileSource: 'measured' | 'inferred';
    safeForWrite: boolean;
}

/**
 * Mức dùng của phiên chat đang mở.
 *
 * Cố ý KHÔNG hứa hẹn hạn mức chi tiêu: con số đó nằm ở gateway và AstraCode
 * chưa có endpoint để đọc. Hiện một số tự bịa ra ở đây còn tệ hơn không hiện.
 */
export interface UsageWire {
  turns: number;
  totalTokens: number;
  contextUsed: number;
  contextUsable: number;
  contextRatio: number;
  /**
   * Phân chia `contextUsed` theo nguồn — chỉ có mặt sau lượt chat đầu tiên
   * (trước đó chưa dựng system prompt/registry nào để đo). Tất cả tính bằng
   * token ước lượng, cùng cách với `contextUsed` (xem `context/tokens.ts`).
   */
  contextBreakdown?: ContextBreakdownWire;
}

/** Mục "Context breakdown" của bảng cài đặt — bảy phần cộng lại đúng bằng `contextWindow`. */
export interface ContextBreakdownWire {
  contextWindow: number;
  systemPrompt: number;
  systemTools: number;
  mcpTools: number;
  memory: number;
  skills: number;
  messages: number;
  free: number;
  /**
   * Token GATEWAY báo cache hit ở LƯỢT GẦN NHẤT (không phải lượt hiện tại đang
   * đo) — xem `TokenUsage.cachedTokens`, core/provider/types.ts. Vắng mặt khi
   * gateway chưa từng báo trường này hoặc chưa có lượt nào chạy.
   */
  cachedTokens?: number;
  /**
   * Token cache hit theo cơ chế RIÊNG của AstraCode ở lượt gần nhất — độc lập
   * với `cachedTokens` ở trên. Đo bằng cách so sánh nội dung system prompt/tool
   * registry/memory/skill catalog với lượt ngay trước; đoạn nào giống hệt được
   * tính là cache hit, bất kể gateway có báo `cachedTokens` hay không. Xem
   * `StaticContextCache`, core/context/staticContextCache.ts. Vắng mặt khi
   * chưa có lượt nào chạy.
   */
  astraCachedTokens?: number;
}

/**
 * Ba con số của thẻ "AI 利用状況" trên trang cá nhân AstraWork — 対話数,
 * トークン, コスト.
 *
 * Chúng KHÔNG do AstraCode đếm. Chúng là tổng gateway ghi lại cho tài khoản
 * này (`GET /auth/me/usage`), đúng cái mà trang web vẽ. Đó là toàn bộ điểm của
 * mục Usage: một con số, hai nơi hiển thị, không có bản sao nào để đi lệch.
 */
export interface AccountUsageWire {
  turns: number;
  totalTokens: number;
  /** USD — đơn vị tiền duy nhất của AstraCode, xem core/config/pricing.ts. */
  costUsd: number;
  daysActive: number;
  /** Epoch ms. Không có = tài khoản chưa dùng AI lần nào. */
  lastUsed?: number;
  /** Số lượt theo nơi phát sinh: `astracode` (IDE) và `astrawork` (web). */
  bySource: Record<string, number>;
  /**
   * Hạn mức tiền của kỳ này và phần còn tiêu được, USD. Cả hai VẮNG MẶT khi
   * gateway không báo hạn mức — khác hẳn với 0, là đã tiêu hết. Xem
   * `core/telemetry/accountUsage.ts`.
   */
  budgetUsd?: number;
  remainingUsd?: number;
}

/** Trạng thái của việc đọc số ấy — xem `AccountUsageStore`. */
export interface AccountUsageStateWire {
  /** Đọc được hay không: cần có gateway VÀ đã đăng nhập. */
  available: boolean;
  loading: boolean;
  usage?: AccountUsageWire;
  /** Lần đọc thành công gần nhất, epoch ms. */
  fetchedAt?: number;
  error?: string;
}

/**
 * Việc đẩy số đo lên board Năng suất có đang trót lọt không.
 *
 * Chỉ có mặt để một thứ đang hỏng không hỏng trong im lặng. Từ 0.0.29 việc đẩy
 * không còn công tắc, nên cả tổ chức dựa vào con số này — mà lỗi đẩy thì trước
 * đó chỉ đi vào một dòng `logger.debug`, tức là PM thấy board thiếu số còn dev
 * thì không thấy gì cả.
 *
 * KHÔNG có trường nào để bật/tắt, và đừng thêm: đây là ô báo trạng thái, không
 * phải một lựa chọn trả lại dưới hình dạng khác.
 */
export interface MetricsSyncWire {
  syncing: boolean;
  /** Lần AstraWork nhận được số gần nhất, epoch ms. */
  syncedAt?: number;
  /** Vì sao lần đẩy gần nhất hỏng. Không có = đang bình thường. */
  lastError?: string;
  pendingTurns: number;
}

/**
 * Toàn bộ nội dung bảng cài đặt.
 *
 * Không còn địa chỉ gateway/web ở đây: chúng là hằng số trong code, không phải
 * cấu hình, nên bảng này không có gì để hiện và cũng không có gì để sửa. Cùng
 * lẽ đó `problems` cũng đi — nó chỉ chứa lỗi gõ địa chỉ.
 */
export interface SettingsWire {
  sourceLabel: string;
  authenticated: boolean;
  username?: string;
  role?: string;
  /** Epoch ms. Không có refresh token nên hạn này là hạn thật của phiên. */
  expiresAt?: number;
  models: SettingsModelRow[];
  /**
   * Model người dùng đang chọn cho việc sửa code. Rỗng = để AstraCode tự chọn.
   */
  selected: string;
  /** Model thật sự đang dùng sau khi giải quyết routing. */
  active?: string;
  /** Model đang chọn cho việc đọc ảnh và lập kế hoạch. */
  selectedPlan: string;
  /** Model thật sự dùng cho hai việc đó, sau routing. */
  activePlan?: string;
    missingProfiles: number;
  lastError?: string;
  usage: UsageWire;
  /** Số của tài khoản, lấy từ AstraWork. Nội dung của mục "Usage". */
  account: AccountUsageStateWire;
  /** Đường đẩy số đo có đang trót lọt không. Xem `MetricsSyncWire`. */
  metricsSync: MetricsSyncWire;
  /** Bộ agent chung của dự án. Xem `ProjectAgentsWire`. */
  projectAgents: ProjectAgentsWire;
}

/**
 * Chuẩn agent của dự án, rút gọn cho bảng cài đặt.
 *
 * Chỉ TÊN, không có thân prompt: bảng này vẽ lại sau mỗi thay đổi nhỏ, và đẩy
 * vài chục nghìn ký tự prompt qua cầu mỗi lần vẽ là trả giá cho một thứ chỉ
 * xem tới khi có người bấm vào. Muốn xem đầy đủ thì lệnh
 * `astra.showProjectAgents` mở ra một trang riêng.
 */
export interface ProjectAgentsWire {
  /** Mục `kind: "agent"` — giao cho agent con, chỉ đọc. */
  names: string[];
  /** Mục `kind: "skill"` — agent chính tự thi hành, sửa được file. */
  skillNames: string[];
  version: number;
  updatedBy?: string;
  /** ISO. Webview tự cắt lấy phần ngày. */
  updatedAt?: string;
  /** `stub` chỉ có trên máy đang thử nghiệm — phải nói rõ, xem session.ts. */
  source: 'gateway' | 'stub' | 'none';
  /** Đang dùng bản cache vì lần gọi gần nhất không tới được gateway. */
  stale: boolean;
}


export interface SessionWire {
  id: string;
  title: string;
  updatedAt: number;
  turns: number;
  totalTokens: number;
  /** Phiên đang mở. */
  active: boolean;
}

/**
 * Dự án + task đang khai, cho thanh chọn phía trên ô nhập.
 *
 * Task đã rút gọn thành `{id, label}`: webview chỉ vẽ một danh sách chọn, và
 * mọi trường khác của một task WBS (assignee, tiến độ, mô tả) là dữ liệu của dự
 * án người khác — không có lý do gì để nó đi vào một webview.
 */
export interface WorkWire {
  projects: { id: number; name: string }[];
  /**
   * Lịch kế hoạch đi kèm từng task, `YYYY-MM-DD` hoặc rỗng.
   *
   * Ngoại lệ có chủ ý với câu "chỉ `{id, label}`" ở trên: dòng lịch dưới ô chọn
   * phải đổi NGAY khi người dùng đổi task, và đi hỏi host cho mỗi lần đổi là
   * một khoảng trắng nhấp nháy ở đúng chỗ mắt đang nhìn. Hai chuỗi 10 ký tự cho
   * mỗi task là cái giá rẻ hơn nhiều so với một vòng gọi qua cầu.
   */
  tasks: { id: number; label: string; planStart: string; planEnd: string }[];
  projectId?: number;
  taskId?: number;
  /** Nhãn task đang khai, dùng khi danh sách chưa về kịp. */
  taskLabel?: string;
  /**
   * Task đang mở của người này nhưng ở công đoạn khác `coding` — chỉ một CON
   * SỐ, không phải danh sách: nó chỉ để giải thích vì sao ô chọn rỗng.
   */
  otherStages?: number;
  loading?: boolean;
  error?: string;
}

/**
 * Nội dung hộp "Report Done" — xem `AstraSession.taskReport`.
 *
 * Đi qua cầu MỘT lần khi hộp mở ra, rồi webview tự giữ: mọi ô đều sửa được,
 * nên đẩy state mới xuống giữa chừng sẽ xoá mất con số người dùng đang gõ dở.
 */
export interface TaskReportWire {
  taskId: number;
  label: string;
  planStart: string;
  planEnd: string;
  actualStart: string;
  actualEnd: string;
  tokens: number;
  costUsd: number;
  /** Đọc số đo hỏng: hai số trên là 0 vì KHÔNG BIẾT, không phải vì bằng 0. */
  usageError?: string;
}

/** Extension host -> webview */
export type ChatHostPayload =
  | {
      type: 'ready';
      model?: ChatModelInfo;
      /**
       * Danh sách cho bảng chọn model ở thanh soạn.
       *
       * Đi cùng `ready` chứ không phải một payload riêng: nó đổi đúng vào những
       * lúc `ready` đổi (đăng nhập, đổi dự án, gateway trả danh sách mới), và
       * hai payload rời nhau sẽ có lúc lệch — bảng chọn hiện một model mà dòng
       * trạng thái nói model khác.
       */
      models?: ChatModelOption[];
      /** Model cấu hình máy sẽ dùng khi người dùng không chọn gì. */
      modelDefault?: string;
      /**
       * Model người dùng đã chọn ở thanh soạn cho PHIÊN này. Vắng mặt = đang
       * theo `modelDefault`.
       */
      modelOverride?: string;
      canChat: boolean;
      blockReason?: string;
      blockKind?: BlockKind;
      permissions?: SessionPermissionState;
      sandbox?: SandboxState;
    }
  /** `open` = mở luôn lớp phủ. Không có nó thì chỉ cập nhật dữ liệu tại chỗ. */
  | { type: 'settings'; state: SettingsWire; open?: boolean }
  | { type: 'settingsBusy'; busy: boolean; label?: string }
  | { type: 'work'; state: WorkWire }
  /**
   * Trả lời cho `openTaskReport`. `state` có = mở hộp; `error` có = không mở
   * được và đây là lý do (hộp rỗng với một dòng lỗi vô dụng hơn một notice).
   */
  | { type: 'taskReport'; state?: TaskReportWire; error?: string }
  /** Đã gửi xong. `datesRejected` = gateway giữ ngày của nó, xem WorkItems.ts. */
  | { type: 'taskReported'; taskId: number; datesRejected: boolean; actualStart: string; actualEnd: string }
  /** Lần gửi hỏng — hộp ở lại để người dùng thử lại mà không gõ lại từ đầu. */
  | { type: 'taskReportFailed'; error: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'permission_request'; turnId: string; prompt: PermissionPrompt }
  | { type: 'permission_resolved'; id: string; decision: 'allow_once' | 'allow_always' | 'deny' }
  | { type: 'permission_state'; state: SessionPermissionState }
  | { type: 'question_request'; turnId: string; prompt: QuestionPrompt }
  | {
      type: 'question_resolved';
      id: string;
      cancelled: boolean;
      answers?: QuestionAnswerWire[];
    }
  | { type: 'todos'; items: TodoWire[] }
  | { type: 'changes'; pending: number; summary: string }
  | {
      type: 'turn_start';
      turnId: string;
      prompt: string;
      /** Số ảnh đã đính kèm. Ảnh không quay ngược về webview — nó tự giữ bản gốc. */
      images: number;
      /**
       * Pin đi kèm ĐÚNG lượt này — một-lần-mỗi-lượt như ảnh, nên gửi ngược lại
       * đây (khác ảnh) để vẽ vào bong bóng: metadata pin nhỏ và không nhạy như
       * ảnh, mọi webview đang mở đều nhận được y hệt qua `pins`, không cần
       * webview tự giữ bản gốc.
       */
      pins: PinnedItemWire[];
    }
  /**
   * Đã gửi request lên model, chưa có token nào về. UI dùng để hiện "đang suy
   * nghĩ" — khoảng lặng này dài nhất trong cả lượt, và không có gì lấp vào thì
   * người dùng tưởng extension treo.
   */
  | { type: 'thinking'; turnId: string; iteration: number }
  | { type: 'text'; turnId: string; delta: string }
  | { type: 'tool_start'; turnId: string; callId: string; name: string; args: unknown }
  /** Output của tool còn đang chạy (bash). Chỉ để hiện dần, không vào history. */
  | { type: 'tool_output'; turnId: string; callId: string; delta: string }
  | {
      type: 'tool_end';
      turnId: string;
      callId: string;
      name: string;
      isError: boolean;
      /** Một dòng "làm được gì", dựng từ meta của tool. */
      summary: string;
      durationMs: number;
      preview: string;
      /** Loại preview — 'diff' thì UI render split diff (trái=cũ, phải=mới). */
      previewKind?: 'diff' | 'command' | 'text';
    }
  | {
      type: 'injection_warning';
      turnId: string;
      toolName: string;
      score: number;
      signals: string[];
      excerpt: string;
    }
  /** Ghi chú trung tính trong dòng chat (không phải lỗi, không phải câu trả lời). */
  | { type: 'note'; turnId?: string; text: string }
  | { type: 'repair'; turnId: string; reason: string }
  | { type: 'tool_call_dropped'; turnId: string; reason: string }
  | { type: 'permission_denied'; turnId: string; toolName: string; reason: string }
  | { type: 'permission_downgraded'; turnId: string; toolName: string; reason: string }
  | {
      type: 'turn_end';
      turnId: string;
      stoppedBy: TurnEndReason;
      toolCalls: number;
      iterations: number;
      totalTokens: number;
      /**
       * Subset của `totalTokens` được nhà cung cấp tính giá rẻ hơn nhờ cache
       * prompt (xem `TokenUsage.cachedTokens`, core/provider/types.ts).
       * `undefined` = gateway/model không báo trường này cho lượt này.
       */
      cachedTokens?: number;
      durationMs: number;
    }
  /**
   * `hintAction` nói nút của `hint` phải làm gì khi bấm — mặc định (thiếu
   * trường này) là mở bảng cài đặt. `'signIn'` nghĩa là bấm phải mở luôn
   * trình duyệt đăng nhập, KHÔNG dừng ở bảng cài đặt: nhãn nút đọc là "Sign in
   * to AstraWork" nên hành vi phải khớp đúng chữ đó, không phải một bước mở
   * bảng rồi bắt người dùng tự tìm nút "Sign in" thật bên trong.
   */
  | { type: 'error'; turnId?: string; message: string; hint?: string; hintAction?: 'signIn' }
  | { type: 'mentions'; query: string; items: MentionItem[] }
  /** Kết quả của `pickAttachment` khi file chọn là ảnh. Huỷ thì không gửi gì. */
  | { type: 'imagePicked'; image: ImageWire }
  /**
   * File chọn KHÔNG phải ảnh.
   *
   * Không đọc nội dung lên đây: một file 20 MB nhét vào prompt là đốt cả cửa sổ
   * ngữ cảnh cho thứ agent có thể tự đọc. Webview chèn `@đường/dẫn` vào ô nhập
   * và để agent gọi `read_file` khi thật sự cần — cùng đường với `@mention`.
   */
  | { type: 'filePicked'; path: string; name: string }
  // ── M6 ──────────────────────────────────────────────────────────────────
  | { type: 'context'; usage: ContextWire }
  /**
   * Nén BẮT ĐẦU. Phải có sự kiện riêng cho lúc bắt đầu chứ không chỉ lúc xong:
   * nén là một lượt gọi model đầy đủ, xảy ra TRƯỚC khi lượt của người dùng
   * chạy, nên nếu chỉ báo lúc xong thì khoảng thời gian đó panel đứng im sau
   * khi họ bấm gửi — trông y hệt như treo.
   */
  | {
      type: 'compacting';
      turnId?: string;
      /** `auto` = chạm ngưỡng ngữ cảnh. `manual` = người dùng gõ `/compact`. */
      trigger: CompactTrigger;
      tokensBefore: number;
      /**
       * Chỉ dẫn người dùng gõ sau `/compact`. Hiện lại nguyên văn: không có nó
       * thì họ không có cách nào biết chỉ dẫn vừa gõ có tới nơi hay bị nuốt.
       */
      focus?: string;
    }
  | {
      type: 'compacted';
      turnId?: string;
      trigger: CompactTrigger;
      droppedMessages: number;
      tokensBefore: number;
      tokensAfter: number;
      /** Phải dùng bản rút gọn cơ học thay cho bản tóm tắt của model. */
      degraded: boolean;
      /** Vì sao phải rút gọn cơ học. `null` khi bản của model dùng được. */
      degradedReason: 'model_failed' | 'injection' | null;
    }
  /**
   * Nén không thành. Hội thoại giữ nguyên nên lượt vẫn chạy tiếp được, nhưng
   * người dùng cần biết: ngữ cảnh vẫn sát trần, và lượt sau có thể vỡ.
   */
  | { type: 'compact_failed'; turnId?: string; trigger: CompactTrigger; reason: string }
  /** Không có gì để nén — chỉ nói khi người dùng tự gõ `/compact` và chờ phản hồi. */
  | { type: 'compact_skipped'; reason: string }
  | { type: 'commands'; items: CommandWire[] }
  /**
   * `open` = mở bảng hội thoại cũ. Không có nó thì chỉ làm mới dữ liệu.
   *
   * Phân biệt này không phải tuỳ chọn cho đẹp: `resumeSession` gửi lại danh
   * sách ở cuối để cập nhật dấu "đang mở", và nếu payload đó cũng mở bảng thì
   * bảng bật lại ngay sau khi vừa đóng để nhường chỗ cho hội thoại được chọn.
   */
  | { type: 'sessions'; items: SessionWire[]; open?: boolean }
  /**
   * Prompt đã gõ trước đây, cũ nhất trước — cho mũi tên lên trong ô nhập.
   *
   * Đọc từ `~/.astra/history.jsonl`, dùng chung với CLI: câu gõ trong terminal
   * tuần trước tìm lại được ở đây, và ngược lại.
   */
  | { type: 'promptHistory'; items: string[] }
  /** Đã nạp lại một phiên cũ — webview vẽ lại từ đầu. */
  | { type: 'restored'; title: string; messages: RestoredMessage[] }
  | {
      type: 'memory';
      files: Array<{ path: string; source: 'user' | 'project'; flagged: boolean }>;
    }
  | { type: 'undone'; turnId: string; files: number; skipped: number }
  | { type: 'cleared' }
  /** Toàn bộ danh sách pin hiện tại — gửi lại mỗi khi thêm/bỏ/đổi trạng thái. */
  | { type: 'pins'; items: PinnedItemWire[] }
  /**
   * Gợi ý pin ngay trong panel chat khi người dùng bôi đen code trong editor —
   * thay cho việc phải mở menu chuột phải "AstraCode: Add to Chat". `ref: null`
   * = không còn gì để gợi ý (bỏ chọn, đổi tab sang chỗ không có selection).
   */
  | { type: 'selectionHint'; ref: SelectionHintWire | null };

/**
 * Một lần gọi tool trong phiên cũ, đã tóm tắt.
 *
 * Cả `input` lẫn `output` đều là văn bản đã cắt ngắn ở host: chúng do model và
 * tool sinh ra, và mục đích ở đây là NHẬN RA mạch việc chứ không phải đọc lại
 * nội dung. Ai cần nội dung thật thì mở file, không đọc trong lịch sử chat.
 */
export interface RestoredToolWire {
  name: string;
  /** Tham số nhận diện: đường dẫn, mẫu tìm, lệnh. Rỗng nếu không rút ra được. */
  input: string;
  /** Kết quả một dòng: số dòng, dòng đầu, hoặc lỗi. Rỗng nếu không có. */
  output: string;
  /**
   * Lần gọi đó hỏng. CHỈ có khi phiên lưu được trạng thái ấy (v2 trở đi) —
   * `undefined` nghĩa là *không biết*, không phải *đã thành công*. Webview vẽ
   * chấm xám cho trường hợp không biết thay vì chấm xanh.
   */
  isError?: boolean;
  /**
   * `ToolCall.id` để ghép kết quả với lời gọi. Chỉ đường native có; đường XML
   * không mang id nào xuống lịch sử nên ở đó vẫn ghép theo thứ tự.
   */
  callId?: string;
}

/**
 * Message vẽ lại khi mở phiên cũ, đã rút gọn ở host.
 *
 * `tool` thay cho nguyên văn lời gọi XML và kết quả của chúng. Không có nhánh
 * nào đi qua markdown ở webview: một hội thoại cũ không nên vẽ được gì lên UI
 * hiện tại — trừ văn xuôi của assistant, vốn đã đi qua DOMPurify.
 */
export type RestoredMessage =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'tool'; tools: RestoredToolWire[] };

export type ChatHostMessage = ChatHostPayload & { protocolVersion: number };

/** Webview -> extension host */
export type ChatWebviewPayload =
  | { type: 'ready' }
  | { type: 'send'; text: string; images?: ImageWire[] }
  /**
   * Mở hộp chọn file của VS Code — webview không tự đọc được đĩa.
   *
   * Nhận MỌI loại file, không riêng ảnh: ảnh đi thẳng vào prompt dưới dạng
   * base64, còn thứ khác quay về thành `@đường/dẫn` để agent tự đọc.
   */
  | { type: 'pickAttachment' }
  | { type: 'stop' }
  | { type: 'clear' }
  | { type: 'mentionQuery'; query: string }
  | { type: 'openFile'; path: string }
  // ── Cài đặt: gộp vào đây từ v5, khi webview cài đặt riêng bị bỏ ──────────
  /** Xin nội dung bảng cài đặt. Host trả lời bằng payload `settings`. */
  | { type: 'openSettings' }
  | { type: 'setModel'; value: string }
  /** Model cho việc đọc ảnh và lập kế hoạch. */
  | { type: 'setPlanModel'; value: string }
  /**
   * Đổi model cho PHIÊN chat đang mở, từ bảng chọn ở thanh soạn.
   *
   * Cố ý KHÔNG ghi vào settings — đó là điểm khác biệt với `setModel`. `id:
   * null` = thôi chọn, quay về cấu hình của máy. Xem `chat/modelChoice.ts`.
   */
  | { type: 'setSessionModel'; id: string | null }
  // ── Dự án / task đang làm ────────────────────────────────────────────────
  /** Đổi dự án. Host xin token mới từ gateway — xem `AstraSession.switchProject`. */
  | { type: 'setProject'; id: number }
  /** Khai task đang làm. `id: null` = thôi khai. */
  | { type: 'setTask'; id: number | null }
  /** Đọc lại hai danh sách. */
  | { type: 'refreshWork' }
  /** Mở hộp "Report Done": host đi đọc lịch và số đo của task này. */
  | { type: 'openTaskReport'; taskId: number }
  /**
   * Gửi báo cáo done lên WBS.
   *
   * Mọi giá trị ở đây là thứ NGƯỜI DÙNG vừa gõ, kể cả khi nó bắt đầu từ số của
   * gateway — nên nó được kiểm như mọi đầu vào khác trong `parseChatMessage`.
   */
  | {
      type: 'reportTaskDone';
      taskId: number;
      planStart: string;
      planEnd: string;
      actualStart: string;
      actualEnd: string;
      tokens: number;
      costUsd: number;
    }
    | { type: 'signIn' }
    | { type: 'signOut' }
    | { type: 'refreshModels' }
    /**
     * Đọc lại số của tài khoản từ AstraWork ngay, không chờ hết hạn cache; và
     * đẩy nốt phần số đo còn tồn đọng của board Năng suất.
     */
    | { type: 'syncUsage' }
    | { type: 'testConnection' }
    | { type: 'showLogs' }
    /** Mở trang xem nội dung bộ agent chung của dự án. */
    | { type: 'showProjectAgents' }
    | { type: 'permissionAnswer'; id: string; decision: 'allow_once' | 'allow_always' | 'deny' }
    /** Câu trả lời cho ask_user_question. `selections[i]` = nhãn đã chọn cho `questions[i]`. */
    | { type: 'questionAnswer'; id: string; selections: string[][] }
    | { type: 'setMode'; mode: PermissionModeWire }
    | { type: 'showChanges' }
    // ── M6 ──────────────────────────────────────────────────────────────────
    | { type: 'listSessions' }
    | { type: 'resumeSession'; id: string }
    /** Bỏ một pin — webview chỉ gửi id, host tự biết đang có gì. */
    | { type: 'pinRemove'; id: string }
    /**
     * Người dùng bấm "Pin" trên gợi ý selection. Không kèm dữ liệu — host là
     * nguồn sự thật duy nhất, tự biết selection nào đang được gợi ý (xem
     * `selectionHint` ở `ChatHostPayload`), giống hệt lý do `pinRemove` chỉ
     * gửi id thay vì cả nội dung.
     */
    | { type: 'pinSelectionHint' };

export type ChatWebviewMessage = ChatWebviewPayload & { protocolVersion: number };

const MAX_TEXT = 32_000;
const MAX_PATH = 2048;
/** Trần cho URL và id model đến từ ô nhập của bảng cài đặt. */
const MAX_SETTING = 2048;
/** Ba trần cho câu trả lời ask_user_question — khớp trần của schema tool ở core. */
const MAX_QUESTIONS = 4;
const MAX_OPTIONS_PER_QUESTION = 4;
const MAX_OPTION_LABEL = 200;

/** Base64 chuẩn, cho phép padding. Không nhận whitespace hay ký tự URL-safe. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Trần cho hai con số trong hộp "Report Done".
 *
 * Không phải để chống tràn: chúng đi vào một dòng chữ trên WBS, không vào phép
 * tính nào. Chúng ở đây để một ô gõ nhầm (dán cả một số điện thoại vào ô token)
 * bị chặn ở cầu thay vì trở thành một dòng vô nghĩa mà cả dự án đọc thấy. Mười
 * tỷ token và một trăm nghìn đô đều xa hơn nhiều so với một task thật.
 */
const MAX_REPORT_TOKENS = 10_000_000_000;
const MAX_REPORT_COST = 100_000;

/** `YYYY-MM-DD` hoặc rỗng — cùng khuôn với `WbsTaskUpdate` ở gateway. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Ô ngày từ webview. `undefined` = không dùng được, phía gọi bỏ cả message.
 *
 * Rỗng là HỢP LỆ và có nghĩa riêng ("chưa đặt lịch"), khác hẳn với rác — nên
 * nó phải đi qua, không bị gộp vào nhánh lỗi.
 */
function isoDate(raw: unknown): string | undefined {
  if (raw === '' || raw === undefined || raw === null) return '';
  return typeof raw === 'string' && ISO_DATE.test(raw) ? raw : undefined;
}

/** Id task từ webview: số nguyên dương thật, không nhận chuỗi số. */
function taskId(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

/** Số không âm, hữu hạn, dưới trần. Dùng cho hai ô token/chi phí. */
function count(raw: unknown, max: number): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= max
    ? raw
    : undefined;
}

/**
 * Ảnh từ webview: dữ liệu nhị phân đi thẳng lên model, nên kiểm từng trường.
 *
 * Trả về `undefined` = message hỏng, bỏ cả message (không phải "bỏ ảnh xấu, giữ
 * phần còn lại"): gửi đi thiếu ảnh mà người dùng tưởng đã gửi là im lặng sai.
 */
function parseImages(raw: unknown): ImageWire[] | undefined {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) return undefined;

  const out: ImageWire[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const img = entry as Record<string, unknown>;

    if (typeof img.name !== 'string' || img.name.length > 200) return undefined;
    if (!IMAGE_MEDIA_TYPES.includes(img.mediaType as ImageMediaType)) return undefined;
    if (typeof img.data !== 'string' || img.data.length === 0) return undefined;
    if (img.data.length > MAX_IMAGE_BASE64) return undefined;
    if (!BASE64.test(img.data)) return undefined;

    out.push({
      // Tên chỉ để hiện lại trên chip — cắt phần thư mục để không lộ đường dẫn máy.
      name: img.name.split(/[\\/]/).pop() ?? 'image',
      mediaType: img.mediaType as ImageMediaType,
      data: img.data,
    });
  }
  return out;
}

/**
 * Validate message từ webview — ranh giới tin cậy y như màn hình cài đặt
 * (documents/SECURITY.md §6.6). Dựng object MỚI, không lan truyền trường thừa.
 */
export function parseChatMessage(raw: unknown): ChatWebviewMessage | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const m = raw as Record<string, unknown>;
  if (m.protocolVersion !== CHAT_PROTOCOL_VERSION) return undefined;
  if (typeof m.type !== 'string') return undefined;

  const v = CHAT_PROTOCOL_VERSION;

  const str = (x: unknown): x is string => typeof x === 'string' && x.length <= MAX_SETTING;

  switch (m.type) {
    case 'ready':
    case 'stop':
    case 'clear':
    case 'openSettings':
    case 'signIn':
    case 'signOut':
    case 'refreshModels':
    case 'syncUsage':
    case 'testConnection':
        case 'showLogs':
        case 'showProjectAgents':
        case 'refreshWork':
          return { protocolVersion: v, type: m.type };

    case 'setModel':
          return str(m.value) ? { protocolVersion: v, type: 'setModel', value: m.value } : undefined;

    case 'setSessionModel':
      // `null` là giá trị HỢP LỆ ở đây, không phải thiếu trường: nó nghĩa là
      // "thôi chọn, quay về cấu hình của máy".
      if (m.id === null) return { protocolVersion: v, type: 'setSessionModel', id: null };
      return str(m.id) ? { protocolVersion: v, type: 'setSessionModel', id: m.id } : undefined;

    case 'setPlanModel':
      return str(m.value)
        ? { protocolVersion: v, type: 'setPlanModel', value: m.value }
        : undefined;

    // Id dự án/task đi thẳng vào một URL và vào thuộc tính telemetry, nên phải
    // là SỐ NGUYÊN DƯƠNG thật — không nhận chuỗi số, không nhận số âm.
    case 'setProject':
      return typeof m.id === 'number' && Number.isInteger(m.id) && m.id > 0
        ? { protocolVersion: v, type: 'setProject', id: m.id }
        : undefined;

    case 'setTask':
      if (m.id === null) return { protocolVersion: v, type: 'setTask', id: null };
      return typeof m.id === 'number' && Number.isInteger(m.id) && m.id > 0
        ? { protocolVersion: v, type: 'setTask', id: m.id }
        : undefined;

    case 'openTaskReport': {
      const id = taskId(m.taskId);
      return id === undefined
        ? undefined
        : { protocolVersion: v, type: 'openTaskReport', taskId: id };
    }

    /**
     * Báo done. Đây là message DUY NHẤT từ webview dẫn tới một lần GHI lên WBS
     * của cả dự án, nên nó là chỗ chặt nhất: id phải là số nguyên dương, bốn ô
     * ngày phải đúng `YYYY-MM-DD` hoặc rỗng (khuôn của `WbsTaskUpdate`), và hai
     * con số phải hữu hạn, không âm. Sai một ô là bỏ CẢ message thay vì sửa
     * giúp — một ngày bị "sửa giúp" thành ngày khác là thứ không ai tra ra được
     * khi nó lên bảng.
     */
    case 'reportTaskDone': {
      const id = taskId(m.taskId);
      if (id === undefined) return undefined;
      const planStart = isoDate(m.planStart);
      const planEnd = isoDate(m.planEnd);
      const actualStart = isoDate(m.actualStart);
      const actualEnd = isoDate(m.actualEnd);
      if ([planStart, planEnd, actualStart, actualEnd].some((d) => d === undefined)) {
        return undefined;
      }
      const tokens = count(m.tokens, MAX_REPORT_TOKENS);
      const costUsd = count(m.costUsd, MAX_REPORT_COST);
      if (tokens === undefined || costUsd === undefined) return undefined;

      return {
        protocolVersion: v,
        type: 'reportTaskDone',
        taskId: id,
        planStart: planStart!,
        planEnd: planEnd!,
        actualStart: actualStart!,
        actualEnd: actualEnd!,
        tokens,
        costUsd,
      };
    }

        case 'send': {
      if (typeof m.text !== 'string' || m.text.length > MAX_TEXT) return undefined;

      const images = parseImages(m.images);
      if (images === undefined) return undefined;
      // Rỗng cả chữ lẫn ảnh thì không có gì để hỏi.
      if (m.text.length === 0 && images.length === 0) return undefined;

      return {
        protocolVersion: v,
        type: 'send',
        text: m.text,
        ...(images.length ? { images } : {}),
      };
    }

    case 'pickAttachment':
      return { protocolVersion: v, type: 'pickAttachment' };

    case 'mentionQuery':
      return typeof m.query === 'string' && m.query.length <= 256
        ? { protocolVersion: v, type: 'mentionQuery', query: m.query }
        : undefined;

    case 'openFile':
      return typeof m.path === 'string' && m.path.length > 0 && m.path.length <= MAX_PATH
        ? { protocolVersion: v, type: 'openFile', path: m.path }
        : undefined;

    case 'showChanges':
    case 'listSessions':
    case 'pinSelectionHint':
      return { protocolVersion: v, type: m.type };

    case 'resumeSession':
      return typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 64
        ? { protocolVersion: v, type: 'resumeSession', id: m.id }
        : undefined;

    case 'pinRemove':
      return typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 64
        ? { protocolVersion: v, type: 'pinRemove', id: m.id }
        : undefined;

    // Câu trả lời cho hộp duyệt quyền. Cả `id` lẫn `decision` đều phải nằm
    // trong tập giá trị biết trước — đây là thứ quyết định agent có được ghi
    // file hay không, nên không nhận bất cứ gì ngoài ba lựa chọn đã định.
    case 'permissionAnswer':
      return typeof m.id === 'string' &&
        m.id.length > 0 &&
        m.id.length <= 64 &&
        (m.decision === 'allow_once' || m.decision === 'allow_always' || m.decision === 'deny')
        ? { protocolVersion: v, type: 'permissionAnswer', id: m.id, decision: m.decision }
        : undefined;

    case 'setMode':
      return m.mode === 'plan' || m.mode === 'ask' || m.mode === 'acceptEdits'
        ? { protocolVersion: v, type: 'setMode', mode: m.mode }
        : undefined;

    // Câu trả lời cho ask_user_question. Chỉ kiểm HÌNH DẠNG ở đây (mảng lồng
    // mảng chuỗi, có trần); đối chiếu nhãn có khớp câu hỏi thật hay không là
    // việc của ChatController.answerQuestion, nơi còn giữ câu hỏi gốc.
    case 'questionAnswer': {
      if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > 64) return undefined;
      if (
        !Array.isArray(m.selections) ||
        m.selections.length === 0 ||
        m.selections.length > MAX_QUESTIONS
      ) {
        return undefined;
      }
      const selections: string[][] = [];
      for (const entry of m.selections) {
        if (!Array.isArray(entry) || entry.length > MAX_OPTIONS_PER_QUESTION) return undefined;
        const labels: string[] = [];
        for (const label of entry) {
          if (typeof label !== 'string' || label.length === 0 || label.length > MAX_OPTION_LABEL) {
            return undefined;
          }
          labels.push(label);
        }
        selections.push(labels);
      }
      return { protocolVersion: v, type: 'questionAnswer', id: m.id, selections };
    }

    default:
      return undefined;
  }
}
