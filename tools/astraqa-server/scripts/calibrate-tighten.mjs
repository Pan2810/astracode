#!/usr/bin/env node
/**
 * Hiệu chỉnh lựa chọn §5 của CANDIDATE_MATCHING_SPEC.md bằng ba ca thử §6.
 *
 * Spec đưa ba cách siết chặt cho `backend=none` (vì nó không có judge dọn sau)
 * và bảo dùng ca B để chọn. Script này chạy cả bốn chế độ trên ĐÚNG repo và
 * ĐÚNG commit spec nêu, rồi in kết quả để chốt bằng số chứ không bằng cảm giác.
 *
 *   node scripts/calibrate-tighten.mjs [--keep <dir>]
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cloneRepo } from '../lib/git.mjs';
import { matchesAny } from '../lib/globs.mjs';
import {
  buildIndex, shortlistFor, queryTerms, discriminating,
} from '../lib/candidates.mjs';

const REPO = 'https://github.com/Pan2810/pimathon_coworklocal.git';
const COMMIT = 'ce9fc6c63cb8d1514564314344b2d3ca14dc2c67';

const CA = [
  {
    ten: 'A — PHẢI khớp',
    ticket: {
      key: 'GEN-R169',
      title: 'Model Pricing & Budget — Per-model pricing table, currency conversion (VND/USD/JPY), budget alerts',
      body: '',
    },
    kyVong: 'shortlist KHÔNG rỗng, core/model_pricing.py đứng đầu',
    dat: (r) => r.files.length > 0 && r.files[0].path.endsWith('core/model_pricing.py'),
  },
  {
    ten: 'B — CHẮC CHẮN không được khớp',
    ticket: {
      key: 'GEN-R999',
      title: 'Quantum blockchain consensus sharding',
      body: 'Implement zero-knowledge rollup validator staking.',
    },
    kyVong: 'shortlist RỖNG (AstraQA hiện để lọt ui/cowork_tab.py)',
    dat: (r) => r.files.length === 0,
  },
  {
    ten: 'C — chỉ khớp bằng từ chung',
    ticket: { key: 'COWORKLOCAL-1', title: 'Management', body: '' },
    kyVong: 'shortlist RỖNG (chỉ 1 term, dưới MIN_TERMS=2)',
    dat: (r) => r.files.length === 0,
  },
];

const MODES = ['none', 'min_terms_3', 'rare_term', 'coverage'];

function argOf(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const keep = argOf('keep');
let repoDir = keep ? path.resolve(keep) : null;
const coSan = repoDir && (await fs.stat(path.join(repoDir, '.git')).then(() => true).catch(() => false));
if (!coSan) {
  repoDir = repoDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'calib-')));
  await fs.mkdir(repoDir, { recursive: true });
  const { head } = await cloneRepo({ repoUrl: REPO, ref: COMMIT, destDir: repoDir, redact: (s) => s, timeoutMs: 600_000 });
  console.log(`clone → ${repoDir} @ ${head}`);
  if (head !== COMMIT) console.log(`⚠ HEAD (${head}) khác commit spec nêu (${COMMIT})`);
} else {
  console.log(`dùng lại clone: ${repoDir}`);
}

const index = await buildIndex({ repoDir, fs, path, excludeGlobs: [], matchesAny });
console.log(`\nindex: ${index.N} file sau khi lọc (spec nói 154), ${index.df.size} term khác nhau`);

// ── Kiểm phần tách từ, độc lập với chế độ siết ──
console.log('\n═══ Từ khoá của từng ca (trước và sau lọc common) ═══');
for (const c of CA) {
  const tho = queryTerms(c.ticket);
  const { terms, escaped } = discriminating(tho, index.df, index.N);
  console.log(`\n${c.ten}  [${c.ticket.key}]`);
  console.log(`  thô (${tho.length}): ${tho.slice().sort().join(' ')}`);
  console.log(`  sau lọc (${terms.length})${escaped ? ' [thoát hiểm §2.3]' : ''}: ${terms.slice().sort().join(' ')}`);
  const co = tho.filter((t) => t === 'gen');
  if (co.length) console.log('  ⚠ CÓ "gen" TRONG TERMS — vi phạm §1.3');
}

// ── Bốn chế độ × ba ca ──
console.log('\n═══ Kết quả theo chế độ siết (§5) ═══');
const bang = [];
for (const mode of MODES) {
  const hang = { mode, dat: 0, chiTiet: [] };
  for (const c of CA) {
    const r = shortlistFor(c.ticket, index, { tightenMode: mode });
    const ok = c.dat(r);
    if (ok) hang.dat += 1;
    hang.chiTiet.push({ ca: c.ten, ok, soFile: r.files.length, dau: r.files[0]?.path ?? '—', matched: r.files[0]?.matched ?? [] });
  }
  bang.push(hang);
}

for (const h of bang) {
  console.log(`\n── chế độ "${h.mode}" — đạt ${h.dat}/3 ──`);
  for (const d of h.chiTiet) {
    console.log(`  ${d.ok ? 'ĐẠT ' : 'HỎNG'} ${d.ca.padEnd(32)} ${d.soFile} file  ${d.dau}${d.matched.length ? `  [${d.matched.join(',')}]` : ''}`);
  }
}

// ── Ảnh hưởng lên toàn repo: chế độ nào làm mất bao nhiêu match thật? ──
/**
 * Ðo RECALL: chế độ chặt quá thì ca B đạt nhưng giết luôn match thật.
 *
 * Ticket giả lập phải giống ticket thật mới đo được. Dựng từ TÊN FILE là sai —
 * tên file chỉ cho một hai từ nên `min_terms_3` bị loại ngay từ cách dựng đề,
 * không phải vì nó chặt. Nên ở đây mỗi ticket lấy 5 định danh ĐẶC TRƯNG NHẤT
 * của chính file đó (document_frequency thấp nhất) — đúng hình dạng một tiêu đề
 * ticket mô tả module ấy, và là thứ tốt nhất mà một matcher đáng tin phải bắt được.
 */
