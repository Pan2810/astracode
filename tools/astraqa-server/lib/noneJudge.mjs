/**
 * Backend `none` — không gọi model nào.
 *
 * Chỉ quét từ khoá của ticket trên cây file đã lọc và trả về đúng những dòng
 * khớp, kèm số dòng thật. Không cần key, không cần mạng, không cần đăng nhập,
 * và tất định: cùng repo + cùng ticket luôn cho cùng một kết quả.
 *
 * ## Ngữ nghĩa `code_status` (hợp đồng v1.1)
 *
 * Bản trước đặt trần cứng "không bao giờ trả `done`", lấy lý do rằng quét từ khoá
 * không chứng minh được "đã làm xong". Đo thật trên 184 ticket cho thấy trần ấy
 * sai hướng: nó biến mọi ticket CÓ code thành `partial`, và AstraQA đọc ra
 * **140 `JIRA_AHEAD` trong đó 138 là giả**. Trần bảo vệ nhầm thứ.
 *
 * Ngữ nghĩa đúng, khớp engine nội bộ của AstraQA:
 *
 *   - có evidence với path thật          → `done`, confidence 0.25
 *     Đọc là **"source có code cho ticket này"**, KHÔNG phải "đã làm đầy đủ".
 *     Confidence thấp chính là chỗ nói điều đó; đừng đọc `done` ở đây thành
 *     `done` của một người đã review.
 *   - không evidence, `files_scanned > 0` → `missing` kèm bản ghi quét đầy đủ
 *     Đây mới là `JIRA_AHEAD` thật: đã quét thật, quét xong, không thấy gì.
 *   - không quét được file nào           → `missing`, `scan: null`
 *     Không biết gì cả. AstraQA phải đọc thành `NO_EVIDENCE`, không bao giờ
 *     `JIRA_AHEAD`.
 *
 * Phân biệt hai dòng cuối là cả lý do `scan` tồn tại: `evidence: []` một mình
 * không nói được "đã quét và không thấy" hay "chưa quét lần nào".
 */
import { buildRepoContext } from './repoContext.mjs';

export async function judgeWithoutModel({ ticket, options, repoDir }) {
  const ctx = await buildRepoContext({
    repoDir,
    ticket,
    excludeGlobs: options.exclude_globs,
    maxSnippets: 60,
  });

  const keyLow = String(ticket.key).toLowerCase().trim();
  const byKey = ctx.snippets.filter((s) => s.keyword === keyLow);
  const hits = byKey.length ? byKey : ctx.snippets;

  // Một đường dẫn một lần: trần `max_files_per_ticket` đếm theo file, và mười
  // dòng trong cùng một file không phải mười bằng chứng.
  const seen = new Set();
  const evidence = [];
  for (const s of hits) {
    if (seen.has(s.path)) continue;
    seen.add(s.path);
    evidence.push({
      path: s.path,
      lines: String(s.line),
      note: `khớp từ khoá "${s.keyword}" (quét tất định, không qua model)`,
    });
    if (evidence.length >= (options.max_files_per_ticket ?? 5)) break;
  }

  /**
   * Bản ghi quét. `terms` là từ khoá THẬT đã dùng để dò từng dòng (chính
   * `ctx.keywords` mà `buildRepoContext` cầm), không phải một danh sách gợi ý
   * dựng lại sau. `files_scanned` là số file thật sự được mở và dò, đã áp
   * `exclude_globs` — không phải số file ứng viên.
   *
   * Quét không nổi file nào thì `scan` là `null`: thà nói "không biết" còn hơn
   * báo `files_scanned: 0` trông như một phép quét đã chạy và không thấy gì.
   */
  const scan = ctx.scannedFiles > 0 ? { files_scanned: ctx.scannedFiles, terms: ctx.keywords } : null;

  const coEvidence = evidence.length > 0;
  return {
    items: [
      {
        key: ticket.key,
        code_status: coEvidence ? 'done' : 'missing',
        confidence: coEvidence ? 0.25 : 0.2,
        evidence,
        // Giữ nguyên ba giá trị cũ. Việc phân biệt "đã quét, không thấy" với
        // "chưa quét" nằm ở `scan` (null hay không), không phải ở đây — đổi giá
        // trị `reason` sẽ phá client cũ đang so chuỗi.
        reason: byKey.length ? 'matched_by_key' : coEvidence ? 'matched_by_summary' : 'no_match',
      },
    ],
    scan,
  };
}
