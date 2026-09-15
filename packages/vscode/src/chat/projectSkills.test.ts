/**
 * Chuẩn dự án phải tới CẢ HAI đường nạp, không chỉ một.
 *
 * Vì sao đáng một bộ test riêng: `loadSkills` được gọi ở hai chỗ với hai mục
 * đích khác nhau, và quên một chỗ không gây lỗi nào cả.
 *
 *   `chat/Extras.ts`        — đường của MODEL. Nó quyết định model có thấy quy
 *                             trình của dự án trong danh mục prompt hay không.
 *   `chat/ChatController.ts` — đường của NGƯỜI DÙNG: ô gợi ý khi gõ `/`, và
 *                             lệnh `/tên` gõ tay (`this.skills` ở `runSlash`).
 *
 * Đó đúng là chuyện đã xảy ra ở 0.0.32: `Extras.ts` được truyền `orgSkills` còn
 * `refreshCommands()` thì không. Kết quả là model gọi được `resolving-merge-
 * conflicts` nhưng người dùng gõ `/` lại không thấy nó — typecheck xanh, build
 * xanh, không một dòng log. Cách duy nhất phát hiện là có người đi tìm và
 * không thấy.
 *
 * Đọc nguồn dạng văn bản là có chủ ý, cùng lối với `webview/markup.test.ts`:
 * hai lời gọi này nằm ở hai file không nhìn thấy nhau, và `orgSkills` là tuỳ
 * chọn nên thiếu nó vẫn hợp kiểu.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');

function read(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), 'utf8');
}

/** Thân của mỗi lời gọi `fn({ … })`, cắt tới dấu đóng ngoặc cùng cấp. */
function callBodies(source: string, fn: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(`${fn}({`, from);
    if (start < 0) return out;
    let depth = 0;
    let i = source.indexOf('{', start);
    const open = i;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) break;
    }
    out.push(source.slice(open, i + 1));
    from = i + 1;
  }
}

describe('chuẩn dự án tới cả hai đường nạp', () => {
  const files = ['chat/Extras.ts', 'chat/ChatController.ts'];

  it('mọi lời gọi loadSkills đều nhận orgSkills', () => {
    for (const f of files) {
      for (const body of callBodies(read(f), 'loadSkills')) {
        expect(body, `${f}: một lời gọi loadSkills thiếu orgSkills`).toContain('orgSkills');
      }
    }
  });

  it('mọi lời gọi loadAgents đều nhận orgAgents', () => {
    for (const f of files) {
      for (const body of callBodies(read(f), 'loadAgents')) {
        expect(body, `${f}: một lời gọi loadAgents thiếu orgAgents`).toContain('orgAgents');
      }
    }
  });

  it('có thật hai đường, không phải test đang canh một tập rỗng', () => {
    // Nếu một ngày hai đường gộp làm một thì hai ca trên vẫn xanh mà không canh
    // gì nữa. Ca này làm chúng đỏ để người gộp phải đọc lại file này.
    const total = files.reduce((n, f) => n + callBodies(read(f), 'loadSkills').length, 0);
    expect(total).toBe(2);
  });

  /**
   * Ô gợi ý dựng lúc webview báo `ready`, còn chuẩn dự án về sau đó — đăng nhập
   * xong, đổi dự án, hoặc lần tự làm mới sau 10 phút. Không có đường dựng lại
   * thì quy trình mới khai chỉ xuất hiện sau khi mở lại cửa sổ.
   */
  it('ô gợi ý được dựng lại khi chuẩn dự án đổi', () => {
    expect(read('chatView.ts')).toContain('refreshCommandsIfStale');
  });
});
