/**
 * Ngân sách prompt của job judge — đo trên đúng hai bộ tham số, cùng một ticket.
 *
 * Ðây là ca duy nhất trong bộ test nói về TIỀN. Một lượt judge là một lượt gọi
 * model, và giá của lượt ấy tỉ lệ thẳng với số token đi vào; nên "prompt gọn
 * lại" phải đo được chứ không phải cảm thấy.
 *
 * Bản cũ: 12 dòng ngữ cảnh, 6 mảnh, 120 dòng mỗi mảnh, mô tả gửi nguyên.
 * Bản này: 20 dòng ngữ cảnh, 3 mảnh, 41 dòng mỗi mảnh (đúng ±20 quanh dòng
 * khớp), mô tả cắt ở 600 ký tự.
 *
 * Ngưỡng 40% là hợp đồng: dưới mức ấy thì việc đổi tham số không đáng một lần
 * đổi hành vi, và ca này phải rơi để có người xem lại.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_JUDGE_OPTIONS, readSnippets, parseJudgeTickets } from '../lib/judge.mjs';
import { buildVerdictPrompt, MAX_TICKET_TEXT } from '../lib/verdictPrompt.mjs';

/** Bộ tham số trước khi siết — giữ nguyên ở đây để phép so không trôi theo code. */
const OLD_OPTIONS = { context_lines: 12, max_snippets: 6, max_snippet_lines: 120, timeout_sec: 600 };

const GUIDE = {
  MATCH: 'kế hoạch và mã nguồn nói cùng một chuyện',
  CODE_AHEAD: 'mã đã có, ticket chưa đóng',
  JIRA_AHEAD: 'ticket đã đóng, mã chưa thấy',
};

/** Ước lượng token: 4 ký tự một token. Thô, nhưng cùng một thước cho cả hai bên. */
const tokens = (s) => Math.ceil(s.length / 4);

let tmp;
let repoDir;
let ticket;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-budget-'));
  repoDir = path.join(tmp, 'repo');
  await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
  // Sáu tệp 400 dòng: đủ để bản cũ lấy hết trần 6 mảnh × 120 dòng.
  for (let f = 1; f <= 6; f++) {
    await fs.writeFile(
      path.join(repoDir, 'src', `mod${f}.py`),
      Array.from({ length: 400 }, (_, i) => `def ham_${f}_${i + 1}(a, b):  # dòng ${i + 1} của mô-đun ${f}`).join('\n'),
    );
  }

  [ticket] = parseJudgeTickets([
    {
      key: 'WEB-1001',
      summary: 'Thêm màn hình đăng nhập bằng mật khẩu',
      // Mô tả dài như một ticket thật: phần lớn là bối cảnh, không phải bằng chứng.
      description: 'Bối cảnh: ' + 'người dùng cần đăng nhập được bằng mật khẩu. '.repeat(120),
      status: 'done',
      grep_verdict: 'CODE_AHEAD',
      grep_reason: 'matched_by_key',
      grep_confidence: 0.6,
      evidence: Array.from({ length: 6 }, (_, i) => ({
        path: `src/mod${i + 1}.py`,
        lines: `${100 + i}-${260 + i}`,
        note: 'khớp từ khoá',
      })),
    },
  ]);
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function promptWith(options) {
  const { snippets, skipped } = await readSnippets({ repoDir, evidence: ticket.evidence, options });
  return { text: buildVerdictPrompt({ ticket, guide: GUIDE, snippets, skipped }), snippets };
}

test('prompt gọn lại hơn 40% token so với bộ tham số cũ, trên cùng một ticket', async () => {
  const before0 = await promptWith(OLD_OPTIONS);
  const after0 = await promptWith(DEFAULT_JUDGE_OPTIONS);

  const cut = 1 - tokens(after0.text) / tokens(before0.text);
  assert.ok(
    cut > 0.4,
    `prompt mới chỉ giảm ${(cut * 100).toFixed(1)}% token ` +
      `(${tokens(before0.text)} → ${tokens(after0.text)}), hợp đồng đòi hơn 40%`,
  );

  // Giảm đến từ ba chỗ, và mỗi chỗ đều kiểm được.
  assert.equal(before0.snippets.length, 6);
  assert.equal(after0.snippets.length, 3, 'tối đa 3 mảnh');
  for (const s of after0.snippets) {
    assert.ok(s.to - s.from + 1 <= 41, `mảnh ${s.path} dài ${s.to - s.from + 1} dòng, trần là 41`);
  }
});

test('±20 dòng quanh dòng khớp: đủ để thấy thân hàm, không lấy cả tệp', async () => {
  const [one] = parseJudgeTickets([
    { key: 'W-1', summary: 'x', evidence: [{ path: 'src/mod1.py', lines: '200' }] },
  ]);
  const { snippets } = await readSnippets({ repoDir, evidence: one.evidence, options: DEFAULT_JUDGE_OPTIONS });
  assert.equal(snippets.length, 1);
  assert.equal(snippets[0].from, 180);
  assert.equal(snippets[0].to, 220);
  // Số dòng thật đi kèm từng dòng — model chỉ trích lại đúng khi nó nhìn thấy.
  assert.match(snippets[0].text, /^180: def ham_1_180/);
  assert.match(snippets[0].text, /220: def ham_1_220/);
});

test('mô tả dài bị cắt ở 600 ký tự, và prompt nói rõ là đã cắt', async () => {
  const { text } = await promptWith(DEFAULT_JUDGE_OPTIONS);
  const line = text.split('\n').find((l) => l.startsWith('Mô tả: '));
  assert.ok(line, 'prompt phải có dòng mô tả');
  assert.match(line, /đã cắt, còn \d+ ký tự/);
  // Ðộ dài dòng = nhãn + 600 ký tự + đuôi ghi chú; chặn trên cho rộng rãi.
  assert.ok(line.length < MAX_TICKET_TEXT + 80, `dòng mô tả dài ${line.length} ký tự`);

  // Tiêu đề ngắn thì không bị đụng tới.
  assert.ok(text.includes('Tiêu đề: Thêm màn hình đăng nhập bằng mật khẩu'));
});

test('bên gọi vẫn nới lại được cho một job riêng', async () => {
  const { snippets } = await readSnippets({
    repoDir,
    evidence: ticket.evidence,
    options: { ...DEFAULT_JUDGE_OPTIONS, max_snippets: 5, max_snippet_lines: 80 },
  });
  assert.equal(snippets.length, 5);
  assert.ok(snippets.every((s) => s.to - s.from + 1 <= 80));
});
