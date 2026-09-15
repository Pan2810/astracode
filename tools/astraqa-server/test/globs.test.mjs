/** Glob tối giản — chỉ cần đúng với những mẫu hợp đồng dùng. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesAny } from '../lib/globs.mjs';

const DEFAULTS = ['**/__pycache__/**', '**/node_modules/**', '**/.venv/**', '**/dist/**'];

test('mặc định của hợp đồng khớp cả ở gốc lẫn trong sâu', () => {
  for (const p of [
    'node_modules/a.js',
    'packages/core/node_modules/x/y.js',
    'dist/main.js',
    'a/b/dist/main.js',
    '.venv/Lib/site.py',
    'app/__pycache__/m.cpython-311.pyc',
  ]) {
    assert.ok(matchesAny(p, DEFAULTS), `phải khớp: ${p}`);
  }
});

test('không khớp nhầm file lành', () => {
  for (const p of ['src/dist-helper.ts', 'src/node_modules_shim.ts', 'distance.md', 'src/app.ts']) {
    assert.ok(!matchesAny(p, DEFAULTS), `không được khớp: ${p}`);
  }
});

test('dấu \\ của Windows được chuẩn hoá trước khi so', () => {
  assert.ok(matchesAny('a\\b\\dist\\x.js', DEFAULTS));
});

test('`*` không vượt qua dấu /', () => {
  assert.ok(matchesAny('src/a.ts', ['src/*.ts']));
  assert.ok(!matchesAny('src/deep/a.ts', ['src/*.ts']));
});
