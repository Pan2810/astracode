#!/usr/bin/env node
/**
 * Ðo chất lượng khớp ticket↔code của backend `none`, để so TRƯỚC và SAU khi đổi
 * luật rút từ khoá.
 *
 * Vì sao gọi thẳng thư viện chứ không qua HTTP: cả hai lần đo phải chạy trên
 * ĐÚNG một bản clone và đúng một danh sách ticket, nếu không thì chênh lệch đọc
 * được có thể đến từ repo chứ không từ luật. Script clone một lần rồi lặp
 * `judgeWithoutModel` — không gọi model, không tốn quota.
 *
 * Dùng:
 *   node scripts/measure-matching.mjs --tickets <file.md> --repo <url|đường dẫn> \
 *        --label truoc --out truoc.json
 *   node scripts/measure-matching.mjs --compare truoc.json sau.json
 *
 * `--keep <dir>` giữ lại bản clone để lần đo sau dùng lại (nhanh hơn, và chắc
 * chắn cùng một revision).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseTickets } from '../lib/tickets.mjs';
import { judgeWithoutModel } from '../lib/noneJudge.mjs';
import { keywordsOf } from '../lib/repoContext.mjs';
import { cloneRepo } from '../lib/git.mjs';
import { keepRealEvidence, DEFAULT_OPTIONS } from '../lib/analyze.mjs';

function argOf(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * Verdict theo đúng luật [4] mà AstraQA đã chốt:
 *   - scan == null                                   → NO_EVIDENCE
 *   - scan != null && files_scanned > 0 && ev rỗng    → JIRA_AHEAD
 *   - có evidence, Jira đã Done                       → MATCH
 *   - có evidence, Jira chưa Done                     → CODE_AHEAD
 *
 * Hai nhánh cuối là suy ra, không nằm trong câu chữ của [4]; chúng chỉ để dựng
 * bảng so cho dễ đọc. Nhánh JIRA_AHEAD và NO_EVIDENCE là nguyên văn.
 */
function verdictOf(item, ticket) {
  if (!item.scan) return 'NO_EVIDENCE';
  if (item.scan.files_scanned > 0 && item.evidence.length === 0) return 'JIRA_AHEAD';
  const done = /^(done|closed|resolved|xong|hoàn thành|hoan thanh)$/i.test(String(ticket.status ?? '').trim());
  return done ? 'MATCH' : 'CODE_AHEAD';
}

async function doMot({ ticketsFile, repo, label, out, keep }) {
  const tickets_md = await fs.readFile(ticketsFile, 'utf8');
  const tickets = parseTickets(tickets_md);

  // CHUẨN HOÁ trước khi dùng: `keepRealEvidence` so đường dẫn bằng
  // `path.resolve` (trên Windows là dấu `\`), nên một `repoDir` viết bằng `/`
  // sẽ làm mọi evidence bị loại nhầm là "thoát khỏi repo". Server thật không
  // dính vì nó dựng repoDir bằng `path.join`.
  let repoDir = keep ? path.resolve(keep) : null;
  let revision = null;
  const sanClone = !keep || !(await fs.stat(path.join(keep, '.git')).then(() => true).catch(() => false));
  if (sanClone) {
    repoDir = keep ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'measure-')));
    await fs.mkdir(repoDir, { recursive: true });
    const r = await cloneRepo({ repoUrl: repo, destDir: repoDir, redact: (s) => s, timeoutMs: 600_000 });
    revision = r.head;
    process.stderr.write(`clone xong → ${repoDir} @ ${revision}\n`);
  } else {
    // Dùng lại bản clone thì `cloneRepo` không chạy, nên đọc SHA từ chính repo —
    // `revision` phải luôn có, nó đi vào từng `scan.revision`.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    revision = (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();
    process.stderr.write(`dùng lại bản clone có sẵn: ${repoDir} @ ${revision}\n`);
  }

  const options = { ...DEFAULT_OPTIONS };
  const rows = [];
  const t0 = Date.now();

  for (const ticket of tickets) {
    const r = await judgeWithoutModel({ ticket, options, repoDir });
    const item = r.items[0];
    const { evidence } = await keepRealEvidence(item.evidence, repoDir, options);
    item.evidence = evidence;
    item.scan = r.scan ? { ...r.scan, revision } : null;
    rows.push({
      key: ticket.key,
      title: ticket.title ?? '',
      jira_status: ticket.status ?? '',
      code_status: item.code_status,
      confidence: item.confidence,
      reason: item.reason,
      evidence: item.evidence,
      scan: item.scan,
      terms: keywordsOf(ticket),
      verdict: verdictOf(item, ticket),
    });
  }

  const snapshot = {
    label,
    measured_at: new Date().toISOString(),
    repo,
    revision,
    tickets_file: ticketsFile,
    tickets: rows.length,
    duration_ms: Date.now() - t0,
    rows,
  };
  if (out) await fs.writeFile(out, JSON.stringify(snapshot, null, 2), 'utf8');
  inBang(snapshot);
  if (out) process.stderr.write(`\nđã ghi ${out}\n`);
  return snapshot;
}

