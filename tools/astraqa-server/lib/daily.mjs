/**
 * Log của SERVER: theo ngày, giữ bảy ngày.
 *
 * `createRunLog` (observe.mjs) lo từng run — `logs/<run_id>.log`. Còn những
 * dòng KHÔNG thuộc run nào thì trước đây chỉ ra console: banner lúc khởi động,
 * mỗi dòng request, mọi 401 và 404. Console của một tiến trình chạy nền là nơi
 * không ai đọc lại được: server khởi động lại là mất, mà đúng những dòng đó
 * ("ai gõ vào cổng này lúc 2 giờ sáng") lại là thứ cần xem sau khi sự việc đã
 * qua.
 *
 * Nên chúng xuống đĩa, một file một ngày: `logs/server-YYYY-MM-DD.log`.
 *
 * Và có hạn: mọi `.log` trong thư mục đó cũ hơn bảy ngày sẽ bị xoá — kể cả log
 * của từng run, vì chúng chưa bao giờ có hạn và cứ thế dồn lại mãi. Bảy ngày là
 * con số IPan chốt. Hệ quả nói thẳng: sau bảy ngày `GET /api/v1/jobs/<id>/log`
 * trả 404 cho run đó. `results/` KHÔNG bị đụng tới — đó là kết quả, không phải
 * log, và trang /admin còn đọc nó.
 *
 * Bất biến giữ nguyên như observe.mjs: mọi chuỗi đi qua đây đều qua `redact`
 * trước, cả đường ra console lẫn đường xuống đĩa.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `YYYY-MM-DD` theo giờ của máy này.
 *
 * Giờ máy, không phải UTC: "log hôm nay" phải là hôm nay của người đang mở thư
 * mục. Từng dòng bên trong vẫn mang dấu thời gian ISO, nên khi cần so với một
 * hệ khác thì vẫn so được.
 */
export function dayStamp(date) {
  const two = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/**
 * Sổ log theo ngày, có dọn.
 *
 * `enabled: false` (test) thì vẫn trả đủ hàm nhưng không đụng đĩa — cùng quy
 * ước với `createRunLog`, để test đơn vị không rải file mà đường đi trong code
 * vẫn y hệt bản chạy thật.
 *
 * `now` tiêm được để test dựng cảnh "sang ngày mới" mà không phải đợi tới nửa
 * đêm.
 */
export function createDailyLog({
  dir,
  keepDays = 7,
  redact = (s) => String(s),
  log = () => {},
  enabled = true,
  now = () => new Date(),
}) {
  // Ghi nối tiếp: hai dòng cùng lúc không được cài răng lược, và việc dọn phải
  // xong trước dòng đầu tiên của ngày mới.
  let queue = Promise.resolve();
  let day = '';

  const enqueue = (fn) => {
    queue = queue.then(fn).catch((err) => {
      // Đĩa đầy hay mất quyền không được làm chết server đang phục vụ. Chỉ ra
      // console: nếu đường xuống đĩa đang hỏng thì viết thêm vào đó là vô ích.
      log(`[server-log] KHÔNG ghi được xuống đĩa — ${redact(String(err?.message ?? err))}`);
    });
    return queue;
  };

  /**
   * Xoá mọi `.log` trong thư mục cũ hơn `keepDays` ngày.
   *
   * Theo mtime chứ không theo tên: file của hôm nay đang được ghi nên mtime của
   * nó là hôm nay, còn log của một run tên là `run_id` thì trong tên không có
   * ngày nào để đọc. Một file không đọc/xoá được thì bỏ qua — có thể nó đang
   * được tiến trình khác giữ, và việc dọn rác không được làm hỏng việc chính.
   */
  async function prune() {
    if (!enabled) return [];
    const cutoff = now().getTime() - keepDays * DAY_MS;
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const gone = [];
    for (const name of names) {
      if (!name.endsWith('.log')) continue;
      const abs = path.join(dir, name);
      try {
        const stat = await fs.stat(abs);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          await fs.unlink(abs);
          gone.push(name);
        }
      } catch {
        continue;
      }
    }
    return gone;
  }

  /** Một dòng: ra console ngay, xuống file của hôm nay theo hàng đợi. */
  function line(message) {
    const safe = redact(String(message ?? ''));
    const at = now();
    const row = `${at.toISOString()} ${safe}`;
    log(row);
    if (!enabled) return row;
    const today = dayStamp(at);
    if (today !== day) {
      // Sang ngày mới (hoặc dòng đầu tiên từ lúc khởi động): dọn trước, để một
      // server chạy liên tục hai tuần cũng không giữ lại tuần đầu.
      day = today;
      enqueue(async () => {
        const gone = await prune();
        if (gone.length) log(`[server-log] đã xoá ${gone.length} log quá ${keepDays} ngày`);
      });
    }
    const file = path.join(dir, `server-${today}.log`);
    enqueue(async () => {
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(file, row + '\n', 'utf8');
    });
    return row;
  }

  /** Đợi mọi việc đĩa đang xếp hàng xong. Cho test, và cho lúc tắt server. */
  function flush() {
    return queue;
  }

  return { line, prune, flush, keepDays };
}
