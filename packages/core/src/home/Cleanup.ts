/**
 * Dọn `~/.astra` — phần "mất được" của thư mục nhà.
 *
 * Thư mục này chỉ lớn lên: mỗi phiên để lại một file, mỗi lượt có sửa file để
 * lại một bản chụp. Không có ai dọn thì sau một năm nó là vài trăm MB gồm bản
 * chụp của những phiên đã bị xoá từ lâu — đúng loại rác không ai nhìn thấy để
 * mà xoá.
 *
 * `.last-cleanup` giữ mốc lần chạy gần nhất. Nhờ nó việc dọn gắn vào lúc khởi
 * động mà không tốn gì: một ngày một lần, và lần nào cũng chỉ đọc một file để
 * biết là chưa tới lúc.
 *
 * Chỉ đụng vào thứ mất được. KHÔNG bao giờ đụng `settings.json`,
 * `credentials.json`, `state.json`, hay phiên còn trong danh sách.
 */
import { join } from 'node:path';
import type { FileSystem } from '../fs/FileSystem.js';
import type { Logger } from '../telemetry/logger.js';
import type { AstraLayout } from './layout.js';

export interface CleanupOptions {
  fs: FileSystem;
  layout: AstraLayout;
  logger: Logger;
  /** Bao lâu dọn một lần. Mặc định 24 giờ. */
  intervalMs?: number;
  /** Bản chụp và cache cũ hơn mức này thì xoá. Mặc định 30 ngày. */
  maxAgeMs?: number;
  now?: () => number;
}

export interface CleanupReport {
  /** Thư mục file-history bị xoá vì phiên không còn. */
  orphanHistories: number;
  /** Bản chụp bị xoá vì quá cũ. */
  staleCheckpoints: number;
  /** File cache bị xoá. */
  cacheFiles: number;
}

const DAY = 24 * 60 * 60 * 1000;

export class HomeCleanup {
  private readonly intervalMs: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: CleanupOptions) {
    this.intervalMs = opts.intervalMs ?? DAY;
    this.maxAgeMs = opts.maxAgeMs ?? 30 * DAY;
    this.now = opts.now ?? Date.now;
  }

  /** Chạy nếu đã quá hạn. Trả `undefined` khi chưa tới lúc. */
  async runIfDue(): Promise<CleanupReport | undefined> {
    if (!(await this.due())) return undefined;
    return this.run();
  }

  async due(): Promise<boolean> {
    try {
      const raw = (await this.opts.fs.readFile(this.opts.layout.lastCleanup)).trim();
      const last = Date.parse(raw);
      if (!Number.isFinite(last)) return true;
      return this.now() - last >= this.intervalMs;
    } catch {
      return true; // Chưa từng dọn.
    }
  }

  async run(): Promise<CleanupReport> {
    const report: CleanupReport = { orphanHistories: 0, staleCheckpoints: 0, cacheFiles: 0 };

    try {
      const live = await this.liveSessionIds();
      report.orphanHistories = await this.pruneFileHistory(live);
      report.staleCheckpoints = await this.pruneStaleCheckpoints();
      report.cacheFiles = await this.pruneCache();
    } catch (err) {
      this.opts.logger.debug('home cleanup stopped early', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await this.opts.fs.writeFile(
        this.opts.layout.lastCleanup,
        `${new Date(this.now()).toISOString()}\n`,
      );
    } catch {
      /* không ghi được mốc thì lần sau dọn lại — vô hại */
    }

    if (report.orphanHistories + report.staleCheckpoints + report.cacheFiles > 0) {
      this.opts.logger.debug('cleaned up the AstraCode home directory', { ...report });
    }
    return report;
  }

  /**
   * Id của mọi phiên còn trên đĩa, quét qua `projects/*`.
   *
   * Tên file phiên là `session-<id>.json` (xem `SessionStore`). Không suy ra
   * được id thì bỏ qua — thà giữ lại một bản chụp thừa còn hơn xoá nhầm bản
   * chụp của một phiên vẫn dùng được.
   */
  private async liveSessionIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    let projects: string[];
    try {
      const entries = await this.opts.fs.readDir(this.opts.layout.projects);
      projects = entries.filter((e) => e.type === 'directory').map((e) => e.name);
    } catch {
      return ids;
    }

    for (const project of projects) {
      try {
        const files = await this.opts.fs.readDir(join(this.opts.layout.projects, project));
        for (const f of files) {
          const m = /^session-(.+)\.json$/.exec(f.name);
          if (m?.[1]) ids.add(m[1]);
        }
      } catch {
        /* thư mục vừa bị xoá giữa chừng — bỏ qua */
      }
    }
    return ids;
  }

  private async pruneFileHistory(live: Set<string>): Promise<number> {
    let removed = 0;
    let dirs: string[];
    try {
      const entries = await this.opts.fs.readDir(this.opts.layout.fileHistory);
      dirs = entries.filter((e) => e.type === 'directory').map((e) => e.name);
    } catch {
      return 0;
    }

    // Không có phiên nào trên đĩa = chưa migrate hoặc thư mục vừa bị xoá tay.
    // Xoá sạch file-history lúc đó là hiểu sai tình huống, nên đứng yên.
    if (live.size === 0) return 0;

    for (const dir of dirs) {
      if (live.has(dir)) continue;
      await this.removeDir(join(this.opts.layout.fileHistory, dir));
      removed++;
    }
    return removed;
  }

  private async pruneStaleCheckpoints(): Promise<number> {
    const cutoff = this.now() - this.maxAgeMs;
    let removed = 0;
    let dirs: string[];
    try {
      const entries = await this.opts.fs.readDir(this.opts.layout.fileHistory);
      dirs = entries.filter((e) => e.type === 'directory').map((e) => e.name);
    } catch {
      return 0;
    }

    for (const dir of dirs) {
      const full = join(this.opts.layout.fileHistory, dir);
      let files: string[];
      try {
        files = (await this.opts.fs.readDir(full)).filter((e) => e.type === 'file').map((e) => e.name);
      } catch {
        continue;
      }
      for (const name of files) {
        const path = join(full, name);
        try {
          const stat = await this.opts.fs.stat(path);
          if (stat.mtimeMs > 0 && stat.mtimeMs < cutoff) {
            await this.opts.fs.deleteFile(path);
            removed++;
          }
        } catch {
          /* bỏ qua file không stat được */
        }
      }
    }
    return removed;
  }

  private async pruneCache(): Promise<number> {
    const cutoff = this.now() - this.maxAgeMs;
    let removed = 0;
    try {
      const entries = await this.opts.fs.readDir(this.opts.layout.cache);
      for (const e of entries) {
        if (e.type !== 'file') continue;
        const path = join(this.opts.layout.cache, e.name);
        const stat = await this.opts.fs.stat(path);
        if (stat.mtimeMs > 0 && stat.mtimeMs < cutoff) {
          await this.opts.fs.deleteFile(path);
          removed++;
        }
      }
    } catch {
      /* chưa có cache */
    }
    return removed;
  }

  /** Xoá hết file trong một thư mục. Trả số file đã xoá. */
  private async removeDir(dir: string): Promise<number> {
    let removed = 0;
    try {
      for (const e of await this.opts.fs.readDir(dir)) {
        if (e.type !== 'file') continue;
        await this.opts.fs.deleteFile(join(dir, e.name));
        removed++;
      }
    } catch {
      /* thư mục không đọc được — để lần sau */
    }
    return removed;
  }
}
