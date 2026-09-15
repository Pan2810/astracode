/**
 * Việc phải làm trước mọi lệnh: đưa `~/.astra` về layout hiện hành rồi dọn rác.
 *
 * Cả hai đều KHÔNG được phép làm hỏng lệnh người dùng vừa gõ. `astracode login`
 * phải chạy được kể cả khi thư mục nhà đang ở trạng thái nửa vời — nên mọi lỗi
 * ở đây bị nuốt, và lần chạy sau thử lại.
 *
 * Dọn dẹp có mốc riêng (`.last-cleanup`), một ngày một lần. Nhờ vậy gắn nó vào
 * mọi lần khởi động vẫn rẻ: lần nào chưa tới hạn cũng chỉ đọc đúng một file.
 */
import {
  HomeCleanup,
  Logger,
  NodeFileSystem,
  defaultRedactor,
  migrateHome,
} from '@astra/core';
import { loadConfig } from './config.js';
import { ensureHome, layout } from './home.js';

export async function bootstrapHome(): Promise<void> {
  try {
    ensureHome();
    const fs = new NodeFileSystem();
    const home = layout();
    const logger = new Logger({ level: loadConfig().logLevel, redactor: defaultRedactor });

    await migrateHome({ fs, layout: home, logger });
    await new HomeCleanup({ fs, layout: home, logger }).runIfDue();
  } catch {
    /* Thư mục nhà không sửa được thì lệnh vẫn phải chạy. */
  }
}
