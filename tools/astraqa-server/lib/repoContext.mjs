/**
 * Gom ngữ cảnh repo cho backend `fci`.
 *
 * Backend `cli` để agent tự đi tìm; backend `fci` chỉ có một request nên phải
 * mang sẵn đủ thứ để model trích dẫn được: cây file đã lọc, và những DÒNG khớp
 * từ khoá của ticket kèm số dòng thật.
 *
 * ## Từ khoá lấy từ `candidates.mjs`, không còn tự nghĩ
 *
 * Bản trước có một bộ tách từ riêng (`keywordsOf`): cắt key theo dấu gạch rồi
 * lấy từng mảnh, và không bỏ dấu tiếng Việt. Hai hệ quả đo được trên ticket
 * `GEN-R123 / "Thêm nút xoá" / "Cho phép người dùng xoá bản ghi"`:
 *
 *     bản cũ : [ 'gen-r123', 'gen', 'r123', 'phép' ]
 *     spec   : [ 'nut', 'xoa', 'phep', 'nguoi', 'dung', 'ban', 'ghi' ]
 *
 * `gen` là đúng mảnh mà `noneJudge.mjs` ghi là "bị trích 294 lần" và đã chữa
 * bằng `TICKET_KEY` khớp nguyên chuỗi — bản chữa ấy chưa bao giờ tới `fci`. Và
 * không fold dấu thì ticket tiếng Việt còn đúng một từ dùng được. Model chỉ
 * trích dẫn được thứ nó nhìn thấy, nên ngữ cảnh hỏng là verdict hỏng, mà
 * `fci` lại là backend MẶC ÐỊNH.
 *
 * Nên từ đây `queryTerms` + `normalizedKey` của spec là nguồn từ khoá duy nhất
 * cho cả hai backend.
 *
 * ## Vì sao KHÔNG gọi thẳng `shortlistFor`
 *
 * `shortlistFor` chọn BẰNG CHỨNG cho backend `none`, nơi không có ai dọn sau
 * nên nó phải chặt: sàn `MIN_TERMS`, `RELATIVE_CUT`, và một shortlist rỗng là
 * một kết luận. Ở đây ta chọn thứ để model ÐỌC, và model mới là tầng lọc chính
 * xác phía sau — nên chỗ này thiên về thu hồi: một từ khớp cũng thành ứng viên,
 * rồi xếp hạng bằng đúng công thức §4.2 và chỉ lấy `maxFiles` file đầu bảng.
 * Chuẩn hoá theo độ dài trong công thức ấy là thứ giữ file tạp nham khỏi thắng,
 * nên nới sàn không kéo theo nới nhiễu.
 *
 * Vì vậy file này KHÔNG đụng tới `TIGHTEN_MODE` — hằng số ấy đã đóng băng và
 * chỉ nói về backend `none`.
 */
import { EXCLUDED_DIRS, fold, normalizedKey, queryTerms, weightOf } from './candidates.mjs';

/**
 * Corpus phụ: file hạ tầng/cấu hình nằm NGOÀI allowlist đuôi của spec.
 *
 * Vì sao cần. Corpus của `candidates.mjs` chỉ nhận đuôi mã nguồn, và đó là
 * luật đúng cho một matcher tất định. Nhưng đo trên một repo thật (astraqa):
 * 187/583 file nằm ngoài allowlist, trong đó có `.mjs`, `.cjs`, `.yml`,
 * `.json`, `.toml`, `.ps1` — chỗ mà không ít ticket được hiện thực thật sự.
 * Ðể model không nhìn thấy chúng là bắt nó kết luận "chưa làm" về thứ nó chưa
 * bao giờ được cho xem.
 *
 * Vì sao ÐỌC chứ không chỉ LIỆT KÊ TÊN. Liệt kê tên một file mà model chưa đọc
 * nội dung là mời nó trích một đường dẫn nghe hợp lý, và `keepRealEvidence`
 * chỉ kiểm đường dẫn có tồn tại — nên trích dẫn ảo ấy sẽ lọt qua. Ở đây chỉ
 * những file thật sự có dòng khớp mới xuất hiện, kèm số dòng thật.
 *
 * Vì sao KHÔNG có `.md`/`.rst`/`.txt`. Tài liệu hay viết ở thì tương lai
 * ("sẽ bổ sung endpoint X"). Một câu như thế lọt vào ngữ cảnh là đúng đường để
 * model kết luận đã làm xong dựa trên một lời hứa. Tài liệu không phải hiện thực.
 *
 * Corpus này KHÔNG vào `scan.files_scanned`: bản ghi quét nói về phép quét tất
 * định của spec, và giữ cho nó đúng một nghĩa quan trọng hơn là gộp cho to.
 */
export const AUX_EXT = new Set([
  '.mjs', '.cjs', '.json', '.jsonc', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
  '.properties', '.gradle', '.tf', '.tfvars', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.xml', '.proto', '.graphql', '.gql', '.prisma', '.tpl', '.mako', '.j2', '.jinja', '.jinja2',
]);

