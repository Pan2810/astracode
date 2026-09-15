/**
 * Mọi lệnh đăng ký trong `extension.ts` phải có mặt trong
 * `contributes.commands` của package.json.
 *
 * Vì sao đáng một bộ test riêng: hai chỗ này lệch nhau KHÔNG gây lỗi nào cả.
 * `registerCommand` chạy êm, typecheck xanh, build xanh, extension hoạt động
 * bình thường — lệnh chỉ đơn giản là không xuất hiện trong Command Palette.
 * Không có stack trace, không có log, không có gì để grep. Cách duy nhất phát
 * hiện là có người đi tìm nó và không thấy.
 *
 * Đó đúng là chuyện đã xảy ra với `astra.copyToken`: tài liệu bảo người dùng
 * mở Command Palette gõ "AstraCode: Sao chép token AstraWork", và ở đó không có
 * gì. Ca test này giữ cho mọi lệnh sau đó không lặp lại.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');

function registeredCommands(): string[] {
  const src = readFileSync(join(ROOT, 'src', 'extension.ts'), 'utf8');
  return [...src.matchAll(/registerCommand\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

function contributedCommands(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    contributes?: { commands?: { command: string; title: string }[] };
  };
  return (pkg.contributes?.commands ?? []).map((c) => c.command);
}

describe('lệnh của extension', () => {
  it('lệnh nào đăng ký cũng khai trong package.json', () => {
    const missing = registeredCommands().filter((c) => !contributedCommands().includes(c));
    // Thiếu ở đây = lệnh vô hình trong Command Palette, không có lỗi nào báo.
    expect(missing).toEqual([]);
  });

  it('không khai lệnh không tồn tại', () => {
    // Chiều ngược lại: một mục trong palette gọi ra lỗi "command not found".
    const registered = registeredCommands();
    const dangling = contributedCommands().filter((c) => !registered.includes(c));
    expect(dangling).toEqual([]);
  });

  /**
   * VS Code gom mọi mục `view/title` ngoài group `navigation` vào một nút `...`.
   * Nút đó đứng ngay cạnh hai nút thật và lấy chỗ của chúng — mà không có lỗi
   * nào báo, vì thêm một mục vào menu luôn "chạy đúng".
   */
  it('thanh tiêu đề chat chỉ có hai nút, không có menu "..."', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      contributes?: { menus?: { 'view/title'?: { command: string; when?: string; group?: string }[] } };
    };
    const chatItems = (pkg.contributes?.menus?.['view/title'] ?? []).filter((m) =>
      (m.when ?? '').includes('astracode.chat'),
    );

    expect(chatItems.map((m) => m.command).sort()).toEqual(['astra.chatHistory', 'astra.newChat']);
    for (const item of chatItems) {
      expect(item.group, item.command).toMatch(/^navigation/);
    }
  });

  it('mỗi lệnh có tiêu đề tìm được bằng cách gõ "AstraCode"', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      contributes?: { commands?: { command: string; title: string }[] };
    };
    // Palette tìm theo tiêu đề. Một lệnh không mang tiền tố thì có tồn tại cũng
    // không ai gõ ra được nếu chưa biết chính xác tên nó.
    for (const c of pkg.contributes?.commands ?? []) {
      expect(c.title, c.command).toMatch(/AstraCode/);
    }
  });
});
