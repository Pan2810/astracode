/**
 * Chọn file ứng viên cho một ticket — port nguyên văn `CANDIDATE_MATCHING_SPEC.md`
 * của AstraQA (nguồn: `services/api/src/specguard_api/code_candidates.py`).
 *
 * Mọi hằng số ở đây là giá trị AstraQA đang chạy thật. **Đừng chỉnh cho vừa một
 * bảng kết quả** — hai bên khác luật thì phép so sánh giữa hai engine vô nghĩa,
 * và đó là cả lý do file này tồn tại thay vì một bộ luật tự nghĩ.
 *
 * Khác biệt duy nhất được phép, và được spec yêu cầu ghi rõ: mục §5 — `backend=none`
 * không có bước judge dọn sau nên phải chặt hơn AstraQA. Lựa chọn đã chốt nằm ở
 * `TIGHTEN_MODE` cuối file, kèm số đo dẫn tới nó.
 */

// ── Hằng số (spec §2.2, §3, §4) ────────────────────────────────────────────
export const COMMON_TERM_RATIO = 0.3;
export const MIN_TERMS = 2;
export const RELATIVE_CUT = 0.45;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_SCANNED_FILES = 4000;
export const MAX_MEAN_LINE_CHARS = 400;
export const MAX_FILES_PER_TICKET = 5;

/** §3.1 — allowlist đuôi file. Không phải blocklist: thứ gì không có ở đây thì không quét. */
export const CODE_EXT = new Set([
  '.java', '.kt', '.ts', '.tsx', '.js', '.jsx', '.vue', '.py', '.cs', '.go', '.rb', '.php',
  '.sql', '.swift', '.scala', '.c', '.cc', '.cpp', '.h', '.hpp',
]);

/** §3.1 — loại thẳng theo đuôi, kể cả khi lọt allowlist ở đâu đó. */
export const BINARY_EXT = new Set(['.pyc', '.pyo', '.pyd', '.class', '.o', '.so', '.dll']);

/** §3.1 — khớp BẤT KỲ phần nào của đường dẫn. */
export const EXCLUDED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'bin', 'obj',
  '.venv', 'venv', '__pycache__', '.next', 'coverage', 'vendor',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', 'site-packages',
]);

/** §3.1 — marker minified, khớp substring trong TÊN file, không phân biệt hoa thường. */
export const MINIFIED_MARKERS = ['.min.js', '.min.css', '.bundle.js', '-min.js'];

/** §2.1 — 38 từ nguyên văn của AstraQA. */
export const STOPWORDS_BASE = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'when', 'then',
  'add', 'update', 'fix', 'make', 'use', 'new', 'all', 'api', 'page', 'screen',
  'cua', 'cho', 'khi', 'trong', 'mot', 'tao', 'them', 'sua', 'moi', 'danh',
  'task', 'planning', 'project', 'support', 'using', 'via', 'per', 'self',
]);

/**
 * §2.1 — tám từ spec KHUYẾN NGHỊ thêm riêng cho AstraCode (AstraQA chưa có).
 * Giữ tách rời để đo được ảnh hưởng của chúng, và để biết chỗ nào ta lệch AstraQA.
 */
export const STOPWORDS_EXTRA = new Set([
  'status', 'done', 'list', 'summary', 'tool', 'workspace', 'dashboard', 'graph',
]);

export const STOPWORDS = new Set([...STOPWORDS_BASE, ...STOPWORDS_EXTRA]);

/** §1.2 — dòng metadata bị nhét vào description của export Jira. Loại trước khi tách từ. */
export const METADATA_LINE =
  /^\s*(PO|BA|QA|Dev|Developer|Tester|Reporter|Assignee|Owner|Status|Priority)\s*:/i;

/**
 * §1.3 — hình dạng ticket key. Khớp nguyên chuỗi, KHÔNG BAO GIỜ tách mảnh.
 *
 * ⚠ LỆCH SPEC CÓ CHỦ Ý — cần AstraQA xác nhận.
 *
 * Spec viết regex `^[A-Za-z][A-Za-z0-9]*-\d+$` nhưng ngay dòng dưới liệt kê
 * `GEN-R169` là ví dụ hợp lệ. Hai thứ đó mâu thuẫn: `R169` không phải `\d+`, nên
 * regex nguyên văn LOẠI chính `GEN-R169` — mà đó lại là dạng key thật của dữ
 * liệu (`GEN-R###`), và là ca thử A lẫn B của §6.
 *
 * Theo ví dụ chứ không theo regex, vì ví dụ mới là sự thật về dữ liệu: yêu cầu
 * phần sau dấu `-` có ÍT NHẤT MỘT CHỮ SỐ. Nhờ vậy `GEN-R169`, `COWORKLOCAL-14`,
 * `PRE-001` đều hợp lệ, còn `auto-routing` thì không (nếu nới thành
 * `[A-Za-z0-9]+` thì mọi từ ghép có gạch nối sẽ thành "ticket key").
 */
