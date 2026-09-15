/**
 * Vòng lặp agent — mốc M2.
 *
 * Chu trình: gửi -> nhận tool_calls -> thực thi -> nhét kết quả vào history ->
 * lặp, cho tới khi model trả lời bằng văn bản hoặc chạm trần an toàn.
 *
 * Bốn thứ khiến vòng lặp này không tầm thường:
 *
 * 1. Trần cứng. Model open-source có thể lặp vô hạn (gọi lại đúng tool cũ với
 *    đúng tham số cũ). Không có trần thì nó đốt sạch quota của người dùng.
 * 2. Repair loop. Đối số sai schema là chuyện thường xuyên; gửi lỗi zod lại cho
 *    model sửa rẻ hơn nhiều so với bỏ cả lượt.
 * 3. Truncate tool result. Một file 5000 dòng nhét thẳng vào history sẽ tràn
 *    context của model 32k ngay ở vòng thứ hai.
 * 4. Bọc delimiter untrusted. Đây là phòng vệ injection ở tầng prompt
 *    (documents/SECURITY.md §1.1).
 */
import type { z } from 'zod';
import type {
  ChatMessage,
  FinishReason,
  ImageAttachment,
  ModelRole,
  Provider,
  StreamRequest,
  ToolCall,
  ToolDefinition,
  TokenUsage,
} from '../provider/types.js';
import type { Tool, ToolContext, ToolIntent, ToolResult, PreviewKind } from '../tools/Tool.js';
import type { ToolRegistry } from '../tools/Tool.js';
import type { Logger } from '../telemetry/logger.js';
import { newTraceId } from '../telemetry/logger.js';
import { scanForInjection, type InjectionScanResult } from '../security/injectionScan.js';
import {
  XML_TOOL_RESULT_CLOSE,
  XML_TOOL_RESULT_FOOTER,
  XML_TOOL_RESULT_HEADING,
  XML_TOOL_RESULT_OPEN,
  XML_TOOL_RESULT_PREFIX,
  buildXmlToolPrompt,
  coerceArgs,
  parseXmlToolCalls,
} from './xmlProtocol.js';
import { XmlTextStream } from './xmlStream.js';
import { buildGoalReminder, Compactor, type DegradedReason } from '../context/compaction.js';
import {
  ContextBudget,
  estimateTokens,
  toolResultCharBudget,
  type ContextUsage,
} from '../context/tokens.js';
import { AstraError, ContentRejectedError, isAbortError } from '../errors.js';
import type { PermissionManager } from '../permissions/PermissionManager.js';
import type { HookRunner } from '../hooks/hooks.js';
import { defaultRedactor, type Redactor } from '../security/redactor.js';

export type ToolProtocol = 'native' | 'xml';

/** Trần cho văn bản thô ghi vào log debug. Đủ để thấy lời gọi hỏng, không hơn. */
const RAW_TEXT_LOG_CHARS = 4_000;

/**
 * Trần riêng cho request phục hồi sau 422. Request thường đã có trần động;
 * request này cố ý chặt hơn vì gateway không trả body nên ta phải loại đồng
 * thời hai nguyên nhân hay gặp: chuỗi giống credential và tool output quá lớn.
 */
const RECOVERY_TOOL_RESULT_CHARS = 4_000;
const RECOVERY_MESSAGE_CHARS = 12_000;

/** 422 không có body là tín hiệu duy nhất gateway để lại cho đường phục hồi. */
function isBodyless422(err: unknown): boolean {
  const bag = (typeof err === 'object' && err !== null ? err : {}) as {
    status?: number;
    statusCode?: number;
    message?: string;
  };
  const status = bag.status ?? bag.statusCode;
  const message = err instanceof Error ? err.message : (bag.message ?? String(err ?? ''));
  return status === 422 && /\bno body\b/i.test(message);
}

function truncateMiddle(content: string, limit: number): string {
  if (content.length <= limit) return content;
  const half = Math.floor(limit / 2);
  const omitted = content.length - limit;
  return (
    content.slice(0, half) +
    `\n\n… [đã lược bỏ ${omitted} ký tự khi phục hồi request 422] …\n\n` +
    content.slice(content.length - half)
  );
}

/** Cộng usage của một request vào tổng của cả lượt. */
function addUsage(total: TokenUsage, one: TokenUsage | undefined): void {
  if (!one) return;
  total.promptTokens += one.promptTokens;
  total.completionTokens += one.completionTokens;
  total.totalTokens += one.totalTokens;
  if (one.cachedTokens !== undefined) {
    total.cachedTokens = (total.cachedTokens ?? 0) + one.cachedTokens;
  }
}

/**
 * Bộ lọc cho event 'context' realtime.
 *
 * Mục đích: phát context meter NGAY TRONG lượt (không chờ turn_end), nhưng chỉ
 * khi con số THẬT SỰ đổi — cùng `used` trên hai vòng liên tiếp (model không gọi
 * tool, chỉ nói tiếp) thì im lặng. `contextWindow: 0` nghĩa là model chưa khai
 * cửa sổ: không có gì để hiện, bỏ qua hẳn thay vì gửi một snapshot vô nghĩa.
 *
 * KHÔNG throttle theo thời gian: mỗi vòng lặp là một ranh giới tự nhiên (tool
 * result mới vào history), nên phát một snapshot mỗi vòng khi `used` đổi là đúng
 * nhịp. Thêm throttle ms chỉ làm UI chậm cập nhật ở đúng những lượt nhanh mà
 * người dùng cần thấy nhất. Số message mỗi lượt bị chặn bởi `maxIterations`.
 */
class ContextMeter {
  private lastUsed = -1;
  private lastLevel: ContextUsage['level'] | '' = '';

  /** Tr về snapshot cần phát, hoặc `undefined` để im lặng. */
  pick(usage: ContextUsage): ContextUsage | undefined {
    if (usage.contextWindow <= 0) return undefined;
    const changed = usage.used !== this.lastUsed || usage.level !== this.lastLevel;
    if (!changed) return undefined;
    this.lastUsed = usage.used;
    this.lastLevel = usage.level;
    return usage;
  }
}

/**
 * Ký tự văn bản model viết thêm giữa hai lần cập nhật đồng hồ ngữ cảnh TRONG
 * LÚC ĐANG STREAM một câu trả lời.
 *
 * Không có ngưỡng này, đồng hồ chỉ nhảy ở ranh giới vòng lặp (đầu/cuối mỗi lần
 * gọi model) — đúng cho lượt gọi nhiều tool, nhưng một câu trả lời dài KHÔNG
 * tool nào chỉ có đúng một vòng, nên UI đứng im từ lúc bắt đầu viết tới lúc
 * viết xong rồi mới nhảy một phát — đúng lỗi "phải xong đoạn chat mới update".
 * ~200 ký tự (~50-70 token) đủ để đồng hồ nhảy vài lần trong một câu trả lời
 * dài mà không dội hàng trăm postMessage ra webview cho từng delta vài ký tự.
 */
const STREAM_CONTEXT_UPDATE_CHARS = 200;

export interface AgentEvent {
  type:
    | 'thinking'
    | 'text'
    | 'tool_start'
    | 'tool_end'
    | 'injection_warning'
    | 'iteration_limit'
    | 'repair'
    | 'tool_call_dropped'
    | 'truncated'
    | 'permission_denied'
    | 'permission_downgraded'
    | 'hook_blocked'
    | 'protocol_fallback'
    | 'context_recovery'
    | 'compacted'
    | 'context'
    | 'done';
  /** Với 'text': mẩu văn bản. */
  delta?: string;
  /**
   * Với 'context': snapshot ngữ cảnh realtime đo trên `messages` ĐANG chạy
   * của lượt này — không phải `this.history` ở ngoài (chỉ gán lại khi lượt
   * xong). UI dùng nó để cập nhật đồng hồ context NGAY TRONG lúc stream/tool
   * chạy, thay vì chờ tới `turn_end`. Xem `emitContextIfChanged`.
   */
  contextUsage?: ContextUsage;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: ToolResult;
  /**
   * Id của lời gọi, có ở 'tool_start' và 'tool_end'. UI ghép hai sự kiện bằng
   * id này — ghép bằng tên tool sẽ vỡ ngay khi model gọi cùng một tool hai lần
   * trong một vòng.
   */
  callId?: string;
  /** Với 'tool_end': thời gian tool chạy, ms. */
  durationMs?: number;
  /**
   * Với 'tool_end': bản xem trước do tool.describe() soạn sẵn — diff cho công cụ
   * ghi file, lệnh cho bash, văn bản trơn cho phần còn lại. UI dùng cái này thay
   * vì content để hiển thị split diff (trái=cũ, phải=mới).
   */
  preview?: string;
  /** Với 'tool_end': loại preview — 'diff' | 'command' | 'text'. */
  previewKind?: PreviewKind;
  /** Với 'injection_warning'. */
  scan?: InjectionScanResult;
  /**
   * Với 'repair' / 'permission_denied' / 'permission_downgraded' /
   * 'hook_blocked' / 'protocol_fallback' / 'context_recovery': lý do.
   */
  reason?: string;
  iterations?: number;
  /** Với 'compacted': số message đã gộp thành bản tóm tắt. */
  droppedMessages?: number;
  /** Với 'compacted': token ước lượng trước/sau khi nén. */
  tokensBefore?: number;
  tokensAfter?: number;
  /** Với 'compacted': phải lùi về bản tóm tắt cơ học thay vì bản model viết. */
  degraded?: boolean;
  /** Với 'compacted': vì sao phải lùi về bản cơ học. Vắng mặt = bản của model dùng được. */
  degradedReason?: DegradedReason;
}

