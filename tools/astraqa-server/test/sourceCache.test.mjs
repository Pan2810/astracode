/** Persistent source mirror: a temporary Git outage must not erase analyzability. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { cloneRepo } from '../lib/git.mjs';

const run = promisify(execFile);

test('lần clone sau dùng source cache khi remote tạm không truy cập được', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astracode-source-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const remote = path.join(root, 'remote');
  await fs.mkdir(remote, { recursive: true });
  await fs.writeFile(path.join(remote, 'feature.js'), 'export const answer = 42;\n');
  await run('git', ['init', '-q', '-b', 'main'], { cwd: remote });
  await run('git', ['add', '-A'], { cwd: remote });
  await run('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'initial'], { cwd: remote });

  const cacheDir = path.join(root, 'cache');
  const firstDest = path.join(root, 'jobs', 'first', 'repo');
  await fs.mkdir(path.dirname(firstDest), { recursive: true });
  const first = await cloneRepo({
    repoUrl: remote,
    ref: 'main',
    repoToken: '',
    destDir: firstDest,
    cacheDir,
    cacheScope: 'tenant-a/project-1',
    redact: (value) => String(value),
  });
  assert.equal(first.sourceCache.used, false);
  assert.match(first.head, /^[a-f0-9]{40}$/);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(cacheDir)).mode & 0o777, 0o700);
  }

  const otherDest = path.join(root, 'jobs', 'other-tenant', 'repo');
  await fs.mkdir(path.dirname(otherDest), { recursive: true });
  await cloneRepo({
    repoUrl: remote,
    ref: 'main',
    repoToken: '',
    destDir: otherDest,
    cacheDir,
    cacheScope: 'tenant-b/project-1',
    redact: (value) => String(value),
  });
  assert.equal((await fs.readdir(cacheDir)).length, 2, 'cùng URL ở hai tenant phải có hai mirror');

  // Mô phỏng Git server/DNS tạm mất sau khi lần scan đầu đã hoàn tất.
  await fs.rename(remote, path.join(root, 'remote-offline'));
  const secondDest = path.join(root, 'jobs', 'second', 'repo');
  await fs.mkdir(path.dirname(secondDest), { recursive: true });
  const second = await cloneRepo({
    repoUrl: remote,
    ref: 'main',
    repoToken: '',
    destDir: secondDest,
    cacheDir,
    cacheScope: 'tenant-a/project-1',
    redact: (value) => String(value),
  });

  assert.equal(second.sourceCache.used, true);
  assert.match(second.sourceCache.warning, /source cache/);
  assert.equal(second.head, first.head);
  assert.equal(await fs.readFile(path.join(secondDest, 'feature.js'), 'utf8'), 'export const answer = 42;\n');
});