export const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]*\d[A-Za-z0-9]*$/;

// ── Chuẩn hoá và tách từ (spec §1.4 – §1.7) ────────────────────────────────

/**
 * §1.4 — NFKC → casefold → đ→d → bỏ dấu phụ Latin, GIỮ NGUYÊN kana/kanji.
 *
 * Chỗ dễ sai: `normalize('NFD')` rồi bỏ mọi `\p{Mn}` sẽ nuốt cả dakuten của kana
 * (が → か), làm hỏng từ khoá tiếng Nhật. Nên chỉ bỏ dấu đứng ngay sau chữ Latin.
 */
export function fold(s) {
  const t = String(s ?? '').normalize('NFKC').toLowerCase().replace(/đ/g, 'd');
  return t.normalize('NFD').replace(/([a-z])(\p{Mn}+)/gu, '$1').normalize('NFC');
}

const RE_WORD = /[a-z0-9]{2,}/g;
const RE_IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const RE_CAMEL_SPLIT = /(?<!^)(?=[A-Z])|_/;
const RE_CJK = /[぀-ヿ㐀-䶿一-鿿]{2,}/g;
const RE_HIRAGANA_RUN = /[぀-ゟ]+/;

/**
 * §1.6 — tiếng Nhật không có dấu cách nên một cụm dài là một token vô dụng.
 * Cắt tại các đoạn hiragana (chất kết dính ngữ pháp), rồi bigram hoá phần còn lại.
 */
export function cjkTerms(raw) {
  const out = [];
  for (const cum of String(raw ?? '').match(RE_CJK) ?? []) {
    for (const manh of cum.split(RE_HIRAGANA_RUN)) {
      if (manh.length < 2) continue;
      if (manh.length === 2) out.push(manh);
      else for (let i = 0; i + 2 <= manh.length; i++) out.push(manh.slice(i, i + 2));
    }
  }
  return out;
}

/**
 * Tách từ dùng chung cho hai phía. Khác nhau đúng hai tham số, theo §1.5 vs §1.7:
 * phía ticket ngưỡng 3 ký tự và bỏ stopword; phía file ngưỡng 2 và không bỏ gì.
 * Phía file rộng hơn là cố ý — mọi phép lọc nằm ở phía ticket.
 */
function tokenize(raw, { minLen, stopwords }) {
  const goc = String(raw ?? '');
  const daFold = fold(goc);
  const out = new Set();
  const nhan = (w) => {
    if (w.length < minLen) return;
    if (stopwords?.has(w)) return;
    out.add(w);
  };

  for (const w of daFold.match(RE_WORD) ?? []) nhan(w);

  // Identifier lấy trên chuỗi GỐC vì camelCase mất hoa thường sau khi fold.
  for (const id of goc.match(RE_IDENTIFIER) ?? []) {
    nhan(fold(id));
    for (const manh of id.split(RE_CAMEL_SPLIT)) if (manh) nhan(fold(manh));
  }

  for (const t of cjkTerms(goc)) nhan(t);
  return out;
}

/** §1.7 — phía file: ngưỡng 2, không bỏ stopword. */
export function fileTokens(text) {
  return tokenize(text, { minLen: 2, stopwords: null });
}

/**
 * §1.1 + §1.2 + §1.5 — từ khoá phía ticket.
 *
 * Chỉ `summary` + `description`. KHÔNG dùng status/assignee/priority/labels/… —
 * đó là siêu dữ liệu quản trị, và cho `status` vào là mọi ticket cùng khớp từ
 * `done`. Dòng `PO:`/`BA:`/`Developer:` bị loại trước khi tách để tên người
 * không thành từ khoá.
 */
export function queryTerms(ticket) {
  const summary = String(ticket.title ?? '');
  const description = String(ticket.body ?? '')
    .split(/\r?\n/)
    .filter((d) => !METADATA_LINE.test(d))
    .join('\n');
  return [...tokenize(`${summary}\n${description}`, { minLen: 3, stopwords: STOPWORDS })];
}