function thongKe(s) {
  const tongEvidence = s.rows.reduce((n, r) => n + r.evidence.length, 0);

  const theoFile = new Map();
  const theoTerm = new Map();
  for (const r of s.rows) {
    for (const ev of r.evidence) {
      theoFile.set(ev.path, (theoFile.get(ev.path) ?? 0) + 1);
      const term = /khớp từ khoá "([^"]+)"/.exec(ev.note)?.[1] ?? '?';
      theoTerm.set(term, (theoTerm.get(term) ?? 0) + 1);
    }
  }

  const demTheo = (f) => {
    const m = new Map();
    for (const r of s.rows) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  return {
    tongEvidence,
    file: [...theoFile.entries()].sort((a, b) => b[1] - a[1]),
    term: [...theoTerm.entries()].sort((a, b) => b[1] - a[1]),
    status: demTheo((r) => r.code_status),
    verdict: demTheo((r) => r.verdict),
    soTermTB: (s.rows.reduce((n, r) => n + r.terms.length, 0) / Math.max(1, s.rows.length)).toFixed(1),
    ticketKhongEvidence: s.rows.filter((r) => r.evidence.length === 0).length,
  };
}

function inBang(s) {
  const k = thongKe(s);
  console.log(`\n═══ ${s.label ?? '(không nhãn)'} — ${s.tickets} ticket @ ${String(s.revision).slice(0, 12)} ═══`);
  console.log(`tổng evidence            : ${k.tongEvidence}`);
  console.log(`ticket không có evidence : ${k.ticketKhongEvidence}`);
  console.log(`số term trung bình/ticket : ${k.soTermTB}`);

  console.log('\nfile bị trích nhiều nhất:');
  for (const [f, n] of k.file.slice(0, 8)) console.log(`  ${String(n).padStart(4)}×  ${f}`);

  console.log('\ntừ khoá sinh ra evidence:');
  for (const [t, n] of k.term.slice(0, 8)) console.log(`  ${String(n).padStart(4)}×  ${t}`);

  console.log('\nphân bố code_status:');
  for (const [v, n] of k.status) console.log(`  ${v.padEnd(10)} ${n}`);

  console.log('\nphân bố verdict (luật [4]):');
  for (const [v, n] of k.verdict) console.log(`  ${v.padEnd(12)} ${n}`);
}

async function soSanh(fileTruoc, fileSau) {
  const a = JSON.parse(await fs.readFile(fileTruoc, 'utf8'));
  const b = JSON.parse(await fs.readFile(fileSau, 'utf8'));
  inBang(a);
  inBang(b);

  const ka = thongKe(a);
  const kb = thongKe(b);
  const delta = (x, y) => `${x} → ${y}  (${y - x >= 0 ? '+' : ''}${y - x})`;

  console.log('\n═══ TRƯỚC → SAU ═══');
  console.log(`tổng evidence            : ${delta(ka.tongEvidence, kb.tongEvidence)}`);
  console.log(`ticket không có evidence : ${delta(ka.ticketKhongEvidence, kb.ticketKhongEvidence)}`);
  console.log(`file bị trích nhiều nhất : ${ka.file[0]?.[0] ?? '—'} ${ka.file[0]?.[1] ?? 0}× → ${kb.file[0]?.[0] ?? '—'} ${kb.file[0]?.[1] ?? 0}×`);

  const moiBen = (k) => Object.fromEntries(k);
  const sa = moiBen(ka.status);
  const sb = moiBen(kb.status);
  console.log('\ncode_status:');
  for (const v of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
    console.log(`  ${v.padEnd(10)} ${delta(sa[v] ?? 0, sb[v] ?? 0)}`);
  }

  const va = moiBen(ka.verdict);
  const vb = moiBen(kb.verdict);
  console.log('\nverdict:');
  for (const v of new Set([...Object.keys(va), ...Object.keys(vb)])) {
    console.log(`  ${v.padEnd(12)} ${delta(va[v] ?? 0, vb[v] ?? 0)}`);
  }

  // Ticket nào đổi verdict, đổi từ gì sang gì.
  const map = new Map(a.rows.map((r) => [r.key, r]));
  const doi = [];
  for (const r of b.rows) {
    const cu = map.get(r.key);
    if (cu && cu.verdict !== r.verdict) doi.push({ key: r.key, tu: cu.verdict, sang: r.verdict, title: r.title, evTruoc: cu.evidence.length, evSau: r.evidence.length });
  }
  console.log(`\nticket đổi verdict: ${doi.length}/${b.rows.length}`);
  const nhom = new Map();
  for (const d of doi) {
    const k = `${d.tu} → ${d.sang}`;
    if (!nhom.has(k)) nhom.set(k, []);
    nhom.get(k).push(d);
  }
  for (const [k, ds] of [...nhom.entries()].sort((x, y) => y[1].length - x[1].length)) {
    console.log(`\n  ${k}  (${ds.length} ticket)`);
    for (const d of ds.slice(0, 15)) {
      console.log(`    ${d.key.padEnd(12)} ev ${d.evTruoc}→${d.evSau}  ${d.title.slice(0, 52)}`);
    }
    if (ds.length > 15) console.log(`    … và ${ds.length - 15} ticket nữa`);
  }
}

const compareIdx = process.argv.indexOf('--compare');
if (compareIdx > -1) {
  await soSanh(process.argv[compareIdx + 1], process.argv[compareIdx + 2]);
} else {
  const ticketsFile = argOf('tickets');
  const repo = argOf('repo');
  if (!ticketsFile || !repo) {
    console.error('cần --tickets <file.md> và --repo <url|đường dẫn>');
    process.exit(2);
  }
  await doMot({ ticketsFile, repo, label: argOf('label', 'không nhãn'), out: argOf('out'), keep: argOf('keep') });
}
