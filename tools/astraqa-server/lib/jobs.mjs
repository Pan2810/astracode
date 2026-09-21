/**
 * Sổ job trong bộ nhớ: ai được vào, và ai được đẩy ra khi hết chỗ.
 *
 * Tách khỏi `server.mjs` vì đây là một CHÍNH SÁCH, không phải một đoạn dọn dẹp.
 * Bản trước nằm lẫn trong route dưới dạng hai dòng giống hệt nhau:
 *
 *     while (jobs.size > MAX_JOBS_KEPT) jobs.delete(jobs.keys().next().value);
 *
 * Nó xoá theo thứ tự chèn mà không nhìn trạng thái, nên job đầu sổ vẫn đang
 * chạy cũng bị đẩy ra. Từ lúc đó job ấy thành vô hình: `GET` trả 404 dù nó còn
 * sống, `AbortController` mất đường chạm tới nên không ai gọi dừng được, mà nó
 * vẫn tiêu hạn mức tới ticket cuối. Bên gọi thấy 404 thì gửi lại cả bảng — trả
 * tiền hai lần cho đúng một việc.
 */

/** Job đã đóng sổ. Chỉ những trạng thái này mới được phép đẩy ra khỏi bộ nhớ. */
export const SETTLED = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * Nhận một job vào sổ, đẩy job ÐÃ ÐÓNG SỔ cũ nhất ra khi cần.
 *
 * Hết chỗ mà trong sổ toàn job đang chạy thì từ chối thẳng, để người gọi trả
 * 503. Một lời từ chối bên gọi thử lại được vẫn rẻ hơn một job vô hình.
 *
 * @param {Map<string, {status: string}>} jobs sổ, theo thứ tự chèn
 * @param {{id: string, status: string}} job
 * @param {number} max trần số job giữ lại
 * @returns {boolean} false = sổ đầy và không có gì được phép đẩy ra
 */
export function admitJob(jobs, job, max) {
  while (jobs.size >= max) {
    let dropped = false;
    // `Map` giữ thứ tự chèn, nên job đóng sổ gặp đầu tiên cũng là job cũ nhất.
    for (const [id, old] of jobs) {
      if (!SETTLED.has(old.status)) continue;
      jobs.delete(id);
      dropped = true;
      break;
    }
    if (!dropped) return false;
  }
  jobs.set(job.id, job);
  return true;
}
