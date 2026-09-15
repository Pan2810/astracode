/**
 * Lưu và mở lại phiên chat — mốc M6.
 *
 * Phiên KHÔNG lưu trong repo. Nó chứa nguyên văn hội thoại, trích đoạn file,
 * đôi khi cả output lệnh — commit nhầm một file như vậy là rò rỉ, và `.gitignore`
 * là một lớp bảo vệ mà người dùng có thể sửa hoặc quên. Nơi
 * lưu do tầng trên quyết định qua `SessionStorage`; trong VS Code là
 * `globalStorageUri`.
 *
 * Store này cố tình không biết gì về đĩa. Đổi nơi lưu là đổi một implementation,
 * không phải sửa logic phiên.
 */
import type { Logger } from '../telemetry/logger.js';
import {
  SESSION_SCHEMA_VERSION,
  newSessionId,
  parseSession,
  titleFrom,
  type PersistedSession,
  type PersistedTurn,
} from './types.js';

/** Cổng lưu trữ. Khoá là tên file phẳng, không có thư mục con. */
export interface SessionStorage {
  read(key: string): Promise<string | undefined>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface SessionSummary {
  id: string;
  title: string;
  workspaceRoot: string;
  updatedAt: number;
  turns: number;
  totalTokens: number;
}

export interface SessionStoreOptions {
  storage: SessionStorage;
  logger: Logger;
  /** Giữ tối đa bấy nhiêu phiên, cũ nhất bị dọn. Mặc định 50. */
  maxSessions?: number;
}

const PREFIX = 'session-';
const SUFFIX = '.json';

export class SessionStore {
  private readonly maxSessions: number;

  constructor(private readonly opts: SessionStoreOptions) {
    this.maxSessions = opts.maxSessions ?? 50;
  }

  create(workspaceRoot: string, model?: string): PersistedSession {
    const now = Date.now();
    return {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id: newSessionId(now),
      title: 'New session',
      workspaceRoot,
      createdAt: now,
      updatedAt: now,
      ...(model ? { model } : {}),
      messages: [],
      turns: [],
      totalTokens: 0,
      compactions: 0,
    };
  }

  async save(session: PersistedSession): Promise<void> {
    session.updatedAt = Date.now();
    try {
      await this.opts.storage.write(key(session.id), JSON.stringify(session));
    } catch (err) {
      // Không lưu được là chuyện khó chịu, không phải chuyện chết người: hội
      // thoại vẫn còn trong bộ nhớ. Ném lên đây sẽ giết cả lượt chat vừa xong.
      this.opts.logger.warn('không lưu được phiên', {
        id: session.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async load(id: string): Promise<PersistedSession | undefined> {
    const raw = await this.readSafe(key(id));
    if (raw === undefined) return undefined;

    const parsed = parseSession(raw);
    if (!parsed) {
      this.opts.logger.warn('bỏ qua phiên không đọc được', { id });
      return undefined;
    }
    return parsed;
  }

  /** Danh sách phiên, mới nhất trước. Lọc theo workspace nếu truyền vào. */
  async list(workspaceRoot?: string): Promise<SessionSummary[]> {
    let keys: string[];
    try {
      keys = await this.opts.storage.keys();
    } catch {
      return [];
    }

    const out: SessionSummary[] = [];
    for (const k of keys) {
      if (!k.startsWith(PREFIX) || !k.endsWith(SUFFIX)) continue;

      const raw = await this.readSafe(k);
      if (raw === undefined) continue;

      const s = parseSession(raw);
      if (!s) continue;
      if (workspaceRoot && !sameRoot(s.workspaceRoot, workspaceRoot)) continue;

      out.push({
        id: s.id,
        title: s.title,
        workspaceRoot: s.workspaceRoot,
        updatedAt: s.updatedAt,
        turns: s.turns.length,
        totalTokens: s.totalTokens,
      });
    }

    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async remove(id: string): Promise<void> {
    try {
      await this.opts.storage.remove(key(id));
    } catch {
      /* phiên không xoá được thì lần dọn sau sẽ gặp lại — không đáng báo */
    }
  }

  /** Dọn phiên cũ. Gọi sau khi lưu, không chặn luồng chat. */
  async prune(): Promise<number> {
    const all = await this.list();
    const excess = all.slice(this.maxSessions);
    for (const s of excess) await this.remove(s.id);
    if (excess.length > 0) {
      this.opts.logger.debug('đã dọn phiên cũ', { removed: excess.length });
    }
    return excess.length;
  }

  private async readSafe(k: string): Promise<string | undefined> {
    try {
      return await this.opts.storage.read(k);
    } catch {
      return undefined;
    }
  }
}

function key(id: string): string {
  // Id do chính store sinh, nhưng nó cũng đến từ file trên đĩa khi mở lại. Lọc
  // để không có đường nào từ một id bịa ra ghi được ra ngoài thư mục lưu trữ.
  return `${PREFIX}${id.replace(/[^a-zA-Z0-9_-]/g, '')}${SUFFIX}`;
}

function sameRoot(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
}

/** Bản trong bộ nhớ, cho test và cho eval harness. */
export class MemorySessionStorage implements SessionStorage {
  private readonly data = new Map<string, string>();

  async read(k: string): Promise<string | undefined> {
    return this.data.get(k);
  }

  async write(k: string, value: string): Promise<void> {
    this.data.set(k, value);
  }

  async remove(k: string): Promise<void> {
    this.data.delete(k);
  }

  async keys(): Promise<string[]> {
    return [...this.data.keys()];
  }
}

/** Gộp thống kê một lượt vào phiên. */
export function appendTurn(session: PersistedSession, turn: PersistedTurn): void {
  session.turns.push(turn);
  session.totalTokens += turn.totalTokens;
  if (session.turns.length === 1 && turn.prompt) session.title = titleFrom(turn.prompt);
}
