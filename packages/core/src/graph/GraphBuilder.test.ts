/**
 * Test tích hợp thật với `web-tree-sitter` + `tree-sitter-wasms` (không mock) —
 * đây là cách duy nhất biết chắc các query trong `parser/queries/*.ts` khớp
 * đúng field/node-type của từng grammar, thay vì đoán theo tài liệu.
 */
import { describe, expect, it } from 'vitest';
import * as nodePath from 'node:path';
import { MemoryFileSystem } from '../fs/FileSystem.js';
import { PathGuard } from '../security/pathGuard.js';
import { Denylist } from '../security/denylist.js';
import { Logger, MemorySink } from '../telemetry/logger.js';
import { GraphBuilder, resolveImportPath } from './GraphBuilder.js';
import { TreeSitterParser } from './parser/TreeSitterParser.js';

const WINDOWS = nodePath.sep === '\\';
const ROOT = WINDOWS ? 'C:\\work\\app' : '/work/app';
const p = (...parts: string[]): string => nodePath.join(ROOT, ...parts);

const FILES: Record<string, string> = {
  [p('src', 'auth.ts')]: 'export function login(user: string) {\n  return user;\n}\n',
  [p('src', 'index.ts')]:
    "import { login as doLogin } from './auth';\n\ndoLogin('x');\n",
  [p('.env')]: 'SECRET=1\n',
  [p('scripts', 'greet.py')]:
    'def handler(name):\n    return f"hi {name}"\n\n\nhandler("world")\n',
  [p('main.go')]:
    'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n',
};

function build(): Promise<import('./CodeGraph.js').CodeGraph> {
  const fs = new MemoryFileSystem({ files: FILES, caseInsensitive: WINDOWS });
  const logger = new Logger({ sink: new MemorySink() });
  const builder = new GraphBuilder({
    workspaceRoot: ROOT,
    fs,
    pathGuard: new PathGuard({ workspaceRoot: ROOT, fs }),
    denylist: new Denylist(),
    logger,
    parser: new TreeSitterParser({ logger }),
  });
  return builder.build();
}

describe('GraphBuilder + TreeSitterParser (grammar thật)', () => {
  it('TS: giải import tương đối thành file thật, và cạnh importedBy đúng chiều', async () => {
    const graph = await build();
    expect(graph.importsOf('src/index.ts')).toEqual(['src/auth.ts']);
    expect(graph.importedBy('src/auth.ts')).toEqual(['src/index.ts']);
  }, 30_000);

  it('TS: bắt được định nghĩa hàm', async () => {
    const graph = await build();
    const def = graph.definitionOf('login');
    expect(def?.file).toBe('src/auth.ts');
    expect(def?.kind).toBe('function');
  }, 30_000);

  it('TS: referencesTo tìm ra chỗ gọi qua alias import — điều grep không làm được', async () => {
    const graph = await build();
    // doLogin('x') gọi login qua alias — grep "login" sẽ KHÔNG khớp dòng này.
    const refs = graph.referencesTo('login');
    expect(refs.some((r) => r.file === 'src/index.ts')).toBe(true);
    // Vẫn còn tham chiếu dưới tên cục bộ như bình thường.
    expect(graph.referencesTo('doLogin').some((r) => r.file === 'src/index.ts')).toBe(true);
  }, 30_000);

  it('.env bị denylist chặn — không bao giờ vào graph', async () => {
    const graph = await build();
    expect(graph.hashOf('.env')).toBeUndefined();
    expect(graph.knownFiles()).not.toContain('.env');
  }, 30_000);

  it('Python: bắt được định nghĩa hàm và tham chiếu khi gọi nó', async () => {
    const graph = await build();
    const def = graph.definitionOf('handler');
    expect(def?.file).toBe('scripts/greet.py');
    expect(graph.referencesTo('handler').some((r) => r.file === 'scripts/greet.py')).toBe(true);
  }, 30_000);

  it('Go: bắt được định nghĩa hàm main, không ném lỗi vì import "fmt" là package ngoài', async () => {
    const graph = await build();
    expect(graph.definitionOf('main')?.file).toBe('main.go');
    expect(graph.hashOf('main.go')).toBeDefined();
  }, 30_000);

  it('build lại lần hai với graph cũ: file không đổi thì không tính là "thay đổi"', async () => {
    const fs = new MemoryFileSystem({ files: FILES, caseInsensitive: WINDOWS });
    const logger = new Logger({ sink: new MemorySink() });
    const builder = new GraphBuilder({
      workspaceRoot: ROOT,
      fs,
      pathGuard: new PathGuard({ workspaceRoot: ROOT, fs }),
      denylist: new Denylist(),
      logger,
      parser: new TreeSitterParser({ logger }),
    });
    const first = await builder.build();
    const hashBefore = first.hashOf('src/auth.ts');
    const second = await builder.build(first);
    expect(second.hashOf('src/auth.ts')).toBe(hashBefore);
    expect(second.importedBy('src/auth.ts')).toEqual(['src/index.ts']);
  }, 30_000);
});

describe('resolveImportPath', () => {
  const known = new Set(['src/auth.ts', 'src/util/hash.ts', 'src/util/index.ts']);

  it('bỏ qua package ngoài (không bắt đầu bằng . hoặc /)', () => {
    expect(resolveImportPath('src/index.ts', 'react', known)).toBeUndefined();
  });

  it('giải specifier tương đối kèm phần mở rộng', () => {
    expect(resolveImportPath('src/index.ts', './auth.ts', known)).toBe('src/auth.ts');
  });

  it('giải specifier tương đối thiếu phần mở rộng', () => {
    expect(resolveImportPath('src/index.ts', './auth', known)).toBe('src/auth.ts');
  });

  it('giải ../ đúng thư mục cha', () => {
    expect(resolveImportPath('src/util/x.ts', '../auth', known)).toBe('src/auth.ts');
  });

  it('giải về file index khi specifier trỏ vào thư mục', () => {
    expect(resolveImportPath('src/index.ts', './util', known)).toBe('src/util/index.ts');
  });
});
