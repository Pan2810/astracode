/**
 * Log của server: một file một ngày, giữ bảy ngày.
 *
 * Bốn thứ được canh:
 *   1. Dòng ra console VÀ xuống đúng file của hôm nay, đã che secret.
 *   2. Sang ngày mới thì sang file mới, không ghi tiếp vào file hôm qua.
 *   3. `.log` cũ hơn bảy ngày bị xoá — kể cả log của từng run.
 *   4. Thứ KHÔNG phải `.log` thì không bị đụng tới.
 *
 * Không mạng, không model, không đợi tới nửa đêm: `now` được tiêm vào.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDailyLog, dayStamp } from '../lib/daily.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

async function tmpdir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'astraqa-daily-'));
}

/** Một file `.log` có tuổi đặt trước, để thử việc dọn. */
async function aged(dir, name, ageDays) {
  const abs = path.join(dir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(abs, `dòng cũ trong ${name}\n`, 'utf8');
  const when = new Date(Date.now() - ageDays * DAY_MS);
  await fs.utimes(abs, when, when);
  return abs;
}

test('dòng log ra console và xuống file của hôm nay, đã che secret', async () => {
  const dir = path.join(await tmpdir(), 'logs');
  const seen = [];
  const at = new Date('2026-09-19T02:03:04.000Z');
  const daily = createDailyLog({
    dir,
    redact: (s) => String(s).replaceAll('service-token-that', '***'),
    log: (row) => seen.push(row),
    now: () => at,
  });

  daily.line('401 GET /admin ← 203.0.113.7 (token service-token-that)');
  await daily.flush();

  const file = path.join(dir, `server-${dayStamp(at)}.log`);
  const text = await fs.readFile(file, 'utf8');
  // Cùng một dòng ở cả hai đường, và secret không có ở đường nào.
  assert.equal(seen.length, 1);
  assert.match(seen[0], /401 GET \/admin/);
  assert.ok(!seen[0].includes('service-token-that'), 'console lộ token');
  assert.ok(!text.includes('service-token-that'), 'file lộ token');
  assert.match(text, /\*\*\*/);
  // Dấu thời gian ISO đứng đầu dòng: để so được với hệ khác dù tên file là giờ máy.
  assert.match(text, /^2026-09-19T02:03:04\.000Z /);
});

test('sang ngày mới thì sang file mới', async () => {
  const dir = path.join(await tmpdir(), 'logs');
  // Giờ MÁY, không phải UTC: tên file theo ngày của người đang mở thư mục, nên
  // cảnh "qua nửa đêm" phải dựng bằng giờ máy để test không phụ thuộc múi giờ.
  let at = new Date(2026, 8, 19, 23, 59, 0);
  const daily = createDailyLog({ dir, now: () => at });

  daily.line('trước nửa đêm');
  await daily.flush();
  at = new Date(at.getTime() + 2 * 60 * 1000);
  daily.line('sau nửa đêm');
  await daily.flush();

  const names = (await fs.readdir(dir)).sort();
  // Hai file, và dòng của hôm nay không lẫn vào file hôm qua.
  assert.equal(names.length, 2, `phải có hai file, có ${names}`);
  const first = await fs.readFile(path.join(dir, names[0]), 'utf8');
  const second = await fs.readFile(path.join(dir, names[1]), 'utf8');
  assert.match(first, /trước nửa đêm/);
  assert.ok(!first.includes('sau nửa đêm'), 'ghi tiếp vào file hôm qua');
  assert.match(second, /sau nửa đêm/);
});

test('log quá bảy ngày bị xoá, log của run cũ cũng vậy', async () => {
  const dir = path.join(await tmpdir(), 'logs');
  const old = await aged(dir, 'server-2026-09-01.log', 18);
  const oldRun = await aged(dir, 'FNSPMO-2191.log', 9);
  const fresh = await aged(dir, 'server-2026-09-18.log', 1);
  const freshRun = await aged(dir, 'FNSPMO-2200.log', 2);
  // Không phải `.log` thì không phải việc của nó — results/ nằm chỗ khác, và
  // một ngày nào đó thư mục này có thêm thứ gì thì cũng không bị dọn lây.
  const other = await aged(dir, 'ghi-chu.txt', 30);

  const daily = createDailyLog({ dir, keepDays: 7, log: () => {} });
  const gone = await daily.prune();

  assert.deepEqual(gone.sort(), ['FNSPMO-2191.log', 'server-2026-09-01.log']);
  for (const abs of [fresh, freshRun, other]) {
    assert.ok(await fs.stat(abs).catch(() => null), `${path.basename(abs)} không được bị xoá`);
  }
  for (const abs of [old, oldRun]) {
    assert.equal(await fs.stat(abs).catch(() => null), null, `${path.basename(abs)} phải bị xoá`);
  }
});

test('dòng đầu tiên của một ngày mới cũng dọn', async () => {
  const dir = path.join(await tmpdir(), 'logs');
  const old = await aged(dir, 'server-2026-08-20.log', 30);
  const at = new Date('2026-09-19T08:00:00.000Z');
  const daily = createDailyLog({ dir, keepDays: 7, log: () => {}, now: () => at });

  // Một server chạy liên tục hai tuần phải dọn được tuần đầu mà không cần ai
  // khởi động lại nó.
  daily.line('khởi động');
  await daily.flush();

  assert.equal(await fs.stat(old).catch(() => null), null, 'log cũ vẫn còn');
  assert.ok(await fs.stat(path.join(dir, `server-${dayStamp(at)}.log`)).catch(() => null));
});

test('enabled: false thì không đụng đĩa', async () => {
  const dir = path.join(await tmpdir(), 'logs');
  const seen = [];
  const daily = createDailyLog({ dir, enabled: false, log: (r) => seen.push(r) });

  daily.line('chỉ ra console');
  await daily.flush();

  // Cùng đường đi trong code, chỉ khác là không rải file — quy ước của
  // createRunLog, giữ nguyên ở đây.
  assert.equal(seen.length, 1);
  assert.deepEqual(await daily.prune(), []);
  assert.equal(await fs.stat(dir).catch(() => null), null, 'không được tạo thư mục');
});