console.log('\n═══ RECALL: 40 ticket giả lập từ định danh đặc trưng của file thật ═══');
console.log('(mỗi ticket lấy 5 term hiếm nhất của một file có thật → matcher đúng PHẢI trả về chính file đó)');
const ungVien = index.files.filter((f) => f.tokens.size >= 40).slice(0, 40);
const mau = ungVien.map((f) => {
  const dacTrung = [...f.tokens]
    .filter((t) => t.length >= 4 && /^[a-z][a-z0-9]*$/.test(t))
    .sort((a, b) => (index.df.get(a) ?? 0) - (index.df.get(b) ?? 0))
    .slice(0, 5);
  return { key: 'SYN-999', title: dacTrung.join(' '), body: '', mong: f.path, terms: dacTrung };
});

/**
 * Ðo ở ĐÚNG RANH GIỚI. Ticket dựng từ 5 term hiếm nhất của chính file thì mode
 * nào cũng 40/40 — tín hiệu quá sạch, không phân biệt được gì. Ticket thật hiếm
 * khi trùng nhiều thế: nó khớp vừa đủ vài từ. Nên đo riêng từng mức 2/3/4 term,
 * vì đó chính là chỗ ba lựa chọn của §5 khác nhau.
 */
for (const soTerm of [2, 3, 4]) {
  console.log(`\n  ── ticket khớp vừa đúng ${soTerm} term đặc trưng ──`);
  for (const mode of MODES) {
    let coShortlist = 0;
    let trung = 0;
    for (const t of mau) {
      const hep = { ...t, title: t.terms.slice(0, soTerm).join(' ') };
      const r = shortlistFor(hep, index, { tightenMode: mode });
      if (r.files.length) coShortlist += 1;
      if (r.files.some((f) => f.path === t.mong)) trung += 1;
    }
    const n = mau.length;
    console.log(
      `    ${mode.padEnd(14)} có shortlist ${String(coShortlist).padStart(2)}/${n}` +
        `   giữ được file đúng ${String(trung).padStart(2)}/${n}`,
    );
  }
}
