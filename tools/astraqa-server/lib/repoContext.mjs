/**
 * Gom ngữ cảnh repo cho backend `fci`.
 *
 * Backend `cli` để agent tự đi tìm; backend `fci` chỉ có một request nên phải
 * mang sẵn đủ thứ để model trích dẫn được: cây file đã lọc, và những DÒNG khớp
 * từ khoá của ticket kèm số dòng thật.
 *
 * Số dòng ở đây là số dòng thật đọc từ đĩa — nhờ vậy model có cái để chép đúng
 * thay vì đoán, và bộ lọc tất định ở `analyze.mjs` vẫn kiểm lại lần nữa.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { matchesAny } from './globs.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build', '.next', 'vendor']);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.tar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.wasm', '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.bin', '.model', '.onnx', '.pyc',
]);

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'when', 'then', 'them', 'have', 'khi',
  'cho', 'khong', 'không', 'được', 'duoc', 'phải', 'phai', 'thêm', 'them', 'trang', 'trong',
  'người', 'nguoi', 'dùng', 'dung', 'một', 'mot', 'của', 'cua', 'theo', 'tại', 'tai', 'các', 'cac',
]);

const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

async function walk(dir, repoDir, excludeGlobs, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= 5000) return;
    const abs = path.join(dir, e.name);
    const rel = path.relative(repoDir, abs).replace(/\\/g, '/');
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (matchesAny(rel, excludeGlobs)) continue;
      await walk(abs, repoDir, excludeGlobs, out);
    } else if (e.isFile()) {
      if (BINARY_EXT.has(path.extname(e.name).toLowerCase())) continue;
      if (matchesAny(rel, excludeGlobs)) continue;
      out.push(rel);
    }
  }
}

/** Từ khoá tìm kiếm rút từ ticket — key nguyên văn cộng các token đủ dài. */
export function keywordsOf(ticket) {
  const words = `${ticket.title ?? ''} ${String(ticket.body ?? '').slice(0, 400)}`
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const key = String(ticket.key ?? '').toLowerCase().trim();
  const keyParts = key.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
  return [...new Set([key, ...keyParts, ...words].filter(Boolean))].slice(0, 14);
}

export async function buildRepoContext({ repoDir, ticket, excludeGlobs = [], maxTreeFiles = 300, maxSnippets = 40 }) {
  const files = [];
  await walk(repoDir, repoDir, excludeGlobs, files);

  const keywords = keywordsOf(ticket);
  const snippets = [];
  let budget = MAX_TOTAL_BYTES;
  // Ðếm file THỰC SỰ được mở và dò từng dòng — không phải số file ứng viên.
  // Vòng lặp dưới đây dừng sớm khi đủ `maxSnippets` hoặc hết `budget`, và bỏ qua
  // file quá lớn / nhị phân trá hình; báo `files.length` sẽ là bịa.
  let scannedFiles = 0;

  for (const rel of files) {
    if (snippets.length >= maxSnippets || budget <= 0) break;
    const abs = path.join(repoDir, rel);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;
    budget -= stat.size;

    let text;
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue; // nhị phân trá hình

    // Tới được đây nghĩa là file đã thật sự được mở và sắp dò từng dòng.
    scannedFiles += 1;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && snippets.length < maxSnippets; i++) {
      const low = lines[i].toLowerCase();
      const hit = keywords.find((k) => low.includes(k));
      if (!hit) continue;
      snippets.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 200), keyword: hit });
    }
  }

  return {
    files: files.slice(0, maxTreeFiles),
    totalFiles: files.length,
    // Số file đã mở và dò thật, sau khi áp `exclude_globs` và các bộ lọc khác.
    scannedFiles,
    // Vòng lặp có dừng sớm không — nếu có thì `scannedFiles` nhỏ hơn corpus.
    scanTruncated: scannedFiles < files.length,
    truncated: files.length > maxTreeFiles,
    snippets,
    keywords,
  };
}

/** Đếm dòng theo đúng quy ước của bộ lọc evidence (xuống dòng cuối không tính thành dòng mới). */
export function renderContext(ctx) {
  const out = [];
  out.push(`Cây file của repo (${ctx.totalFiles} file${ctx.truncated ? `, hiện ${ctx.files.length} đầu` : ''}):`);
  out.push(ctx.files.map((f) => `  ${f}`).join('\n') || '  (rỗng)');
  out.push('');
  if (ctx.snippets.length) {
    out.push(`Các dòng khớp từ khoá của ticket (${ctx.keywords.join(', ')}):`);
    for (const s of ctx.snippets) out.push(`  ${s.path}:${s.line}: ${s.text}`);
  } else {
    out.push(`Không dòng nào khớp từ khoá của ticket (${ctx.keywords.join(', ')}).`);
  }
  return out.join('\n');
}
