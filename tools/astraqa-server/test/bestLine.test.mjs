/**
 * §3.5 — neo trích đoạn là dòng ĐẠI DIỆN, không phải dòng khớp đầu tiên.
 *
 * Ca trung tâm là ca đã đo được trên board thật: `app.py` của `pimsathon` khớp
 * "top" ở dòng 2 (docstring) trong khi `class _Toast` — đúng thứ ticket hỏi —
 * nằm ở dòng 53. Neo cũ trỏ vào dòng 2, bên đọc mở cửa sổ ±20 quanh đó, và model
 * kết luận tính năng không tồn tại ở confidence 0,95. Các ca dưới đây canh từng
 * phần của thang điểm để một lần chỉnh sau này làm hỏng cái gì thì nói ra ngay.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, bestLineWith, firstLineWith } from '../lib/candidates.mjs';
import { matchesAny } from '../lib/globs.mjs';

async function indexOf(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bestline-'));
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), text, 'utf8');
  }
  return buildIndex({ repoDir: dir, fs, path, excludeGlobs: [], matchesAny });
}

test('§3.5 — docstring mở đầu thua dòng khai báo thật', async () => {
  const index = await indexOf({
    'app.py': [
      '"""Cowork Local.',
      '',
      'pages and top bar."""',
      'import sys',
      '',
      'class Toast(QLabel):',
      '    """auto-hiding notification at the top-left."""',
    ].join('\n'),
  });

  assert.equal(
    firstLineWith(index, 'app.py', ['top']).line, 3,
    'neo cũ rơi đúng vào docstring — đây là hành vi đang được thay',
  );
  assert.equal(
    bestLineWith(index, 'app.py', ['toast', 'hiding', 'top']).line, 6,
    'neo mới phải trỏ vào dòng class, nơi cửa sổ ±N còn bao được phần thân',
  );
});

test('§3.5 — nhiều term trên một dòng thắng một term lẻ ở dòng sớm hơn', async () => {
  const index = await indexOf({
    'tasks.py': [
      'REPEAT = ("daily",)',
      'def unrelated():',
      '    pass',
      'def next_occurrence(daily, cron, expression):',
      '    return None',
    ].join('\n'),
  });
  assert.equal(bestLineWith(index, 'tasks.py', ['daily', 'cron', 'expression']).line, 4);
});

test('§3.5 — docstring VẪN được chọn khi nó là chỗ duy nhất khớp', async () => {
  const index = await indexOf({
    'mod.py': ['"""A module about scheduling."""', 'import os', 'x = 1'].join('\n'),
  });
  assert.equal(
    bestLineWith(index, 'mod.py', ['scheduling']).line, 1,
    'im lặng về một file đã khớp còn tệ hơn trỏ vào lời mở đầu của nó',
  );
});

test('§3.5 — hoà điểm thì dòng sớm hơn thắng, nên hai lần chạy cùng một trích dẫn', async () => {
  const index = await indexOf({
    'a.py': ['def alpha(cron):', '    pass', 'def beta(cron):', '    pass'].join('\n'),
  });
  const once = bestLineWith(index, 'a.py', ['cron']).line;
  assert.equal(once, 1);
  assert.equal(bestLineWith(index, 'a.py', ['cron']).line, once);
});

test('§3.5 — file không có trong index trả về dòng 1, không ném', async () => {
  const index = await indexOf({ 'a.py': 'x = 1\n' });
  assert.deepEqual(bestLineWith(index, 'khong-co.py', ['x']), { line: 1, term: 'x' });
  assert.deepEqual(bestLineWith(index, 'a.py', []), { line: 1, term: '' });
});