/** File không có đuôi nhưng vẫn là nơi hiện thực nằm. */
export const AUX_NAMES = new Set([
  'dockerfile', 'makefile', 'procfile', 'jenkinsfile', 'vagrantfile',
  '.env.example', '.env.sample', 'requirements.txt', 'go.mod',
]);

export const AUX_MAX_FILES = 600;
export const AUX_MAX_FILE_BYTES = 256 * 1024;
export const AUX_MAX_TOTAL_BYTES = 4 * 1024 * 1024;

function auxWanted(rel) {
  const name = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
  if (AUX_NAMES.has(name)) return true;
  const dot = name.lastIndexOf('.');
  return dot > 0 && AUX_EXT.has(name.slice(dot));
}

/**
 * Dựng corpus phụ MỘT LẦN cho cả job, như `buildIndex`.
 *
 * Trần byte có vì một `package-lock.json` hay một bundle `.xml` có thể một
 * mình ăn hết ngân sách và đẩy những file thật sự đáng đọc ra ngoài.
 */
export async function buildAuxCorpus({ repoDir, fs, path, excludeGlobs = [], matchesAny = () => false }) {
  const files = [];
  let budget = AUX_MAX_TOTAL_BYTES;

  async function walk(dir) {
    if (files.length >= AUX_MAX_FILES || budget <= 0) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= AUX_MAX_FILES || budget <= 0) return;
      const abs = path.join(dir, e.name);
      const rel = path.relative(repoDir, abs).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.has(e.name)) continue;
        if (matchesAny(rel, excludeGlobs)) continue;
        await walk(abs);
        continue;
      }
      if (!e.isFile() || !auxWanted(rel)) continue;
      if (matchesAny(rel, excludeGlobs)) continue;
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      if (stat.size > AUX_MAX_FILE_BYTES) continue;
      let text;
      try {
        text = await fs.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000') || !text.trim()) continue;
      budget -= stat.size;
      files.push({ path: rel, text });
    }
  }

  await walk(repoDir);
  return { files, N: files.length };
}

/** Trần dòng trích ra từ MỘT file, để một file dài không ăn hết ngân sách. */
const MAX_LINES_PER_FILE = 8;

/**
 * Sàn số file ứng viên cho model đọc.
 *
 * Sàn chứ không phải trần: bên gọi xin `max_files_per_ticket` bằng chứng thì
 * model phải được xem ÍT NHẤT chừng ấy file, nếu không nó không có cách nào
 * điền đủ cái trần vừa được cho. Tám là mức dưới, để một job đặt trần 2 vẫn
 * cho model vài lựa chọn thay vì ép nó chọn trong hai.
 */
export const MIN_CONTEXT_FILES = 8;

/**
 * Từ khoá dùng để tìm, theo đúng spec.
 *
 * `key` chỉ có mặt khi nó đúng hình dạng ticket key (§1.3) và luôn khớp NGUYÊN
 * CHUỖI — không bao giờ là một mảnh như `gen`.
 *
 * @returns {{key: string|null, terms: string[], needles: string[]}}
 */
export function contextTerms(ticket) {
  const key = normalizedKey(ticket);
  const terms = queryTerms(ticket);
  return { key, terms, needles: key ? [key, ...terms] : terms };
}

/** Những dòng trong một file có chứa một needle, kèm số dòng THẬT. */
function linesOf(file, needles, limit) {
  const out = [];
  const raw = file.text.split(/\r?\n/);
  for (let i = 0; i < raw.length && out.length < limit; i++) {
    const low = fold(raw[i]);
    const hit = needles.find((n) => low.includes(n));
    if (!hit) continue;
    out.push({ path: file.path, line: i + 1, text: raw[i].trim().slice(0, 200), keyword: hit });
  }
  return out;
}

/**
 * @param {object} a
 * @param {object} a.index index toàn repo, dựng MỘT LẦN cho cả job (xem analyze.mjs).
 *   Bản trước đi lại cả cây thư mục cho TỪNG ticket — 184 ticket là 184 lượt
 *   quét đĩa cho cùng một bản clone.
 */
