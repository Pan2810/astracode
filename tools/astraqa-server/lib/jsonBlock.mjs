/**
 * Bóc khối ```json trong stdout của CLI và kiểm schema.
 *
 * Mọi đường ở đây kết thúc bằng THROW chứ không bằng một giá trị mặc định.
 * Một `items: []` trả về im lặng khi model nói lung tung là kiểu hỏng tệ nhất
 * của hệ này: AstraQA sẽ đọc nó thành "không ticket nào có vấn đề".
 */

const STATUSES = new Set(['done', 'partial', 'missing']);

/**
 * Từ vựng trạng thái của MỘT tiêu chí chấp nhận.
 *
 * Bốn giá trị này là của AstraQA (`code_reconcile.AC_STATUSES`), chép nguyên
 * văn chứ không đặt lại tên: bên kia đọc `status` bằng đúng bốn chữ ấy và mọi
 * chữ khác rơi về `unknown`, nên một bảng dịch ở giữa chỉ tạo ra chỗ để lệch.
 */
const AC_STATUSES = new Set(['satisfied', 'partial', 'not_satisfied', 'unknown']);

/**
 * Model hay trả bằng chữ của con người. Nhận những chữ ấy rồi quy về từ vựng
 * chuẩn — khoan dung ở đầu vào, nghiêm ngặt ở đầu ra.
 */
const AC_SYNONYMS = new Map([
  ['met', 'satisfied'],
  ['done', 'satisfied'],
  ['pass', 'satisfied'],
  ['passed', 'satisfied'],
  ['ok', 'satisfied'],
  ['unmet', 'not_satisfied'],
  ['not met', 'not_satisfied'],
  ['missing', 'not_satisfied'],
  ['fail', 'not_satisfied'],
  ['failed', 'not_satisfied'],
  ['partially', 'partial'],
  ['partially_satisfied', 'partial'],
  ['unclear', 'unknown'],
  ['unsure', 'unknown'],
  ['', 'unknown'],
]);

function acStatus(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (AC_STATUSES.has(s)) return s;
  const mapped = AC_SYNONYMS.get(s) ?? AC_SYNONYMS.get(s.replace(/_/g, ' '));
  return mapped ?? 'unknown';
}

/**
 * `assessment` — một mục cho MỘT tiêu chí, dựng từ danh sách ta đã gửi đi.
 *
 * Không lấy nguyên danh sách model trả về, và đây là chỗ quan trọng nhất của
 * hàm này: `id` phải là số thứ tự của tiêu chí trong request, còn `text` phải
 * là chữ của bên gọi. Ðể model tự đặt `id` hoặc tự viết lại `text` thì bên
 * nhận gộp kết quả nhiều repo theo `id` ấy, và hai kết luận về hai tiêu chí
 * khác nhau sẽ chồng lên nhau mà không ai thấy.
 *
 * Tiêu chí model không nhắc tới → `unknown`. Nói "không biết" là một câu trả
 * lời hợp lệ; bịa ra một trạng thái cho nó thì không.
 */
function buildAssessment(raw, criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) return null;

  const said = new Map();
  const list = Array.isArray(raw?.criteria) ? raw.criteria : Array.isArray(raw) ? raw : [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const id = Number(entry.id);
    if (Number.isInteger(id) && id >= 1 && id <= criteria.length) {
      if (!said.has(id)) said.set(id, entry);
      continue;
    }
    // Không có `id` dùng được thì thử khớp bằng chính chữ của tiêu chí —
    // model nào cũng chép lại đề bài dễ hơn là đếm đúng số thứ tự.
    const text = String(entry.criterion ?? entry.text ?? '').trim().toLowerCase();
    if (!text) continue;
    const at = criteria.findIndex((c) => String(c).trim().toLowerCase() === text);
    if (at >= 0 && !said.has(at + 1)) said.set(at + 1, entry);
  }

  return {
    criteria: criteria.map((text, i) => {
      const id = i + 1;
      const entry = said.get(id);
      const evidence = Array.isArray(entry?.evidence)
        ? entry.evidence
            .filter((ev) => ev && typeof ev === 'object' && String(ev.path ?? '').trim())
            .map((ev) => ({
              path: String(ev.path).trim(),
              lines: String(ev.lines ?? '').trim(),
              note: String(ev.note ?? '').trim(),
            }))
        : [];
      const status = entry ? acStatus(entry.status ?? entry.state) : 'unknown';
      return {
        id,
        text: String(text),
        // Cùng luật với AstraQA: một trạng thái khác `unknown` mà không chỉ
        // được dòng nào thì nó không phải kết luận, nó là một phỏng đoán.
        status: status !== 'unknown' && !evidence.some((ev) => ev.lines) ? 'unknown' : status,
        evidence,
        reason: String(entry?.reason ?? '').trim(),
      };
    }),
  };
}

