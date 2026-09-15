/**
 * Phân loại lỗi HTTP và tính thời gian chờ.
 *
 * Quy tắc: retry CHሆ cho 429 và 5xx. Mọi 4xx khác ném
 * ngay — retry một request sai định dạng chỉ làm hỏng nhanh hơn.
 *
 * Chỗ tinh tế: 429 có hai nghĩa hoàn toàn khác nhau ở gateway AstraWork.
 * Rate limit thì chờ rồi thử lại được. Vượt AI budget thì chờ bao lâu cũng vô
 * ích, và đổi model cũng vô ích vì budget tính theo user. Nhầm hai cái này
 * nghĩa là quay vòng vô hạn khi user hết hạn mức.
 */
import {
  AstraError,
  BudgetExceededError,
  ContentRejectedError,
  ProviderError,
  RateLimitedError,
} from '../errors.js';

/** Dấu hiệu 429 là do budget chứ không phải rate limit. */
const BUDGET_MARKERS =
  /budget|quota|hạn mức|limit exceeded|insufficient[_ ]?(credit|balance)/i;

/**
 * Chỗ `GatewayProvider` gắn body THÔ của response lỗi vào chính error object.
 *
 * Cần đường vòng này vì SDK openai vứt mất body của lỗi kiểu FastAPI: nó chỉ đọc
 * `body.error`, và AstraWork trả `{"detail": ..., "findings": ...}` nên
 * `APIError.makeMessage` rơi vào nhánh cuối và in ra đúng một câu
 * `"422 status code (no body)"`. Toàn bộ thông tin để biết PHẢI LÀM GÌ đã bị bỏ
 * trước khi tới được AstraCode.
 *
 * Dùng `Symbol.for` chứ không phải một field thường: không lọt vào
 * `JSON.stringify` của log, và không đụng field nào SDK có thể thêm sau này.
 */
export const RAW_ERROR_BODY: unique symbol = Symbol.for('astra.rawErrorBody') as never;

export interface HttpErrorLike {
  status?: number;
  message?: string;
  headers?: Record<string, string> | Headers;
  /** Body đã parse, nếu SDK cung cấp. */
  error?: unknown;
  /** Body thô do `GatewayProvider` chụp lại — xem `RAW_ERROR_BODY`. */
  [RAW_ERROR_BODY]?: string;
}

/**
 * Body lỗi của gateway, ở cả hai shape có thể gặp.
 *
 * `detail`/`findings` là shape của FastAPI (AstraWork); `error.message` là shape
 * OpenAI mà các endpoint model trả về. Đọc cả hai vì route `/v1/` là đường lai:
 * middleware của gateway trả shape thứ nhất, lỗi upstream đi qua trả shape thứ hai.
 */
export interface GatewayErrorBody {
  detail?: string;
  findings?: Record<string, number>;
  code?: string;
  error?: { message?: string; code?: string };
}

