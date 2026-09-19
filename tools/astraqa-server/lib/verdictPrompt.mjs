/**
 * Prompt cho job judge: soát lại một kết luận, trên đúng đoạn code được trích.
 *
 * File riêng chứ không thêm vào `prompt.mjs`, vì hai prompt trả lời hai câu hỏi
 * khác nhau. `prompt.mjs` hỏi "phần code cho ticket này đã hiện thực chưa" và
 * nhận lại `code_status` — từ vựng của AstraCode. Đây hỏi "trong những kết luận
 * bên gọi cho phép, kết luận nào đúng" và nhận lại một trong chính những tên ấy.
 *
 * Danh sách kết luận và định nghĩa của chúng do BÊN GỌI cấp (`guide`). Server
 * không có từ vựng verdict nào của riêng nó, và không được có: thêm một bản sao
 * ở đây là thêm một chỗ phải sửa khi bên kia đổi cách gọi, và bản sao ấy sẽ
 * lặng lẽ lệch đi.
 */
import { SCHEMA_TAIL } from './prompt.mjs';

const HOW = [
  'Bạn được cho một ticket, kết luận sơ bộ của một tầng đối chiếu bằng khớp từ khoá, và',
  'ÐÚNG những đoạn code mà tầng ấy trích ra làm bằng chứng. Nhiệm vụ: chọn kết luận đúng.',
  '',
  'Cách làm:',
  '- Chỉ dựa vào các đoạn code dưới đây. Không suy đoán về file không xuất hiện ở đó.',
  '- Trạng thái ticket nói bên kế hoạch TỰ CHO LÀ đã xong hay chưa. Nó không phải bằng',
  '  chứng về code — nhưng chênh lệch giữa nó và code chính là thứ cần kết luận.',
  '- Kết luận sơ bộ có thể sai. Ðồng ý thì trả lại đúng nó; không đồng ý thì trả cái khác',
  '  và nói trong "reason" bạn thấy gì trong code khiến bạn đổi.',
  '- "confidence" là mức chắc chắn của chính bạn, 0.0 đến 1.0.',
  '- "reason" viết cho người đọc, một câu, bằng tiếng Việt.',
].join('\n');

/**
 * Kết luận của tầng trước được nói ra, có chủ ý.
 *
 * Model đang soát lại một ý kiến chứ không chấm từ đầu, và một model bị bắt
 * đoán mà không biết mình đang phản biện cái gì thì hay trả về đúng hệt ý kiến
 * cũ — nghĩa là tốn một lượt gọi để in lại tầng grep dưới nhãn "AI".
 */
/**
 * Trần chữ cho phần mô tả ticket.
 *
 * Một mô tả dài không làm verdict đúng hơn: thứ quyết định nằm ở code được
 * trích, còn mô tả chỉ để model biết ticket đang nói về chuyện gì. Cắt ở 600
 * ký tự và NÓI RA là đã cắt, để không ai đọc prompt rồi tưởng model đã thấy cả
 * bài.
 */
export const MAX_TICKET_TEXT = 600;

function clip(raw, max = MAX_TICKET_TEXT) {
  const s = String(raw ?? '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max).trimEnd()}… (đã cắt, còn ${s.length - max} ký tự)`;
}

function ticketBlock(ticket) {
  return [
    `Ticket key: ${ticket.key}`,
    ticket.summary ? `Tiêu đề: ${clip(ticket.summary)}` : '',
    ticket.description ? `Mô tả: ${clip(ticket.description)}` : '',
    ticket.status ? `Trạng thái bên kế hoạch: ${ticket.status}` : '',
    ticket.grep_verdict ? `Kết luận sơ bộ (tầng khớp từ khoá): ${ticket.grep_verdict}` : '',
    ticket.grep_reason ? `Lý do của kết luận sơ bộ: ${ticket.grep_reason}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildVerdictPrompt({ ticket, guide, snippets, skipped = [], guidance = '' }) {
  const names = Object.keys(guide);
  const allowed = names.map((name) => `- ${name}: ${guide[name]}`).join('\n');

  const code = snippets
    .map((s) => {
      const where = s.cited ? ` (bằng chứng trích dòng ${s.cited})` : '';
      return `### ${s.path}${where}\n\n${s.text}`;
    })
    .join('\n\n');

  // Nói ra những mảnh KHÔNG đọc được. Im lặng ở đây là để model kết luận trên
  // một tập bằng chứng nhỏ hơn nó tưởng, mà không biết là mình đang thiếu.
  const missing = skipped.length
    ? `\n\nKhông đọc được (đừng kết luận gì về chúng): ${skipped.map((s) => s.path).join(', ')}`
    : '';

  const schema =
    '```json\n' +
    JSON.stringify(
      {
        items: [
          {
            key: '<đúng ticket key ở trên>',
            verdict: `<một trong: ${names.join(' | ')}>`,
            confidence: 0.0,
            reason: '<một câu>',
          },
        ],
      },
      null,
      2,
    ) +
    '\n```';

  /*
   * Từ vựng riêng của codebase, do đội tự viết (`judge_guidance` trong rules).
   *
   * Đặt SAU danh sách kết luận và TRƯỚC ticket: nó giải thích cách đọc mã
   * nguồn này, chứ không được phép thêm hay đổi nghĩa một kết luận nào. Một
   * tệp hướng dẫn bảo model trả về tên khác vẫn bị `pickVerdict` chặn.
   */
  const house = String(guidance || '').trim();
  const houseBlock = house
    ? ['', '--- QUY ƯỚC CỦA CODEBASE NÀY (đội tự viết) ---', house, '--- HẾT QUY ƯỚC ---']
    : [];

  return [
    HOW,
    '',
    'Các kết luận được phép, và chỉ những kết luận này:',
    allowed,
    ...houseBlock,
    '',
    ticketBlock(ticket),
    '',
    '--- CODE ÐƯỢC TRÍCH ---',
    code + missing,
    '--- HẾT CODE ---',
    '',
    SCHEMA_TAIL,
    schema,
    '',
  ].join('\n');
}
