/**
 * Bóc khối ```json trong stdout của CLI và kiểm schema.
 *
 * Mọi đường ở đây kết thúc bằng THROW chứ không bằng một giá trị mặc định.
 * Một `items: []` trả về im lặng khi model nói lung tung là kiểu hỏng tệ nhất
 * của hệ này: AstraQA sẽ đọc nó thành "không ticket nào có vấn đề".
 */

const STATUSES = new Set(['done', 'partial', 'missing']);

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
export function pickItem(parsed, ticketKey) {
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
    ac_assessment: Array.isArray(item.ac_assessment) ? item.ac_assessment : [],
  };
}
