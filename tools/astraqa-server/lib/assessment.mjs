/** AC assessment is independent of the legacy Jira/source consistency verdict. */
const STATUSES = new Set(['satisfied', 'partial', 'not_satisfied', 'unknown']);

export function notAssessed(ticket) {
  const criteria = (Array.isArray(ticket.acceptance_criteria) ? ticket.acceptance_criteria : [])
    .map((text, index) => ({ id: index + 1, text, status: 'unknown', evidence: [], reason: null, test_status: 'not_run' }));
  return { state: 'not_assessed', test_status: 'not_run', criteria };
}

/**
 * Hai chiều khẳng định, và chúng KHÔNG chịu chung một luật.
 *
 * - `satisfied` / `partial` là khẳng định DƯƠNG: "có code làm việc này". Bằng
 *   chứng cho nó là một dòng mở được, nên thiếu dòng ấy thì hạ về `unknown`.
 * - `not_satisfied` là khẳng định ÂM: "đã tìm và không có". Một tiêu chí chưa
 *   làm thì tự nhiên KHÔNG có dẫn chứng — đòi dẫn chứng ở đây là đòi một thứ
 *   không thể tồn tại, và bản trước vì thế hạ mọi `not_satisfied` về `unknown`,
 *   khiến `state: "not_implemented"` gần như không bao giờ đạt tới. Ðiều kiện
 *   đúng cho chiều âm là PHẠM VI QUÉT: lượt này có thật sự đi tìm không.
 * - `unknown` luôn nhận: nó chính là câu trả lời khi hai điều kiện trên hụt.
 *
 * `coverage` do người gọi tính và truyền vào (xem `analyze.mjs`), vì chỉ bên đó
 * biết lượt này có bản ghi quét đầy đủ hay một phiên agent đã tự duyệt repo.
 * Mặc định `false` — không nói gì thì coi như chưa chứng minh được là đã tìm.
 */
function decide(claimed, hasEvidence, coverage) {
  if (!STATUSES.has(claimed)) return 'unknown';
  if (claimed === 'unknown') return 'unknown';
  if (claimed === 'not_satisfied') return coverage ? 'not_satisfied' : 'unknown';
  return hasEvidence ? claimed : 'unknown';
}

export async function normalizeAssessment({ raw, ticket, repoDir, options, validateEvidence, coverage = false }) {
  const requested = Array.isArray(ticket.acceptance_criteria) ? ticket.acceptance_criteria : [];
  if (!requested.length) return notAssessed(ticket);

  const supplied = new Map();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const id = Number(entry?.id);
    if (Number.isInteger(id) && id >= 1 && id <= requested.length && !supplied.has(id)) supplied.set(id, entry);
  }

  const criteria = [];
  for (let index = 0; index < requested.length; index++) {
    const id = index + 1;
    const entry = supplied.get(id);
    const claimed = String(entry?.status ?? '').trim().toLowerCase();
    const candidates = Array.isArray(entry?.evidence)
      ? entry.evidence.filter((ev) => ev && typeof ev.path === 'string' && ev.path.trim())
          .map((ev) => ({ path: ev.path, lines: String(ev.lines ?? ''), note: String(ev.note ?? '') }))
      : [];
    const checked = await validateEvidence(candidates, repoDir, options);
    // An AC assertion needs a precise, openable line, not merely a plausible filename.
    const evidence = checked.evidence.filter((ev) => ev.lines);
    const status = decide(claimed, evidence.length > 0, coverage);
    criteria.push({
      id,
      text: requested[index],
      status,
      evidence,
      reason: String(entry?.reason ?? '').trim().slice(0, 2000) || null,
      // Model assertions about test results are not execution records.
      test_status: 'not_run',
    });
  }

  const statuses = criteria.map((criterion) => criterion.status);
  const state = statuses.every((status) => status === 'satisfied') ? 'implemented_unverified'
    : statuses.every((status) => status === 'not_satisfied') ? 'not_implemented'
      : statuses.some((status) => status === 'satisfied' || status === 'partial') ? 'partial'
        : 'not_assessed';
  return { state, test_status: 'not_run', criteria };
}
