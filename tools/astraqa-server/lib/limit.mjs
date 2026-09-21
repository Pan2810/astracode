/**
 * Trần số lượt judge chạy cùng lúc trên TOÀN server.
 *
 * Trong một job analyze các ticket vốn đã chạy tuần tự, nên trần này có tác
 * dụng ở hai chỗ: khi AstraQA bắn nhiều job chồng nhau, và trong một job judge
 * (nhiều lane cùng chạy). Đặt ở cấp server chứ không cấp job là cố ý: hạn mức
 * tính theo API key, mà key thì cả server dùng chung.
 *
 * ## Vì sao TRAO chỗ chứ không nhả rồi cho tranh lại
 *
 * Bản đầu nhả chỗ trước (`active -= 1`) rồi mới đánh thức người xếp hàng, và
 * người được đánh thức làm `active += 1` mà không kiểm lại trần. Giữa hai việc
 * ấy là một khe microtask, và bất cứ ai gọi `run()` trong khe đó đều thấy còn
 * chỗ trống nên đi thẳng vào — rồi người xếp hàng cũng vào nốt. Ðúng hình dạng
 * nhiều lane của `judge.mjs` thì `cap = 2` đo được 5 lượt chạy cùng lúc.
 *
 * Nên ở đây `release()` KHÔNG giảm `active` khi còn người xếp hàng: nó trao
 * thẳng chỗ vừa trống cho người đầu hàng. `active` không bao giờ tụt xuống dưới
 * số chỗ đang có chủ, nên không còn khe nào để chen. Trao theo thứ tự đến cũng
 * là thứ tự công bằng duy nhất nói được thành câu.
 *
 * `active` vì vậy đọc là "số chỗ đang có chủ", kể cả chỗ vừa trao cho một lượt
 * chưa kịp chạy tiếp — đó mới là con số mà một cái trần cần đếm.
 */

/** @param {number} max số lượt được chạy đồng thời (>=1) */
export function createLimiter(max = 2) {
  const cap = Math.max(1, Number(max) || 1);
  let active = 0;
  /** @type {Array<() => void>} */
  const waiting = [];

  function acquire() {
    if (active < cap) {
      active += 1;
      return undefined;
    }
    // Không tăng `active` ở đây: chỗ sẽ được TRAO trong `release()`, và lúc ấy
    // `active` vẫn đang tính chỗ của người vừa nhả.
    return new Promise((resolve) => waiting.push(resolve));
  }

  function release() {
    const next = waiting.shift();
    // Còn người xếp hàng thì chỗ này đổi chủ, không trống ra lúc nào cả.
    if (next) {
      next();
      return;
    }
    active -= 1;
  }

  /** Chạy `fn` khi có chỗ. Trả đúng thứ `fn` trả, ném đúng thứ `fn` ném. */
  async function run(fn) {
    const wait = acquire();
    if (wait) await wait;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { run, cap, get active() { return active; }, get waiting() { return waiting.length; } };
}
