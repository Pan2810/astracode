import { describe, expect, it } from 'vitest';
import * as nodePath from 'node:path';
import { MemoryFileSystem } from '../fs/FileSystem.js';
import { PathGuard } from '../security/pathGuard.js';
import { Denylist } from '../security/denylist.js';
import { Logger, MemorySink } from '../telemetry/logger.js';
import type { ToolContext } from '../tools/Tool.js';
import { resolvePins, renderPinnedContext } from './pins.js';

const WINDOWS = nodePath.sep === '\\';
const ROOT = WINDOWS ? 'C:\\work\\app' : '/work/app';
const p = (...parts: string[]): string => nodePath.join(ROOT, ...parts);

const FILES: Record<string, string> = {
  [p('.env')]: 'SECRET=hunter2\n',
  [p('src', 'auth.ts')]:
    'export function login(user: string) {\n' +
    '  return verify(user);\n' +
    '}\n' +
    'export function logout() {}\n',
  [p('big.txt')]: Array.from({ length: 6000 }, (_, i) => `dòng ${i + 1}`).join('\n'),
};

function makeCtx(): ToolContext {
  const fs = new MemoryFileSystem({ files: FILES, caseInsensitive: WINDOWS });
  return {
    workspaceRoot: ROOT,
    fs,
    pathGuard: new PathGuard({ workspaceRoot: ROOT, fs }),
    denylist: new Denylist(),
    logger: new Logger({ sink: new MemorySink() }),
  };
}

describe('resolvePins', () => {
  it('đọc đúng đoạn dòng đã pin', async () => {
    const [resolved] = await resolvePins(
      [{ path: 'src/auth.ts', startLine: 1, endLine: 3 }],
      makeCtx(),
    );
    expect(resolved!.error).toBeUndefined();
    expect(resolved!.content).toContain('export function login');
    expect(resolved!.content).not.toContain('logout');
  });

  it('pin cả file (không truyền dòng) đọc hết trong trần 5000 dòng', async () => {
    const [resolved] = await resolvePins([{ path: 'src/auth.ts' }], makeCtx());
    expect(resolved!.error).toBeUndefined();
    expect(resolved!.content).toContain('logout');
    expect(resolved!.truncated).toBe(false);
  });

  it('pin cả file dài hơn trần thì báo truncated', async () => {
    const [resolved] = await resolvePins([{ path: 'big.txt' }], makeCtx());
    expect(resolved!.error).toBeUndefined();
    expect(resolved!.truncated).toBe(true);
  });

  it('pin file bị denylist thì trả về error, không lộ nội dung', async () => {
    const [resolved] = await resolvePins([{ path: '.env' }], makeCtx());
    expect(resolved!.error).toBeDefined();
    expect(resolved!.content).toBe('');
  });

  it('pin file không tồn tại thì trả về error', async () => {
    const [resolved] = await resolvePins([{ path: 'no-such-file.ts' }], makeCtx());
    expect(resolved!.error).toBeDefined();
  });
});

describe('renderPinnedContext', () => {
  it('bọc nội dung trong thẻ pinned_context kèm nhãn dòng', async () => {
    const resolved = await resolvePins(
      [{ path: 'src/auth.ts', startLine: 1, endLine: 3 }],
      makeCtx(),
    );
    const rendered = renderPinnedContext(resolved);
    expect(rendered).toContain('<pinned_context untrusted="true">');
    expect(rendered).toContain('src/auth.ts (dòng 1–3)');
    expect(rendered).toContain('export function login');
  });

  it('bỏ qua pin lỗi, không đưa error vào prompt', async () => {
    const resolved = await resolvePins(
      [{ path: '.env' }, { path: 'src/auth.ts', startLine: 1, endLine: 1 }],
      makeCtx(),
    );
    const rendered = renderPinnedContext(resolved);
    expect(rendered).not.toContain('.env');
    expect(rendered).toContain('src/auth.ts');
  });

  it('rỗng khi không có pin nào đọc được', () => {
    expect(renderPinnedContext([{ path: '.env', content: '', truncated: false, error: 'x' }])).toBe(
      '',
    );
  });
});
