/**
 * Trần số lượt judge chạy cùng lúc trên TOÀN server.
 *
 * Trong một job các ticket vốn đã chạy tuần tự (xem `analyze.mjs`), nên trần này
 * chỉ có tác dụng khi AstraQA bắn nhiều job chồng nhau — đúng lúc dễ đụng hạn
 * mức request/phút của nhà cung cấp nhất. Đặt ở cấp server chứ không cấp job là
 * cố ý: hạn mức tính theo API key, mà key thì cả server dùng chung.
 */

/** @param {number} max số lượt được chạy đồng thời (>=1) */
export function createLimiter(max = 2) {
  const cap = Math.max(1, Number(max) || 1);
  let active = 0;
  /** @type {Array<() => void>} */
  const waiting = [];

  function release() {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  /** Chạy `fn` khi có chỗ. Trả đúng thứ `fn` trả, ném đúng thứ `fn` ném. */
  async function run(fn) {
    if (active >= cap) {
      await new Promise((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { run, cap, get active() { return active; }, get waiting() { return waiting.length; } };
}
