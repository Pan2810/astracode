import { describe, expect, it } from 'vitest';
import * as nodePath from 'node:path';
import { MemoryFileSystem } from '../fs/FileSystem.js';
import { PathGuard } from '../security/pathGuard.js';
import { Denylist } from '../security/denylist.js';
import { Logger, MemorySink } from '../telemetry/logger.js';
import { readFileTool } from './readFile.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { listDirTool } from './listDir.js';
import { ToolRegistry } from './Tool.js';
import type { ToolContext } from './Tool.js';

const WINDOWS = nodePath.sep === '\\';
const ROOT = WINDOWS ? 'C:\\work\\app' : '/work/app';
const OUTSIDE = WINDOWS ? 'C:\\Users\\victim' : '/home/victim';

const p = (...parts: string[]): string => nodePath.join(ROOT, ...parts);

const FILES: Record<string, string> = {
  [p('README.md')]: '# App\n\nHướng dẫn cài đặt.\n',
  [p('.env')]: 'DATABASE_URL=postgres://user:hunter2@db/app\n',
  [p('.env.example')]: 'DATABASE_URL=\n',
  [p('package.json')]: '{"name":"app"}',
  [p('src', 'index.ts')]: 'import { login } from "./auth";\nlogin();\n',
  [p('src', 'auth.ts')]:
    'export function login(user: string) {\n' +
    '  // xác thực người dùng\n' +
    '  return verifyPassword(user);\n' +
    '}\n' +
    'export function logout() {}\n',
  [p('src', 'util', 'hash.ts')]: 'export const hash = (s: string) => s;\n',
  [p('node_modules', 'lodash', 'index.js')]: 'module.exports = {};',
  [p('dist', 'bundle.js')]: 'console.log(1)',
  [p('big.txt')]: Array.from({ length: 300 }, (_, i) => `dòng ${i + 1}`).join('\n'),
  [nodePath.join(OUTSIDE, '.ssh', 'id_rsa')]: 'PRIVATE KEY',
};

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const fs = new MemoryFileSystem({ files: FILES, caseInsensitive: WINDOWS });
  return {
    workspaceRoot: ROOT,
    fs,
    pathGuard: new PathGuard({ workspaceRoot: ROOT, fs }),
    denylist: new Denylist(),
    logger: new Logger({ sink: new MemorySink() }),
    ...overrides,
  };
}

