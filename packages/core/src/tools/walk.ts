/**
 * Duyệt cây thư mục dùng chung cho glob và grep.
 *
 * Đi qua FileSystem port chứ không phải node:fs, nên test chạy được trên
 * MemoryFileSystem và mọi đường dẫn vẫn qua pathGuard.
 *
 * Bỏ qua sẵn các thư mục nặng mà không mang thông tin (node_modules, .git...):
 * không phải để bảo mật mà vì duyệt chúng làm agent chậm và tốn token vô ích.
 */
import * as nodePath from 'node:path';
import type { ToolContext } from './Tool.js';

export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.turbo',
  '.cache',
  'target',
  'vendor',
]);

export interface WalkOptions {
  /** Thư mục gốc, đường dẫn tuyệt đối đã qua pathGuard. */
  root: string;
  /** Trần số file duyệt — chặn treo trên repo khổng lồ. */
  maxFiles?: number;
  maxDepth?: number;
  /** Bỏ qua file bị denylist chặn. Mặc định bật. */
  applyDenylist?: boolean;
}

export interface WalkedFile {
  absolute: string;
  /** Tương đối so với workspace root, luôn dùng `/`. */
  relative: string;
}

/**
 * Trả về danh sách file, đã lọc denylist. Symlink KHÔNG được đi theo —
 * đó là đường thoát khỏi workspace, và pathGuard đã chặn nó ở tầng dưới;
 * ở đây bỏ qua luôn để không tốn một vòng kiểm tra thất bại.
 */
export async function walkFiles(
  ctx: ToolContext,
  opts: WalkOptions,
): Promise<{ files: WalkedFile[]; truncated: boolean }> {
  const maxFiles = opts.maxFiles ?? 20_000;
  const maxDepth = opts.maxDepth ?? 24;
  const applyDenylist = opts.applyDenylist ?? true;

  const files: WalkedFile[] = [];
  let truncated = false;

  const queue: Array<{ dir: string; depth: number }> = [{ dir: opts.root, depth: 0 }];

  while (queue.length > 0) {
    if (ctx.signal?.aborted) break;

    const { dir, depth } = queue.shift()!;
    if (depth > maxDepth) continue;

    let entries;
    try {
      entries = await ctx.fs.readDir(dir);
    } catch {
      continue; // Không đọc được thư mục thì bỏ qua, không làm hỏng cả lượt duyệt.
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return { files, truncated };
      }

      if (entry.type === 'symlink') continue;

      const absolute = nodePath.join(dir, entry.name);

      if (entry.type === 'directory') {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push({ dir: absolute, depth: depth + 1 });
        continue;
      }

      if (entry.type !== 'file') continue;

      const relative = await ctx.pathGuard.toRelative(absolute);
      if (applyDenylist && ctx.denylist.isDenied(relative)) continue;

      files.push({ absolute, relative });
    }
  }

  return { files, truncated };
}
