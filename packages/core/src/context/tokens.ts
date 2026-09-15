/**
 * Đếm token và ngân sách context — mốc M6.
 *
 * Ước lượng bằng ký tự chứ không tokenize thật. Ba lý do, theo thứ tự quan
 * trọng:
 *
 *   1. Không biết tokenizer nào đúng. Mỗi model FPT dùng một bộ khác nhau, và
 *      gateway không nói ra. Một con số chính xác cho model sai còn tệ hơn một
 *      con số xấp xỉ đúng cho mọi model.
 *   2. Con số này chỉ dùng để QUYẾT ĐỊNH KHI NÀO NÉN, không dùng để tính tiền.
 *      Nén sớm một chút thì mất vài trăm token; nén muộn thì hỏng cả lượt.
 *   3. Tokenizer thật kéo theo vài MB WASM vào extension.
 *
 * Hệ số được chọn thận trọng — thà ước lượng CAO hơn thực tế. Ước thấp là
 * loại sai duy nhất gây hậu quả thật: tưởng còn chỗ, gửi đi, model từ chối cả
 * lượt.
 */
import type { ChatMessage } from '../provider/types.js';

/**
 * Ký tự trên một token.
 *
 * Tiếng Anh và code khoảng 3.5–4. Tiếng Việt có dấu tốn hơn nhiều (mỗi ký tự
 * có dấu thường là 2–3 byte UTF-8 và hay bị tách riêng), nên lấy 3 cho phần
 * ngoài ASCII. Hội thoại của AstraCode luôn lẫn cả hai.
 */
const ASCII_CHARS_PER_TOKEN = 3.8;
const NON_ASCII_CHARS_PER_TOKEN = 1.8;

/** Overhead mỗi message: role, delimiter, khung JSON của API. */
const PER_MESSAGE_OVERHEAD = 4;

/**
 * Chi phí một ảnh đính kèm.
 *
 * Token của ảnh phụ thuộc kích thước pixel chứ không phụ thuộc số byte base64,
 * mà ở tầng này không có kích thước pixel. Lấy một hằng số cao — một ảnh chụp
 * màn hình full-HD ở các model phổ biến rơi vào 1.1k–1.6k token — vì lý do #3 ở
 * đầu file: ước thấp mới là loại sai gây hỏng lượt.
 */
const PER_IMAGE_TOKENS = 1_600;

export function estimateTokens(text: string): number {
  if (!text) return 0;

  let ascii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
  }
  const other = text.length - ascii;

  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN + other / NON_ASCII_CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: ChatMessage): number {
  let total = PER_MESSAGE_OVERHEAD;

  if (message.role === 'assistant') {
    total += estimateTokens(message.content ?? '');
    for (const call of message.toolCalls ?? []) {
      // Tên + JSON đối số + khung của một tool call.
      total += estimateTokens(call.name) + estimateTokens(call.arguments) + 8;
    }
    return total;
  }

  if (message.role === 'user' && message.images?.length) {
    total += message.images.length * PER_IMAGE_TOKENS;
  }

  return total + estimateTokens(message.content);
}

export function estimateConversationTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