describe('read_file', () => {
  it('đọc file và đánh số dòng để model trích dẫn được vị trí', async () => {
    const r = await readFileTool.execute({ path: 'src/auth.ts' }, makeCtx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('src/auth.ts');
    expect(r.content).toMatch(/1\texport function login/);
    // Nội dung file là dữ liệu không tin cậy — AgentLoop cần cờ này.
    expect(r.untrusted).toBe(true);
  });

  it('TỪ CHỐI đọc .env dù được yêu cầu trực tiếp', async () => {
    const r = await readFileTool.execute({ path: '.env' }, makeCtx());
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain('hunter2');
    expect(r.content).toMatch(/bí mật|tầng công cụ/);
  });

  it('cho phép .env.example vì đó là tài liệu', async () => {
    const r = await readFileTool.execute({ path: '.env.example' }, makeCtx());
    expect(r.isError).toBeFalsy();
  });

  it('chặn đường dẫn leo ra ngoài workspace', async () => {
    const r = await readFileTool.execute(
      { path: '../../Users/victim/.ssh/id_rsa' },
      makeCtx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain('PRIVATE KEY');
  });

  it('phân trang bằng offset/limit', async () => {
    const r = await readFileTool.execute({ path: 'big.txt', offset: 100, limit: 5 }, makeCtx());
    expect(r.content).toContain('dòng 100');
    expect(r.content).toContain('dòng 104');
    expect(r.content).not.toContain('dòng 105');
    expect(r.meta?.truncated).toBe(true);
  });

  it('báo lỗi rõ ràng khi offset vượt quá số dòng', async () => {
    const r = await readFileTool.execute({ path: 'big.txt', offset: 9999 }, makeCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/300 dòng/);
  });

  it('chỉ đường sang list_dir khi trỏ vào thư mục', async () => {
    const r = await readFileTool.execute({ path: 'src' }, makeCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('list_dir');
  });

  it('file không tồn tại -> lỗi có kiểm soát, không ném', async () => {
    const r = await readFileTool.execute({ path: 'src/khong-co.ts' }, makeCtx());
    expect(r.isError).toBe(true);
  });
});

describe('glob', () => {
  it('tìm theo mẫu đệ quy', async () => {
    const r = await globTool.execute({ pattern: 'src/**/*.ts' }, makeCtx());
    expect(r.content).toContain('src/auth.ts');
    expect(r.content).toContain('src/util/hash.ts');
  });

  it('hỗ trợ nhóm {a,b}', async () => {
    const r = await globTool.execute({ pattern: '**/*.{json,md}' }, makeCtx());
    expect(r.content).toContain('package.json');
    expect(r.content).toContain('README.md');
  });

  it('bỏ qua node_modules và dist', async () => {
    const r = await globTool.execute({ pattern: '**/*.js' }, makeCtx());
    expect(r.content).not.toContain('node_modules');
    expect(r.content).not.toContain('dist/');
  });

  it('không bao giờ trả file bị denylist chặn', async () => {
    const r = await globTool.execute({ pattern: '**/*' }, makeCtx());
    expect(r.content).not.toMatch(/(^|\n)\.env$/m);
  });

  it('không khớp -> gợi ý bước tiếp theo thay vì im lặng', async () => {
    const r = await globTool.execute({ pattern: '**/*.rs' }, makeCtx());
    expect(r.content).toContain('list_dir');
    expect(r.meta?.count).toBe(0);
  });

  it('giới hạn phạm vi bằng path', async () => {
    const r = await globTool.execute({ pattern: '**/*.ts', path: 'src/util' }, makeCtx());
    expect(r.content).toContain('src/util/hash.ts');
    expect(r.content).not.toContain('src/auth.ts');
  });
});

describe('grep', () => {
  it('tìm được hàm trong codebase, kèm số dòng', async () => {
    const r = await grepTool.execute({ pattern: 'function login' }, makeCtx());
    expect(r.content).toContain('src/auth.ts');
    expect(r.content).toMatch(/1:export function login/);
  });

  it('mặc định không phân biệt hoa thường', async () => {
    const r = await grepTool.execute({ pattern: 'FUNCTION LOGIN' }, makeCtx());
    expect(r.meta?.count).toBeGreaterThan(0);
  });

  it('bật được phân biệt hoa thường', async () => {
    const r = await grepTool.execute(
      { pattern: 'FUNCTION LOGIN', caseSensitive: true },
      makeCtx(),
    );
    expect(r.meta?.count).toBe(0);
  });

  it('lọc theo glob', async () => {
    const r = await grepTool.execute({ pattern: 'login', glob: '**/*.ts' }, makeCtx());
    expect(r.content).toContain('src/auth.ts');
    expect(r.content).toContain('src/index.ts');
  });

  it('trả dòng ngữ cảnh khi được yêu cầu', async () => {
    const r = await grepTool.execute(
      { pattern: 'xác thực', contextLines: 1 },
      makeCtx(),
    );
    expect(r.content).toMatch(/1-export function login/);
    expect(r.content).toMatch(/2:.*xác thực/);
  });

  it('KHÔNG bao giờ tìm trong file bị denylist chặn', async () => {
    // `DATABASE_URL` có ở cả .env (bị chặn) lẫn .env.example (được phép).
    // Kết quả phải chỉ đến từ file được phép, và không mang theo giá trị thật.
    const r = await grepTool.execute({ pattern: 'DATABASE_URL' }, makeCtx());
    expect(r.content).toContain('.env.example');
    expect(r.content).not.toMatch(/(^|\n)\.env\n/);
    expect(r.content).not.toContain('hunter2');
    expect(r.content).not.toContain('postgres://');
  });

  it('regex hỏng -> báo lỗi thay vì ném', async () => {
    const r = await grepTool.execute({ pattern: '([unclosed' }, makeCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Regex');
  });

  it('không tìm thấy -> gợi ý dùng glob', async () => {
    const r = await grepTool.execute({ pattern: 'khongtontaidau' }, makeCtx());
    expect(r.content).toContain('glob');
  });

  it('tôn trọng limit', async () => {
    const r = await grepTool.execute({ pattern: 'dòng', limit: 3 }, makeCtx());
    expect(r.meta?.count).toBe(3);
    expect(r.meta?.truncated).toBe(true);
  });
});

describe('list_dir', () => {
  it('liệt kê thư mục trước file', async () => {
    const r = await listDirTool.execute({}, makeCtx());
    const lines = r.content.split('\n');
    expect(lines).toContain('src/');
    expect(lines).toContain('README.md');
    expect(lines.indexOf('src/')).toBeLessThan(lines.indexOf('README.md'));
  });

  it('ẩn file bí mật NHƯNG nói rõ có bao nhiêu cái bị ẩn', async () => {
    const r = await listDirTool.execute({}, makeCtx());
    expect(r.content).not.toMatch(/(^|\n)\.env$/m);
    expect(r.content).toMatch(/bị ẩn vì có thể chứa thông tin bí mật/);
  });

  it('bỏ qua thư mục sinh ra bởi build và nói rõ', async () => {
    const r = await listDirTool.execute({}, makeCtx());
    expect(r.content).not.toContain('node_modules/');
    expect(r.content).toMatch(/build\/deps bị bỏ qua/);
  });

  it('chặn đường dẫn ngoài workspace', async () => {
    const r = await listDirTool.execute({ path: OUTSIDE }, makeCtx());
    expect(r.isError).toBe(true);
  });

  it('chỉ đường sang read_file khi trỏ vào file', async () => {
    const r = await listDirTool.execute({ path: 'README.md' }, makeCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('read_file');
  });
});

describe('ToolRegistry', () => {
  const registry = new ToolRegistry([readFileTool, globTool, grepTool, listDirTool]);

  it('sinh định nghĩa JSON Schema cho model', () => {
    const defs = registry.definitions();
    expect(defs.map((d) => d.name).sort()).toEqual(['glob', 'grep', 'list_dir', 'read_file']);

    const readDef = defs.find((d) => d.name === 'read_file')!;
    expect(readDef.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
  });

  it('không để lọt $schema hay $ref — model yếu dễ rối vì chúng', () => {
    for (const def of registry.definitions()) {
      const json = JSON.stringify(def.parameters);
      expect(json).not.toContain('$schema');
      expect(json).not.toContain('$ref');
    }
  });

  it('từ chối đăng ký trùng tên', () => {
    expect(() => registry.register(readFileTool)).toThrow(/trùng tên/);
  });

  it('mọi tool ở M2 đều là read-only', () => {
    expect(registry.all().every((t) => t.readOnly)).toBe(true);
  });
});

describe('read_file — trần kích thước (sổ nợ #20)', () => {
  /** File riêng cho nhóm này: giữ chúng ngoài FILES để test khác không tốn RAM. */
  function ctxWithBig(sizes: Record<string, number>): ToolContext {
    const files: Record<string, string> = { ...FILES };
    for (const [name, bytes] of Object.entries(sizes)) {
      files[p(name)] = 'x'.repeat(bytes);
    }
    const fs = new MemoryFileSystem({ files, caseInsensitive: WINDOWS });
    return {
      workspaceRoot: ROOT,
      fs,
      pathGuard: new PathGuard({ workspaceRoot: ROOT, fs }),
      denylist: new Denylist(),
      logger: new Logger({ sink: new MemorySink() }),
    };
  }

  it('từ chối file > 512 KB khi đọc cả file', async () => {
    const r = await readFileTool.execute({ path: 'huge.log' }, ctxWithBig({ 'huge.log': 600_000 }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('offset');
  });

  it('limit KHÔNG mở được cửa cho file khổng lồ — trần tuyệt đối vẫn áp', async () => {
    // Đây là lỗ hổng thật: bản trước chỉ kiểm trần khi `limit === undefined`, nên
    // `limit: 1` là đủ để nạp trọn một file vài trăm MB vào RAM extension host.
    const ctx = ctxWithBig({ 'giant.log': 9 * 1024 * 1024 });
    const r = await readFileTool.execute({ path: 'giant.log', limit: 1 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('grep');
  });

  it('offset một mình cũng không mở được cửa đó', async () => {
    const ctx = ctxWithBig({ 'giant.log': 9 * 1024 * 1024 });
    const r = await readFileTool.execute({ path: 'giant.log', offset: 1 }, ctx);
    expect(r.isError).toBe(true);
  });

  it('file lớn vừa phải vẫn đọc được khi đã phân trang', async () => {
    // Trần thứ hai không được chặt tới mức làm hỏng công dụng của offset/limit.
    const ctx = ctxWithBig({ 'medium.log': 600_000 });
    const r = await readFileTool.execute({ path: 'medium.log', offset: 1, limit: 1 }, ctx);
    expect(r.isError).toBeFalsy();
  });
});

describe('grep — regex không tin cậy (sổ nợ #21)', () => {
  it('từ chối mẫu backtracking thảm hoạ TRƯỚC khi quét', async () => {
    const started = Date.now();
    const r = await grepTool.execute({ pattern: '(a+)+$' }, makeCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('lồng nhau');
    // Nếu mẫu này được đem chạy thật, ca test treo chứ không fail.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('vẫn nhận mẫu bình thường', async () => {
    const r = await grepTool.execute({ pattern: 'function login' }, makeCtx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('src/auth.ts');
  });

  it('mẫu sai cú pháp vẫn báo lỗi có kiểm soát như trước', async () => {
    const r = await grepTool.execute({ pattern: '(unclosed' }, makeCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('không hợp lệ');
  });

  it('chỉ khớp phần đầu của dòng quá dài, và NÓI RA là đã cắt', async () => {
    const files = {
      ...FILES,
      [p('minified.js')]: `${'a'.repeat(5000)}NEEDLE\nconst x = 1;\n`,
    };
    const fs = new MemoryFileSystem({ files, caseInsensitive: WINDOWS });
    const ctx: ToolContext = {
      workspaceRoot: ROOT,
      fs,
      pathGuard: new PathGuard({ workspaceRoot: ROOT, fs }),
      denylist: new Denylist(),
      logger: new Logger({ sink: new MemorySink() }),
    };

    // NEEDLE nằm sau ký tự thứ 4000 nên không khớp — đó là cái giá của trần đầu
    // vào, và nó phải được nói ra chứ không im lặng.
    const r = await grepTool.execute({ pattern: 'NEEDLE' }, ctx);
    expect(r.meta?.count ?? 0).toBe(0);

    const found = await grepTool.execute({ pattern: 'const x' }, ctx);
    expect(found.meta?.longLinesClipped).toBe(1);
    expect(found.content).toContain('chỉ được khớp ở phần đầu');
  });

  it('huỷ giữa lúc quét thì dừng — signal được kiểm ở chỗ có nhường event loop', async () => {
    // Đủ dòng để vượt LINES_PER_YIELD, tức là chắc chắn có một điểm nhường.
    const files = {
      ...FILES,
      [p('many.txt')]: Array.from({ length: 6000 }, (_, i) => `dòng ${i}`).join('\n'),
    };
    const fs = new MemoryFileSystem({ files, caseInsensitive: WINDOWS });
    const controller = new AbortController();
    const ctx: ToolContext = {
      workspaceRoot: ROOT,
      fs,
      pathGuard: new PathGuard({ workspaceRoot: ROOT, fs }),
      denylist: new Denylist(),
      logger: new Logger({ sink: new MemorySink() }),
      signal: controller.signal,
    };

    const running = grepTool.execute({ pattern: 'dòng', limit: 500 }, ctx);
    controller.abort();
    const r = await running;
    // Không ném: grep là tool readOnly, huỷ giữa chừng trả phần đã có.
    expect(r.isError).toBeFalsy();
  });
});
