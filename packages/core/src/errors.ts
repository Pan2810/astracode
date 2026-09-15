/**
 * Phân loại lỗi của AstraCode.
 *
 * Lý do có file này thay vì ném Error trần: quyết định "có retry không" và
 * "có báo user không" phải đọc được từ kiểu lỗi, không phải từ việc dò chuỗi
 * message — dò chuỗi là thứ vỡ âm thầm khi gateway đổi wording.
 */

export type AstraErrorCode =
  | 'auth_required'
  | 'budget_exceeded'
  | 'rate_limited'
  | 'gateway_unreachable'
  | 'provider_error'
  | 'content_rejected'
  | 'stream_interrupted'
  | 'config_error'
  | 'aborted';

export class AstraError extends Error {
  readonly code: AstraErrorCode;
  /** Retry cùng model có khả năng thành công không. */
  readonly retryable: boolean;
  /** Chuyển sang model khác trong fallback chain có ý nghĩa không. */
  readonly failoverable: boolean;
  override readonly cause?: unknown;

  constructor(
    code: AstraErrorCode,
    message: string,
    opts: { retryable?: boolean; failoverable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.failoverable = opts.failoverable ?? false;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * 401 từ gateway. Phiên được gia hạn TRƯỚC khi hết hạn (AstraWorkAuth.ensureFresh);
 * tới được đây nghĩa là cách đó đã không kịp hoặc quyền đã bị thu hồi, và
 * /auth/refresh cũng sẽ 401. User phải đăng nhập lại. Đừng retry.
 */
export class AuthRequiredError extends AstraError {
  constructor(message = 'Sign in to AstraWork again', cause?: unknown) {
    super('auth_required', message, { retryable: false, failoverable: false, cause });
  }
}

/**
 * 429 do vượt hạn mức AI budget. Khác hẳn rate limit: chờ rồi thử lại không
 * giúp gì, và đổi model cũng không (budget tính theo user, không theo model).
 */
export class BudgetExceededError extends AstraError {
  readonly detail: string;
  constructor(detail: string, cause?: unknown) {
    super('budget_exceeded', `AI budget exceeded: ${detail}`, {
      retryable: false,
      failoverable: false,
      cause,
    });
    this.detail = detail;
  }
}

/** 429 do rate limit. Chờ rồi thử lại. */
export class RateLimitedError extends AstraError {
  readonly retryAfterMs: number | undefined;
  constructor(retryAfterMs?: number, cause?: unknown) {
    super('rate_limited', 'Rate limited', {
      retryable: true,
      failoverable: true,
      cause,
    });
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Không kết nối được gateway. KHÔNG bao giờ tự chuyển sang gọi thẳng FPT —
 * xem documents/SECURITY.md §2 và ADR-011.
 */
export class GatewayUnreachableError extends AstraError {
  constructor(baseURL: string, cause?: unknown) {
    super('gateway_unreachable', `Cannot reach the AstraWork gateway (${baseURL})`, {
      retryable: true,
      failoverable: false,
      cause,
    });
  }
}

/** 5xx hoặc lỗi không phân loại được từ phía model/gateway. */
export class ProviderError extends AstraError {
  readonly status: number | undefined;
  constructor(message: string, status?: number, cause?: unknown) {
    const retryable = status === undefined || status >= 500;
    super('provider_error', message, { retryable, failoverable: retryable, cause });
    this.status = status;
  }
}

/**
 * Gateway từ chối CẢ REQUEST vì nội dung bên trong trông giống credential.
 *
 * AstraWork quét mọi chuỗi trong body bằng một bộ regex chặn cứng
 * (`middleware/sanitization.py`) và trả 422 kèm `findings` — tên rule và số lần
 * khớp, không kèm giá trị. Nguồn hay khớp nhất là những dòng hoàn toàn vô hại
 * trong mã nguồn (`password: string;` trong một interface TypeScript), nên đây
 * KHÔNG phải bằng chứng có secret thật; nó là bằng chứng request này sẽ không
 * bao giờ đi qua nếu gửi lại y nguyên.
 *
 * Tách khỏi `ProviderError` để `AgentLoop` phân biệt được ba loại 422 vốn trước
 * đây trông giống hệt nhau: loại này (che nội dung rồi gửi lại là xong), 422 sai
 * shape request (phải dựng lại transcript), và 422 không có body (không biết gì,
 * phải đoán). Đoán khi đã biết là chỗ lượt chat chết oan.
 *
 * Không retry và không failover: đổi model không đổi được nội dung hội thoại.
 */
export class ContentRejectedError extends AstraError {
  readonly status: number;
  /** Câu gateway nói, nguyên văn — để log và để hiện khi không che được gì. */
  readonly detail: string;
  /** Tên rule → số lần khớp. Rỗng nếu gateway không kèm `findings`. */
  readonly findings: Record<string, number>;

  constructor(
    detail: string,
    findings: Record<string, number> = {},
    status = 422,
    cause?: unknown,
  ) {
    const rules = Object.keys(findings);
    super(
      'content_rejected',
      `AstraWork blocked this request: the conversation contains credential-like content` +
        `${rules.length > 0 ? ` (${rules.join(', ')})` : ''}.`,
      { retryable: false, failoverable: false, cause },
    );
    this.status = status;
    this.detail = detail;
    this.findings = findings;
  }
}

/**
 * Stream đứt SAU khi đã có nội dung chảy ra ngoài.
 *
 * Lý do phải có kiểu riêng: `retryable`/`failoverable` được tính từ mã HTTP, và
 * theo mã thì một 5xx giữa stream "retry được". Nhưng retry ở tầng HTTP nghĩa là
 * gửi lại cả request và phát lại TOÀN BỘ text từ đầu — bên nhận (`AgentLoop`)
 * nối `text += delta` nên câu trả lời và history đều có hai bản; nếu request đầu
 * đã phát `tool_call` thì lần hai còn chạy lại cả hành động ghi. Failover sang
 * model khác cũng đúng vấn đề đó.
 *
 * Nên: sau khi đã phát nội dung, request KHÔNG được thử lại ở tầng dưới. Việc
 * quyết định làm gì tiếp là của tầng trên, nơi biết đã nhận được những gì.
 */
export class StreamInterruptedError extends AstraError {
  readonly status: number | undefined;
  /** Đã có delta chảy ra trước khi đứt. Luôn `true` — để chỗ nhận đọc được ý. */
  readonly partial = true;

  constructor(reason: string, status?: number, cause?: unknown) {
    super(
      'stream_interrupted',
      `The connection dropped while the model was answering (${reason}). ` +
        `The reply above is incomplete; it was not retried, to avoid repeating it.`,
      { retryable: false, failoverable: false, cause },
    );
    this.status = status;
  }
}

export class ConfigError extends AstraError {
  constructor(message: string) {
    super('config_error', message, { retryable: false, failoverable: false });
  }
}

export class AbortedError extends AstraError {
  constructor(message = 'Cancelled') {
    super('aborted', message, { retryable: false, failoverable: false });
  }
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof AbortedError) return true;
  if (err instanceof Error) {
    return err.name === 'AbortError' || err.name === 'APIUserAbortError';
  }
  return false;
}
