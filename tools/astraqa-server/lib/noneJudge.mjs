/**
 * Backend `none` — không gọi model nào.
 *
 * Từ 2026-09-16 nó chạy theo `CANDIDATE_MATCHING_SPEC.md` của AstraQA
 * (`lib/candidates.mjs`): cùng hằng số, cùng stopword, cùng ngưỡng. Hai bên khác
 * luật thì bảng so sánh giữa hai engine vô nghĩa.
 *
 * Bản cũ quét từ khoá thô và để lọt hai lỗi mà spec §0 đo được: `gen` (mảnh của
 * ticket key `GEN-R###`) bị trích 294 lần, và `assets/d3.min.js` bị trích 89 lần.
 * Hệ quả là KHÔNG ticket nào có `evidence == []`, nên `scan` của hợp đồng v1.1
 * không bao giờ được dùng tới và bảng nghiệm thu ra `JIRA_AHEAD = 0`.
 *
 * ## Ngữ nghĩa `code_status` (hợp đồng v1.1)
 *
 *   - có evidence với path thật          → `done`, confidence 0.25
 *     Đọc là **"source có code cho ticket này"**, KHÔNG phải "đã làm đầy đủ".
 *     Confidence thấp chính là chỗ nói điều đó.
 *   - shortlist rỗng, `files_scanned > 0` → `missing` kèm bản ghi quét đầy đủ
 *     Đây mới là `JIRA_AHEAD` thật: đã quét thật, quét xong, không thấy gì.
 *   - không quét được file nào           → `missing`, `scan: null`
 *     Không biết gì cả → AstraQA đọc thành `NO_EVIDENCE`, không bao giờ `JIRA_AHEAD`.
 */
import { shortlistFor, firstLineWith, TIGHTEN_MODE, MAX_FILES_PER_TICKET } from './candidates.mjs';

/**
 * @param {object} a
 * @param {object} a.index index toàn repo, dựng MỘT LẦN cho cả job (xem analyze.mjs).
 *   `document_frequency` là đại lượng toàn repo nên không tính được từ một lượt
 *   quét riêng của một ticket.
 */
export async function judgeWithoutModel({ ticket, options, index }) {
  const maxFiles = options?.max_files_per_ticket ?? MAX_FILES_PER_TICKET;
  const { matchedBy, terms, files } = shortlistFor(ticket, index, {
    tightenMode: TIGHTEN_MODE,
    maxFiles,
  });

  const evidence = files.map((f) => {
    const { line, term } = firstLineWith(index, f.path, f.matched);
    return {
      path: f.path,
      lines: String(line),
      note:
        matchedBy === 'key'
          ? `khớp ticket key "${term}" nguyên chuỗi (quét tất định, không qua model)`
          : `khớp ${f.matched.length} từ khoá: ${f.matched.join(', ')} (quét tất định, không qua model)`,
    };
  });

  /**
   * `terms` phải là tập term THỰC SỰ đã dùng để tìm — sau mọi bộ lọc (§5), không
   * phải toàn bộ từ trong ticket. `files_scanned` là kích thước index, tức số file
   * đã đọc và tách token sau khi áp allowlist đuôi, loại thư mục, loại minified,
   * loại file generated và `exclude_globs`.
   *
   * Index rỗng thì `scan` là `null`: thà nói "không biết" còn hơn báo
   * `files_scanned: 0` trông như một phép quét đã chạy xong và không thấy gì.
   */
  const scan = index.N > 0
    ? { files_scanned: index.N, terms, complete: index.complete === true, omitted: index.omitted }
    : null;

  const coEvidence = evidence.length > 0;
  return {
    items: [
      {
        key: ticket.key,
        code_status: coEvidence ? 'done' : 'missing',
        // 0.25 cho CẢ HAI nhánh là theo spec §6 ca C, nơi item `missing` cũng ghi
        // `confidence: 0.25`. Con số này không tham gia luật [4] của AstraQA; giữ
        // đúng giá trị spec để hai bên diff được từng field.
        confidence: 0.25,
        evidence,
        // Giữ nguyên ba giá trị cũ. Phân biệt "đã quét, không thấy" với "chưa
        // quét" nằm ở `scan` (null hay không), không phải ở đây — đổi giá trị
        // `reason` sẽ phá client cũ đang so chuỗi.
        reason: matchedBy === 'key' && coEvidence ? 'matched_by_key' : coEvidence ? 'matched_by_summary' : 'no_match',
      },
    ],
    scan,
  };
}
