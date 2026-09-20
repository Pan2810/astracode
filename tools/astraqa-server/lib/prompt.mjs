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
      "reason": "<matched_by_key | matched_by_summary | ...>"
    }
  ]
}
\`\`\``;

/**
 * Schema khi ticket có tiêu chí chấp nhận: thêm `assessment`, một mục cho MỘT
 * tiêu chí.
 *
 * `id` là số thứ tự của tiêu chí trong danh sách bên trên, không phải số model
 * tự đặt: bên nhận gộp kết quả của nhiều repo theo đúng `id` ấy, nên một `id`
 * lệch là hai kết luận về hai tiêu chí khác nhau bị chồng lên nhau.
 *
 * Từ vựng `satisfied | partial | not_satisfied | unknown` là của AstraQA
 * (`code_reconcile.AC_STATUSES`), khai nguyên văn ở đây để không có bảng dịch
 * nào ở giữa.
 */
export const ASSESSMENT_SCHEMA_TEXT = `\`\`\`json
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
      "assessment": {
        "criteria": [
          {
            "id": 1,
            "status": "satisfied | partial | not_satisfied | unknown",
            "evidence": [
              { "path": "<đường dẫn có thật>", "lines": "120-148", "note": "<dòng nào thoả tiêu chí này>" }
            ],
            "reason": "<một câu: vì sao tiêu chí này ở trạng thái đó>"
          }
        ]
      }
    }
  ]
}
\`\`\``;

/** Khối "Tiêu chí chấp nhận" — mỗi tiêu chí một dòng, đánh số đúng bằng `id`. */
export function acceptanceBlock(criteria = []) {
  if (!Array.isArray(criteria) || criteria.length === 0) return '';
  return ['Tiêu chí chấp nhận (mỗi dòng một tiêu chí, số đầu dòng là "id" phải dùng lại trong "assessment"):']
    .concat(criteria.map((text, i) => `${i + 1}. ${String(text).replace(/\s*\n\s*/g, ' ')}`))
    .join('\n');
}

/** Hướng dẫn thêm, chỉ gắn khi ticket thật sự có tiêu chí. */
const ACCEPTANCE_RULES = [
  '- Ticket này có danh sách tiêu chí chấp nhận. Ngoài kết luận chung, chấm TỪNG tiêu chí',
  '  trong "assessment.criteria": một mục cho một tiêu chí, "id" đúng bằng số thứ tự ở trên.',
  '- "satisfied" = code thoả tiêu chí ấy và bạn chỉ được ra chỗ thoả. "partial" = thoả một',
  '  phần. "not_satisfied" = đã tìm và thấy chưa có. "unknown" = không đủ căn cứ để nói.',
  '- Mỗi tiêu chí KHÁC "unknown" phải kèm ít nhất một bằng chứng có đường dẫn VÀ khoảng dòng.',
  '  Không có chỗ để chỉ thì trạng thái là "unknown" — đó là câu trả lời hợp lệ.',
].join('\n');

/** Câu chốt bắt buộc, hợp đồng quy định nguyên văn. */
export const SCHEMA_TAIL = 'Trả lời CHỈ bằng một khối ```json đúng schema sau, không giải thích gì thêm:';

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
    acceptanceBlock(ticket.acceptance_criteria),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Ticket có tiêu chí thì prompt đổi cả phần luật lẫn phần schema. */
function schemaFor(ticket) {
  return Array.isArray(ticket.acceptance_criteria) && ticket.acceptance_criteria.length
    ? ASSESSMENT_SCHEMA_TEXT
    : ITEM_SCHEMA_TEXT;
}

function rulesFor(ticket, head) {
  return Array.isArray(ticket.acceptance_criteria) && ticket.acceptance_criteria.length
    ? `${head}\n${ACCEPTANCE_RULES}`
    : head;
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
  return `${rulesFor(ticket, head)}\n\n--- NGỮ CẢNH REPO ---\n${context}\n--- HẾT NGỮ CẢNH ---\n\n${ticketBlock(ticket)}\n\n${SCHEMA_TAIL}\n${schemaFor(ticket)}\n`;
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

  return `${rulesFor(ticket, head)}\n\n${ticketBlock(ticket)}\n\n${SCHEMA_TAIL}\n${schemaFor(ticket)}\n`;
}
