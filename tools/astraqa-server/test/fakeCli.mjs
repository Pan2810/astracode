#!/usr/bin/env node
/**
 * Đóng vai CLI của AstraCode để nghiệm thu và test chạy được khi không có
 * gateway/LLM.
 *
 * Nó nhận ĐÚNG argv mà server gửi cho CLI thật (`--mode=plan --raw -p <prompt>`),
 * lấy ticket key từ prompt và lấy bằng chứng từ chính thư mục đang đứng — nên
 * nó không biết repo nào, y như CLI thật. Trỏ ASTRACODE_CLI_PATH vào file này
 * là chạy được toàn bộ đường ống mà không tốn một token nào.
 *
 * Cố ý trả về một đường dẫn KHÔNG tồn tại trong mỗi câu trả lời, để chứng minh
 * bộ lọc "path phải có thật trong repo" của server thực sự cắt.
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const pi = argv.indexOf('-p');
const prompt = pi >= 0 ? (argv[pi + 1] ?? '') : '';

if (prompt.includes('Review the supplied code evidence for ticket ')) {
  const key = /Review the supplied code evidence for ticket ([^.]*)\./.exec(prompt)?.[1]?.trim() || '';
  const guide = JSON.parse(/Choose exactly one verdict key from this guide: (\{[^\n]*\})\./.exec(prompt)?.[1] || '{}');
  const verdict = Object.keys(guide)[0];
  console.log('```json');
  console.log(JSON.stringify({ key, verdict, confidence: 0.7, reason: 'fake CLI inspected cited code' }));
  console.log('```');
  process.exit(0);
}

const key = (/Ticket key:\s*(.+)/.exec(prompt)?.[1] ?? '').trim();
if (!key) {
  console.error('fakeCli: prompt không có dòng "Ticket key:".');
  process.exit(2);
}

function walk(dir, out = [], depth = 0) {
  if (out.length >= 8 || depth > 3) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, depth + 1);
    else if (e.isFile()) out.push(full);
    if (out.length >= 8) break;
  }
  return out;
}

const root = process.cwd();
const files = walk(root).slice(0, 2);

function lineCount(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    return Math.max(1, text.split(/\r?\n/).length);
  } catch {
    return 1;
  }
}

// Trạng thái suy ra từ key, tất định nhưng khác nhau giữa các ticket.
const STATUSES = ['done', 'partial', 'missing'];
let h = 0;
for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
const status = STATUSES[h % STATUSES.length];

const evidence = files.map((f) => {
  const rel = path.relative(root, f).replace(/\\/g, '/');
  const total = lineCount(f);
  const end = Math.min(total, 5);
  return { path: rel, lines: end > 1 ? `1-${end}` : '1', note: `stub: file có thật trong repo (${total} dòng)` };
});
evidence.push({
  path: 'khong/ton/tai-' + (h % 97) + '.txt',
  lines: '1-3',
  note: 'stub: đường dẫn bịa, server phải loại dòng này',
});

console.log(`· read_file ${evidence[0]?.path ?? '(repo rỗng)'}`);
console.log(`✓ tìm xong cho ${key}`);
console.log('```json');
console.log(
  JSON.stringify(
    {
      items: [
        {
          key,
          code_status: status,
          confidence: Number((0.5 + (h % 50) / 100).toFixed(2)),
          evidence,
          reason: files.length ? 'matched_by_key' : 'matched_by_summary',
          ac_assessment: key === 'A-1' ? [
            { id: 1, status: 'satisfied', evidence: evidence.slice(0, 1), reason: 'source line found', test_status: 'passed' },
            { id: 2, status: 'satisfied', evidence: [{ path: 'missing-ac.ts', lines: '1' }], reason: 'fabricated citation' },
          ] : [],
        },
      ],
    },
    null,
    2,
  ),
);
console.log('```');
