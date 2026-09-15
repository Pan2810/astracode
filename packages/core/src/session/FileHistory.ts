/**
 * `~/.astra/file-history/<sessionId>/<turnId>.json` — checkpoint xuống đĩa.
 *
 * Vì sao cần: `CheckpointStore` sống trong RAM, nên `/undo` chết theo cửa sổ
 * VS Code. Mở lại một phiên cũ là mất hẳn khả năng hoàn tác — README từng phải
 * nói thẳng điều đó với người dùng ("phiên mở lại bắt đầu với lịch sử undo
 * trống"). Ghi bản chụp xuống đĩa biến câu xin lỗi đó thành một tính năng.
 *
 * Một file MỘT LƯỢT, không phải một file cả phiên. Ba lý do, cái cuối quan trọng
 * nhất:
 *
 *   1. Ghi sau mỗi lượt chỉ tốn đúng phần vừa thêm.
 *   2. `/undo` xoá lượt nào thì xoá đúng file đó.
 *   3. Một file hỏng chỉ mất một lượt. Cả phiên trong một file thì lần ghi dở
 *      dang ở lượt 12 làm mất luôn bản chụp của lượt 1.
 *
 * Nội dung file là nguyên văn file nguồn TRƯỚC khi agent sửa — cùng loại dữ
 * liệu nhạy cảm như phiên chat, nên nó nằm ở HOME chứ không trong repo.
 */
import { join } from 'node:path';
import type { FileSystem } from '../fs/FileSystem.js';
import type { Logger } from '../telemetry/logger.js';
import { safeName, sessionHistoryDir, type AstraLayout } from '../home/layout.js';
import type { Checkpoint, CheckpointEntry } from './Checkpoint.js';

export const FILE_HISTORY_SCHEMA_VERSION = 1;

export interface FileHistoryOptions {
  fs: FileSystem;
  layout: AstraLayout;
  logger: Logger;
  /** Trần số lượt giữ trên đĩa cho mỗi phiên. Mặc định 20, khớp CheckpointStore. */
  maxTurns?: number;
  /** Trần ký tự cho một file được chụp. Mặc định 2 MB, khớp CheckpointStore. */
  maxFileChars?: number;
}

export class FileHistoryStore {
  private readonly maxTurns: number;
  private readonly maxFileChars: number;

  constructor(private readonly opts: FileHistoryOptions) {
    this.maxTurns = opts.maxTurns ?? 20;
    this.maxFileChars = opts.maxFileChars ?? 2_000_000;
  }

  /**
   * Ghi bản chụp của một lượt.
   *
   * Không ném: hỏng việc ghi checkpoint làm mất khả năng undo của lượt đó, chứ
   * không được phép làm hỏng lượt chat vừa hoàn thành.
   */
  async saveTurn(sessionId: string, checkpoint: Checkpoint): Promise<void> {
    if (!sessionId || checkpoint.entries.length === 0) return;

    const payload = {
      schemaVersion: FILE_HISTORY_SCHEMA_VERSION,
      turnId: checkpoint.turnId,
      createdAt: checkpoint.createdAt,
      entries: checkpoint.entries.filter(
        (e) => e.content === null || e.content.length <= this.maxFileChars,
      ),
    };

    try {
      await this.opts.fs.writeFile(this.turnPath(sessionId, checkpoint.turnId), JSON.stringify(payload));
      await this.pruneSession(sessionId);
    } catch (err) {
      this.opts.logger.warn('could not save the undo checkpoint for this turn', {
        session: sessionId,
        turn: checkpoint.turnId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Bản chụp của một phiên, cũ nhất trước — đúng thứ tự `CheckpointStore` giữ. */
  async load(sessionId: string): Promise<Checkpoint[]> {
    const dir = sessionHistoryDir(this.opts.layout, sessionId);
    let names: string[];
    try {
      const entries = await this.opts.fs.readDir(dir);
      names = entries.filter((e) => e.type === 'file' && e.name.endsWith('.json')).map((e) => e.name);
    } catch {
      return [];
    }

    const out: Checkpoint[] = [];
    for (const name of names) {
      try {
        const parsed = parseCheckpoint(await this.opts.fs.readFile(join(dir, name)));
        if (parsed) out.push(parsed);
      } catch {
        /* một file hỏng chỉ mất một lượt — đúng lý do tách file theo lượt */
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Xoá bản chụp của những lượt vừa bị `/undo` tiêu thụ. */
  async removeTurns(sessionId: string, turnIds: string[]): Promise<void> {
    for (const turnId of turnIds) {
      try {
        await this.opts.fs.deleteFile(this.turnPath(sessionId, turnId));
      } catch {
        /* lần dọn sau sẽ gặp lại */
      }
    }
  }

  /** Xoá toàn bộ lịch sử của một phiên (phiên bị xoá, hoặc `/clear`). */
  async removeSession(sessionId: string): Promise<void> {
    const dir = sessionHistoryDir(this.opts.layout, sessionId);
    try {
      const entries = await this.opts.fs.readDir(dir);
      for (const e of entries) await this.opts.fs.deleteFile(join(dir, e.name));
    } catch {
      /* chưa từng có gì để xoá */
    }
  }

  /** Id phiên đang có bản chụp trên đĩa — cho bước dọn dẹp. */
  async sessions(): Promise<string[]> {
    try {
      const entries = await this.opts.fs.readDir(this.opts.layout.fileHistory);
      return entries.filter((e) => e.type === 'directory').map((e) => e.name);
    } catch {
      return [];
    }
  }

  private async pruneSession(sessionId: string): Promise<void> {
    const all = await this.load(sessionId);
    const excess = all.slice(0, Math.max(0, all.length - this.maxTurns));
    await this.removeTurns(
      sessionId,
      excess.map((c) => c.turnId),
    );
  }

  private turnPath(sessionId: string, turnId: string): string {
    return join(sessionHistoryDir(this.opts.layout, sessionId), `${safeName(turnId)}.json`);
  }
}

export function parseCheckpoint(raw: string): Checkpoint | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;

  const version = typeof d.schemaVersion === 'number' ? d.schemaVersion : 0;
  if (version > FILE_HISTORY_SCHEMA_VERSION) return undefined;
  if (typeof d.turnId !== 'string' || !d.turnId) return undefined;

  return {
    turnId: d.turnId,
    createdAt: typeof d.createdAt === 'number' ? d.createdAt : 0,
    entries: parseEntries(d.entries),
  };
}

function parseEntries(raw: unknown): CheckpointEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CheckpointEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    if (typeof e.uri !== 'string' || !e.uri) continue;
    // `content: null` là thông tin THẬT (file lúc đó chưa tồn tại), không phải
    // thiếu dữ liệu — undo của nó là xoá file đi. Đừng lọc nhầm.
    if (typeof e.content !== 'string' && e.content !== null) continue;
    out.push({
      uri: e.uri,
      relativePath: typeof e.relativePath === 'string' ? e.relativePath : e.uri,
      content: e.content,
    });
  }
  return out;
}