/** Đọc body thô thành shape đã biết. Trả `undefined` nếu không phải JSON object. */
export function parseGatewayErrorBody(raw: string | undefined): GatewayErrorBody | undefined {
  if (!raw || !raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;

  const bag = parsed as Record<string, unknown>;
  const out: GatewayErrorBody = {};

  // `detail` của FastAPI là chuỗi ở nhánh HTTPException, nhưng là mảng ở nhánh
  // RequestValidationError. Ép cả hai về một câu đọc được.
  if (typeof bag.detail === 'string') out.detail = bag.detail;
  else if (bag.detail !== undefined) out.detail = safeStringify(bag.detail);

  if (typeof bag.code === 'string') out.code = bag.code;

  if (typeof bag.findings === 'object' && bag.findings !== null && !Array.isArray(bag.findings)) {
    const findings: Record<string, number> = {};
    for (const [rule, count] of Object.entries(bag.findings as Record<string, unknown>)) {
      if (typeof count === 'number') findings[rule] = count;
    }
    out.findings = findings;
  }

  if (typeof bag.error === 'object' && bag.error !== null && !Array.isArray(bag.error)) {
    const e = bag.error as Record<string, unknown>;
    out.error = {
      ...(typeof e.message === 'string' ? { message: e.message } : {}),
      ...(typeof e.code === 'string' ? { code: e.code } : {}),
    };
  }

  return out;
}

/**
 * 422 này có phải "gateway chặn vì nội dung giống credential" không.
 *
 * Xét CẤU TRÚC trước, câu chữ sau. `findings` chỉ do middleware sanitization của
 * AstraWork gắn vào, nên sự tồn tại của nó là bằng chứng đủ mạnh và không vỡ khi
 * bên kia sửa lại câu thông báo — đúng bài học của mục #18 trong OPEN-ISSUES.
 * Nhánh khớp chữ chỉ để đỡ cho gateway phiên bản cũ chưa gửi `findings`.
 */
function isContentRejection(body: GatewayErrorBody): boolean {
  if (body.findings && Object.keys(body.findings).length > 0) return true;
  if (body.code === 'secret_detected') return true;
  const text = `${body.detail ?? ''} ${body.error?.message ?? ''}`;
  return /credential-like content|credential_harvest|secret detected/i.test(text);
}

export function classifyHttpError(err: unknown): AstraError {
  if (err instanceof AstraError) return err;

  const e = err as HttpErrorLike;
  const status = typeof e?.status === 'number' ? e.status : undefined;
  const raw = typeof e?.message === 'string' ? e.message : String(err);

  const body = parseGatewayErrorBody(e?.[RAW_ERROR_BODY]);
  const bodyDetail = body?.detail ?? body?.error?.message;
  // `raw` của SDK thường là `"<status> status code (no body)"` cho mọi lỗi kiểu
  // FastAPI. Chụp được body thì thay bằng câu gateway thật sự nói — mọi nhánh
  // dưới đây, kể cả nhận diện budget, đọc câu đó chứ không đọc câu rỗng nghĩa.
  const message = bodyDetail && status !== undefined ? `${status} ${bodyDetail}` : raw;

  if (status === 401 || status === 403) {
    // 403 ở đây gần như luôn là RBAC: user không được dùng model này.
    // Không retry, không failover — đổi model là việc của người dùng.
    return new ProviderError(message, status, err);
  }

  if (status === 422 && body && isContentRejection(body)) {
    return new ContentRejectedError(
      bodyDetail ?? raw,
      body.findings ?? {},
      status,
      err,
    );
  }

  if (status === 429) {
    const haystack = `${message} ${safeStringify(e?.error)}`;
    if (BUDGET_MARKERS.test(haystack)) {
      return new BudgetExceededError(bodyDetail ?? extractDetail(e) ?? message, err);
    }
    const retryAfter = parseRetryAfter(e?.headers);
    return retryAfter !== undefined
      ? new RateLimitedError(retryAfter, err)
      : new RateLimitedError(undefined, err);
  }

  if (status !== undefined && status >= 400 && status < 500) {
    return new ProviderError(message, status, err);
  }

  return new ProviderError(message, status, err);
}

function extractDetail(e: HttpErrorLike): string | undefined {
  const body = e?.error as { detail?: unknown; message?: unknown } | undefined;
  if (typeof body?.detail === 'string') return body.detail;
  if (typeof body?.message === 'string') return body.message;
  return undefined;
}

function safeStringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

/** Retry-After theo giây, hoặc theo HTTP-date. Trả về milli-giây. */
export function parseRetryAfter(headers: HttpErrorLike['headers']): number | undefined {
  if (!headers) return undefined;
  const raw =
    headers instanceof Headers
      ? headers.get('retry-after')
      : (headers['retry-after'] ?? headers['Retry-After']);
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Nguồn ngẫu nhiên — tiêm vào để test tất định. */
  random?: () => number;
}

/**
 * Exponential backoff có jitter. Jitter quan trọng khi nhiều dev cùng bị 429
 * một lúc — không có nó thì cả nhóm cùng thử lại đúng một thời điểm.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 30_000;
  const random = opts.random ?? Math.random;
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.5 + random() * 0.5));
}

/** Chờ, nhưng bỏ chờ ngay nếu bị hủy. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