/** Mẩu output tool đẩy thẳng ra UI trong lúc còn đang chạy. */
export interface ToolOutputChunk {
  callId: string;
  toolName: string;
  text: string;
}

export interface AgentLoopOptions {
  provider: Provider;
  tools: ToolRegistry;
  toolContext: ToolContext;
  logger: Logger;
  systemPrompt: string;
  /** Đường tool-calling. Lấy từ `toolCalling` trong models.json. */
  protocol?: ToolProtocol;
  model?: string;
  role?: ModelRole;
  /** Trần vòng lặp mỗi lượt. Mặc định không giới hạn — để người dùng tự quyết
   * khi dừng qua cost. Truyền số dương để gián tự lại. */
  maxIterations?: number;
  /** Số lần cho model tự sửa đối số sai schema. Mặc định 2. */
  maxRepairs?: number;
  /** Ký tự tối đa cho một tool result trước khi cắt. Mặc định 24000 (~6k token). */
  maxToolResultChars?: number;
  /** Redactor áp lên mọi tool result trước khi nó vào request model. */
  redactor?: Redactor;
  /**
   * Cổng quyền (M4). Không truyền = mọi tool chạy tự do. Đó là mặc định đúng
   * cho eval harness và test, KHÔNG đúng cho sản phẩm — extension luôn truyền.
   */
  permissions?: PermissionManager;
  /**
   * Output của tool đang chạy, đẩy ra ngay khi có.
   *
   * Là callback chứ không phải sự kiện của generator vì `execute()` được await:
   * trong lúc chờ nó, generator không yield được gì. Một lệnh test chạy 40 giây
   * mà UI đứng im suốt 40 giây thì người dùng không biết nó treo hay đang chạy.
   */
  onToolOutput?: (chunk: ToolOutputChunk) => void;
  /**
   * Hooks của dự án (M8). Không truyền = không có hook nào chạy.
   *
   * Đặt SAU cổng quyền một cách có chủ ý: hook là luật riêng của đội dự án,
   * không phải lớp bảo mật thay cho PermissionManager. Thứ tự "quyền trước,
   * hook sau" nghĩa là hook không bao giờ MỞ được thứ mà quyền đã đóng.
   */
  hooks?: HookRunner;
  /**
   * Chèn lại yêu cầu gốc sau mỗi bấy nhiêu vòng lặp. 0 = tắt. Mặc định 8 (M6).
   *
   * Model open-source chạy 20+ vòng hay quên việc ban đầu và bắt đầu tối ưu
   * thứ nó vừa nhìn thấy. Một dòng nhắc ~100 token rẻ hơn nhiều so với một
   * lượt đi lạc rồi phải làm lại.
   */
  goalReminderEvery?: number;
  /**
   * Bộ nén dùng để tự nén NGAY TRONG một lượt, khi nhiều vòng lặp liên tiếp
   * (đọc file, grep, chạy lệnh — chưa có message user mới nào chen vào) làm
   * ngữ cảnh chạm ngưỡng trước khi lượt kịp kết thúc.
   *
   * Không truyền = tắt tính năng này. Không có nó, `messages` bên trong `run()`
   * chỉ được nén ở NGOÀI — trước lần gọi `run()` tiếp theo — nên một lượt dài
   * hàng chục vòng có thể tự phình tới lúc gateway từ chối cả request, và
   * người dùng phải gõ thêm một câu mới thấy nén chạy (đúng lỗi đã gặp: nén chỉ
   * xảy ra sau khi người dùng gõ "tiếp tục").
   */
  compactor?: Compactor;
  /**
   * Cửa sổ context của model đang chat, để `compactor` ở trên biết khi nào
   * chạm ngưỡng. Bỏ trống thì `ContextBudget` coi như 32k (xem `context/tokens.ts`).
   */
  contextWindow?: number;
  /**
   * Ngưỡng tự nén GIỮA lượt, theo tỉ lệ cửa sổ THẬT. Lấy từ profile model
   * (`ModelProfileSchema.compactAt`); bỏ trống thì `ContextBudget` dùng 0.8.
   *
   * Khác với `ContextBudget` (phần đo NGOÀI lượt, host tự dựng ở `chat.ts`),
   * phần đo GIỮA lượt ở dưới dựng `ContextBudget` riêng — nên hai ngưỡng này
   * phải truyền qua `AgentLoopOptions`, không tự chảy từ compactor.
   */
  compactAt?: number;
  /**
   * Ngưỡng cảnh báo, theo tỉ lệ cửa sổ THẬT. Lấy từ profile; bỏ trống = 0.7.
   * Luôn đứng trước `compactAt` theo tỉ lệ không đổi (xem `tokens.ts`).
   */
  warnAt?: number;
  /**
   * Gọi khi lượt đang chạy phải tụt từ native xuống XML (xem
   * `isNativeToolsUnsupported`).
   *
   * Đây là chỗ phép đo năng lực thật sự xảy ra bây giờ: thay vì bắt người dùng
   * chạy một lệnh đo trước khi dùng được gì, ta giả định model làm được, và
   * lần đầu tiên nó không làm được thì ghi lại. Host cài callback này để nhớ
   * sang các lượt sau — không nhớ thì lượt nào cũng trả giá bằng một request
   * hỏng.
   */
  onProtocolFallback?: (info: { model?: string; reason: string }) => void;
}

/**
 * Lỗi này có phải "endpoint/model không nhận `tools`" không.
 *
 * Chỉ nhận diện lỗi ĐỐI SỐ (4xx do shape request), không nhận diện lỗi mạng
 * hay 5xx: một gateway chập chờn không phải bằng chứng model kém, và tụt
 * xuống XML vì một lần timeout sẽ khiến model tốt bị giáng cấp vĩnh viễn.
 *
 * Khớp trên thông điệp vì các endpoint tương thích OpenAI không có mã lỗi
 * chung cho việc này — vLLM, llama.cpp và Azure mỗi bên nói một kiểu.
 */
export function isNativeToolsUnsupported(err: unknown): boolean {
  // `err` có thể là bất cứ gì — một `throw undefined` ở tầng dưới không được
  // phép làm nổ chính cái hàm đang quyết định có cứu được lượt hay không.
  const bag = (typeof err === 'object' && err !== null ? err : {}) as {
    status?: number;
    statusCode?: number;
  };
  const status = bag.status ?? bag.statusCode;
  // 400/404/422: request sai shape với endpoint này. 501: nói thẳng chưa cài.
  if (status !== undefined && status !== 400 && status !== 404 && status !== 422 && status !== 501) {
    return false;
  }

  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (!msg) return false;

  const mentionsTools = /\btool[s_]?|\bfunction[s_]?call|\btool_choice\b/.test(msg);
  const mentionsUnsupported =
    /not support|unsupported|unrecognized|unknown (field|parameter|argument)|does not accept|invalid.*(parameter|field)|no such/.test(
      msg,
    );
  return mentionsTools && mentionsUnsupported;
}

export interface AgentRunResult {
  /** Câu trả lời cuối cùng dạng văn bản. */
  text: string;
  messages: ChatMessage[];
  iterations: number;
  toolCalls: number;
  stoppedBy: 'answer' | 'iteration_limit' | 'aborted' | 'error';
  /**
   * Có mặt khi và chỉ khi `stoppedBy === 'error'`.
   *
   * Lượt gặp lỗi TRẢ VỀ chứ không ném (xem cuối `run()`): ném đi thì người gọi
   * mất `messages` tích luỹ, nên phần tool đã chạy — kể cả file đã ghi thật —
   * biến mất khỏi hội thoại trong khi thay đổi trên đĩa vẫn còn.
   */
  error?: { code: string; message: string };
  injectionWarnings: number;
  /**
   * Tổng token của cả lượt, cộng dồn qua mọi vòng lặp. Eval harness (M2.5)
   * dùng con số này để so chi phí giữa các model — một model trả lời đúng
   * nhưng tốn gấp ba lần token thì chưa chắc đã tốt hơn.
   */
  usage: TokenUsage;
}

export class AgentLoop {
  private readonly maxIterations: number;
  private readonly maxRepairs: number;
  private readonly maxToolResultChars: number;
  /**
   * KHÔNG readonly: một lượt có thể bắt đầu ở native rồi tụt xuống XML giữa
   * chừng khi endpoint từ chối `tools` — xem chỗ bắt lỗi trong `run()`.
   */
  private protocol: ToolProtocol;
  private readonly redactor: Redactor;

  constructor(private readonly opts: AgentLoopOptions) {
    // Mặc định không giới hạn: người dùng chịu phí token nên để họ quyết định lúc
    // nào dừng. Truyền số dương để gián tự lại giới hạn.
    this.maxIterations = opts.maxIterations ?? Number.POSITIVE_INFINITY;
    this.maxRepairs = opts.maxRepairs ?? 2;
    this.maxToolResultChars = opts.maxToolResultChars ?? 24_000;
    this.protocol = opts.protocol ?? 'native';
    this.redactor = opts.redactor ?? defaultRedactor;
  }

  /** System prompt đầy đủ — với đường XML thì kèm mô tả định dạng thẻ. */
  private systemPrompt(): string {
    if (this.protocol === 'native') return this.opts.systemPrompt;
    return `${this.opts.systemPrompt}\n\n${buildXmlToolPrompt(this.opts.tools.definitions())}`;
  }

  /** Đường XML mô tả tool trong prompt, nên KHÔNG gửi kèm `tools`. */
  private toolDefinitions(): ToolDefinition[] | undefined {
    return this.protocol === 'native' ? this.opts.tools.definitions() : undefined;
  }