export interface ContextBudgetOptions {
  /** Cửa sổ context của model. 0 hoặc không biết = coi như 32k. */
  contextWindow: number;
  /**
   * Trần TUYỆT ĐỐI để dành cho câu trả lời + tool result của vòng tiếp theo.
   *
   * Đây KHÔNG phải điểm nén — nó chỉ là lưới an toàn cho model cửa sổ nhỏ, nơi
   * 20% cửa sổ (phần để dành ngầm định của `compactAt`, xem dưới) không đủ cho
   * một kết quả tool bị cắt (`maxToolResultChars`). Model cửa sổ lớn không bao
   * giờ chạm trần này — xem `compactThreshold()`.
   */
  reserveForOutput?: number;
  /**
   * Ngưỡng cảnh báo, theo tỉ lệ CỬA SỔ THẬT của model. Mặc định 0.7.
   *
   * Luôn đứng trước `compactAt` theo cùng một tỉ lệ, kể cả khi trần
   * `reserveForOutput` kéo điểm nén xuống dưới ngưỡng này ở model cửa sổ nhỏ
   * — xem `compactThreshold()`.
   */
  warnAt?: number;
  /**
   * Ngưỡng tự nén, theo tỉ lệ CỬA SỔ THẬT của model — KHÔNG theo `usable`.
   * Mặc định 0.8: nén ở khoảng 80% cửa sổ cho MỌI model có cửa sổ đủ lớn (từ
   * ~13k token trở lên), không phụ thuộc việc model đó cụ thể là 8k hay 200k.
   *
   * Trước đây ngưỡng này tính trên `usable` (đã trừ 1/4 cửa sổ), nên điểm nén
   * thật sự rơi vào ~64% cửa sổ — sớm hơn nhiều so với con số 85% mà tên biến
   * gợi ý, và người dùng phải đợi cả một lượt dài chạy hết mới thấy nén chạy dù
   * ngữ cảnh còn xa mới đầy.
   */
  compactAt?: number;
}

export interface ContextUsage {
  used: number;
  /**
   * Sức chứa còn CHẮC CHẮN AN TOÀN = contextWindow − reserveForOutput.
   *
   * Chỉ dùng làm lưới an toàn nội bộ (xem `compactThreshold()`) — hiển thị ra
   * UI thì dùng `contextWindow`, vì đó là con số khớp với `ratio`.
   */
  usable: number;
  contextWindow: number;
  /** Tỉ lệ đã dùng trên CỬA SỔ THẬT, 0–1+ (vượt 1 nghĩa là đã tràn). */
  ratio: number;
  level: 'ok' | 'warn' | 'compact';
}

const DEFAULT_WINDOW = 32_000;

export class ContextBudget {
  private readonly contextWindow: number;
  private readonly reserve: number;
  private readonly warnAt: number;
  private readonly compactAt: number;

  constructor(opts: ContextBudgetOptions) {
    this.contextWindow = opts.contextWindow > 0 ? opts.contextWindow : DEFAULT_WINDOW;
    // Mặc định để dành 15% cửa sổ, tối thiểu 2k. Với model cửa sổ lớn (từ
    // ~13k token) con số này LUÔN nhỏ hơn phần compactAt để dành (20%), nên nó
    // không bao giờ là ràng buộc quyết định — compactAt mới là cái quyết định
    // điểm nén. Nó chỉ ra tay ở model cửa sổ nhỏ hơn ~13k, xem
    // `compactThreshold()`.
    this.reserve = opts.reserveForOutput ?? Math.max(2000, Math.floor(this.contextWindow * 0.15));
    this.warnAt = opts.warnAt ?? 0.7;
    this.compactAt = opts.compactAt ?? 0.8;
  }

  get usable(): number {
    return Math.max(1, this.contextWindow - this.reserve);
  }

  /**
   * Điểm nén thật sự — LẤY MỐC NHỎ HƠN trong hai ràng buộc:
   *
   *   1. `compactAt` × cửa sổ: mục tiêu chung (~80%), áp dụng như nhau cho mọi
   *      model, không phân biệt cửa sổ 8k hay 200k.
   *   2. `usable`: trần tuyệt đối để dành cho lượt kế tiếp (xem
   *      `reserveForOutput`).
   *
   * Với model cửa sổ đủ lớn, (1) luôn nhỏ hơn (2) nên nó quyết định — mọi
   * model lớn nén ở đúng ~80% như nhau. Model cửa sổ nhỏ (dưới ~13k token) thì
   * (2) nhỏ hơn và thắng: nén sớm hơn 80%, đổi lại an toàn hơn cho cửa sổ vốn
   * đã chật.
   */
  private compactThreshold(): number {
    return Math.min(this.compactAt * this.contextWindow, this.usable);
  }

