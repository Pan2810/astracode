/**
 * `SessionStorage` đặt trên đĩa, qua cổng `FileSystem` của core.
 *
 * Điểm mấu chốt nằm ở CHỖ ĐẶT, không ở code: mỗi instance trỏ vào thư mục của
 * MỘT dự án (`~/.astra/projects/<slug>/`). Nhờ vậy `SessionStore.list()` chỉ
 * đọc phiên của repo đang mở thay vì mở mọi file rồi lọc, và `prune()` chỉ dọn
 * trong phạm vi repo đó — trước đây trần 50 phiên tính chung nên làm nhiều ở
 * repo này sẽ đẩy phiên của repo khác ra khỏi đĩa.
 *
 * Vẫn giữ nguyên `SessionStorage`: `SessionStore` không biết gì về đĩa, và đó
 * là lý do đổi được nơi lưu mà không đụng vào logic phiên.
 */
import { join } from 'node:path';
import type { FileSystem } from '../fs/FileSystem.js';
import { safeName } from '../home/layout.js';
import type { SessionStorage } from './SessionStore.js';

export class FsSessionStorage implements SessionStorage {
  constructor(
    private readonly fs: FileSystem,
    private readonly dir: string,
  ) {}

  async read(key: string): Promise<string | undefined> {
    try {
      return await this.fs.readFile(this.path(key));
    } catch {
      return undefined;
    }
  }

  async write(key: string, value: string): Promise<void> {
    await this.fs.writeFile(this.path(key), value);
  }

  async remove(key: string): Promise<void> {
    try {
      await this.fs.deleteFile(this.path(key));
    } catch {
      /* đã không còn thì coi như xong */
    }
  }

  async keys(): Promise<string[]> {
    try {
      const entries = await this.fs.readDir(this.dir);
      return entries.filter((e) => e.type === 'file').map((e) => e.name);
    } catch {
      // Thư mục chưa tồn tại = chưa có phiên nào. Không phải lỗi.
      return [];
    }
  }

  /**
   * Khoá đến từ `SessionStore`, nhưng cũng đến từ tên file có sẵn trong thư
   * mục. Lọc ở đây là chốt chặn cuối trước khi một tên bịa ra chạm đường dẫn
   * thật — `..` hay dấu phân cách không đi qua được `safeName`.
   */
  private path(key: string): string {
    return join(this.dir, safeName(key));
  }
}
