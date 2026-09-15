/**
 * Nội dung của ASTRA.md, tách khỏi VS Code API.
 *
 * File này KHÔNG import `vscode`. Đó là chủ ý: phần biến đổi văn bản là phần
 * duy nhất có thể ăn mất dữ liệu của người dùng (ASTRA.md do họ viết tay), nên
 * nó phải test được thẳng bằng vitest thay vì chỉ được nhìn bằng mắt. Phần
 * đụng đĩa nằm ở `memoryFile.ts`.
 */

export const MEMORY_FILE_NAME = 'ASTRA.md';

/**
 * Mục mà `/memory <rule>` nối vào.
 *
 * Cùng một chuỗi dùng cho cả việc TÌM mục trong file có sẵn lẫn việc TẠO mục
 * khi chưa có, nên hai bên không thể lệch nhau. Nó cũng khớp với tiêu đề trong
 * bản mẫu dưới đây — lệch là file mới tinh cũng phải mọc thêm một mục thứ hai.
 */
export const CONVENTIONS_HEADING = '## Project conventions';

/**
 * Bản mẫu cho ASTRA.md chưa tồn tại.
 *
 * Cố ý ngắn và nói thẳng rằng nội dung này đi vào system prompt: một file "ghi
 * chú" mà người viết không biết nó có sức nặng đó là cách sinh ra những chỉ dẫn
 * tuỳ tiện rồi ngạc nhiên vì agent làm theo.
 */
export const MEMORY_TEMPLATE = `# Notes for AstraCode

This file is loaded into the system prompt on every turn. Keep it short —
every line here costs context on every later question.

${CONVENTIONS_HEADING}

- (example) Tests run with \`pnpm test\`, not \`npm test\`.
- (example) Comments are written in Vietnamese.

## Careful around here

- (example) Do not edit \`src/generated/\` — it is generated.
`;

/**
 * Nối một quy ước vào cuối mục "Project conventions".
 *
 * Nối vào CUỐI MỤC chứ không phải cuối file: rule mới phải nằm cùng chỗ với
 * rule cũ, nếu không thì sau vài lần gõ `/memory` file thành một danh sách rời
 * rạc mà chính người dùng cũng không sửa nổi bằng tay.
 *
 * Không có mục đó thì dựng nó ở cuối file. Ghi bừa một gạch đầu dòng vào cuối
 * mà không có tiêu đề thì lần gọi sau không tìm lại được chỗ để nối tiếp, và
 * mỗi lần gọi lại đẻ ra một dòng lạc lõng ở một chỗ khác.
 */
export function withConvention(current: string, rule: string): string {
  const text = normalizeRule(rule);
  if (!text) return current;

  // Giữ nguyên kiểu xuống dòng của file. Repo này chạy trên Windows, và viết
  // lại một file CRLF bằng LF làm git báo đổi TOÀN BỘ dòng — một rule ba chữ
  // biến thành một diff cả trăm dòng.
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const lines = current.split(/\r?\n/);
  const bullet = `- ${text}`;

  const heading = lines.findIndex(isConventionsHeading);

  if (heading === -1) {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    lines.push('', CONVENTIONS_HEADING, '', bullet, '');
    return lines.join(eol);
  }

  // Cuối mục = ngay trước tiêu đề kế tiếp, sau khi đã bỏ các dòng trống đệm.
  let end = heading + 1;
  while (end < lines.length && !isHeading(lines[end]!)) end++;
  while (end > heading + 1 && lines[end - 1]!.trim() === '') end--;

  // Mục rỗng: chừa một dòng trắng sau tiêu đề cho khớp phần còn lại của file.
  lines.splice(end, 0, ...(end === heading + 1 ? ['', bullet] : [bullet]));

  if (lines[lines.length - 1]!.trim() !== '') lines.push('');
  return lines.join(eol);
}

/**
 * Câu người dùng gõ → đúng một gạch đầu dòng.
 *
 * Gộp mọi khoảng trắng vì `/memory` nhận được cả câu dán nhiều dòng, và một
 * rule xuống dòng giữa chừng sẽ vỡ danh sách markdown. Bỏ dấu gạch đầu nếu họ
 * tự gõ sẵn, để không thành `- - rule`.
 */
function normalizeRule(rule: string): string {
  return rule
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-*+]\s*/, '')
    .trim();
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s/.test(line);
}

function isConventionsHeading(line: string): boolean {
  return line.trim().replace(/\s+/g, ' ').toLowerCase() === CONVENTIONS_HEADING.toLowerCase();
}
