#!/usr/bin/env node
/**
 * Ðo bốn cách dựng văn bản truy vấn từ ticket, so với verdict thật của engine
 * AstraQA (`expected-verdicts.json`).
 *
 * CHỈ ÐO — không sửa gì trong `lib/`. Mục đích là có bảng số để chốt xem §1.1 và
 * §1.2 nên áp tới đâu, thay vì tôi tự quyết.
 *
 *   node scripts/diagnose-real.mjs --keep <clone-dir>
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseTickets } from '../lib/tickets.mjs';
import { buildIndex, shortlistFor, discriminating, fold, STOPWORDS, MIN_TERMS } from '../lib/candidates.mjs';
import { matchesAny } from '../lib/globs.mjs';

const GOC = 'E:/astraqa-demo-backup/astracode-baseline';

function argOf(n) {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : null;
}

// ── Bốn cách dựng văn bản truy vấn ──

/** Nhãn metadata spec §1.2 liệt kê nguyên văn. */
const NHAN_SPEC = /^\s*(PO|BA|QA|Dev|Developer|Tester|Reporter|Assignee|Owner|Status|Priority)\s*:/i;
/** Thêm nhãn tiếng Việt CÓ THẬT trong export này — spec chưa liệt kê. */
const NHAN_MO_RONG = /^\s*(PO|BA|QA|Dev|Developer|Tester|Reporter|Assignee|Owner|Status|Priority|Ngày nhận|Ngay nhan|Ghi chú|Ghi chu|Người thực hiện|Nguoi thuc hien)\s*:/i;
/** Dòng field markdown `- label: value` và heading `### x` là CẤU TRÚC, không phải nội dung. */
const DONG_FIELD = /^\s*[-*+]\s*[A-Za-z_][\w \t]{0,30}:\s*/;
const DONG_HEADING = /^\s*#{1,6}\s/;

const CACH = {
  // V0 — đúng những gì đang chạy: body markdown thô, chỉ lọc nhãn của spec.
  V0_hien_tai: (t) => `${t.title ?? ''}\n${String(t.body ?? '').split(/\r?\n/).filter((d) => !NHAN_SPEC.test(d)).join('\n')}`,

  // V1 — §1.1 chặt: bỏ cả dòng field markdown và heading. Chỉ còn summary +
  // NỘI DUNG description.
  V1_bo_cau_truc: (t) =>
    `${t.title ?? ''}\n${String(t.body ?? '')
      .split(/\r?\n/)
      .filter((d) => !NHAN_SPEC.test(d) && !DONG_FIELD.test(d) && !DONG_HEADING.test(d))
      .join('\n')}`,

  // V2 — V1 + nhãn tiếng Việt có thật trong dữ liệu này.
  V2_them_nhan_VN: (t) =>
    `${t.title ?? ''}\n${String(t.body ?? '')
      .split(/\r?\n/)
      .filter((d) => !NHAN_MO_RONG.test(d) && !DONG_FIELD.test(d) && !DONG_HEADING.test(d))
      .join('\n')}`,

  // V3 — GIỐNG ASTRAQA: không lọc nhãn gì cả (spec §1.2 nói AstraQA chưa làm),
  // chỉ bỏ cấu trúc markdown. Dùng để xem bảng 138/44/2/0 sinh ra từ đâu.
  V3_nhu_AstraQA: (t) =>
    `${t.title ?? ''}\n${String(t.body ?? '')
      .split(/\r?\n/)
      .filter((d) => !DONG_HEADING.test(d))
      .join('\n')}`,
};

// Tách từ y hệt candidates.mjs nhưng nhận văn bản dựng sẵn.
const RE_WORD = /[a-z0-9]{2,}/g;
const RE_ID = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const RE_CAMEL = /(?<!^)(?=[A-Z])|_/;
function termsOf(raw) {
  const goc = String(raw ?? '');
  const daFold = fold(goc);
  const out = new Set();
  const nhan = (w) => {
    if (w.length < 3 || STOPWORDS.has(w)) return;
    out.add(w);
  };
  for (const w of daFold.match(RE_WORD) ?? []) nhan(w);
  for (const id of goc.match(RE_ID) ?? []) {
    nhan(fold(id));
    for (const m of id.split(RE_CAMEL)) if (m) nhan(fold(m));
  }
  return [...out];
}

const keep = path.resolve(argOf('keep'));
const md = await fs.readFile(path.join(GOC, 'tickets.md'), 'utf8');
const mong = JSON.parse(await fs.readFile(path.join(GOC, 'expected-verdicts.json'), 'utf8'));
const tickets = parseTickets(md);
const index = await buildIndex({ repoDir: keep, fs, path, excludeGlobs: [], matchesAny });

console.log(`index: ${index.N} file  |  ${tickets.length} ticket  |  đích: ${JSON.stringify(mong.summary)}\n`);

const mongTheoKey = new Map(mong.tickets.map((t) => [t.key, t]));
const laDone = (s) => /^(done|closed|resolved)$/i.test(String(s ?? '').trim());

for (const [ten, dung] of Object.entries(CACH)) {
  const dem = { MATCH: 0, CODE_AHEAD: 0, JIRA_AHEAD: 0, NO_EVIDENCE: 0 };
  let khopVerdict = 0;
  let tongTerm = 0;
  const lech = [];

  for (const t of tickets) {
    const tho = termsOf(dung(t));
    const { terms } = discriminating(tho, index.df, index.N);
    tongTerm += terms.length;

    // Dùng chính shortlistFor nhưng ép terms đã dựng, bằng cách giả một ticket
    // chỉ có title là chuỗi term — cách rẻ nhất để không phải nhân bản hàm chấm.
    const gia = { key: 'X-0', title: terms.join(' '), body: '' };
    const r = terms.length < MIN_TERMS ? { files: [] } : shortlistFor(gia, index, { tightenMode: 'rare_term' });

    const v = r.files.length === 0 ? 'JIRA_AHEAD' : laDone(t.status) ? 'MATCH' : 'CODE_AHEAD';
    dem[v] += 1;
    const m = mongTheoKey.get(t.key);
    if (m && m.verdict === v) khopVerdict += 1;
    else if (m) lech.push({ key: t.key, mong: m.verdict, duoc: v, terms: terms.slice(0, 6) });
  }

  console.log(`── ${ten} ──`);
  console.log(`   ${JSON.stringify(dem)}`);
  console.log(`   khớp verdict với AstraQA: ${khopVerdict}/${tickets.length} (${((khopVerdict / tickets.length) * 100).toFixed(1)}%)`);
  console.log(`   số term trung bình: ${(tongTerm / tickets.length).toFixed(1)}`);
  const nhom = new Map();
  for (const l of lech) {
    const k = `${l.mong} → ${l.duoc}`;
    nhom.set(k, (nhom.get(k) ?? 0) + 1);
  }
  if (nhom.size) console.log(`   lệch: ${[...nhom.entries()].map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  console.log();
}
