/**
 * Thử lại cho đúng hai mã: 429 (vượt hạn mức) và 503 (model tạm không phục vụ).
 *
 * Hai mã đó nói "lát nữa gọi lại đi"; mọi mã 4xx còn lại nói "request của anh
 * sai" — thử lại chỉ tốn thời gian và làm hỏng thêm hạn mức. Nên danh sách này
 * cố ý hẹp, và đừng nới: một `400` hay `401` được thử lại 4 lần là 30 giây mất
 * trắng cho mỗi ticket, nhân với số ticket của cả một đêm.
 *
 * Bốn lần chờ 2s/4s/8s/16s → tối đa 5 lượt gọi và 30 giây chờ cho một ticket.
 */

export const RETRY_STATUSES = new Set([429, 503]);
export const BACKOFF_MS = [2000, 4000, 8000, 16000];

/** Lỗi HTTP đáng thử lại. Chỉ lỗi thuộc lớp này mới được `withRetry` bắt. */
export class RetryableHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RetryableHttpError';
    this.status = status;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Chạy `fn`, thử lại khi nó ném `RetryableHttpError`.
 *
 * Mọi loại lỗi khác ném thẳng ra ngoài ngay lần đầu — kể cả lỗi mạng: hợp đồng
 * nói "chỉ 429 và 503", và đoán thêm ở đây là tự ý nới.
 *
 * @param {() => Promise<any>} fn
 * @param {{delays?: number[], sleep?: (ms:number)=>Promise<void>, onRetry?: (info:{status:number, attempt:number, of:number, waitMs:number, message:string})=>void, signal?: AbortSignal}} opts
 */
export async function withRetry(fn, { delays = BACKOFF_MS, sleep = defaultSleep, onRetry = () => {}, signal } = {}) {
  let last;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RetryableHttpError)) throw err;
      last = err;
      if (attempt === delays.length) break;
      const waitMs = delays[attempt];
      onRetry({
        status: err.status,
        attempt: attempt + 1,
        of: delays.length,
        waitMs,
        message: err.message,
      });
      await sleep(waitMs);
      if (signal?.aborted) throw new Error('job đã bị huỷ trong lúc chờ thử lại.');
    }
  }
  throw new Error(`${last.message} — đã thử lại ${delays.length} lần (${delays.map((d) => `${d / 1000}s`).join('/')}) mà vẫn ${last.status}.`);
}