  async *run(
    userMessage: string,
    history: ChatMessage[] = [],
    signal?: AbortSignal,
    /** Ảnh người dùng đính kèm cho ĐÚNG lượt này. */
    images?: ImageAttachment[],
  ): AsyncGenerator<AgentEvent, AgentRunResult> {
    const traceId = newTraceId('turn');
    const logger = this.opts.logger.child({ traceId, protocol: this.protocol });

    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt() },
      ...history,
      { role: 'user', content: userMessage, ...(images?.length ? { images } : {}) },
    ];

    let iterations = 0;
    let toolCalls = 0;
    let repairs = 0;
    let injectionWarnings = 0;
    let finalText = '';
    // Bật sau đúng một lỗi 422 không body. Từ đó mọi request còn lại của lượt
    // dùng một view đã redact + rút gọn của history; tool đã chạy vẫn nằm trong
    // `messages` gốc để UI/session giữ đúng tiến độ, nhưng tuyệt đối không chạy
    // lại chỉ để phục hồi request model.
    let safeRequestMode = false;
    let recoveredBodyless422 = false;
    let xmlRecoveryAttempted = false;
    // Đã che nội dung giống credential trong history vì gateway chặn. Bật đúng
    // một lần: che xong mà vẫn bị chặn thì thứ bị chặn không nằm trong tầm bộ
    // rule của ta, và che lại lần nữa cũng ra đúng chuỗi đó.
    let maskedRejectedContent = false;
    const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    // Đồng hồ ngữ cảnh realtime cho lượt này. Đo trên `messages` ĐANG chạy —
    // `this.history` ở ngoài chỉ gán lại khi lượt xong, nên đo ở đây là duy
    // nhất nhìn thấy biến động giữa các vòng. Xem `ContextMeter`.
    const contextMeter = new ContextMeter();

    /**
     * Kết thúc lượt vì một lỗi không cứu được, NHƯNG giữ nguyên tiến độ.
     *
     * Trước đây chỗ này `throw`, và hệ quả không nằm ở chỗ người dùng thấy một
     * thông báo lỗi — nó nằm ở chỗ `messages` tích luỹ bị mất theo. Một lượt đã
     * chạy năm tool và ghi hai file, gặp 5xx ở vòng thứ sáu, thì file trên đĩa
     * vẫn đổi mà hội thoại không còn dấu vết nào của việc đó: lượt sau agent
     * không biết mình đã làm gì, và `/undo` cũng không có gì để đối chiếu.
     *
     * Nên: trả về như một lượt "dừng vì lỗi", đủ `messages`, kèm `error` cho
     * người gọi hiện thông báo. Sổ nợ #10.
     */
    const failTurn = (
      err: unknown,
      partialText: string,
      lastUsage: TokenUsage | undefined,
    ): AgentRunResult => {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof AstraError ? err.code : 'provider_error';
      logger.error('lượt dừng vì lỗi không cứu được', { code, reason: message });

      addUsage(usage, lastUsage);

      // Đoạn văn bản đã chảy ra màn hình trước khi đứt vẫn phải vào history:
      // người dùng đã đọc nó, và một history thiếu đúng đoạn đó khiến lượt sau
      // nối tiếp vào chỗ trống. Chỉ có `content`, không có `toolCalls` — lời gọi
      // dở dang chưa hề chạy, và một `tool_calls` không có `role:"tool"` đáp lại
      // sẽ làm gateway từ chối thẳng request của lượt sau.
      if (partialText) {
        messages.push({ role: 'assistant', content: partialText });
        finalText = partialText;
      }

      return this.result(
        finalText,
        messages,
        iterations,
        toolCalls,
        'error',
        injectionWarnings,
        usage,
        { code, message },
      );
    };

    // Snapshot đầu lượt: user message vừa vào, trước khi chạy vòng đầu.
    // Phát ra cho UI có số ngay lập tức thay vì chờ vòng đầu xong.
    if (this.opts.contextWindow) {
      const budget = new ContextBudget({
        contextWindow: this.opts.contextWindow,
        ...(this.opts.compactAt !== undefined ? { compactAt: this.opts.compactAt } : {}),
        ...(this.opts.warnAt !== undefined ? { warnAt: this.opts.warnAt } : {}),
      });
      const initial = contextMeter.pick(budget.measure(messages));
      if (initial) yield { type: 'context', contextUsage: initial };
    }

    while (iterations < this.maxIterations) {
      if (signal?.aborted) {
        return this.result(finalText, messages, iterations, toolCalls, 'aborted', injectionWarnings, usage);
      }
      iterations++;

      // Tự nén GIỮA lượt (M6 mở rộng) + đồng hồ ngữ cảnh realtime. Đặt ở ĐẦU
      // vòng lặp — cùng chỗ an toàn với lời nhắc mục tiêu ngay dưới đây — vì lý
      // do y hệt: mọi tool result của vòng trước đã vào history, nên đây là
      // ranh giới `user` sạch, không cắt ngang cặp tool_call/tool_result nào.
      //
      // `budget` dựng ở đây đo MỘT lần mỗi vòng và phục vụ CẢ hai việc: quyết định
      // nén (nếu có compactor) LẪN phát event 'context' cho UI (xem
      // `ContextMeter`). Trước đây `contextUsage` chỉ đo trong nhánh compactor,
      // nên lượt không có compactor thì đồng hồ không cập nhật giữa chừng dù
      // `messages` phình lên — đây là gốc của lỗi "context chỉ cập nhật khi
      // lượt xong".
      const budget = new ContextBudget({
        contextWindow: this.opts.contextWindow ?? 0,
        ...(this.opts.compactAt !== undefined ? { compactAt: this.opts.compactAt } : {}),
        ...(this.opts.warnAt !== undefined ? { warnAt: this.opts.warnAt } : {}),
      });
      // Chẩn đoán giữa lượt: là câu trả lời cho "nén chạy hay chưa rồi vẫn
      // tràn?". `compacted` ở dưới chỉ phát KHI NÉN XONG, nên khi gateway từ
      // chối vì tràn, người nhìn log không biết nén đã thử và thất bại, hay
      // chưa kịp chạm ngưỡng. Dòng này hiện con số thứ hai mỗi vòng.
      const contextUsage = budget.measure(messages);
      logger.debug('kiểm tra nén giữa lượt', {
        iteration: iterations,
        used: contextUsage.used,
        contextWindow: contextUsage.contextWindow,
        level: contextUsage.level,
        ratio: Math.round(contextUsage.ratio * 100) / 100,
      });

      // Phát snapshot ra UI TRƯỚC khối nén: nếu nén chạy, UI thấy "đang gần
      // đầy" rồi MỚI thấy "đã nén" (sự kiện `compacted` tự phát dưới).
      // Đảo ngược thứ tự thì người dùng nhìn thấy meter nhảy xuống rồi một
      // thông báo "đã nén" hiện ra — sai trật tự với sự việc thật.
      //
      // Chỉ emit khi `contextWindow` thật sự được khai: `ContextBudget` normalise
      // 0 → 32k (DEFAULT_WINDOW), nên contextMeter không thể tự biết "chưa khai" —
      // check ở đây, đúng chỗ duy nhất còn giữ giá trị gốc.
      const meterSnapshot =
        this.opts.contextWindow ? contextMeter.pick(contextUsage) : undefined;
      if (meterSnapshot) yield { type: 'context', contextUsage: meterSnapshot };

      if (this.opts.compactor && budget.shouldCompact(messages)) {
        try {
          const compaction = await this.opts.compactor.compact(messages, signal);
          if (compaction.compacted) {
            messages.length = 0;
            messages.push(...compaction.messages);
            logger.info('tự nén giữa lượt vì ngữ cảnh sắp đầy', {
              iteration: iterations,
              droppedMessages: compaction.droppedMessages,
              tokensBefore: compaction.tokensBefore,
              tokensAfter: compaction.tokensAfter,
            });
            yield {
              type: 'compacted',
              droppedMessages: compaction.droppedMessages,
              tokensBefore: compaction.tokensBefore,
              tokensAfter: compaction.tokensAfter,
              degraded: compaction.degraded,
              ...(compaction.degradedReason ? { degradedReason: compaction.degradedReason } : {}),
            };
          }
        } catch (err) {
          if (isAbortError(err)) {
            return this.result(
              finalText,
              messages,
              iterations,
              toolCalls,
              'aborted',
              injectionWarnings,
              usage,
            );
          }
          // Nén hỏng không được giết cả lượt: hội thoại
          // chưa nén vẫn gửi được, chỉ là sát trần hơn.
          logger.warn('tự nén giữa lượt thất bại, tiếp tục không nén', {
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Chống trôi mục tiêu (M6). Đặt ở ĐẦU vòng lặp là chỗ duy nhất an toàn:
      // mọi tool result của vòng trước đã vào history, nên chèn một message
      // `user` ở đây không cắt ngang cặp tool_call/tool_result nào.
      const reminderEvery = this.opts.goalReminderEvery ?? 8;
      if (reminderEvery > 0 && iterations > 1 && (iterations - 1) % reminderEvery === 0) {
        logger.debug('nhắc lại mục tiêu', { iteration: iterations });
        messages.push({ role: 'user', content: buildGoalReminder(userMessage) });
      }

      const req: StreamRequest = {
        messages: safeRequestMode ? this.buildRecoveryMessages(messages) : messages,
        traceId,
        ...(this.opts.model ? { model: this.opts.model } : {}),
        ...(this.opts.role ? { role: this.opts.role } : {}),
        ...(this.toolDefinitions() ? { tools: this.toolDefinitions()! } : {}),
        ...(signal ? { signal } : {}),
      };

      let text = '';
      /** Lý do model dừng ở request NÀY. `'unknown'` khi gateway không nói. */
      let finishReason: FinishReason = 'unknown';
      /**
       * Usage của riêng request này.
       *
       * Giữ bản CUỐI chứ không cộng dồn: endpoint tương thích OpenAI (vLLM mà
       * FPT Cloud chạy) gắn usage TÍCH LUỸ vào mọi chunk khi bật
       * `include_usage`. Cộng lại thì một lượt vài nghìn token hiện thành vài
       * trăm nghìn, và con số sai đó chảy tiếp vào đồng hồ ngữ cảnh lẫn ngưỡng
       * tự nén. Bản cuối cùng luôn là bản đầy đủ.
       */
      let lastUsage: TokenUsage | undefined;
      const pendingCalls: ToolCall[] = [];
      // Điểm mốc cho STREAM_CONTEXT_UPDATE_CHARS — số ký tự của `text` tại lần
      // phát context gần nhất trong lúc stream (0 = chưa phát lần nào).
      let lastContextCheckpoint = 0;

      // Ở đường XML, thẻ tool chảy chung dòng với câu trả lời. Lọc theo từng
      // mẩu thay vì chờ hết lượt — nếu chờ, người dùng nhìn màn hình trắng
      // suốt cả lượt, mà đây lại là đường mặc định cho model chưa đo.
      const xmlText =
        this.protocol === 'xml' ? new XmlTextStream(this.opts.tools.names()) : undefined;

      yield { type: 'thinking', iterations };

      try {
        for await (const event of this.opts.provider.stream(req)) {
          switch (event.type) {
            case 'text': {
              text += event.delta;
              const visible = xmlText ? xmlText.push(event.delta) : event.delta;
              if (visible) yield { type: 'text', delta: visible };

              // Đồng hồ ngữ cảnh giữa lúc stream — xem STREAM_CONTEXT_UPDATE_CHARS.
              // `text` chưa vào `messages` (chỉ được push sau khi stream xong),
              // nên cộng ước lượng của nó làm `extraTokens` thay vì đo lại
              // `messages` mỗi delta.
              if (
                this.opts.contextWindow &&
                text.length - lastContextCheckpoint >= STREAM_CONTEXT_UPDATE_CHARS
              ) {
                lastContextCheckpoint = text.length;
                const streaming = contextMeter.pick(budget.measure(messages, estimateTokens(text)));
                if (streaming) yield { type: 'context', contextUsage: streaming };
              }
              break;
            }
            case 'tool_call':
              pendingCalls.push(event.call);
              break;
            case 'usage':
              lastUsage = event.usage;
              break;
            case 'done':
              // Vì sao phải đọc: `length` nghĩa là model bị CẮT vì hết token
              // đầu ra, không phải nó đã nói xong. Bỏ qua nhánh này thì một câu
              // trả lời dở hiện ra y như một câu hoàn chỉnh, và một lời gọi tool
              // bị cắt giữa JSON thì rơi vào repair loop với lý do "JSON không
              // hợp lệ" — model được bảo sửa đúng cái nó không làm sai.
              finishReason = event.finishReason;
              break;
            default:
              break;
          }
        }
      } catch (err) {
        if (isAbortError(err)) {
          addUsage(usage, lastUsage);
          return this.result(
            finalText,
            messages,
            iterations,
            toolCalls,
            'aborted',
            injectionWarnings,
            usage,
          );
        }

        // Model/endpoint không nhận `tools`. Đây KHÔNG phải lượt hỏng — đổi
        // sang đường XML rồi chạy lại đúng vòng này.
        //
        // Phép đo năng lực nằm ở đây chứ không nằm ở một lệnh chạy trước khi
        // dùng: giả định model làm được, và lần đầu nó không làm được thì ghi
        // lại. Người dùng trả giá một request hỏng, một lần, thay vì một bước
        // cài đặt bắt buộc.
        if (this.protocol === 'native' && isNativeToolsUnsupported(err)) {
          const reason = err instanceof Error ? err.message : String(err);
          this.protocol = 'xml';
          logger.warn('endpoint từ chối native tool-calling, chuyển sang XML', {
            model: this.opts.model,
            reason,
          });
          this.opts.onProtocolFallback?.({
            ...(this.opts.model ? { model: this.opts.model } : {}),
            reason,
          });

          // System prompt khác nhau giữa hai đường: đường XML phải mô tả định
          // dạng thẻ. Dựng lại message hệ thống, nếu không model sẽ được bảo
          // dùng công cụ mà không được cho biết cú pháp nào.
          messages[0] = { role: 'system', content: this.systemPrompt() };

          yield { type: 'protocol_fallback', reason };
          addUsage(usage, lastUsage);
          // Vòng này không sinh ra gì, đừng tính vào trần lặp.
          iterations--;
          continue;
        }

        // Gateway chặn CẢ request vì trong hội thoại có đoạn trông giống
        // credential. Khác hai nhánh dưới đây ở một điểm quyết định: ở đây ta
        // BIẾT nguyên nhân (gateway nói rule nào khớp), nên không đoán, không hạ
        // giao thức, không hạ transcript thành văn bản — chỉ che đúng thứ bị
        // chặn rồi gửi lại y nguyên hình dạng request.
        //
        // Che thẳng vào `messages`, KHÔNG dựng một view riêng như đường 422 mù ở
        // dưới: view sạch chỉ cứu được đúng request này, còn history vẫn mang
        // nguyên đoạn bị chặn — nên lượt sau lại 422, và người dùng trả thêm một
        // request hỏng cho MỖI lượt tới hết phiên. Sửa vào history là chỗ duy
        // nhất chấm dứt được vòng đó.
        //
        // Cũng chỉ cứu khi chưa có delta nào về, cùng lý do như đường 422 mù.
        if (
          err instanceof ContentRejectedError &&
          text.length === 0 &&
          pendingCalls.length === 0 &&
          lastUsage === undefined
        ) {
          const masked = maskedRejectedContent ? 0 : this.maskSecrets(messages);
          if (masked > 0) {
            maskedRejectedContent = true;
            const rules = Object.keys(err.findings);
            logger.warn('gateway chặn vì nội dung giống credential, đã che rồi gửi lại', {
              iteration: iterations,
              maskedMessages: masked,
              detail: err.detail,
              ...(rules.length > 0 ? { rules: rules.join(',') } : {}),
            });
            yield {
              type: 'context_recovery',
              reason:
                `AstraWork blocked the request: it found credential-like content in this ` +
                `conversation${rules.length > 0 ? ` (${rules.join(', ')})` : ''}. ` +
                `AstraCode masked ${masked} message${masked === 1 ? '' : 's'} and is retrying — ` +
                `the model will see those spots as [REDACTED].`,
            };
            // Request bị chặn không phải một vòng suy luận của model.
            iterations--;
            continue;
          }

          // Không còn gì che được mà gateway vẫn chặn. Dừng với đúng câu gateway
          // nói: đoán tiếp ở đây chỉ đốt thêm request và vẫn kết thúc ở cùng một
          // chỗ, còn người dùng thì mất luôn manh mối duy nhất.
          logger.error('gateway chặn nội dung và AstraCode không che được gì', {
            iteration: iterations,
            detail: err.detail,
          });
          return failTurn(err, text, lastUsage);
        }

        // AstraWork đôi khi trả đúng `422 status code (no body)`: không có chi
        // tiết để biết WAF chặn credential-like content, request quá lớn, hay
        // endpoint không nhận native tools. Retry ở GatewayProvider sẽ gửi lại
        // y nguyên payload nên bị cấm. AgentLoop mới có đủ ngữ cảnh để dựng một
        // request KHÁC mà không chạy lại tool.
        //
        // Chỉ cứu khi chưa có delta nào về. Nếu stream đã trả text/tool call,
        // retry có thể làm UI lặp chữ hoặc thực thi trùng hành động ghi.
        if (
          isBodyless422(err) &&
          text.length === 0 &&
          pendingCalls.length === 0 &&
          lastUsage === undefined
        ) {
          if (!recoveredBodyless422) {
            recoveredBodyless422 = true;
            safeRequestMode = true;
            logger.warn('gateway trả 422 không body, dựng lại context an toàn rồi thử một lần', {
              iteration: iterations,
            });
            yield {
              type: 'context_recovery',
              reason: 'Gateway rejected the request (422); sanitized context and retrying once.',
            };
            // Request hỏng không phải một vòng suy luận của model và không được
            // ăn vào maxIterations.
            iterations--;
            continue;
          }

          // Nếu payload đã sạch vẫn bị 422, thử bỏ native tool schema đúng một
          // lần. Không ghi nhớ fallback này sang phiên sau: 422 không body không
          // đủ bằng chứng model thật sự thiếu native tool-calling.
          if (this.protocol === 'native' && !xmlRecoveryAttempted) {
            xmlRecoveryAttempted = true;
            this.protocol = 'xml';
            messages[0] = { role: 'system', content: this.systemPrompt() };
            logger.warn('request an toàn vẫn bị 422, thử đường XML đúng một lần', {
              iteration: iterations,
            });
            yield {
              type: 'context_recovery',
              reason: 'Sanitized request was still rejected; retrying once without native tool schema.',
            };
            iterations--;
            continue;
          }
        }

        // Hết đường cứu. KHÔNG ném — xem `failTurn`.
        return failTurn(err, text, lastUsage);
      }

      addUsage(usage, lastUsage);

      // Văn bản THÔ, trước khi lọc thẻ. Khi model viết lời gọi sai định dạng,
      // đây là chỗ duy nhất nhìn thấy nó viết cái gì — không có dòng này thì
      // một lượt hỏng chỉ để lại một mảnh thẻ trên màn hình và không có gì để
      // đối chiếu.
      logger.debug('văn bản model trả về', {
        iteration: iterations,
        chars: text.length,
        text: text.slice(0, RAW_TEXT_LOG_CHARS),
      });

      // Đường XML: bóc lời gọi ra khỏi văn bản.
      //
      // Phần hiển thị đã chảy ra hết trong vòng lặp trên; ở đây chỉ xả nốt đuôi
      // buffer rồi bóc lời gọi trên văn bản ĐẦY ĐỦ. Hai việc tách nhau có chủ
      // đích: hiển thị được phép sai lệch vài ký tự, hành vi thì không.
      let visibleText = text;
      if (this.protocol === 'xml') {
        const tail = xmlText?.flush() ?? '';
        if (tail) yield { type: 'text', delta: tail };

        const parsed = parseXmlToolCalls(text, this.opts.tools.names());
        visibleText = parsed.text;

        for (const call of parsed.calls) {
          const tool = this.opts.tools.get(call.name);
          const schema = tool ? this.jsonSchemaOf(tool) : {};
          pendingCalls.push({
            id: `xml_${call.name}_${pendingCalls.length}`,
            name: call.name,
            arguments: JSON.stringify(coerceArgs(call.args, schema)),
          });
        }

        // Model ĐỊNH gọi tool nhưng viết thẻ sai. Không bắt ở đây thì mảnh thẻ
        // hỏng đi thẳng ra màn hình và lượt kết thúc như thể đã trả lời xong —
        // hỏng mà không ai biết. Cho model một lần viết lại rẻ hơn nhiều.
        if (parsed.calls.length === 0 && parsed.malformedReason !== undefined) {
          if (repairs < this.maxRepairs) {
            repairs++;
            const reason = parsed.malformedReason;
            logger.warn('lời gọi tool sai định dạng, cho model viết lại', {
              malformed: parsed.malformed.join(','),
              attempt: repairs,
            });
            yield { type: 'repair', reason };
            messages.push({ role: 'assistant', content: text });
            messages.push({ role: 'user', content: reason });
            continue;
          }
          // Hết lượt sửa thì để nguyên văn bản đi tiếp: phần thẻ hỏng đã chảy
          // ra màn hình từ lúc stream rồi, giấu nó khỏi history chỉ làm hai
          // bên lệch nhau.
          //
          // Nhưng PHẢI nói ra. Không nói thì lượt kết thúc trông y hệt một câu
          // trả lời bình thường — người dùng ngồi đợi một việc đã bỏ dở mà
          // không có dấu hiệu nào.
          logger.warn('bỏ qua lời gọi tool sai định dạng sau khi hết lượt sửa', {
            malformed: parsed.malformed.join(','),
          });
          yield {
            type: 'tool_call_dropped',
            ...(parsed.malformed[0] ? { toolName: parsed.malformed[0] } : {}),
            reason:
              `The model wrote a malformed ${parsed.malformed[0] ?? 'tool'} call ` +
              `${this.maxRepairs + 1} times in a row, so this turn stops here. ` +
              `Ask again, or pick another model — this one cannot follow the XML tag format.`,
          };
        }
      }

      // Chốt số ngay khi stream vừa xong — dứt điểm cho trường hợp lượt chỉ có
      // một vòng, không tool nào (hỏi đáp thường): không có vòng kế tiếp để
      // phát snapshot đầu vòng, nên thiếu dòng này thì đồng hồ dừng ở mốc
      // checkpoint cuối cùng của STREAM_CONTEXT_UPDATE_CHARS thay vì số thật.
      if (this.opts.contextWindow) {
        const settled = contextMeter.pick(budget.measure(messages, estimateTokens(visibleText)));
        if (settled) yield { type: 'context', contextUsage: settled };
      }

      // Không gọi tool nữa -> đây là câu trả lời cuối.
      if (pendingCalls.length === 0) {
        // …trừ khi model bị CẮT giữa chừng. `finishReason` là thứ duy nhất phân
        // biệt "đã nói xong" với "hết chỗ để nói", và không đọc nó thì một câu
        // trả lời dở kết thúc lượt y như một câu hoàn chỉnh.
        if (finishReason === 'length') {
          logger.warn('câu trả lời bị cắt vì hết token đầu ra', { iteration: iterations });
          yield {
            type: 'truncated',
            reason:
              'The model ran out of output tokens, so this answer stops mid-way. ' +
              'Ask it to continue, or pick a model with a larger output limit.',
          };
        } else if (finishReason === 'content_filter') {
          logger.warn('câu trả lời bị bộ lọc nội dung cắt', { iteration: iterations });
          yield {
            type: 'truncated',
            reason: 'A content filter stopped this answer part-way through.',
          };
        }

        finalText = visibleText;
        messages.push({ role: 'assistant', content: visibleText });
        // Hook `stop` (M8) — chạy TRƯỚC khi phát 'done' để lệnh kiểm tra của
        // dự án kịp chạy trong lúc UI còn đang hiện trạng thái bận.
        await this.runStopHook(signal);
        yield { type: 'done', iterations };
        return this.result(
          finalText,
          messages,
          iterations,
          toolCalls,
          'answer',
          injectionWarnings,
          usage,
        );
      }

      /**
       * Kết quả tool của đường XML, gom lại để gửi về dưới dạng MỘT message
       * `user`. Rỗng ở đường native.
       */
      const xmlResults: string[] = [];

      if (this.protocol === 'xml') {
        // Model đi đường này KHÔNG có native function calling — đó là định
        // nghĩa của đường XML. Gửi ngược `tool_calls` và `role: "tool"` cho nó
        // là đưa hai giao thức mâu thuẫn vào cùng một hội thoại: request không
        // có trường `tools`, nhưng lịch sử lại đầy lời gọi native. Chat template
        // của vLLM dựng lại đoạn đó thành một thứ méo mó, và model đáp lại bằng
        // cách chép lại nguyên cả bản ghi — kể cả delimiter `<tool_result>`.
        //
        // Đúng ra: lượt của model là văn bản THÔ nó đã viết (kèm thẻ), kết quả
        // tool quay về như lời của người dùng. Một giao thức, một mạch hội thoại.
        messages.push({ role: 'assistant', content: text || visibleText });
      } else {
        messages.push({
          role: 'assistant',
          content: visibleText || null,
          toolCalls: pendingCalls,
        });
      }

      let repairRequested = false;
      // `i` khai báo NGOÀI vòng lặp: sau khi vòng dừng vì huỷ (break ở dưới),
      // cần biết nó dừng ở đâu để trả lời nốt những lời gọi còn thiếu — xem
      // khối ngay sau vòng lặp.
      let i = 0;
      let interruptedDuringExecution = false;
      let startedAt = 0;

      // Chạy song song khi CẢ LÔ đều là tool readOnly đã biết. Đa số lượt gọi
      // nhiều tool trong thực tế là toàn đọc (grep+read+list_dir) hoặc một lệnh
      // ghi duy nhất; trộn đọc/ghi trong cùng lượt hiếm và phức tạp hơn nhiều để
      // làm đúng thứ tự giữa các nhóm, nên trường hợp đó vẫn đi đường tuần tự
      // dưới đây — vòng `for` giữ NGUYÊN, không đổi gì.
      const allReadOnly =
        pendingCalls.length > 1 &&
        pendingCalls.every((c) => this.opts.tools.get(c.name)?.readOnly === true);

      if (allReadOnly) {
        const batch = yield* this.runReadOnlyBatch(
          pendingCalls,
          messages,
          xmlResults,
          signal,
          logger,
          repairs,
        );
        repairs = batch.repairs;
        repairRequested = batch.repairRequested;
        toolCalls += batch.toolCalls;
        injectionWarnings += batch.injectionWarnings;
        // Promise.all luôn settle cho MỌI phần tử — cả lô đã được trả lời đầy đủ.
        // Đưa `i` tới cuối để vòng `for` ngay dưới không chạy thân vòng nào (điều
        // kiện `i < pendingCalls.length` sai ngay từ đầu) và khối backfill của
        // Fix 1 phía sau đó cũng thành no-op — dùng đúng cơ chế đã có, không cần
        // thêm nhánh `else` lồng vào vòng lặp cũ.
        i = pendingCalls.length;
      }

      for (; i < pendingCalls.length; i++) {
        const call = pendingCalls[i]!;
        if (signal?.aborted) break;

        const tool = this.opts.tools.get(call.name);
        if (!tool) {
          this.pushToolResult(
            messages,
            xmlResults,
            call,
            `Không có công cụ tên "${call.name}". ` +
              `Các công cụ có sẵn: ${this.opts.tools.names().join(', ')}.`,
          );
          continue;
        }

        const parsedArgs = this.parseArgs(tool, call.arguments);
        if (!parsedArgs.ok) {
          if (repairs < this.maxRepairs) {
            repairs++;
            repairRequested = true;
            // Đối số hỏng vì model bị cắt giữa JSON là chuyện KHÁC hẳn đối số
            // sai schema. Nói "sai schema, gọi lại cho đúng" trong trường hợp đó
            // là bảo model sửa đúng thứ nó không làm sai — nó sẽ viết lại y
            // nguyên rồi lại bị cắt ở đúng chỗ cũ.
            const cutOff = finishReason === 'length';
            const reason = cutOff
              ? `${parsedArgs.error} (lời gọi bị cắt vì hết token đầu ra)`
              : parsedArgs.error;
            yield { type: 'repair', reason };
            logger.warn('đối số tool không dùng được, cho model sửa lại', {
              tool: call.name,
              attempt: repairs,
              cutOff,
            });
            this.pushToolResult(
              messages,
              xmlResults,
              call,
              cutOff
                ? `Lời gọi này bị cắt giữa chừng vì hết token đầu ra (${parsedArgs.error}). ` +
                    `Gọi lại với đối số NGẮN hơn — ví dụ ghi từng phần, hoặc thu hẹp phạm vi.`
                : `Đối số không hợp lệ: ${parsedArgs.error}\nGọi lại với đối số đúng schema.`,
            );
          } else {
            this.pushToolResult(
              messages,
              xmlResults,
              call,
              `Đối số không hợp lệ sau ${this.maxRepairs} lần thử: ${parsedArgs.error}. ` +
                `Bỏ qua lời gọi này — hãy thử cách khác hoặc trả lời bằng thông tin đã có.`,
            );
          }
          continue;
        }

        // ── Cổng quyền (M4) ──────────────────────────────────────────────
        // Đứng TRƯỚC tool_start và trước execute. Đặt sau execute thì việc
        // "từ chối" chỉ còn là che kết quả của một thao tác đã xảy ra rồi.
        //
        // Intent (mô tả + preview) được dựng cho MỌI tool ghi, kể cả khi cổng
        // quyền tắt: UI cần nó để hiển thị split diff sau khi tool chạy xong,
        // không chỉ để hỏi người dùng duyệt trước khi chạy.
        let intent: ToolIntent | undefined;
        if (!tool.readOnly) {
          const ctx = { ...this.opts.toolContext, ...(signal ? { signal } : {}) };
          intent = await this.describeIntent(tool, parsedArgs.value, ctx);
        }
        if (this.opts.permissions && !tool.readOnly) {
          const verdict = await this.opts.permissions.check({
            tool: tool.name,
            readOnly: tool.readOnly,
            summary: intent!.summary,
            ...(intent!.path ? { path: intent!.path } : {}),
            ...(intent!.preview ? { preview: intent!.preview } : {}),
            ...(intent!.previewKind ? { previewKind: intent!.previewKind } : {}),
            // Cảnh báo của tool đi thẳng vào cổng quyền, không chỉ ra UI: nó là
            // thứ BUỘC thao tác phải được hỏi, dù chế độ đang là gì.
            ...(intent!.warnings?.length ? { warnings: intent!.warnings } : {}),
          });

          if (!verdict.allowed) {
            const reason = verdict.reason ?? 'Không được phép.';
            logger.info('chặn tool theo quyền', { tool: call.name });
            yield { type: 'permission_denied', toolName: call.name, reason };
            this.pushToolResult(messages, xmlResults, call, reason);
            continue;
          }
        }

        // ── Hook preToolUse (M8) ─────────────────────────────────────────
        // Sau cổng quyền, trước execute. Thoát khác 0 = chặn, và lý do đi
        // thẳng về cho model dưới dạng tool result.
        if (this.opts.hooks) {
          const verdict = await this.opts.hooks.run({
            event: 'preToolUse',
            toolName: call.name,
            args: parsedArgs.value,
            ...(signal ? { signal } : {}),
          });
          if (!verdict.allowed) {
            const reason = verdict.reason ?? 'Bị hook của dự án chặn.';
            yield { type: 'hook_blocked', toolName: call.name, reason };
            this.pushToolResult(messages, xmlResults, call, reason);
            continue;
          }
        }

        toolCalls++;
        yield {
          type: 'tool_start',
          callId: call.id,
          toolName: call.name,
          toolArgs: parsedArgs.value,
        };

        startedAt = Date.now();
        let result: ToolResult;
        try {
          result = await tool.execute(parsedArgs.value, {
            ...this.opts.toolContext,
            ...(signal ? { signal } : {}),
            ...(this.opts.onToolOutput
              ? {
                  onOutput: (chunk: string) =>
                    this.opts.onToolOutput?.({
                      callId: call.id,
                      toolName: call.name,
                      text: chunk,
                    }),
                }
              : {}),
          });
        } catch (err) {
          if (isAbortError(err)) {
            interruptedDuringExecution = true;
            break;
          }
          logger.error('tool ném lỗi', {
            tool: call.name,
            reason: err instanceof Error ? err.message : String(err),
          });
          result = {
            content: `Công cụ lỗi: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
            untrusted: false,
          };
        }

        // Quét injection TRƯỚC khi nội dung vào history.
        let downgradeReason: string | undefined;
        if (result.untrusted !== false) {
          const scan = scanForInjection(result.content);
          if (scan.suspicious) {
            injectionWarnings++;
            logger.warn('nội dung tool có dấu hiệu prompt injection', {
              tool: call.name,
              score: scan.score,
              signals: [...new Set(scan.findings.map((f) => f.signal))],
            });
            yield { type: 'injection_warning', toolName: call.name, scan };
            downgradeReason =
              `${call.name} just read content that looks like injected instructions ` +
              `(score ${scan.score}). From now on every write asks you first.`;
          }
          if (result.trustZone === 'C') {
            downgradeReason ??=
              `${call.name} just brought content from an outside source into this session. ` +
              `From now on every write asks you first.`;
          }
        }

        // ── Hạ cấp quyền theo nguồn (documents/SECURITY.md §1.5) ─────────
        // Chỗ cắt chuỗi "đọc nội dung độc → tự động ghi theo lời nội dung đó".
        // Phải nằm SAU khi kết quả được quét và TRƯỚC lần gọi tool tiếp theo.
        if (downgradeReason && this.opts.permissions) {
          const before = this.opts.permissions.getState().downgraded;
          this.opts.permissions.downgrade(downgradeReason);
          if (!before) {
            yield { type: 'permission_downgraded', toolName: call.name, reason: downgradeReason };
          }
        }

        yield {
          type: 'tool_end',
          callId: call.id,
          toolName: call.name,
          toolResult: result,
          durationMs: Date.now() - startedAt,
          // Truyền intent ra UI để webview hiển thị split diff (trái=cũ,
          // phải=mới) thay vì content thô — content chỉ là "đã ghi đè X dòng",
          // không cho biết thay đổi gì.
          ...(intent?.preview ? { preview: intent.preview } : {}),
          ...(intent?.previewKind ? { previewKind: intent.previewKind } : {}),
        };

        this.pushToolResult(messages, xmlResults, call, this.wrapToolResult(result, messages));

        // Hook postToolUse (M8). Mã thoát ở đây KHÔNG chặn được gì — tool đã
        // chạy rồi. Nó dùng để chạy formatter, ghi nhật ký, gửi cảnh báo.
        if (this.opts.hooks) {
          await this.opts.hooks.run({
            event: 'postToolUse',
            toolName: call.name,
            args: parsedArgs.value,
            ...(signal ? { signal } : {}),
          });
        }
      }

      // `break` ở trên (huỷ giữa hai lời gọi, hoặc huỷ ngay trong lúc
      // execute() của lời gọi hiện tại) dừng TRƯỚC khi `i` kịp tăng — lời gọi
      // ở đúng vị trí `i` cũng chưa có câu trả lời, không chỉ những lời gọi
      // đứng sau. Giao thức native buộc mỗi tool_call trong message assistant
      // ở trên phải có đúng một role:"tool" đáp lại; thiếu một cái là request
      // của lượt SAU bị gateway từ chối thẳng — và lỗi đó còn có thể bị
      // isNativeToolsUnsupported hiểu nhầm thành "model không hỗ trợ native
      // tools" rồi tụt giao thức oan uổng.
      if (i < pendingCalls.length) {
        const cancelled: ToolResult = {
          content: 'Lượt bị huỷ giữa chừng — không có kết quả cho lời gọi này.',
          isError: true,
          untrusted: false,
        };

        // Lời gọi ở vị trí `i` đã có tool_start (UI đang hiện "đang chạy")
        // nhưng execute() bị cắt ngang trước khi tới tool_end — không phát
        // nốt thì UI treo mãi ở trạng thái "đang chạy" dù history đã đúng.
        if (interruptedDuringExecution) {
          const interrupted = pendingCalls[i]!;
          yield {
            type: 'tool_end',
            callId: interrupted.id,
            toolName: interrupted.name,
            toolResult: cancelled,
            durationMs: Date.now() - startedAt,
          };
        }

        for (; i < pendingCalls.length; i++) {
          this.pushToolResult(messages, xmlResults, pendingCalls[i]!, cancelled.content);
        }
      }

      // Một lượt tool = một message `user`. Gộp chứ không rải mỗi kết quả một
      // message: model đường XML đọc hội thoại như văn bản, và một chuỗi dài
      // các lượt `user` liên tiếp làm nó tưởng người dùng đang nói nhiều lần.
      if (this.protocol === 'xml' && xmlResults.length > 0) {
        messages.push({
          role: 'user',
          content:
            `${XML_TOOL_RESULT_PREFIX}\n\n${xmlResults.join('\n\n')}\n\n` +
            XML_TOOL_RESULT_FOOTER,
        });
      }

      if (repairRequested) continue;
    }

    logger.warn('chạm trần vòng lặp', { maxIterations: this.maxIterations });
    await this.runStopHook(signal);
    yield { type: 'iteration_limit', iterations };
    return this.result(
      finalText,
      messages,
      iterations,
      toolCalls,
      'iteration_limit',
      injectionWarnings,
      usage,
    );
  }

  /**
   * Chạy một lô lời gọi tool ĐỀU LÀ readOnly, tận dụng song song hoá I/O.
   *
   * Ba giai đoạn cố ý tách rời:
   *   1. Cổng (tuần tự, được yield): parse đối số + hook preToolUse. Hai bước
   *      này CHẠY TUẦN TỰ có chủ đích — `HookRunner.approved()` là check-then-
   *      act có await ở giữa, không khoá; hai lời gọi cùng kích hoạt một hook
   *      CHƯA duyệt mà chạy đồng thời có thể hỏi người dùng duyệt hai lần cho
   *      cùng một hook.
   *   2. Thực thi (song song, KHÔNG yield): đây là I/O thật sự chạy đồng thời —
   *      lý do toàn bộ hàm này tồn tại. Không yield được ở đây vì `yield` chỉ
   *      hợp lệ trong đúng stack của generator đang chạy, không xuyên qua được
   *      một `Promise.all` đang chờ nhiều lời gọi cùng lúc.
   *   3. Hoàn tất (tuần tự, được yield): quét injection + kiểm tra hạ cấp quyền
   *      PHẢI ở lại tuần tự — khối hạ cấp quyền hôm nay chỉ an toàn vì không có
   *      `await` nào giữa lúc đọc `getState().downgraded` và lúc yield event;
   *      để hai lời gọi chạy qua khối đó đồng thời sẽ mở lại đúng race đã tránh
   *      được nhờ tình cờ không có await.
   *
   * Nếu một lời gọi tự huỷ (AbortError) trong lúc đang chạy, các lời gọi khác
   * trong CÙNG lô — đã khởi động song song từ trước — vẫn chạy tiếp và trả kết
   * quả thật: đã khởi động song song thì không "huỷ ngược" một việc đang chạy
   * chỉ vì việc khác trong cùng lô gặp abort được.
   */
  private async *runReadOnlyBatch(
    pendingCalls: ToolCall[],
    messages: ChatMessage[],
    xmlResults: string[],
    signal: AbortSignal | undefined,
    logger: Logger,
    repairsIn: number,
  ): AsyncGenerator<
    AgentEvent,
    { repairs: number; repairRequested: boolean; toolCalls: number; injectionWarnings: number }
  > {
    let repairs = repairsIn;
    let repairRequested = false;
    let toolCalls = 0;
    let injectionWarnings = 0;

    const inFlight: Array<{ call: ToolCall; args: unknown; startedAt: number }> = [];

    // Pass 1 — cổng, TUẦN TỰ. Tool readOnly luôn được cổng quyền cho qua ngay
    // (xem `PermissionManager.check`), nên không cần describeIntent/permission
    // check ở đây — y hệt cách nhánh tuần tự hiện tại gate cho tool readOnly.
    for (const call of pendingCalls) {
      const tool = this.opts.tools.get(call.name)!; // allReadOnly đã đảm bảo tool tồn tại

      const parsedArgs = this.parseArgs(tool, call.arguments);
      if (!parsedArgs.ok) {
        if (repairs < this.maxRepairs) {
          repairs++;
          repairRequested = true;
          yield { type: 'repair', reason: parsedArgs.error };
          logger.warn('đối số tool sai schema, cho model sửa lại', {
            tool: call.name,
            attempt: repairs,
          });
          this.pushToolResult(
            messages,
            xmlResults,
            call,
            `Đối số không hợp lệ: ${parsedArgs.error}\nGọi lại với đối số đúng schema.`,
          );
        } else {
          this.pushToolResult(
            messages,
            xmlResults,
            call,
            `Đối số không hợp lệ sau ${this.maxRepairs} lần thử: ${parsedArgs.error}. ` +
              `Bỏ qua lời gọi này — hãy thử cách khác hoặc trả lời bằng thông tin đã có.`,
          );
        }
        continue;
      }

      if (this.opts.hooks) {
        const verdict = await this.opts.hooks.run({
          event: 'preToolUse',
          toolName: call.name,
          args: parsedArgs.value,
          ...(signal ? { signal } : {}),
        });
        if (!verdict.allowed) {
          const reason = verdict.reason ?? 'Bị hook của dự án chặn.';
          yield { type: 'hook_blocked', toolName: call.name, reason };
          this.pushToolResult(messages, xmlResults, call, reason);
          continue;
        }
      }

      toolCalls++;
      yield {
        type: 'tool_start',
        callId: call.id,
        toolName: call.name,
        toolArgs: parsedArgs.value,
      };
      inFlight.push({ call, args: parsedArgs.value, startedAt: Date.now() });
    }

    // Pass 2 — thực thi THẬT SỰ song song.
    const settled = await Promise.all(
      inFlight.map(({ call, args }) => this.runToolExecuteSafely(call, args, signal, logger)),
    );

    // Pass 3 — hoàn tất TUẦN TỰ, đúng thứ tự gọi ban đầu.
    for (let idx = 0; idx < inFlight.length; idx++) {
      const { call, args, startedAt } = inFlight[idx]!;
      const outcome = settled[idx]!;

      if (outcome.aborted) {
        const cancelled: ToolResult = {
          content: 'Lượt bị huỷ giữa chừng — không có kết quả cho lời gọi này.',
          isError: true,
          untrusted: false,
        };
        yield {
          type: 'tool_end',
          callId: call.id,
          toolName: call.name,
          toolResult: cancelled,
          durationMs: Date.now() - startedAt,
        };
        this.pushToolResult(messages, xmlResults, call, cancelled.content);
        continue;
      }

      const result = outcome.result;

      // Quét injection TRƯỚC khi nội dung vào history.
      let downgradeReason: string | undefined;
      if (result.untrusted !== false) {
        const scan = scanForInjection(result.content);
        if (scan.suspicious) {
          injectionWarnings++;
          logger.warn('nội dung tool có dấu hiệu prompt injection', {
            tool: call.name,
            score: scan.score,
            signals: [...new Set(scan.findings.map((f) => f.signal))],
          });
          yield { type: 'injection_warning', toolName: call.name, scan };
          downgradeReason =
            `${call.name} just read content that looks like injected instructions ` +
            `(score ${scan.score}). From now on every write asks you first.`;
        }
        if (result.trustZone === 'C') {
          downgradeReason ??=
            `${call.name} just brought content from an outside source into this session. ` +
            `From now on every write asks you first.`;
        }
      }

      // ── Hạ cấp quyền theo nguồn (documents/SECURITY.md §1.5) ─────────
      if (downgradeReason && this.opts.permissions) {
        const before = this.opts.permissions.getState().downgraded;
        this.opts.permissions.downgrade(downgradeReason);
        if (!before) {
          yield { type: 'permission_downgraded', toolName: call.name, reason: downgradeReason };
        }
      }

      yield {
        type: 'tool_end',
        callId: call.id,
        toolName: call.name,
        toolResult: result,
        durationMs: Date.now() - startedAt,
      };

      this.pushToolResult(messages, xmlResults, call, this.wrapToolResult(result, messages));

      if (this.opts.hooks) {
        await this.opts.hooks.run({
          event: 'postToolUse',
          toolName: call.name,
          args,
          ...(signal ? { signal } : {}),
        });
      }
    }

    return { repairs, repairRequested, toolCalls, injectionWarnings };
  }

  /**
   * Chạy `tool.execute()` một lời gọi, KHÔNG BAO GIỜ throw — dùng cho
   * `Promise.all` trong `runReadOnlyBatch`. Không phải generator nên không yield
   * được gì; mọi sự kiện cho lời gọi này do người gọi (`runReadOnlyBatch`) phát
   * sau khi Promise này settle.
   */
  private async runToolExecuteSafely(
    call: ToolCall,
    args: unknown,
    signal: AbortSignal | undefined,
    logger: Logger,
  ): Promise<{ aborted: true } | { aborted: false; result: ToolResult }> {
    const tool = this.opts.tools.get(call.name)!;
    try {
      const result = await tool.execute(args, {
        ...this.opts.toolContext,
        ...(signal ? { signal } : {}),
        ...(this.opts.onToolOutput
          ? {
              onOutput: (chunk: string) =>
                this.opts.onToolOutput?.({
                  callId: call.id,
                  toolName: call.name,
                  text: chunk,
                }),
            }
          : {}),
      });
      return { aborted: false, result };
    } catch (err) {
      if (isAbortError(err)) return { aborted: true };
      logger.error('tool ném lỗi', {
        tool: call.name,
        reason: err instanceof Error ? err.message : String(err),
      });
      return {
        aborted: false,
        result: {
          content: `Công cụ lỗi: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
          untrusted: false,
        },
      };
    }
  }

  /**
   * Hook `stop`. Lỗi của nó không được làm hỏng lượt: người dùng đã có câu trả
   * lời rồi, và một script nhật ký hỏng không phải lý do để nuốt kết quả.
   */
  private async runStopHook(signal: AbortSignal | undefined): Promise<void> {
    if (!this.opts.hooks?.has('stop')) return;
    try {
      await this.opts.hooks.run({ event: 'stop', ...(signal ? { signal } : {}) });
    } catch (err) {
      this.opts.logger.warn('hook stop lỗi', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Đưa kết quả một tool về cho model, đúng giao thức đang dùng.
   *
   * Native: `role: "tool"` ghép theo `toolCallId` — API đòi đúng cặp.
   * XML: gom lại, người gọi gộp thành một message `user` sau khi chạy hết
   * lượt. Không có `tool_call` native nào tồn tại ở đường này, nên cũng không
   * được có `role: "tool"` nào.
   */
  private pushToolResult(
    messages: ChatMessage[],
    xmlResults: string[],
    call: ToolCall,
    content: string,
  ): void {
    // Gateway AstraWork chặn toàn bộ request bằng 422 nếu tool result chứa
    // credential-like content. Redact tại biên DUY NHẤT trước history để secret
    // không rời máy; aggressive chỉ bật ở đường code/tool result, không bật cho
    // logger vì source thường có tên biến password/token vô hại.
    const redacted = this.redactor.redact(content, { aggressive: true });
    if (redacted.hits.length > 0) {
      this.opts.logger.warn('đã che secret trong tool result trước khi gọi model', {
        tool: call.name,
        hits: redacted.hits.length,
        rules: [...new Set(redacted.hits.map((hit) => hit.rule))],
      });
    }
    const safeContent = redacted.text;

    if (this.protocol === 'xml') {
      xmlResults.push(`${XML_TOOL_RESULT_HEADING}${call.name}\n${safeContent}`);
      return;
    }
    messages.push({ role: 'tool', toolCallId: call.id, content: safeContent });
  }

  /**
   * Che mọi đoạn giống credential trong history, TẠI CHỖ.
   *
   * Khác `buildRecoveryMessages` ngay ở chữ "tại chỗ": hàm kia dựng một bản sao
   * chỉ để gửi đi, hàm này sửa chính `messages` — thứ sẽ trở thành history của
   * phiên. Đó là điểm khác biệt quyết định, vì nguyên nhân 422 kiểu này nằm
   * TRONG hội thoại: không sửa nguồn thì mọi lượt sau đều mang lại đúng đoạn
   * đó và đều bị chặn lại.
   *
   * Có che cả message của người dùng. Đây là đánh đổi có ý thức: người dùng dán
   * một đoạn log rồi thấy `[REDACTED:...]` trong chính câu mình vừa gõ là khó
   * chịu, nhưng lựa chọn còn lại là lượt chat chết hẳn với một mã lỗi. Nói ra
   * qua `context_recovery` để họ biết vì sao model đọc thiếu, thay vì im lặng.
   *
   * `aggressive: true` vì đây đúng là đường tool result / mã nguồn: bộ rule đó
   * được chọn để là TẬP CHA của bộ rule chặn phía gateway, nên che xong là chắc
   * chắn qua được. Hai bộ lệch nhau thì hàm này trả về > 0 mà request vẫn 422,
   * và người gọi ném lỗi ra — xem test `secretRules.test.ts`.
   *
   * @returns số message thật sự đổi nội dung. `0` = không có gì trong tầm bộ
   * rule của ta, nên gửi lại cũng vô ích.
   */
  private maskSecrets(messages: ChatMessage[]): number {
    let changed = 0;
    const clean = (text: string): string => this.redactor.redactText(text, { aggressive: true });

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!;

      switch (message.role) {
        case 'system': {
          const content = clean(message.content);
          if (content === message.content) break;
          messages[i] = { role: 'system', content };
          changed++;
          break;
        }
        case 'user': {
          const content = clean(message.content);
          if (content === message.content) break;
          messages[i] = {
            role: 'user',
            content,
            ...(message.images?.length ? { images: message.images } : {}),
          };
          changed++;
          break;
        }
        case 'assistant': {
          // Đối số tool cũng phải che: nội dung file mà model sắp ghi đi trong
          // `arguments`, và gateway quét mọi chuỗi trong body chứ không chỉ
          // phần `content`.
          const content = message.content === null ? null : clean(message.content);
          const calls = message.toolCalls?.map((call) => ({
            ...call,
            arguments: clean(call.arguments),
          }));
          const argsChanged = (calls ?? []).some(
            (call, idx) => call.arguments !== message.toolCalls?.[idx]?.arguments,
          );
          if (content === message.content && !argsChanged) break;
          messages[i] = {
            role: 'assistant',
            content,
            ...(calls?.length ? { toolCalls: calls } : {}),
          };
          changed++;
          break;
        }
        case 'tool': {
          const content = clean(message.content);
          if (content === message.content) break;
          messages[i] = { role: 'tool', toolCallId: message.toolCallId, content };
          changed++;
          break;
        }
      }
    }

    return changed;
  }

  /**
   * Dựng view provider-only sau 422; không mutate history cục bộ.
   *
   * Native tool transcript được hạ thành văn bản thường để loại thêm một nguồn
   * schema 422 nhưng vẫn giữ kết quả cho model tiếp tục. Việc này cũng khiến
   * lần fallback XML kế tiếp hợp lệ: không còn `role: tool` mồ côi khi request
   * không gửi `tools`.
   */
  private buildRecoveryMessages(messages: ChatMessage[]): ChatMessage[] {
    const toolNames = new Map<string, string>();
    const out: ChatMessage[] = [];

    const safe = (content: string, limit = RECOVERY_MESSAGE_CHARS): string =>
      truncateMiddle(this.redactor.redactText(content, { aggressive: true }), limit);

    for (const message of messages) {
      switch (message.role) {
        case 'system':
          out.push({ role: 'system', content: safe(message.content) });
          break;
        case 'user':
          out.push({
            role: 'user',
            content: safe(message.content),
            ...(message.images?.length ? { images: message.images } : {}),
          });
          break;
        case 'assistant': {
          const parts: string[] = [];
          if (message.content) parts.push(safe(message.content));
          for (const call of message.toolCalls ?? []) {
            toolNames.set(call.id, call.name);
            parts.push(
              `[Local tool request: ${call.name} ${safe(call.arguments, RECOVERY_TOOL_RESULT_CHARS)}]`,
            );
          }
          out.push({
            role: 'assistant',
            content: parts.join('\n') || '[Local tool request completed]',
          });
          break;
        }
        case 'tool':
          out.push({
            role: 'user',
            content:
              `[Recovered local result for ${toolNames.get(message.toolCallId) ?? message.toolCallId}]\n` +
              safe(message.content, RECOVERY_TOOL_RESULT_CHARS),
          });
          break;
      }
    }

    return out;
  }

  /**
   * Bọc delimiter + cắt ngắn.
   *
   * Cắt ở GIỮA chứ không cắt đuôi: phần đầu cho biết đang xem cái gì, phần cuối
   * thường là chỗ có kết luận. Cắt đuôi thẳng làm mất nửa sau của mọi file dài.
   *
   * Trần cắt tính ĐỘNG theo phần context còn trống thật lúc này (`messages`
   * hiện tại của lượt) qua `toolResultCharBudget` — không phải một số cố định
   * suy từ model. Đầu lượt còn nhiều chỗ thì gần như không cắt; cuối một lượt
   * dài đã dùng nhiều context thì trần co lại đúng bằng phần còn trống thật.
   * Không có `contextWindow` để đo (host không truyền) thì rơi về trần tĩnh
   * `maxToolResultChars`.
   */
  private wrapToolResult(result: ToolResult, messages: ChatMessage[]): string {
    let content = result.content;
    const limit = this.opts.contextWindow
      ? toolResultCharBudget(
          new ContextBudget({
            contextWindow: this.opts.contextWindow,
            ...(this.opts.compactAt !== undefined ? { compactAt: this.opts.compactAt } : {}),
            ...(this.opts.warnAt !== undefined ? { warnAt: this.opts.warnAt } : {}),
          }).measure(messages),
          this.maxToolResultChars,
        )
      : this.maxToolResultChars;

    if (content.length > limit) {
      const half = Math.floor(limit / 2);
      const omitted = content.length - limit;
      content =
        content.slice(0, half) +
        `\n\n… [đã lược bỏ ${omitted} ký tự ở giữa — thu hẹp phạm vi tìm nếu cần phần này] …\n\n` +
        content.slice(content.length - half);
    }

    if (result.untrusted === false) return content;

    return `${XML_TOOL_RESULT_OPEN}\n${content}\n${XML_TOOL_RESULT_CLOSE}`;
  }

  private parseArgs(
    tool: Tool,
    raw: string,
  ): { ok: true; value: unknown } | { ok: false; error: string } {
    let json: unknown;
    try {
      json = raw.trim() === '' ? {} : JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        error: `không phải JSON hợp lệ (${err instanceof Error ? err.message : 'lỗi parse'})`,
      };
    }

    const parsed = (tool.schema as z.ZodTypeAny).safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 4)
        .map((i) => `${i.path.join('.') || '(gốc)'}: ${i.message}`)
        .join('; ');
      return { ok: false, error: issues };
    }
    return { ok: true, value: parsed.data };
  }

  /**
   * Mô tả thao tác sắp làm cho hộp duyệt quyền.
   *
   * `describe()` của tool đọc file để dựng diff, nên nó CÓ THỂ ném (file biến
   * mất, quyền đọc bị từ chối). Ném ở đây sẽ giết cả lượt chat vì một lời xem
   * trước — nên bọc lại và lùi về mô tả thô. Người dùng vẫn duyệt được, chỉ là
   * không nhìn thấy diff.
   */
  private async describeIntent(
    tool: Tool,
    args: unknown,
    ctx: ToolContext,
  ): Promise<ToolIntent> {
    const fallback: ToolIntent = { summary: `${tool.name}` };
    if (!tool.describe) return fallback;
    try {
      return await tool.describe(args, ctx);
    } catch (err) {
      this.opts.logger.debug('không dựng được mô tả thao tác', {
        tool: tool.name,
        reason: err instanceof Error ? err.message : String(err),
      });
      return fallback;
    }
  }

  private jsonSchemaOf(tool: Tool): Record<string, unknown> {
    return (
      this.opts.tools.definitions().find((d) => d.name === tool.name)?.parameters ?? {}
    );
  }

  private result(
    text: string,
    messages: ChatMessage[],
    iterations: number,
    toolCalls: number,
    stoppedBy: AgentRunResult['stoppedBy'],
    injectionWarnings: number,
    usage: TokenUsage,
    error?: AgentRunResult['error'],
  ): AgentRunResult {
    return {
      text,
      messages,
      iterations,
      toolCalls,
      stoppedBy,
      injectionWarnings,
      usage,
      ...(error ? { error } : {}),
    };
  }
}
