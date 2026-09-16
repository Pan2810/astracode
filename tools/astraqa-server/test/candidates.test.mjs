/**
 * Port của `CANDIDATE_MATCHING_SPEC.md` — canh từng mục một.
 *
 * Mọi hằng số ở đây phải khớp spec, không phải khớp một bảng kết quả. Nếu một ca
 * dưới đây hỏng, câu hỏi đúng là "ta lệch spec ở đâu", không phải "chỉnh ngưỡng
 * nào cho nó xanh lại".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  fold, cjkTerms, queryTerms, fileTokens, normalizedKey, isExcludedPath, isGenerated,
  discriminating, weightOf, buildIndex, shortlistFor,
  COMMON_TERM_RATIO, MIN_TERMS, RELATIVE_CUT, MAX_MEAN_LINE_CHARS, STOPWORDS_BASE, TIGHTEN_MODE,
} from '../lib/candidates.mjs';
import { matchesAny } from '../lib/globs.mjs';

test('§2.2/§4 — hằng số đúng nguyên văn spec', () => {
  assert.equal(COMMON_TERM_RATIO, 0.3);
  assert.equal(MIN_TERMS, 2);
  assert.equal(RELATIVE_CUT, 0.45);
  assert.equal(MAX_MEAN_LINE_CHARS, 400);
  assert.equal(STOPWORDS_BASE.size, 38, 'danh sách tĩnh của AstraQA đúng 38 từ');
});

test('§1.4 — fold bỏ dấu Latin nhưng GIỮ dakuten của kana', () => {
  assert.equal(fold('Đăng Nhập'), 'dang nhap');
  assert.equal(fold('Tiếng Việt'), 'tieng viet');
  // Nếu bỏ mọi \p{Mn} thì "が" thành "か" và từ khoá tiếng Nhật hỏng.
  assert.equal(fold('ガガ'), 'ガガ');
  assert.equal(fold('認証設定'), '認証設定');
});

test('§1.6 — cụm CJK cắt tại hiragana rồi bigram hoá', () => {
  assert.deepEqual(cjkTerms('認証設定'), ['認証', '証設', '設定']);
  assert.deepEqual(cjkTerms('認証'), ['認証']);
  // Hiragana là chất kết dính ngữ pháp: cắt tại đó.
  const t = cjkTerms('セッションをクッキーに保存');
  assert.ok(t.length > 0);
  assert.ok(!t.some((x) => x.includes('を')), `không được giữ hiragana nối: ${t}`);
});

test('§1.3 — ticket key khớp nguyên chuỗi, KHÔNG BAO GIỜ tách mảnh', () => {
  assert.equal(normalizedKey({ key: 'GEN-R169' }), 'gen-r169');
  assert.equal(normalizedKey({ key: 'COWORKLOCAL-14' }), 'coworklocal-14');
  assert.equal(normalizedKey({ key: 'khong-phai-key' }), null);
  assert.equal(normalizedKey({ key: '#77' }), null);

  // Ðây là lỗi lớn nhất spec đo được: `gen` bị trích 294 lần.
  const terms = queryTerms({ key: 'GEN-R169', title: 'Model Pricing', body: '' });
  assert.ok(!terms.includes('gen'), `"gen" lọt vào terms: ${terms}`);
  assert.ok(!terms.includes('r169'), `"r169" lọt vào terms: ${terms}`);
  assert.ok(!terms.includes('169'), `"169" lọt vào terms: ${terms}`);
});

test('§1.1 — siêu dữ liệu quản trị không được thành từ khoá', () => {
  const terms = queryTerms({
    key: 'X-1',
    title: 'Them man hinh dang nhap',
    body: 'Status: Done\nPriority: High\nAssignee: someone',
  });
  for (const rac of ['status', 'done', 'priority', 'high', 'assignee', 'someone']) {
    assert.ok(!terms.includes(rac), `"${rac}" không được vào terms: ${terms}`);
  }
});

test('§1.2 — dòng PO:/BA:/Developer: bị loại, tên người không thành từ khoá', () => {
  const terms = queryTerms({
    key: 'GEN-R169',
    title: 'Model Pricing',
    body: 'PO: QuanDh14\nBA: QuanDh14\nDeveloper: QuanDh14',
  });
  for (const rac of ['quandh14', 'quan', 'dh14', 'developer']) {
    assert.ok(!terms.includes(rac), `"${rac}" lọt vào terms: ${terms}`);
  }
});

test('§1.5 — identifier tách camelCase/snake_case, mỗi mảnh ≥ 3 ký tự', () => {
  const terms = queryTerms({ key: 'X-1', title: 'registerMember and user_profile', body: '' });
  for (const w of ['registermember', 'register', 'member', 'user_profile', 'user', 'profile']) {
    assert.ok(terms.includes(w), `thiếu "${w}" trong ${terms}`);
  }
});

test('§1.7 — phía file ngưỡng 2 ký tự và KHÔNG bỏ stopword', () => {
  const t = fileTokens('the api page id');
  // "the", "api", "page" là stopword phía ticket nhưng phía file phải giữ.
  for (const w of ['the', 'api', 'page', 'id']) assert.ok(t.has(w), `phía file phải giữ "${w}"`);
  assert.ok(!queryTerms({ key: 'X-1', title: 'the api page', body: '' }).includes('the'));
});

test('§3.1 — allowlist đuôi, thư mục loại, marker minified', () => {
  assert.equal(isExcludedPath('core/model_pricing.py'), false);
  assert.equal(isExcludedPath('ui/App.tsx'), false);
  // Ngoài allowlist.
  assert.equal(isExcludedPath('assets/RULEBASE.md'), true);
  assert.equal(isExcludedPath('assets/graph_template.html'), true);
  assert.equal(isExcludedPath('README.txt'), true);
  // Minified — spec đo `assets/d3.min.js` bị trích 89 lần.
  assert.equal(isExcludedPath('assets/d3.min.js'), true);
  assert.equal(isExcludedPath('static/app.bundle.js'), true);
  assert.equal(isExcludedPath('static/jquery-min.js'), true);
  // Thư mục loại, khớp bất kỳ phần nào của đường dẫn.
  for (const p of ['node_modules/x/a.js', 'a/dist/b.js', 'x/__pycache__/m.py', 'v/site-packages/q.py']) {
    assert.equal(isExcludedPath(p), true, `phải loại ${p}`);
  }
  // `__pycache__` phải chặn được bằng CẢ đuôi lẫn tên thư mục.
  assert.equal(isExcludedPath('somewhere/m.pyc'), true);
});

test('§3.3 — file dòng dài bị loại hẳn, kể cả khi tên không có "min"', () => {
  assert.equal(isGenerated('a\nb\nc\n'), false);
  // Ba dòng 2000 ký tự → trung bình ~1500/dòng, vượt ngưỡng 400. (Ðúng hình dạng
  // `d3.min.js`: vài trăm dòng, mỗi dòng vài nghìn ký tự.)
  assert.equal(isGenerated(`${'x'.repeat(2000)}\n${'y'.repeat(2000)}\n${'z'.repeat(2000)}\n`), true);
  // Ngay dưới ngưỡng thì không phải generated.
  assert.equal(isGenerated(`${'x'.repeat(300)}\n${'y'.repeat(300)}\n${'z'.repeat(300)}\n`), false);
  // Một dòng duy nhất dài hơn ngưỡng.
  assert.equal(isGenerated('x'.repeat(401)), true);
  assert.equal(isGenerated('x'.repeat(399)), false);
});

test('§2.2 + §2.3 — lọc common, và luật thoát hiểm khi lọc sạch', () => {
  const N = 100;
  const df = new Map([['hiem', 2], ['pho_bien', 80], ['khong_co', 0], ['vua', 10]]);
  const a = discriminating(['hiem', 'pho_bien', 'khong_co', 'vua'], df, N);
  assert.deepEqual(a.terms, ['hiem', 'vua'], 'bỏ term > 30% số file và term không file nào chứa');
  assert.equal(a.escaped, false);

  // Repo nhỏ: ceiling = 1, mọi term trông đều phổ biến → phải thoát hiểm.
  const dfNho = new Map([['refund', 3], ['order', 3]]);
  const b = discriminating(['refund', 'order'], dfNho, 3);
  assert.equal(b.escaped, true, 'lọc sạch thì phải dùng luật thoát hiểm');
  assert.deepEqual(b.terms, ['refund', 'order']);
});

test('§4.2 — term hiếm nặng hơn term phổ biến', () => {
  assert.ok(weightOf(1, 154) > weightOf(50, 154));
  assert.ok(weightOf(50, 154) > weightOf(150, 154));
});

test('§4.1 — sàn 2 term áp cả ở phía ticket lẫn phía từng file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cand-'));
  await fs.writeFile(path.join(dir, 'a.py'), 'def refund_order(x):\n    return x\n');
  await fs.writeFile(path.join(dir, 'b.py'), 'def invoice(x):\n    return x\n');
  await fs.writeFile(path.join(dir, 'c.py'), 'def shipment(x):\n    return x\n');
  const index = await buildIndex({ repoDir: dir, fs, path, excludeGlobs: [], matchesAny });

  // Một term duy nhất → shortlist rỗng ngay, không chấm file nào (ca C của spec).
  const motTerm = shortlistFor({ key: 'K-1', title: 'refund', body: '' }, index, { tightenMode: 'none' });
  assert.deepEqual(motTerm.files, [], 'một term thì phải trả shortlist rỗng');

  // Hai term nằm ở hai file khác nhau → không file nào đạt sàn.
  const haiFile = shortlistFor({ key: 'K-2', title: 'invoice shipment', body: '' }, index, { tightenMode: 'none' });
  assert.deepEqual(haiFile.files, [], 'mỗi file chỉ chung 1 term thì không file nào qua sàn');

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

test('§5 — chế độ siết đang dùng đã được ghi rõ', () => {
  assert.ok(['none', 'min_terms_3', 'rare_term', 'coverage'].includes(TIGHTEN_MODE));
  // Chốt bằng ca thử B (xem MATCHING_BASELINE.md); đổi giá trị này là đổi hành vi
  // nghiệm thu, nên nó phải đi kèm số đo mới.
  assert.equal(TIGHTEN_MODE, 'rare_term');
});