  measure(messages: ChatMessage[], extraTokens = 0): ContextUsage {
    const used = estimateConversationTokens(messages) + extraTokens;
    const ratio = used / this.contextWindow;
    const compactThreshold = this.compactThreshold();
    // warn luôn đứng TRƯỚC compact theo cùng tỉ lệ warnAt/compactAt, kể cả khi
    // compactThreshold bị trần `usable` kéo xuống ở model cửa sổ nhỏ — tính
    // độc lập theo `warnAt * contextWindow` có thể để warn rơi SAU compact ở
    // đúng những model cần cảnh báo sớm nhất.
    const warnThreshold = compactThreshold * (this.warnAt / this.compactAt);

    return {
      used,
      usable: this.usable,
      contextWindow: this.contextWindow,
      ratio,
      level: used >= compactThreshold ? 'compact' : used >= warnThreshold ? 'warn' : 'ok',
    };
  }

  shouldCompact(messages: ChatMessage[], extraTokens = 0): boolean {
    return this.measure(messages, extraTokens).level === 'compact';
  }
}

/**
 * Câu mô tả cho UI: "12.4k/32k · 39%".
 *
 * Mẫu số là `contextWindow` (cửa sổ THẬT), khớp với `ratio` — trước đây dùng
 * `usable` làm mẫu số trong khi `ratio` tính trên cửa sổ thật thì phần trăm
 * hiện ra sẽ không khớp với chính phân số đứng cạnh nó.
 */
export function describeUsage(usage: ContextUsage): string {
  return `${short(usage.used)}/${short(usage.contextWindow)} · ${Math.round(usage.ratio * 100)}%`;
}

function short(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * Sàn tối thiểu cho trần cắt một tool result, bất kể context còn trống bao
 * nhiêu — dưới mức này, kết quả bị cắt vụn tới mức vô nghĩa mà việc cắt gọn
 * hơn cũng không cứu được lượt (context đã cạn thì phải nén, không phải cắt
 * tool result nhỏ hơn nữa).
 */
const MIN_TOOL_RESULT_CHARS = 4_000;

/**
 * Trần ký tự cho MỘT tool result, tính ĐỘNG tại thời điểm gọi — dựa trên phần
 * context THẬT SỰ còn trống lúc đó (`usage`, đo trên `messages` hiện tại của
 * lượt), không phải một số suy sẵn từ `contextWindow` của model.
 *
 * Vì sao động thay vì tĩnh theo model: một trần tĩnh nhỏ cho model cửa sổ nhỏ
 * sẽ cắt oan ngay cả tool call ĐẦU TIÊN của một lượt, lúc context còn trống
 * gần như hoàn toàn — hại tới độ hoàn thành task mà không đổi lại gì (context
 * còn thừa rất nhiều chỗ). Tính theo phần còn trống thật thì: đầu lượt trần
 * gần bằng `ceilingChars` (không cắt oan), cuối một lượt dài đã dùng nhiều
 * context thì trần co lại đúng bằng phần còn trống thật — cắt vì THẬT SỰ hết
 * chỗ, không phải vì đoán trước model này "yếu".
 *
 * `ceilingChars` là trần TUYỆT ĐỐI (mặc định 24000 của `AgentLoop`, chọn cho
 * lượt còn nhiều chỗ) — kết quả không bao giờ vượt qua nó dù context đang rất
 * trống, để một tool result không tự nó chiếm hết ngân sách của cả lượt.
 */
export function toolResultCharBudget(usage: ContextUsage, ceilingChars: number): number {
  const remainingTokens = Math.max(0, usage.usable - usage.used);
  const remainingChars = Math.floor(remainingTokens * ASCII_CHARS_PER_TOKEN);
  return Math.min(ceilingChars, Math.max(MIN_TOOL_RESULT_CHARS, remainingChars));
}
