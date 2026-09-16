#!/usr/bin/env node
/**
 * Bảng verdict của bốn chế độ siết §5, đo trên 184 ticket THẬT.
 *
 * Dùng đúng `queryTerms` của bản chạy thật (đã áp §1.1 + §1.2 theo quyết định
 * 2026-09-16) — không có biến thể nào nữa, matcher đã đóng băng. Việc duy nhất
 * còn mở là chọn `TIGHTEN_MODE`, và bảng này là đầu vào cho quyết định đó.
 *
 *   node scripts/tighten-table.mjs --keep <clone-dir>
 *
 * Không gọi model, không tốn quota.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseTickets } from '../lib/tickets.mjs';
import { buildIndex, shortlistFor, queryTerms, discriminating, MIN_TERMS } from '../lib/candidates.mjs';
import { matchesAny } from '../lib/globs.mjs';

const GOC = 'E:/astraqa-demo-backup/astracode-baseline';
const MODES = ['none', 'rare_term', 'min_terms_3', 'coverage'];

function argOf(n) {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : null;
}

const keep = path.resolve(argOf('keep'));
const md = await fs.readFile(path.join(GOC, 'tickets.md'), 'utf8');
const mong = JSON.parse(await fs.readFile(path.join(GOC, 'expected-verdicts.json'), 'utf8'));
const tickets = parseTickets(md);
const index = await buildIndex({ repoDir: keep, fs, path, excludeGlobs: [], matchesAny });

const byKey = new Map(mong.tickets.map((t) => [t.key, t]));
const laDone = (s) => /^(done|closed|resolved)$/i.test(String(s ?? '').trim());

console.log(`repo @ ${mong.revision.slice(0, 12)} · ${index.N} file · ${tickets.length} ticket`);
console.log(`đích AstraQA: ${JSON.stringify(mong.summary)}\n`);

const ketQua = [];
for (const mode of MODES) {
  const dem = { MATCH: 0, CODE_AHEAD: 0, JIRA_AHEAD: 0, NO_EVIDENCE: 0 };
  const lech = [];
  let khop = 0;

  for (const t of tickets) {
    const { terms } = discriminating(queryTerms(t), index.df, index.N);
    const r = terms.length < MIN_TERMS ? { files: [] } : shortlistFor(t, index, { tightenMode: mode });
    const v = r.files.length === 0 ? 'JIRA_AHEAD' : laDone(t.status) ? 'MATCH' : 'CODE_AHEAD';
    dem[v] += 1;
    const m = byKey.get(t.key);
    if (!m) continue;
    if (m.verdict === v) khop += 1;
    else lech.push({ key: t.key, title: (t.title ?? '').slice(0, 44), mong: m.verdict, duoc: v });
  }

  ketQua.push({ mode, dem, khop, lech });
}

console.log('┌─ Bảng verdict theo chế độ siết ─────────────────────────────────────────────');
console.log(`│ ${'chế độ'.padEnd(13)} ${'MATCH'.padStart(6)} ${'CODE_AH'.padStart(8)} ${'JIRA_AH'.padStart(8)} ${'NO_EV'.padStart(6)}  ${'khớp'.padStart(8)}  lệch`);
console.log(`│ ${'ÐÍCH'.padEnd(13)} ${String(mong.summary.MATCH).padStart(6)} ${String(mong.summary.CODE_AHEAD).padStart(8)} ${String(mong.summary.JIRA_AHEAD).padStart(8)} ${String(mong.summary.NO_EVIDENCE).padStart(6)}  ${'184/184'.padStart(8)}  0`);
for (const r of ketQua) {
  console.log(
    `│ ${r.mode.padEnd(13)} ${String(r.dem.MATCH).padStart(6)} ${String(r.dem.CODE_AHEAD).padStart(8)} ` +
      `${String(r.dem.JIRA_AHEAD).padStart(8)} ${String(r.dem.NO_EVIDENCE).padStart(6)}  ` +
      `${`${r.khop}/184`.padStart(8)}  ${r.lech.length}`,
  );
}
console.log('└─────────────────────────────────────────────────────────────────────────────');

for (const r of ketQua) {
  const nhom = new Map();
  for (const l of r.lech) {
    const k = `${l.mong} → ${l.duoc}`;
    if (!nhom.has(k)) nhom.set(k, []);
    nhom.get(k).push(l);
  }
  console.log(`\n── "${r.mode}" — ${r.lech.length} ticket lệch ──`);
  if (!r.lech.length) {
    console.log('   (không lệch ticket nào)');
    continue;
  }
  for (const [k, ds] of [...nhom.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`   ${k}: ${ds.length}`);
    for (const d of ds.slice(0, 6)) console.log(`      ${d.key.padEnd(15)} ${d.title}`);
    if (ds.length > 6) console.log(`      … và ${ds.length - 6} ticket nữa`);
  }
}

// ── Hai dòng JIRA_AHEAD thật: chúng là cả lý do hợp đồng v1.1 tồn tại ──
console.log('\n═══ Hai dòng JIRA_AHEAD thật sau khi áp §1.2 ═══');
for (const key of ['COWORKLOCAL-1', 'COWORKLOCAL-2']) {
  const t = tickets.find((x) => x.key === key);
  if (!t) {
    console.log(`  ${key}: KHÔNG CÓ trong tickets.md`);
    continue;
  }
  const tho = queryTerms(t);
  const { terms } = discriminating(tho, index.df, index.N);
  console.log(`\n  ${key} — "${t.title ?? ''}"  (jira: ${t.status})`);
  console.log(`    terms thô(${tho.length}): ${JSON.stringify(tho)}`);
  console.log(`    sau lọc(${terms.length}): ${JSON.stringify(terms)}`);
  for (const mode of MODES) {
    const r = terms.length < MIN_TERMS ? { files: [] } : shortlistFor(t, index, { tightenMode: mode });
    const v = r.files.length === 0 ? 'JIRA_AHEAD' : 'có evidence';
    console.log(`    ${mode.padEnd(13)} → ${v}${r.files.length ? ` (${r.files.map((f) => f.path).join(', ')})` : ''}`);
  }
}
