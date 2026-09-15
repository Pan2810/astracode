import { describe, expect, it } from 'vitest';
import * as nodePath from 'node:path';
import { MemoryFileSystem } from '../fs/FileSystem.js';
import { PathGuard } from '../security/pathGuard.js';
import { Denylist } from '../security/denylist.js';
import { Logger, MemorySink } from '../telemetry/logger.js';
import { CodeGraph } from '../graph/CodeGraph.js';
import type { CodeGraphProvider } from '../graph/types.js';
import type { ToolContext } from './Tool.js';
import { findReferencesTool, impactOfTool } from './codeGraphTools.js';

const WINDOWS = nodePath.sep === '\\';
const ROOT = WINDOWS ? 'C:\\work\\app' : '/work/app';
const p = (...parts: string[]): string => nodePath.join(ROOT, ...parts);

function graphWithFixture(): CodeGraph {
  const graph = new CodeGraph();
  graph.setFile(
    'src/auth.ts',
    'h1',
    [],
    [{ file: 'src/auth.ts', name: 'login', line: 3, column: 16, kind: 'function' }],
    [],
  );
  graph.setFile('src/index.ts', 'h2', ['src/auth.ts'], [], [{ file: 'src/index.ts', name: 'login', line: 5, column: 0 }]);
  return graph;
}

function makeCtx(codeGraph?: CodeGraphProvider): ToolContext {
  const files: Record<string, string> = { [p('src', 'auth.ts')]: '', [p('src', 'index.ts')]: '' };
  const fs = new MemoryFileSystem({ files, caseInsensitive: WINDOWS });
  return {
    workspaceRoot: ROOT,
    fs,
    pathGuard: new PathGuard({ workspaceRoot: ROOT, fs }),
    denylist: new Denylist(),
    logger: new Logger({ sink: new MemorySink() }),
    ...(codeGraph ? { codeGraph } : {}),
  };
}

describe('find_references', () => {
  it('không có ctx.codeGraph -> báo lỗi rõ ràng, không throw', async () => {
    const result = await findReferencesTool.execute({ symbol: 'login' }, makeCtx());
    expect(result.isError).toBe(true);
  });

  it('tìm được định nghĩa và mọi tham chiếu', async () => {
    const provider: CodeGraphProvider = { ensureFresh: async () => graphWithFixture() };
    const result = await findReferencesTool.execute({ symbol: 'login' }, makeCtx(provider));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('src/auth.ts:3');
    expect(result.content).toContain('src/index.ts:5');
    expect(result.meta?.found).toBe(true);
  });

  it('symbol không tồn tại -> found:false, không phải lỗi', async () => {
    const provider: CodeGraphProvider = { ensureFresh: async () => graphWithFixture() };
    const result = await findReferencesTool.execute({ symbol: 'khongTonTai' }, makeCtx(provider));

    expect(result.isError).toBeUndefined();
    expect(result.meta?.found).toBe(false);
  });
});

describe('impact_of', () => {
  it('không có ctx.codeGraph -> báo lỗi rõ ràng', async () => {
    const result = await impactOfTool.execute({ file: 'src/auth.ts' }, makeCtx());
    expect(result.isError).toBe(true);
  });

  it('liệt kê file bị ảnh hưởng qua importedBy', async () => {
    const provider: CodeGraphProvider = { ensureFresh: async () => graphWithFixture() };
    const result = await impactOfTool.execute({ file: 'src/auth.ts' }, makeCtx(provider));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('src/index.ts');
    expect(result.meta?.impacted).toBe(1);
  });

  it('file chưa được index -> found:false', async () => {
    const provider: CodeGraphProvider = { ensureFresh: async () => new CodeGraph() };
    const result = await impactOfTool.execute({ file: 'src/auth.ts' }, makeCtx(provider));

    expect(result.meta?.found).toBe(false);
  });
});
