/**
 * `ASTRACODE_JUDGE_EXTRA_BODY` — field riêng của từng nhà cung cấp, đặt ở env.
 *
 * Vì sao ở env chứ không hardcode: Qwen3.6 phải tắt thinking bằng
 * `{"chat_template_kwargs":{"enable_thinking":false}}`, DeepSeek không cần, và
 * gửi field ấy cho nhà cung cấp không hiểu nó là gửi rác.
 *
 * Ba điều được canh: env rỗng thì body y NGUYÊN như cũ; env có giá trị thì trộn
 * đúng; JSON hỏng thì NÉM lúc khởi động chứ không im lặng bỏ qua — im lặng là
 * kiểu hỏng tệ nhất ở đây, model vẫn chạy còn field bạn tưởng đã bật thì không
 * bao giờ được gửi.
 *
 * Model được đóng thế bằng một HTTP server cục bộ ghi lại body nhận được.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readConfig, parseExtraBody } from '../server.mjs';
import { askFci } from '../lib/fciJudge.mjs';

let fake;
let nhanDuoc;
let baseUrl;

before(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      nhanDuoc = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '```json\n{"items":[]}\n```' } }] }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${fake.address().port}/v1`;
});

after(async () => {
  await new Promise((r) => fake.close(r));
});

const cauHinh = (extra) => ({
  fciBaseUrl: baseUrl,
  fciApiKey: 'key-gia-lap-0123456789',
  fciModel: 'DeepSeek-V4-Flash',
  fciExtraBody: extra,
});

test('env RỖNG → body y nguyên như cũ, không thêm field nào', async () => {
  await askFci({ config: cauHinh(null), prompt: 'xin chao', timeoutMs: 5000, redact: (s) => s });

  assert.deepEqual(Object.keys(nhanDuoc).sort(), ['messages', 'model', 'temperature']);
  assert.equal(nhanDuoc.model, 'DeepSeek-V4-Flash');
  assert.equal(nhanDuoc.temperature, 0, 'temperature: 0 là bắt buộc — hai lần chạy phải cho cùng kết luận');
  assert.equal(nhanDuoc.messages.length, 2);
  assert.equal(nhanDuoc.messages[0].role, 'system');
  assert.equal(nhanDuoc.messages[1].content, 'xin chao');
  // Không được rò field của nhà cung cấp khác vào đây.
  assert.ok(!('chat_template_kwargs' in nhanDuoc), 'không được hardcode field riêng của Qwen');
});

test('env có giá trị → trộn đúng, giữ nguyên field cũ', async () => {
  const extra = { chat_template_kwargs: { enable_thinking: false } };
  await askFci({ config: cauHinh(extra), prompt: 'xin chao', timeoutMs: 5000, redact: (s) => s });

  assert.deepEqual(nhanDuoc.chat_template_kwargs, { enable_thinking: false });
  // Field cũ không được mất.
  assert.equal(nhanDuoc.model, 'DeepSeek-V4-Flash');
  assert.equal(nhanDuoc.temperature, 0);
  assert.equal(nhanDuoc.messages.length, 2);
});

test('extra body trộn được nhiều field một lúc', async () => {
  await askFci({
    config: cauHinh({ top_p: 0.1, stream: false, reasoning_effort: 'low' }),
    prompt: 'x',
    timeoutMs: 5000,
    redact: (s) => s,
  });
  assert.equal(nhanDuoc.top_p, 0.1);
  assert.equal(nhanDuoc.stream, false);
  assert.equal(nhanDuoc.reasoning_effort, 'low');
  assert.equal(nhanDuoc.temperature, 0);
});

test('extra body ÐÈ ÐƯỢC field cũ — nó sinh ra để làm việc đó', async () => {
  await askFci({ config: cauHinh({ temperature: 0.7 }), prompt: 'x', timeoutMs: 5000, redact: (s) => s });
  assert.equal(nhanDuoc.temperature, 0.7, 'extra phải thắng, nếu không thì không ép được gì');
});

test('parseExtraBody: rỗng/thiếu → null', () => {
  assert.equal(parseExtraBody(undefined), null);
  assert.equal(parseExtraBody(''), null);
  assert.equal(parseExtraBody('   '), null);
});

test('parseExtraBody: JSON hỏng → NÉM, kèm tên biến và lý do', () => {
  for (const hong of ['{', '{"a":}', 'khong phai json', '{"a": 1,}']) {
    assert.throws(
      () => parseExtraBody(hong),
      (err) => {
        assert.match(err.message, /ASTRACODE_JUDGE_EXTRA_BODY/, 'lỗi phải nêu tên biến');
        assert.match(err.message, /không phải JSON hợp lệ/);
        return true;
      },
      `"${hong}" phải ném`,
    );
  }
});

test('parseExtraBody: JSON hợp lệ nhưng không phải object → NÉM', () => {
  for (const sai of ['[1,2]', '"chuoi"', '42', 'true', 'null']) {
    assert.throws(() => parseExtraBody(sai), /phải là một JSON object|không phải JSON hợp lệ/, `"${sai}" phải ném`);
  }
});

test('readConfig đọc biến, và JSON hỏng làm hỏng cả readConfig (chặn khởi động)', () => {
  assert.equal(readConfig({}).fciExtraBody, null);
  assert.deepEqual(
    readConfig({ ASTRACODE_JUDGE_EXTRA_BODY: '{"chat_template_kwargs":{"enable_thinking":false}}' }).fciExtraBody,
    { chat_template_kwargs: { enable_thinking: false } },
  );
  // Ðây là đường chặn khởi động: readConfig ném → server.mjs in lỗi rồi exit(2).
  assert.throws(() => readConfig({ ASTRACODE_JUDGE_EXTRA_BODY: '{hong' }), /ASTRACODE_JUDGE_EXTRA_BODY/);
});