/** Lấy khối ```json CUỐI CÙNG — model hay in nháp trước rồi mới chốt. */
export function extractJsonBlock(stdout) {
  const text = String(stdout ?? '');
  const fences = [...text.matchAll(/```([A-Za-z0-9_-]*)\r?\n([\s\S]*?)```/g)];
  if (!fences.length) {
    throw new Error('CLI không trả về khối ```json nào.');
  }

  const tagged = fences.filter((f) => f[1].toLowerCase() === 'json');
  const candidates = (tagged.length ? tagged : fences).map((f) => f[2]);

  let lastErr;
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    'Khối ```json của CLI không parse được: ' + (lastErr instanceof Error ? lastErr.message : 'không rõ'),
  );
}

function fail(ticketKey, what) {
  throw new Error(`Ticket "${ticketKey}": CLI trả về sai schema — ${what}`);
}

/**
 * Kiểm `{items: [...]}` rồi trả về ĐÚNG một item của ticket đang xét.
 *
 * Key do model trả phải khớp key đọc từ tickets_md. Lệch thì hỏng thật: hoặc
 * model đang trả lời nhầm ticket, hoặc nó tự đặt lại key — im lặng sửa lại
 * chỉ giấu cả hai.
 */
export function pickItem(parsed, ticketKey, { acceptanceCriteria = [] } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(ticketKey, 'tầng ngoài cùng phải là object có field "items".');
  }
  const items = parsed.items;
  if (!Array.isArray(items)) fail(ticketKey, '"items" phải là mảng.');
  if (items.length === 0) fail(ticketKey, '"items" rỗng.');

  const want = String(ticketKey).trim().toLowerCase();
  const matched = items.filter((it) => it && String(it.key ?? '').trim().toLowerCase() === want);
  if (matched.length === 0) {
    const got = items.map((it) => JSON.stringify(it?.key ?? null)).join(', ');
    fail(ticketKey, `không có item nào mang đúng key này (nhận được: ${got}).`);
  }

  const item = matched[0];
  const status = String(item.code_status ?? '').trim().toLowerCase();
  if (!STATUSES.has(status)) {
    fail(ticketKey, `"code_status" phải là done|partial|missing, nhận được ${JSON.stringify(item.code_status)}.`);
  }

  const confidence = typeof item.confidence === 'number' ? item.confidence : Number(item.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    fail(ticketKey, `"confidence" phải là số trong [0,1], nhận được ${JSON.stringify(item.confidence)}.`);
  }

  if (!Array.isArray(item.evidence)) fail(ticketKey, '"evidence" phải là mảng.');
  const evidence = item.evidence.map((ev, i) => {
    if (!ev || typeof ev !== 'object') fail(ticketKey, `evidence[${i}] phải là object.`);
    if (typeof ev.path !== 'string' || !ev.path.trim()) fail(ticketKey, `evidence[${i}].path phải là chuỗi không rỗng.`);
    return {
      path: ev.path.trim(),
      lines: String(ev.lines ?? '').trim(),
      note: String(ev.note ?? '').trim(),
    };
  });

  const reason = String(item.reason ?? '').trim();
  if (!reason) fail(ticketKey, '"reason" phải là chuỗi không rỗng.');

  return {
    key: String(ticketKey),
    code_status: status,
    confidence,
    evidence,
    reason,
    // Chỉ có mặt khi ticket mang tiêu chí chấp nhận. `null` ở đây là "ticket
    // này không có tiêu chí nào", khác hẳn "có tiêu chí mà chưa chấm" — cái
    // sau là một danh sách toàn `unknown`.
    assessment: buildAssessment(item.assessment, acceptanceCriteria),
  };
}
