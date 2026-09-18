/**
 * Tệp rules trong repo: đọc nguyên văn, và chỉ những gì nằm trong bản clone.
 *
 * AstraCode KHÔNG hiểu nội dung tệp này — luật verdict nằm bên AstraQA. Nên
 * những gì phải giữ ở đây là ba điều, và mỗi điều là một cách nó đã có thể
 * hỏng mà vẫn trông như chạy đúng:
 *
 *   - `null` (không có tệp) KHÁC tệp rỗng. Tệp rỗng là đội đã nói "dùng mặc
 *     định"; không có tệp là đội chưa nói gì và bộ luật cấp tenant được lên
 *     tiếng. Gộp hai cái làm một là âm thầm đổi bộ luật đang áp.
 *   - Ðường dẫn leo ra ngoài bản clone không được mở. Bản clone là thứ duy
 *     nhất job này được phép đọc.
 *   - Tệp quá lớn bị từ chối chứ không được đọc rồi cắt: một tệp rules bị cắt
 *     giữa chừng vẫn parse được, và nó sẽ quyết verdict bằng một nửa luật.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_RULES_BYTES,
  readGuidanceText,
  readRepoRules,
} from '../lib/repoRules.mjs';

let tmp;
let repo;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-rules-'));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(path.join(repo, '.astraqa'), { recursive: true });
  // Một tệp NGOÀI repo, để thử đường leo ra.
  await fs.writeFile(path.join(tmp, 'secret.md'), 'không được đọc\n');
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function put(rel, text) {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text);
}

async function clear() {
  await fs.rm(path.join(repo, '.astraqa'), { recursive: true, force: true });
  await fs.mkdir(path.join(repo, '.astraqa'), { recursive: true });
}

test('repo không có tệp rules thì trả null, không phải tệp rỗng', async () => {
  await clear();
  assert.equal(await readRepoRules({ repoDir: repo }), null);
});

test('tệp rỗng vẫn là một câu trả lời, và nó khác null', async () => {
  await clear();
  await put('.astraqa/rules.yml', '');
  const got = await readRepoRules({ repoDir: repo });
  assert.ok(got, 'tệp rỗng phải trả về một bản ghi');
  assert.equal(got.text, '');
  assert.equal(got.bytes, 0);
  assert.equal(got.path, '.astraqa/rules.yml');
});

test('đọc nguyên văn, kể cả comment — không parse, không sửa', async () => {
  await clear();
  const text = '# đội tự viết\ndone_means:\n  - done\n  - in_review\n';
  await put('.astraqa/rules.yml', text);
  const got = await readRepoRules({ repoDir: repo });
  assert.equal(got.text, text, 'byte nào vào thì byte ấy ra');
});

test('.yaml cũng được nhận, khỏi bắt ai đổi tên', async () => {
  await clear();
  await put('.astraqa/rules.yaml', 'ignore: []\n');
  const got = await readRepoRules({ repoDir: repo });
  assert.equal(got.path, '.astraqa/rules.yaml');
});

test('tệp vượt trần bị từ chối chứ không bị cắt', async () => {
  await clear();
  await put('.astraqa/rules.yml', 'x'.repeat(MAX_RULES_BYTES + 10));
  const got = await readRepoRules({ repoDir: repo });
  assert.equal(got.too_big, true);
  // Quan trọng hơn: KHÔNG có nội dung. Một tệp rules bị cắt vẫn parse được, và
  // nó sẽ quyết verdict bằng một nửa bộ luật mà không ai biết.
  assert.equal(got.text, '');
});

test('judge_guidance được đọc kèm khi nó trỏ vào trong repo', async () => {
  await clear();
  await put('.astraqa/judge.md', '"adapter" và "connector" ở đây là một thứ.\n');
  await put('.astraqa/rules.yml', 'judge_guidance: .astraqa/judge.md\n');
  const got = await readRepoRules({ repoDir: repo });
  assert.equal(got.guidance.path, '.astraqa/judge.md');
  assert.match(got.guidance.text, /adapter/);
});

test('judge_guidance trỏ ra ngoài bản clone thì không mở', async () => {
  await clear();
  await put('.astraqa/rules.yml', 'judge_guidance: ../secret.md\n');
  const got = await readRepoRules({ repoDir: repo });
  assert.equal(got.guidance, null, 'bản clone là thứ duy nhất được đọc');
});

test('readGuidanceText mở đúng đường dẫn bên gọi đưa, và chỉ trong repo', async () => {
  await clear();
  await put('doc/house.md', 'quy ước nhà\n');

  assert.match(await readGuidanceText({ repoDir: repo, rel: 'doc/house.md' }), /quy ước nhà/);

  // Bộ rules đang áp có thể ở cấp tenant, nên đường dẫn do AstraQA đưa xuống —
  // nhưng nó vẫn phải nằm trong bản clone.
  for (const bad of ['../secret.md', '/etc/passwd', 'C:/Windows/win.ini', 'a/../../secret.md']) {
    assert.equal(await readGuidanceText({ repoDir: repo, rel: bad }), '', bad);
  }
  // Không có đường dẫn là chuyện bình thường, không phải lỗi.
  assert.equal(await readGuidanceText({ repoDir: repo, rel: '' }), '');
  // Ðường dẫn trỏ vào tệp không tồn tại cũng không được ném: thiếu quy ước làm
  // câu trả lời nghèo đi, không làm nó sai.
  assert.equal(await readGuidanceText({ repoDir: repo, rel: 'doc/khong-co.md' }), '');
});
