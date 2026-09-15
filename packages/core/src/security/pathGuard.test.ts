import { describe, expect, it } from 'vitest';
import * as nodePath from 'node:path';
import { PathGuard, PathGuardError, isWithin } from './pathGuard.js';
import { MemoryFileSystem } from '../fs/FileSystem.js';

/**
 * Mỗi test dưới đây tương ứng một dòng trong bảng "Path traversal trên Windows"
 * của docs/SECURITY.md §5. Đây là phần dễ tưởng là xong mà thực ra chưa.
 */

const WINDOWS = nodePath.sep === '\\';
const ROOT = WINDOWS ? 'C:\\work\\app' : '/work/app';
const OUTSIDE = WINDOWS ? 'C:\\Users\\victim' : '/home/victim';

function guard(opts?: {
  files?: Record<string, string>;
  symlinks?: Record<string, string>;
}): PathGuard {
  const fs = new MemoryFileSystem({
    files: {
      [nodePath.join(ROOT, 'src', 'index.ts')]: 'export const a = 1;',
      [nodePath.join(ROOT, 'README.md')]: '# app',
      [nodePath.join(OUTSIDE, '.ssh', 'id_rsa')]: 'PRIVATE KEY',
      [nodePath.join(WINDOWS ? 'C:\\work\\app-secrets' : '/work/app-secrets', 'k.txt')]: 'secret',
      ...(opts?.files ?? {}),
    },
    ...(opts?.symlinks ? { symlinks: opts.symlinks } : {}),
    caseInsensitive: WINDOWS,
  });
  return new PathGuard({ workspaceRoot: ROOT, fs });
}

describe('isWithin — so sánh có biên', () => {
  it('chấp nhận chính root và file bên trong', () => {
    expect(isWithin(ROOT, ROOT)).toBe(true);
    expect(isWithin(ROOT, nodePath.join(ROOT, 'src', 'a.ts'))).toBe(true);
  });

  it('KHÔNG nuốt thư mục có tên bắt đầu giống root', () => {
    // Đây là lỗi kinh điển của startsWith() thiếu separator.
    const sibling = WINDOWS ? 'C:\\work\\app-secrets\\k.txt' : '/work/app-secrets/k.txt';
    expect(isWithin(ROOT, sibling)).toBe(false);
  });

  it('bỏ qua dấu phân cách thừa ở cuối root', () => {
    expect(isWithin(ROOT + nodePath.sep, nodePath.join(ROOT, 'a'))).toBe(true);
  });

  it.runIf(WINDOWS)('không phân biệt hoa thường trên Windows', () => {
    expect(isWithin('C:\\work\\app', 'c:\\WORK\\App\\src\\a.ts')).toBe(true);
  });
});

describe('PathGuard.resolveExisting', () => {
  it('cho qua file trong workspace, trả đường dẫn thật', async () => {
    const real = await guard().resolveExisting('src/index.ts');
    expect(isWithin(ROOT, real)).toBe(true);
  });

  it('chặn ../ leo ra ngoài', async () => {
    await expect(guard().resolveExisting('../../Users/victim/.ssh/id_rsa')).rejects.toThrow(
      PathGuardError,
    );
  });

  it('chặn đường dẫn tuyệt đối ngoài workspace', async () => {
    await expect(
      guard().resolveExisting(nodePath.join(OUTSIDE, '.ssh', 'id_rsa')),
    ).rejects.toMatchObject({ reason: 'outside-root' });
  });

  it('chặn thư mục anh em có tên trùng tiền tố', async () => {
    const sibling = WINDOWS ? 'C:\\work\\app-secrets\\k.txt' : '/work/app-secrets/k.txt';
    await expect(guard().resolveExisting(sibling)).rejects.toMatchObject({
      reason: 'outside-root',
    });
  });

  it('chặn junction/symlink trỏ ra ngoài — realpath phải chạy TRƯỚC khi so sánh', async () => {
    const g = guard({
      symlinks: { [nodePath.join(ROOT, 'inner')]: OUTSIDE },
    });
    // Cú pháp thì nằm trong root; chỉ realpath mới lộ ra là nó đi ra ngoài.
    await expect(g.resolveExisting('inner/.ssh/id_rsa')).rejects.toMatchObject({
      reason: 'outside-root',
    });
  });

  it('cho qua symlink trỏ vào chỗ vẫn trong workspace', async () => {
    const g = guard({
      symlinks: { [nodePath.join(ROOT, 'alias')]: nodePath.join(ROOT, 'src') },
    });
    const real = await g.resolveExisting('alias/index.ts');
    expect(isWithin(ROOT, real)).toBe(true);
  });

  it('chặn UNC path', async () => {
    await expect(guard().resolveExisting('\\\\server\\share\\x')).rejects.toMatchObject({
      reason: 'unc-path',
    });
  });

  it('chặn device path \\\\?\\', async () => {
    await expect(guard().resolveExisting('\\\\?\\C:\\Windows\\win.ini')).rejects.toMatchObject({
      reason: 'device-path',
    });
    await expect(guard().resolveExisting('\\\\.\\PIPE\\x')).rejects.toMatchObject({
      reason: 'device-path',
    });
  });

  it('chặn drive-relative C:foo', async () => {
    await expect(guard().resolveExisting('C:foo')).rejects.toMatchObject({
      reason: 'drive-relative',
    });
  });

  it('đường dẫn rỗng bị từ chối, không bị coi là root', async () => {
    await expect(guard().resolveExisting('')).rejects.toMatchObject({ reason: 'empty' });
    await expect(guard().resolveExisting('   ')).rejects.toMatchObject({ reason: 'empty' });
  });

  it('file không tồn tại -> not-found, phân biệt với outside-root', async () => {
    await expect(guard().resolveExisting('src/khong-co.ts')).rejects.toMatchObject({
      reason: 'not-found',
    });
  });

  it.runIf(WINDOWS)('chấp nhận khác hoa thường của cùng một file', async () => {
    const real = await guard().resolveExisting('SRC\\INDEX.TS');
    expect(isWithin(ROOT, real)).toBe(true);
  });
});

