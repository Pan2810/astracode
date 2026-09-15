/**
 * Mọi `getElementById` trong webview phải trỏ tới một id có thật trong HTML mà
 * `chatView.ts` dựng.
 *
 * Vì sao đáng một bộ test riêng: hai file này không nhìn thấy nhau. HTML là một
 * template string trong extension host, còn webview là một bundle esbuild —
 * typecheck xanh cả hai bên dù id gõ sai. Lỗi chỉ nổ lúc chạy, ở dòng
 * `document.getElementById('x')!.addEventListener(...)`, và vì nó nổ ở tầng
 * ngoài cùng của module nên KHÔNG có phần nào của chat kịp khởi tạo: người dùng
 * mở panel ra và thấy một khung trắng, không banner, không lỗi.
 *
 * Đọc nguồn dạng văn bản là có chủ ý — không cần dựng DOM giả để canh một thứ
 * vốn là chuyện chính tả giữa hai file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

function read(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), 'utf8');
}

/**
 * Id mà script webview tin chắc là có: `getElementById('x')!` hoặc
 * `getElementById('x') as HTMLButtonElement`.
 *
 * Cố ý bỏ qua các lượt tra không khẳng định (`getElementById('x')?.remove()`) —
 * chúng tìm phần tử do chính script tạo ra lúc chạy, như `sandbox-warning`, và
 * không có gì trong HTML để đối chiếu.
 */
function lookedUpIds(): string[] {
  const src = read('src', 'webview', 'chat.ts');
  const hits = src.matchAll(/getElementById\(\s*'([^']+)'\s*\)\s*(?:!|as\b)/g);
  return [...new Set([...hits].map((m) => m[1]!))];
}

/** Id có mặt trong HTML template. */
function markupIds(): string[] {
  const src = read('src', 'chatView.ts');
  return [...new Set([...src.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!))];
}

describe('HTML của webview chat', () => {
  it('mọi id script đi tìm đều có trong markup', () => {
    const missing = lookedUpIds().filter((id) => !markupIds().includes(id));
    expect(missing).toEqual([]);
  });

  /**
   * Popup cài đặt cần đủ ba mảnh: lớp mờ (bấm ra ngoài để đóng), hộp có
   * role=dialog, và thân cuộn được. Thiếu lớp mờ thì hộp vẫn hiện nhưng chỉ
   * đóng được bằng Esc hoặc nút X — mất đúng cái làm nó thành popup.
   */
  it('bảng cài đặt là popup, không phải lớp phủ kín panel', () => {
    const html = read('src', 'chatView.ts');
    expect(html).toMatch(/id="settings" class="modal"/);
    expect(html).toMatch(/id="settingsScrim"/);
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/id="settingsBody" class="modal-body"/);
  });

  /**
   * Bảng hội thoại cũ dùng CHUNG vỏ popup với bảng cài đặt. Nó từng là lớp phủ
   * kín cả panel; đổi lại nửa vời — hộp nổi nhưng không có lớp mờ — thì bấm ra
   * ngoài không đóng được, và người dùng mắc kẹt trong một bảng trông như bấm
   * đâu cũng thoát.
   */
  it('bảng hội thoại cũ cũng là popup', () => {
    const html = read('src', 'chatView.ts');
    expect(html).toMatch(/id="history" class="modal"/);
    expect(html).toMatch(/id="historyScrim"/);
    expect(html).toMatch(/aria-labelledby="historyTitle"/);
  });

  /**
   * CSP của webview là `style-src ${cspSource}` — không có 'unsafe-inline'. Một
   * thuộc tính `style=` trong DOM dựng bằng JS sẽ bị chặn im lặng: phần tử vẫn
   * nằm đó, chỉ là không có kích thước nào được áp. Bề rộng phải đặt qua CSSOM.
   */
  it('không có style nội tuyến nào trong DOM của bảng cài đặt', () => {
    const src = read('src', 'webview', 'settingsPanel.ts');
    expect(src).not.toMatch(/style:\s*`/);
    expect(src).not.toMatch(/setAttribute\(\s*'style'/);
  });
});
