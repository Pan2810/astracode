/**
 * Thử lại cho đúng những mã nói "lát nữa gọi lại đi".
 *
 * Mọi mã 4xx còn lại nói "request của anh sai" — thử lại chỉ tốn thời gian và
 * làm hỏng thêm hạn mức. Nên danh sách này cố ý hẹp: một `400` hay `401` được
 * thử lại 4 lần là 15 giây mất trắng cho mỗi ticket, nhân với số ticket của cả
 * một đêm. Nhưng "hẹp" nghĩa là loại 4xx, không phải loại timeout tầng gateway.
 *
 * ## Vì sao có thêm nhóm 5xx của gateway
 *
 * Ðo được trên lần chạy thật 2026-09-21: một ticket chết với
 * `FCI trả 524: <!DOCTYPE html>` sau 125 giây. `524` là "origin timeout" của
 * Cloudflare — đúng loại "lát nữa gọi lại đi", nhưng vì không nằm trong danh
 * sách nên nó ném thẳng và cả ticket mất trắng một lượt đã trả tiền chờ.
 *
 * Nhóm được nhận, và lý do của từng mã:
 *   429 — vượt hạn mức, nhà cung cấp bảo chờ
 *   502 — bad gateway: proxy không nói chuyện được với origin lúc này
 *   503 — model tạm không phục vụ
 *   504 — gateway timeout
 *   522 — Cloudflare không mở được kết nối tới origin
 *   524 — origin nhận request nhưng trả lời quá chậm
 *
 * KHÔNG nhận `500` (có thể là lỗi tất định do chính payload của ta — thử lại 4
 * lần cho mỗi ticket là phí), và KHÔNG nhận `525`/`526` (sai cấu hình TLS,
 * thử lại không bao giờ thành).
 *
 * Bốn lần chờ 1s/2s/4s/8s → tối đa 5 lượt gọi và 15 giây CHỜ cho một ticket.
 *
 * ## `deadlineAt` — vì sao chỉ đếm thời gian chờ là chưa đủ
 *
 * 15 giây là tổng thời gian NẰM CHỜ, không phải tổng thời gian chạy. Một `429`
 * trả về tức thì nên hai con số gần bằng nhau; một `524` thì không — lần chạy
 * thật mất 125 giây mới biết là hỏng. Thử lại bốn lần kiểu ấy là hơn tám phút
 * cho một ticket, trong khi bên gọi chỉ xin `timeout_sec`.
 *
 * Nên người gọi truyền `deadlineAt`: hết hạn thì thôi không thử nữa, dù còn
 * lượt. Không truyền thì giữ nguyên hành vi cũ.
 *
 * ## `Retry-After` thắng bảng chờ
 *
 * Bảng trên là phỏng đoán; `Retry-After` là nhà cung cấp tự nói còn bao lâu nữa
 * mới hết cửa sổ hạn mức. Chờ ít hơn con số ấy là cầm chắc thêm một 429 nữa,
 * nên khi header có mặt thì nó thắng. Trần `RETRY_AFTER_CAP_MS` để một header
 * hỏng (hoặc một `Retry-After: 3600`) không treo cả job một tiếng — quá trần
 * thì thà hỏng sớm, AstraQA chạy lại rẻ hơn là chờ.
 */

export const RETRY_STATUSES = new Set([429, 502, 503, 504, 522, 524]);
export const BACKOFF_MS = [1000, 2000, 4000, 8000];

/** Trần cho `Retry-After`. Nhà cung cấp đòi chờ lâu hơn thế thì bỏ cuộc. */
export const RETRY_AFTER_CAP_MS = 60_000;

/** Lỗi HTTP đáng thử lại. Chỉ lỗi thuộc lớp này mới được `withRetry` bắt. */
export class RetryableHttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {number|null} [retryAfterMs] giá trị `Retry-After` đã đổi ra ms, nếu header có.
   */
  constructor(status, message, retryAfterMs = null) {
    super(message);
    this.name = 'RetryableHttpError';
    this.status = status;
    this.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : null;
  }
}

/**
 * `Retry-After` → ms, hoặc `null` nếu không đọc được.
 *
 * RFC cho phép hai dạng: số giây (`Retry-After: 30`) và một HTTP-date
 * (`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`). Nhận cả hai; mọi thứ khác trả
 * `null` để người gọi rơi về bảng chờ, chứ không đoán.
 *
 * @param {string|null|undefined} raw
 * @param {number} [now] mốc thời gian, để test không phụ thuộc đồng hồ thật.
 */
export function parseRetryAfter(raw, now = Date.now()) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const ms = Number(s) * 1000;
    return ms > 0 ? ms : null;
  }
  const at = Date.parse(s);
  if (!Number.isFinite(at)) return null;
  const ms = at - now;
  return ms > 0 ? ms : null;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Chạy `fn`, thử lại khi nó ném `RetryableHttpError`.
 *
 * Mọi loại lỗi khác ném thẳng ra ngoài ngay lần đầu — kể cả lỗi mạng: hợp đồng
 * nói "chỉ 429 và 503", và đoán thêm ở đây là tự ý nới.
 *
 * @param {() => Promise<any>} fn
 * @param {{delays?: number[], sleep?: (ms:number)=>Promise<void>, onRetry?: (info:{status:number, attempt:number, of:number, waitMs:number, source:'retry-after'|'backoff', message:string})=>void, signal?: AbortSignal}} opts
 */
export async function withRetry(
  fn,
  { delays = BACKOFF_MS, sleep = defaultSleep, onRetry = () => {}, signal, deadlineAt = null, now = () => Date.now() } = {},
) {
  let last;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RetryableHttpError)) throw err;
      last = err;
      if (attempt === delays.length) break;
      // Header thắng bảng chờ, nhưng không được vượt trần.
      const asked = err.retryAfterMs;
      const useHeader = Number.isFinite(asked) && asked > 0 && asked <= RETRY_AFTER_CAP_MS;
      const waitMs = useHeader ? asked : delays[attempt];
      // Ngân sách của bên gọi đã hết thì dừng ở đây: lượt sau có thể lại mất
      // hai phút mới biết là hỏng, và bên gọi thà nhận lỗi sớm.
      if (deadlineAt !== null && now() + waitMs >= deadlineAt) {
        throw new Error(`${last.message} — hết ngân sách thời gian sau ${attempt} lần thử lại, không thử tiếp.`);
      }
      onRetry({
        status: err.status,
        attempt: attempt + 1,
        of: delays.length,
        waitMs,
        source: useHeader ? 'retry-after' : 'backoff',
        message: err.message,
      });
      await sleep(waitMs);
      if (signal?.aborted) throw new Error('job đã bị huỷ trong lúc chờ thử lại.');
    }
  }
  throw new Error(`${last.message} — đã thử lại ${delays.length} lần (${delays.map((d) => `${d / 1000}s`).join('/')}) mà vẫn ${last.status}.`);
}