/** §1.3 — key hợp lệ thì khớp nguyên chuỗi, không phân biệt hoa thường. */
export function normalizedKey(ticket) {
  const key = String(ticket.key ?? '').trim();
  return TICKET_KEY.test(key) ? key.toLowerCase() : null;
}

// ── Lọc file (spec §3) ─────────────────────────────────────────────────────

export function isExcludedPath(rel) {
  const parts = String(rel).replace(/\\/g, '/').split('/');
  if (parts.some((p) => EXCLUDED_DIRS.has(p))) return true;
  const ten = (parts[parts.length - 1] ?? '').toLowerCase();
  if (MINIFIED_MARKERS.some((m) => ten.includes(m))) return true;
  const ext = ten.includes('.') ? ten.slice(ten.lastIndexOf('.')) : '';
  if (BINARY_EXT.has(ext)) return true;
  return !CODE_EXT.has(ext);
}

/**
 * §3.3 — bundle không đặt tên theo quy ước, bắt bằng độ dài dòng trung bình.
 * File "generated" bị loại HẲN, không phải cắt bớt: không ai kiểm được một trích
 * dẫn trỏ vào cột 40.000.
 */
export function isGenerated(text) {
  const newlines = (String(text).match(/\n/g) ?? []).length;
  if (newlines < 2) return text.length > MAX_MEAN_LINE_CHARS;
  return text.length / (newlines + 1) > MAX_MEAN_LINE_CHARS;
}

// ── Chấm điểm (spec §2.2, §2.3, §4) ────────────────────────────────────────

/** §4.2 — term càng hiếm càng nặng. */
export function weightOf(df, N) {
  return Math.log(1 + N / Math.max(1, df));
}

/**
 * §2.2 + §2.3 — bỏ term quá phổ biến, nhưng có luật thoát hiểm.
 *
 * Trên repo nhỏ hoặc đồng nhất, luật 2.2 bỏ sạch term và ticket có code thật lại
 * không ghi điểm nào. Khi còn dưới `MIN_TERMS` thì bỏ qua bộ lọc và dùng mọi term
 * xuất hiện ít nhất một lần; chuẩn hoá theo độ dài ở §4.2 mới là thứ giữ file tạp
 * nham khỏi thắng.
 */
export function discriminating(terms, df, N) {
  const ceiling = Math.max(1, Math.floor(N * COMMON_TERM_RATIO));
  const giu = terms.filter((t) => {
    const d = df.get(t) ?? 0;
    return d >= 1 && d <= ceiling;
  });
  if (giu.length >= MIN_TERMS) return { terms: giu, escaped: false };
  return { terms: terms.filter((t) => (df.get(t) ?? 0) >= 1), escaped: true };
}

/**
 * §5 — `backend=none` không có judge dọn sau nên phải chặt hơn AstraQA.
 *
 * Ba lựa chọn spec đưa ra, hiệu chỉnh bằng ca thử B:
 *   'min_terms_3'  — nâng sàn term lên 3
 *   'rare_term'    — đòi ít nhất một term xuất hiện ở ≤ 5% số file
 *   'coverage'     — đòi phủ ≥ 50% số term của ticket
 *   'none'         — y hệt AstraQA (dùng để đo mức nền)
 *
 * Giá trị đang dùng ghi ở cuối file, kèm lý do.
 */
export function passesTighten(mode, { matched, queryTermCount, maxWeight, N }) {
  switch (mode) {
    case 'min_terms_3':
      return matched.length >= 3;
    case 'rare_term': {
      // Ngưỡng tính theo N chứ không hardcode — nó phụ thuộc kích thước repo.
      const nguong = weightOf(Math.max(1, Math.floor(0.05 * N)), N);
      return maxWeight >= nguong;
    }
    case 'coverage':
      return queryTermCount > 0 && matched.length / queryTermCount >= 0.5;
    case 'none':
    default:
      return true;
  }
}

/**
 * Dựng index toàn repo MỘT LẦN cho cả job.
 *
 * Bắt buộc phải một lần: `document_frequency` là đại lượng toàn repo, không tính
 * được từ một lượt quét riêng của một ticket. (Bản cũ quét lại repo cho từng
 * ticket, nên cũng không có cách nào tính đúng df.)
 */