describe('PathGuard.isAllowed', () => {
  it('trả boolean thay vì ném, dùng để lọc danh sách', async () => {
    const g = guard();
    expect(await g.isAllowed('src/index.ts')).toBe(true);
    expect(await g.isAllowed('../../Users/victim/.ssh/id_rsa')).toBe(false);
  });
});

describe('PathGuard.toRelative', () => {
  it('trả đường dẫn dùng / để model và UI đọc thống nhất', async () => {
    const g = guard();
    const real = await g.resolveExisting('src/index.ts');
    expect(await g.toRelative(real)).toBe('src/index.ts');
  });
});

/**
 * resolveForWrite (M4) — đường dẫn CHƯA tồn tại.
 *
 * `resolveExisting` không dùng được cho file mới, nhưng bỏ realpath đi thì thư
 * mục cha có thể là junction trỏ ra ngoài workspace. Đây là chỗ dễ thủng nhất
 * của toàn bộ M4: file mới trông vô hại vì chưa có gì để realpath.
 */
describe('PathGuard.resolveForWrite', () => {
  it('cho phép file chưa tồn tại trong thư mục có thật', async () => {
    const abs = await guard().resolveForWrite('src/moi.ts');
    expect(isWithin(ROOT, abs)).toBe(true);
    expect(abs.endsWith(nodePath.join('src', 'moi.ts'))).toBe(true);
  });

  it('cho phép cả thư mục cha chưa tồn tại', async () => {
    const abs = await guard().resolveForWrite('a/b/c/moi.ts');
    expect(isWithin(ROOT, abs)).toBe(true);
  });

  it('chặn ghi ra ngoài workspace bằng ..', async () => {
    await expect(guard().resolveForWrite('../ngoai.ts')).rejects.toBeInstanceOf(PathGuardError);
  });

  it('chặn file MỚI nằm trong thư mục cha là junction trỏ ra ngoài', async () => {
    // mklink /J C:\work\app\link C:\Users\victim
    const g = guard({ symlinks: { [nodePath.join(ROOT, 'link')]: OUTSIDE } });

    await expect(g.resolveForWrite('link/backdoor.ts')).rejects.toMatchObject({
      reason: 'outside-root',
    });
  });

  it('chặn device path và UNC y như đường đọc', async () => {
    const g = guard();
    await expect(g.resolveForWrite(String.raw`\\?\C:\Windows\x.ts`)).rejects.toMatchObject({
      reason: 'device-path',
    });
    await expect(g.resolveForWrite(String.raw`\\server\share\x.ts`)).rejects.toMatchObject({
      reason: 'unc-path',
    });
  });

  it.runIf(WINDOWS)('chặn drive-relative', async () => {
    await expect(guard().resolveForWrite('C:x.ts')).rejects.toMatchObject({
      reason: 'drive-relative',
    });
  });

  it('KHÔNG nuốt thư mục anh em có tên bắt đầu giống root', async () => {
    const sibling = WINDOWS
      ? String.raw`C:\work\app-secrets\moi.txt`
      : '/work/app-secrets/moi.txt';
    await expect(guard().resolveForWrite(sibling)).rejects.toMatchObject({
      reason: 'outside-root',
    });
  });
});
