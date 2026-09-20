/**
 * Dựng prompt gửi cho CLI — một ticket một lượt.
 *
 * Không có gì về dự án cụ thể ở đây: mọi thứ riêng của một job (key, tiêu đề,
 * mô tả, glob loại trừ, trần số file) đều đến từ request. Server không biết
 * repo nào, ticket format nào, và không được phép biết.
 */

/** Schema mà CLI phải trả về. Đây cũng là schema AstraQA cầm. */
export const ITEM_SCHEMA_TEXT = `\`\`\`json
{
  "items": [
    {
      "key": "<đúng ticket key ở trên>",
      "code_status": "done | partial | missing",
      "confidence": 0.0,
      "evidence": [
        { "path": "<đường dẫn TƯƠNG ĐỐI trong repo>", "lines": "120-148", "note": "<vì sao đoạn này là bằng chứng>" }
      ],
      "reason": "<matched_by_key | matched_by_summary | ...>",
      "ac_assessment": [
        { "id": 1, "status": "satisfied | partial | not_satisfied | unknown", "evidence": [{ "path": "src/example.ts", "lines": "10-20", "note": "implementation" }], "reason": "<how this criterion is or is not met>" }
      ]
    }
  ]
}
\`\`\``;

/** Câu chốt bắt buộc, hợp đồng quy định nguyên văn. */
export const SCHEMA_TAIL = 'Trả lời CHỈ bằng một khối ```json đúng schema sau, không giải thích gì thêm:';

const AC_RULES = `For every supplied acceptance criterion, return exactly one ac_assessment entry with its 1-based id.
Use satisfied only when a cited source line directly supports it; partial when cited code supports only part.
Use unknown when the repository evidence is inconclusive. Do not infer passing tests from test files or from Jira status.
If no acceptance criteria were supplied, return ac_assessment: [].`;

const DEFAULT_BODY = `Bạn đang đứng ở thư mục gốc của một repo đã được clone sẵn. Nhiệm vụ: xác định phần code
tương ứng với ticket dưới đây ĐÃ được hiện thực hay chưa.

Cách làm:
- Tìm trong repo bằng các công cụ đọc file (grep/glob/đọc file/tra symbol). Bắt đầu từ key
  của ticket, rồi tới các từ khoá trong tiêu đề và mô tả.
- Mở nhiều nhất {{max_files}} file. Bỏ qua mọi đường dẫn khớp: {{exclude_globs}}
- "done" = có code hiện thực đủ ý ticket. "partial" = có dấu vết nhưng thiếu/chưa nối.
  "missing" = không tìm thấy gì.
- Mỗi bằng chứng phải là đường dẫn TƯƠNG ĐỐI có thật trong repo, kèm khoảng dòng thật
  (dạng "120-148" hoặc "42"). Tuyệt đối không bịa đường dẫn: đường dẫn không tồn tại sẽ
  bị loại và làm kết luận mất giá trị.
- "confidence" là mức chắc chắn của chính bạn, 0.0 đến 1.0.
- Trạng thái ticket ghi ở dưới là do hệ thống ngoài báo — nó KHÔNG phải bằng chứng, đừng
  để nó ảnh hưởng kết luận về code.`;

function ticketBlock(ticket) {
  return [
    `Ticket key: ${ticket.key}`,
    ticket.title ? `Ticket title: ${ticket.title}` : '',
    ticket.status ? `Ticket status (nguồn ngoài, chỉ để tham khảo): ${ticket.status}` : '',
    ticket.body ? `Mô tả ticket:\n${ticket.body}` : '',
    ticket.acceptance_criteria?.length ? `Acceptance criteria (IDs start at 1):\n${ticket.acceptance_criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * `prompt_override` thay phần hướng dẫn, KHÔNG thay khối ticket và không thay
 * câu chốt schema — nếu không thì AstraQA gửi một override vô hại cũng làm
 * output hết parse được, và lỗi sẽ hiện ra ở tận bước gộp.
 *
 * Trong override dùng được `{{key}}`, `{{title}}`, `{{status}}`, `{{body}}`,
 * `{{max_files}}`, `{{exclude_globs}}`.
 */
const JUDGE_BODY = `Bạn được cho ngữ cảnh của một repo (cây file và các dòng khớp từ khoá của ticket) và một
ticket. Nhiệm vụ: kết luận phần code tương ứng với ticket ĐÃ được hiện thực hay chưa.

Cách làm:
- Chỉ dựa vào ngữ cảnh bên dưới. Không suy đoán về file không xuất hiện ở đó.
- "done" = có code hiện thực đủ ý ticket. "partial" = có dấu vết nhưng thiếu/chưa nối.
  "missing" = không tìm thấy gì.
- Mỗi bằng chứng phải là đường dẫn có trong cây file, kèm khoảng dòng có thật (dạng
  "120-148" hoặc "42"). Không chắc số dòng thì bỏ trống "lines", đừng bịa.
- Nêu nhiều nhất {{max_files}} file.
- "confidence" là mức chắc chắn của chính bạn, 0.0 đến 1.0.
- Trạng thái ticket ghi ở dưới là do hệ thống ngoài báo — nó KHÔNG phải bằng chứng.`;

/** Prompt cho backend `fci`: ngữ cảnh repo đi kèm vì model không tự duyệt được file. */
export function buildJudgePrompt({ ticket, options = {}, context, promptOverride = null }) {
  const head = (typeof promptOverride === 'string' && promptOverride.trim() ? promptOverride : JUDGE_BODY).replace(
    /\{\{(\w+)\}\}/g,
    (m, k) =>
      ({
        key: ticket.key,
        title: ticket.title ?? '',
        status: ticket.status ?? '',
        body: ticket.body ?? '',
        max_files: String(options.max_files_per_ticket ?? 5),
        exclude_globs: (options.exclude_globs ?? []).join(', ') || '(không có)',
      })[k] ?? m,
  );
  return `${head}\n\n${AC_RULES}\n\n--- NGỮ CẢNH REPO ---\n${context}\n--- HẾT NGỮ CẢNH ---\n\n${ticketBlock(ticket)}\n\n${SCHEMA_TAIL}\n${ITEM_SCHEMA_TEXT}\n`;
}

export function buildPrompt({ ticket, options = {}, promptOverride = null }) {
  const vars = {
    key: ticket.key,
    title: ticket.title ?? '',
    status: ticket.status ?? '',
    body: ticket.body ?? '',
    max_files: String(options.max_files_per_ticket ?? 5),
    exclude_globs: (options.exclude_globs ?? []).join(', ') || '(không có)',
  };
  const fill = (tpl) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

  const head = fill(typeof promptOverride === 'string' && promptOverride.trim() ? promptOverride : DEFAULT_BODY);

  return `${head}\n\n${AC_RULES}\n\n${ticketBlock(ticket)}\n\n${SCHEMA_TAIL}\n${ITEM_SCHEMA_TEXT}\n`;
}