export async function buildIndex({ repoDir, fs, path, excludeGlobs = [], matchesAny = () => false }) {
  const files = [];
  const df = new Map();

  async function walk(dir) {
    if (files.length >= MAX_SCANNED_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_SCANNED_FILES) return;
      const abs = path.join(dir, e.name);
      const rel = path.relative(repoDir, abs).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.has(e.name)) continue;
        if (matchesAny(rel, excludeGlobs)) continue;
        await walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      if (isExcludedPath(rel)) continue;
      if (matchesAny(rel, excludeGlobs)) continue;

      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;

      let text;
      try {
        text = await fs.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      if (text.includes(' ')) continue;
      if (isGenerated(text)) continue;

      const tokens = fileTokens(text);
      // File không có token nào (thường là `__init__.py` rỗng) không bao giờ khớp
      // được, nên đếm nó vào `files_scanned` là khai khống phép quét.
      //
      // SUY RA, chưa xác nhận với AstraQA: repo demo có đúng 155 file `.py`, đúng
      // một file rỗng, và spec §6 nói 154. Bỏ file rỗng là khớp chính xác. Nếu
      // AstraQA loại nó bằng luật khác (ví dụ bỏ cả `tests/`) thì sửa ở đây.
      if (tokens.size === 0) continue;
      for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
      files.push({ path: rel, tokens, text, folded: fold(text) });
    }
  }

  await walk(repoDir);
  return { files, df, N: files.length };
}

/**
 * Shortlist cho một ticket. Trả về cả tập term ĐÃ THỰC SỰ dùng để tìm (sau mọi
 * bộ lọc) — đó là thứ `scan.terms` phải mang, không phải toàn bộ từ trong ticket.
 */
export function shortlistFor(ticket, index, { tightenMode = 'none', maxFiles = MAX_FILES_PER_TICKET } = {}) {
  const { files, df, N } = index;

  // §1.3 — key khớp nguyên chuỗi thì dừng ở đó, không chạy tiếp khớp từ vựng.
  const key = normalizedKey(ticket);
  if (key) {
    const trung = files.filter((f) => f.folded.includes(key) || f.path.toLowerCase().includes(key));
    if (trung.length) {
      return {
        matchedBy: 'key',
        terms: [key],
        files: trung.slice(0, maxFiles).map((f) => ({ path: f.path, matched: [key], score: Infinity })),
      };
    }
  }

  const tho = queryTerms(ticket);
  const { terms } = discriminating(tho, df, N);

  // §4.1 lần 1 — dưới sàn thì trả shortlist rỗng NGAY, không chấm file nào.
  if (terms.length < MIN_TERMS) return { matchedBy: 'summary', terms, files: [] };

  const cham = [];
  for (const f of files) {
    const matched = terms.filter((t) => f.tokens.has(t));
    // §4.1 lần 2 — một từ chung là cách "Update member list" bám vào mọi file có "list".
    if (matched.length < MIN_TERMS) continue;

    const maxWeight = Math.max(...matched.map((t) => weightOf(df.get(t) ?? 0, N)));
    if (!passesTighten(tightenMode, { matched, queryTermCount: terms.length, maxWeight, N })) continue;

    // §4.2 — mẫu số là toàn bộ vấn đề: không có nó, một bảng dịch 6000 token
    // thắng module 400 token thật sự hiện thực ticket.
    const tong = matched.reduce((s, t) => s + weightOf(df.get(t) ?? 0, N), 0);
    cham.push({ path: f.path, matched, score: tong / Math.sqrt(Math.max(1, f.tokens.size)) });
  }

  // §4.3 — `path` nằm trong khoá sắp xếp để shortlist ổn định giữa hai lần chạy.
  cham.sort((a, b) => b.score - a.score || b.matched.length - a.matched.length || a.path.localeCompare(b.path));
  const dinh = cham.length ? cham[0].score : 0;
  return {
    matchedBy: 'summary',
    terms,
    files: cham.filter((c) => c.score >= dinh * RELATIVE_CUT).slice(0, maxFiles),
  };
}

/** Dòng đầu tiên trong file có chứa một term đã khớp — để dựng `evidence.lines` thật. */
export function firstLineWith(index, relPath, terms) {
  const f = index.files.find((x) => x.path === relPath);
  if (!f) return { line: 1, term: terms[0] ?? '' };
  const lines = f.text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const low = fold(lines[i]);
    const hit = terms.find((t) => low.includes(t));
    if (hit) return { line: i + 1, term: hit };
  }
  return { line: 1, term: terms[0] ?? '' };
}

/**
 * §5 — lựa chọn siết chặt đang dùng cho `backend=none`.
 * Giá trị này được chốt bằng ca thử B; số đo nằm trong MATCHING_BASELINE.md.
 */
export const TIGHTEN_MODE = 'rare_term';
