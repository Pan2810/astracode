import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, type FileStat, type FileSystem } from '../fs/FileSystem.js';
import { Logger, MemorySink } from '../telemetry/logger.js';
import { HomeCleanup } from './Cleanup.js';
import { astraLayout, sessionHistoryDir } from './layout.js';

const HOME = process.platform === 'win32' ? 'C:\\Users\\test\\.astra' : '/home/test/.astra';
const layout = astraLayout(HOME);
const logger = (): Logger => new Logger({ sink: new MemorySink() });

/**
 * MemoryFileSystem trả mtime = 0 cho mọi file, còn việc dọn dẹp lại quyết định
 * theo tuổi file. Lớp này gắn mtime giả cho đúng những đường dẫn cần kiểm.
 */
class AgedFs implements FileSystem {
  constructor(
    private readonly inner: MemoryFileSystem,
    private readonly mtimes: Record<string, number>,
  ) {}

  realpath = (p: string): Promise<string> => this.inner.realpath(p);
  readFile = (p: string): Promise<string> => this.inner.readFile(p);
  readDir = (p: string): ReturnType<FileSystem['readDir']> => this.inner.readDir(p);
  exists = (p: string): Promise<boolean> => this.inner.exists(p);
  writeFile = (p: string, c: string): Promise<void> => this.inner.writeFile(p, c);
  deleteFile = (p: string): Promise<void> => this.inner.deleteFile(p);
  mkdirp = (p: string): Promise<void> => this.inner.mkdirp(p);

  async stat(p: string): Promise<FileStat> {
    const s = await this.inner.stat(p);
    return { ...s, mtimeMs: this.mtimes[p] ?? s.mtimeMs };
  }
}

const sessionFile = (slug: string, id: string): string =>
  join(layout.projects, slug, `session-${id}.json`);

describe('HomeCleanup — lịch chạy', () => {
  it('chưa từng dọn thì tới hạn ngay', async () => {
    const fs = new MemoryFileSystem({ files: {} });
    const cleanup = new HomeCleanup({ fs, layout, logger: logger(), now: () => 1_000_000 });

    expect(await cleanup.due()).toBe(true);
  });

  it('vừa dọn xong thì lần sau không dọn lại', async () => {
    const now = Date.parse('2026-08-13T00:00:00.000Z');
    const fs = new MemoryFileSystem({ files: {} });
    const cleanup = new HomeCleanup({ fs, layout, logger: logger(), now: () => now });

    await cleanup.run();

    expect(await cleanup.due()).toBe(false);
    expect(await cleanup.runIfDue()).toBeUndefined();
  });

  it('mốc hỏng thì coi như chưa dọn, không kẹt vĩnh viễn', async () => {
    const fs = new MemoryFileSystem({ files: { [layout.lastCleanup]: 'không phải ngày tháng' } });
    const cleanup = new HomeCleanup({ fs, layout, logger: logger() });

    expect(await cleanup.due()).toBe(true);
  });
});

describe('HomeCleanup — dọn cái gì', () => {
  it('xoá bản chụp của phiên không còn tồn tại, giữ nguyên phiên còn sống', async () => {
    const fs = new MemoryFileSystem({
      files: {
        [sessionFile('repo-a', 'con-song')]: '{}',
        [join(sessionHistoryDir(layout, 'con-song'), 't1.json')]: '{}',
        [join(sessionHistoryDir(layout, 'da-xoa'), 't1.json')]: '{}',
      },
    });
    const cleanup = new HomeCleanup({ fs, layout, logger: logger() });

    const report = await cleanup.run();

    expect(report.orphanHistories).toBe(1);
    expect(await fs.exists(join(sessionHistoryDir(layout, 'con-song'), 't1.json'))).toBe(true);
    expect(await fs.exists(join(sessionHistoryDir(layout, 'da-xoa'), 't1.json'))).toBe(false);
  });

  // Không có phiên nào trên đĩa có thể là "chưa migrate", không phải "mọi phiên
  // đã bị xoá". Hiểu nhầm chỗ này là xoá sạch khả năng undo của người dùng.
  it('không có phiên nào thì ĐỨNG YÊN, không xoá sạch file-history', async () => {
    const fs = new MemoryFileSystem({
      files: { [join(sessionHistoryDir(layout, 's1'), 't1.json')]: '{}' },
    });
    const cleanup = new HomeCleanup({ fs, layout, logger: logger() });

    const report = await cleanup.run();

    expect(report.orphanHistories).toBe(0);
    expect(await fs.exists(join(sessionHistoryDir(layout, 's1'), 't1.json'))).toBe(true);
  });

  it('xoá bản chụp quá cũ của phiên vẫn còn sống', async () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const old = join(sessionHistoryDir(layout, 's1'), 'cu.json');
    const fresh = join(sessionHistoryDir(layout, 's1'), 'moi.json');
    const inner = new MemoryFileSystem({
      files: { [sessionFile('repo-a', 's1')]: '{}', [old]: '{}', [fresh]: '{}' },
    });
    const fs = new AgedFs(inner, { [old]: 1, [fresh]: now - 1000 });
    const cleanup = new HomeCleanup({ fs, layout, logger: logger(), now: () => now });

    const report = await cleanup.run();

    expect(report.staleCheckpoints).toBe(1);
    expect(await fs.exists(old)).toBe(false);
    expect(await fs.exists(fresh)).toBe(true);
  });

  it('dọn cache cũ', async () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const stale = join(layout.cache, 'models.json');
    const inner = new MemoryFileSystem({ files: { [stale]: '{}' } });
    const fs = new AgedFs(inner, { [stale]: 1 });
    const cleanup = new HomeCleanup({ fs, layout, logger: logger(), now: () => now });

    expect((await cleanup.run()).cacheFiles).toBe(1);
    expect(await fs.exists(stale)).toBe(false);
  });

  it('KHÔNG bao giờ đụng vào settings, credentials hay state', async () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    const inner = new MemoryFileSystem({
      files: {
        [layout.settings]: '{}',
        [layout.credentials]: '{}',
        [layout.state]: '{}',
        [sessionFile('repo-a', 's1')]: '{}',
      },
    });
    const fs = new AgedFs(inner, { [layout.settings]: 1, [layout.credentials]: 1, [layout.state]: 1 });
    const cleanup = new HomeCleanup({ fs, layout, logger: logger(), now: () => now });

    await cleanup.run();

    expect(await fs.exists(layout.settings)).toBe(true);
    expect(await fs.exists(layout.credentials)).toBe(true);
    expect(await fs.exists(layout.state)).toBe(true);
    expect(await fs.exists(sessionFile('repo-a', 's1'))).toBe(true);
  });
});
