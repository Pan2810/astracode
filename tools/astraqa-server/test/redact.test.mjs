/**
 * Bất biến: không token nào rời khỏi tiến trình.
 *
 * Test này canh đúng một thứ và canh nó chặt: bốn loại bí mật mà hợp đồng nêu
 * tên (astrawork_token, repo_token, ASTRACODE_SERVICE_TOKEN, API key LLM) không
 * được xuất hiện trong bất kỳ chuỗi nào đi ra ngoài — log hay message lỗi.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRedactor, redactMessage } from '../lib/redact.mjs';
import { urlWithToken } from '../lib/git.mjs';

const SECRETS = {
  astrawork: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbmhucDg0In0.s3cr3t-signature-part',
  repo: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  service: 'svc-token-rat-dai-va-bi-mat-0123456789',
  llm: 'sk-TyfKdMQJtvRVEBCrlcNvdJRyyVLrdvDPj2_fwNhG4IQ=',
};

const redact = makeRedactor([SECRETS.astrawork, SECRETS.repo, SECRETS.service, SECRETS.llm]);

function assertClean(text) {
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.ok(!text.includes(value), `lộ secret "${name}" trong: ${text}`);
  }
}

test('mọi loại secret bị che trong một chuỗi log', () => {
  const line =
    `clone https://x-access-token:${SECRETS.repo}@github.com/a/b.git ` +
    `Authorization: Bearer ${SECRETS.astrawork} svc=${SECRETS.service} key=${SECRETS.llm}`;
  assertClean(redact(line));
});

test('message lỗi đã che, và không kèm stack', () => {
  const err = new Error(`git clone thất bại: fatal: repository 'https://x:${SECRETS.repo}@host/x.git' not found`);
  const msg = redactMessage(err, redact);
  assertClean(msg);
  assert.ok(!msg.includes('at '), 'message không được chứa stack');
  assert.match(msg, /git clone thất bại/);
});

test('che được cả secret KHÔNG khai trước — bắt theo hình dạng', () => {
  const blind = makeRedactor([]);
  const out = blind(
    `key=sk-khongkhaitruoc0123456789 token=ghp_khongkhaitruoc0123456789 jwt=eyJhbGciOi.eyJzdWIi.sig123456 url=https://user:pw-rat-dai@h/x.git`,
  );
  assert.ok(!out.includes('sk-khongkhaitruoc0123456789'));
  assert.ok(!out.includes('ghp_khongkhaitruoc0123456789'));
  assert.ok(!out.includes('pw-rat-dai'));
  assert.ok(!out.includes('eyJhbGciOi.eyJzdWIi.sig123456'));
});

test('URL có token vẫn che được sau khi git.mjs nhét token vào', () => {
  const url = urlWithToken('https://github.com/a/b.git', SECRETS.repo);
  assert.ok(url.includes('x-access-token'), 'token phải được nhét vào userinfo');
  assertClean(redact(`git clone ${url} dest`));
});

test('chuỗi quá ngắn không bị coi là secret (tránh băm nát message)', () => {
  const r = makeRedactor(['abc']);
  assert.equal(r('abc def'), 'abc def');
});
