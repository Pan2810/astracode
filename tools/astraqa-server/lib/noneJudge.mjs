/**
 * Backend `none` — không gọi model nào.
 *
 * Chỉ quét từ khoá của ticket trên cây file đã lọc và trả về đúng những dòng
 * khớp, kèm số dòng thật. Không cần key, không cần mạng, không cần đăng nhập,
 * và tất định: cùng repo + cùng ticket luôn cho cùng một kết quả.
 *
 * Nó KHÔNG BAO GIỜ trả `done`. Một phép quét từ khoá chứng minh được "có chỗ
 * nhắc tới thứ này", không chứng minh được "đã làm xong" — trả `done` ở đây là
 * nói dối bằng một con số confidence trông có vẻ đáng tin. Trần của nó là
 * `partial`, và đó cũng là ranh giới giữa nó với hai backend kia.
 *
 * Dùng để: dựng đường ống, kiểm hợp đồng HTTP với AstraQA, và có một mức nền
 * tất định để so khi model nói khác.
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

  return {
    items: [
      {
        key: ticket.key,
        code_status: hits.length ? 'partial' : 'missing',
        confidence: byKey.length ? 0.5 : hits.length ? 0.35 : 0.2,
        evidence,
        reason: byKey.length ? 'matched_by_key' : hits.length ? 'matched_by_summary' : 'no_match',
      },
    ],
  };
}