export function buildRepoContext({
  index,
  ticket,
  aux = null,
  maxTreeFiles = 300,
  maxSnippets = 40,
  maxFiles = MIN_CONTEXT_FILES,
  // Trần RIÊNG, nhỏ hơn hẳn: corpus phụ là chỗ bổ khuyết, không được lấn chỗ
  // của mã nguồn trong prompt.
  maxAuxFiles = 3,
  maxAuxSnippets = 10,
} = {}) {
  const { key, terms, needles } = contextTerms(ticket);
  const { files, df, N } = index;

  // §1.3 — key khớp nguyên chuỗi thì đó là ứng viên chắc nhất, xếp trước mọi
  // file chỉ khớp từ vựng.
  const scored = [];
  for (const f of files) {
    const matched = terms.filter((t) => f.tokens.has(t));
    const keyHit = Boolean(key) && (f.folded.includes(key) || f.path.toLowerCase().includes(key));
    if (!keyHit && matched.length === 0) continue;
    const weight = matched.reduce((s, t) => s + weightOf(df.get(t) ?? 0, N), 0);
    scored.push({
      file: f,
      matched: keyHit ? [key, ...matched] : matched,
      // §4.2 — mẫu số là toàn bộ vấn đề: không có nó, một bảng dịch 6000 token
      // thắng module 400 token thật sự hiện thực ticket.
      score: keyHit ? Infinity : weight / Math.sqrt(Math.max(1, f.tokens.size)),
    });
  }
  // `path` nằm trong khoá sắp xếp để ngữ cảnh ổn định giữa hai lần chạy.
  scored.sort((a, b) => b.score - a.score || b.matched.length - a.matched.length || a.file.path.localeCompare(b.file.path));

  /*
   * `maxSnippets` mới là thứ chặn kích thước prompt, nên `maxFiles` có nới
   * rộng cũng không làm prompt nổ. Ðổi lại phải đếm ứng viên bằng số file
   * THẬT SỰ góp được dòng: một file lọt shortlist nhờ tên khớp key mà trong
   * ruột không có dòng nào khớp thì model có đọc gì của nó đâu mà tính.
   */
  const picked = [];
  const snippets = [];
  for (const cand of scored.slice(0, Math.max(1, maxFiles))) {
    if (snippets.length >= maxSnippets) break;
    const room = Math.min(MAX_LINES_PER_FILE, maxSnippets - snippets.length);
    const lines = linesOf(cand.file, cand.matched, room);
    if (!lines.length) continue;
    picked.push(cand);
    snippets.push(...lines);
  }

  /*
   * Corpus phụ: xếp theo số dòng khớp, lấy vài file đầu.
   *
   * Không chấm điểm theo df như phía mã nguồn: tập này nhỏ và không có
   * `document_frequency` để dựa vào, mà nó cũng chỉ đóng vai bổ khuyết.
   */
  const auxHits = [];
  for (const f of aux?.files ?? []) {
    const lines = linesOf(f, needles, MAX_LINES_PER_FILE);
    if (lines.length) auxHits.push({ path: f.path, lines });
  }
  auxHits.sort((a, b) => b.lines.length - a.lines.length || a.path.localeCompare(b.path));

  const auxSnippets = [];
  for (const hit of auxHits.slice(0, Math.max(0, maxAuxFiles))) {
    if (auxSnippets.length >= maxAuxSnippets) break;
    auxSnippets.push(...hit.lines.slice(0, maxAuxSnippets - auxSnippets.length));
  }

  return {
    // Cây file là CORPUS ÐÃ QUÉT, không phải mọi thứ trong bản clone: chỉ
    // những file đã qua allowlist đuôi, loại thư mục, loại minified/generated
    // và `exclude_globs`. Khai đúng thứ đã đọc để model không trích một đường
    // dẫn mà cả phép quét lẫn nó đều chưa từng nhìn thấy.
    files: files.slice(0, maxTreeFiles).map((f) => f.path),
    totalFiles: N,
    truncated: N > maxTreeFiles,
    // Số file model THẬT SỰ được đọc trích đoạn. Khác `files_scanned` (cả
    // corpus) và đó là chỗ phân biệt "không có ứng viên nào" với "có ứng viên
    // nhưng model đọc xong vẫn không nêu bằng chứng".
    candidates: picked.length,
    snippets,
    // Dòng khớp từ file hạ tầng/cấu hình ngoài allowlist. Tách riêng khỏi
    // `snippets` vì chúng KHÔNG thuộc phép quét tất định, và `scan` không
    // được đếm chúng.
    auxSnippets,
    auxFiles: [...new Set(auxSnippets.map((s) => s.path))],
    auxScanned: aux?.N ?? 0,
    keywords: needles,
    terms,
    key,
    complete: index.complete === true,
  };
}

export function renderContext(ctx) {
  const out = [];
  out.push(
    `Cây file đã quét (${ctx.totalFiles} file${ctx.truncated ? `, hiện ${Math.min(ctx.files.length, ctx.totalFiles)} đầu` : ''}` +
      `${ctx.complete ? '' : ', phép quét CHƯA đi hết repo'}):`,
  );
  out.push(ctx.files.map((f) => `  ${f}`).join('\n') || '  (rỗng)');
  out.push('');
  if (ctx.snippets.length) {
    out.push(`Các dòng khớp từ khoá của ticket (${ctx.keywords.join(', ')}):`);
    for (const s of ctx.snippets) out.push(`  ${s.path}:${s.line}: ${s.text}`);
  } else {
    out.push(`Không dòng nào trong ${ctx.totalFiles} file đã quét khớp từ khoá của ticket (${ctx.keywords.join(', ') || '(không rút được từ khoá nào)'}).`);
  }
  if (ctx.auxSnippets?.length) {
    out.push('');
    out.push(
      `Ngoài ra, trong ${ctx.auxScanned} file hạ tầng/cấu hình (yaml, json, script, Dockerfile…) — ` +
        'chúng nằm ngoài cây file trên và không thuộc phép quét mã nguồn, nhưng vẫn là đường dẫn có thật:',
    );
    for (const s of ctx.auxSnippets) out.push(`  ${s.path}:${s.line}: ${s.text}`);
  }
  return out.join('\n');
}
