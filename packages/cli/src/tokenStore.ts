/**
 * TokenStore trên đĩa cho CLI — `~/.astra/credentials.json`.
 *
 * Extension dùng SecretStorage của VS Code (được OS mã hoá). Ngoài VS Code thì
 * không có thứ tương đương nào chạy được ở mọi nơi, nên đây là một file với
 * quyền 0600 — yếu hơn, và phải nói thẳng ra thay vì để người dùng tưởng nó
 * được mã hoá.
 *
 * **File riêng, không nằm trong settings.** Đó là ranh giới khiến `settings.json`
 * chép sang máy khác được mà không kéo theo một lần rò rỉ.
 *
 * Cái KHÔNG làm: đọc token từ biến môi trường rồi ghi ngầm xuống đĩa. Một biến
 * môi trường đi vào mọi tiến trình con; ghi thêm bản sao xuống đĩa nhân đôi bề
 * mặt lộ mà chẳng thêm tiện lợi gì.
 */
import { readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { readAccessToken, writeAccessToken, type TokenStore } from '@astra/core';
import { credentialsPath, legacyTokenPath, ensureHome } from './home.js';

export class FileTokenStore implements TokenStore {
  get(): Promise<string | undefined> {
    // Biến môi trường THẮNG file: đó là cách chạy trong CI hoặc chạy tạm với
    // một danh tính khác mà không giẫm lên token đã đăng nhập trên máy.
    const fromEnv = process.env.ASTRAWORK_TOKEN?.trim();
    if (fromEnv) return Promise.resolve(fromEnv);

    // File `token` cũ vẫn đọc được: migrate có thể chưa chạy, và bắt đăng nhập
    // lại khi token còn dùng được là một câu trả lời sai.
    for (const path of [credentialsPath(), legacyTokenPath()]) {
      try {
        const token = readAccessToken(readFileSync(path, 'utf8'));
        if (token) return Promise.resolve(token);
      } catch {
        /* thử đường tiếp theo */
      }
    }
    return Promise.resolve(undefined);
  }

  set(token: string): Promise<void> {
    ensureHome();
    const path = credentialsPath();
    writeFileSync(path, writeAccessToken(token), { encoding: 'utf8', mode: 0o600 });
    try {
      // writeFileSync chỉ áp `mode` khi TẠO file. File đã tồn tại từ lần đăng
      // nhập trước thì quyền cũ giữ nguyên, nên phải đặt lại lần nữa.
      chmodSync(path, 0o600);
    } catch {
      /* Windows: ACL quyết định, chmod gần như không có tác dụng. */
    }
    // Bản cũ phải biến mất ngay khi có bản mới: để lại một file `token` chứa
    // JWT đã hết hạn chỉ tạo thêm một chỗ rò rỉ mà không ai còn đọc.
    try {
      rmSync(legacyTokenPath(), { force: true });
    } catch {
      /* không xoá được thì lần đăng nhập sau thử lại */
    }
    return Promise.resolve();
  }

  clear(): Promise<void> {
    for (const path of [credentialsPath(), legacyTokenPath()]) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* Không có file thì coi như đã sạch. */
      }
    }
    return Promise.resolve();
  }
}
