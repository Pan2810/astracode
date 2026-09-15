/**
 * `~/.astra/state.json` — thứ MÁY ghi, không phải thứ người viết.
 *
 * Ranh giới với `settings.json` là ranh giới quan trọng nhất của thư mục này:
 * settings mở ra là hiểu ngay và chép sang máy khác được; state là sổ ghi chép
 * nội bộ (đã khởi động bao nhiêu lần, repo nào đụng lần cuối lúc nào, model nào
 * đã tự chứng minh là không gọi được tool native). Trộn hai thứ vào một file thì
 * người dùng không dám sửa file cấu hình của chính mình nữa.
 *
 * ## Vì sao có backups/
 *
 * File này bị ghi lại sau gần như mọi lượt. Một lần ghi dở dang (mất điện, đóng
 * máy giữa chừng) làm JSON hỏng, và khi đó `load()` trả về bản mặc định — tức là
 * mất sạch. Bản sao xoay vòng biến "mất sạch" thành "lùi lại vài phút".
 *
 * ## Cái CỐ TÌNH không nằm ở đây
 *
 * Quyền đã cấp ("luôn cho phép"). `~/.claude.json` có `allowedTools` theo dự án,
 * nhưng ở AstraCode quyền chết theo phiên là một quyết định có chủ ý
 * (PermissionManager, documents/SECURITY.md §1.5) — ghi nó xuống đĩa là nới một ranh
 * giới bảo mật, và việc đó phải là một thay đổi được bàn riêng chứ không phải
 * hệ quả phụ của việc dọn thư mục.
 */
import { join } from 'node:path';
import type { FileSystem } from '../fs/FileSystem.js';
import type { Logger } from '../telemetry/logger.js';
import { astraLayout, type AstraLayout } from './layout.js';

export const STATE_SCHEMA_VERSION = 1;

export interface AstraProjectState {
  /** Lần cuối mở agent trong thư mục này. Dùng để dọn mục cũ. */
  lastUsedAt: number;
  /** Số phiên đã tạo. Chỉ để hiện thống kê, không ai dựa vào để quyết định gì. */
  sessions: number;
  turns: number;
  /** Người dùng đã bấm tin cậy thư mục này lúc nào (mirror của workspace trust). */
  trustAcceptedAt?: number;
  /** Server MCP đang bật cho repo này — để CLI và extension khớp nhau. */
  enabledMcpServers?: string[];
}

export interface AstraState {
  schemaVersion: number;
  /** Định danh máy, sinh một lần. Không kèm thông tin gì về người dùng. */
  machineId: string;
  startups: number;
  /** Bản extension/CLI chạy lần cuối — để biết vừa nâng cấp mà báo đúng. */
  lastVersion?: string;
  /**
   * Model đã tự chứng minh là không nhận native tool-calling.
   *
   * Ở HOME chứ không trong globalState của VS Code: đây là tính chất của MODEL.
   * Đo bằng CLI thì extension khỏi tốn một request hỏng để học lại, và ngược lại.
   */
  nativeToolsUnsupported: string[];
  /** Khoá là đường dẫn tuyệt đối của workspace, giữ nguyên dạng người dùng thấy. */
  projects: Record<string, AstraProjectState>;
}

export interface StateStoreOptions {
  fs: FileSystem;
  layout: AstraLayout;
  logger: Logger;
  /** Số bản sao giữ lại. Mặc định 5. */
  maxBackups?: number;
  /** Số dự án nhớ tối đa, cũ nhất bị quên. Mặc định 100. */
  maxProjects?: number;
  /** Tiêm được để test có kết quả xác định. */
  now?: () => number;
}

export function emptyState(machineId: string): AstraState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    machineId,
    startups: 0,
    nativeToolsUnsupported: [],
    projects: {},
  };
}

export class StateStore {
  private readonly maxBackups: number;
  private readonly maxProjects: number;
  private readonly now: () => number;
  /** Nối đuôi các lần ghi: read-modify-write song song sẽ mất một bên. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: StateStoreOptions) {
    this.maxBackups = opts.maxBackups ?? 5;
    this.maxProjects = opts.maxProjects ?? 100;
    this.now = opts.now ?? Date.now;
  }

  /** Đọc state. File thiếu hoặc hỏng đều trả bản rỗng — không bao giờ ném. */
  async load(): Promise<AstraState> {
    try {
      const raw = await this.opts.fs.readFile(this.opts.layout.state);
      const parsed = parseState(raw);
      if (parsed) return parsed;
      this.opts.logger.warn('state.json unreadable, falling back to a backup');
      return (await this.loadBackup()) ?? emptyState(this.newMachineId());
    } catch {
      return emptyState(this.newMachineId());
    }
  }

  /**
   * Sửa state rồi ghi lại. Hàm `mutate` nhận bản vừa đọc và sửa tại chỗ.
   *
   * Ghi lỗi thì nuốt và log: state là sổ ghi chép, mất một dòng không đáng làm
   * hỏng lượt chat vừa xong.
   */
  async update(mutate: (state: AstraState) => void): Promise<AstraState> {
    const run = this.queue.then(async () => {
      const state = await this.load();
      mutate(state);
      state.schemaVersion = STATE_SCHEMA_VERSION;
      pruneProjects(state, this.maxProjects);
      await this.write(state);
      return state;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Ghi nhận một lần khởi động. Gọi một lần lúc activate. */
  async recordStartup(version?: string): Promise<AstraState> {
    return this.update((s) => {
      s.startups += 1;
      if (version) s.lastVersion = version;
    });
  }

  /** Ghi nhận có hoạt động trong một workspace. */
  async touchProject(
    workspaceRoot: string,
    patch: Partial<Omit<AstraProjectState, 'lastUsedAt'>> = {},
  ): Promise<void> {
    if (!workspaceRoot) return;
    await this.update((s) => {
      const current = s.projects[workspaceRoot] ?? { lastUsedAt: 0, sessions: 0, turns: 0 };
      s.projects[workspaceRoot] = {
        ...current,
        ...patch,
        sessions: current.sessions + (patch.sessions ?? 0),
        turns: current.turns + (patch.turns ?? 0),
        lastUsedAt: this.now(),
      };
    });
  }

  async project(workspaceRoot: string): Promise<AstraProjectState | undefined> {
    const s = await this.load();
    return s.projects[workspaceRoot];
  }

  /** Model không nhận native tool-calling — đọc/ghi dùng chung CLI ↔ extension. */
  async isNativeUnsupported(model: string): Promise<boolean> {
    return (await this.load()).nativeToolsUnsupported.includes(model);
  }

  async markNativeUnsupported(model: string): Promise<void> {
    await this.update((s) => {
      if (!s.nativeToolsUnsupported.includes(model)) s.nativeToolsUnsupported.push(model);
    });
  }

  private async write(state: AstraState): Promise<void> {
    try {
      await this.backup();
      await this.opts.fs.writeFile(this.opts.layout.state, `${JSON.stringify(state, null, 2)}\n`);
    } catch (err) {
      this.opts.logger.warn('could not write state.json', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Chép bản hiện tại sang backups/ rồi cắt bớt bản cũ. */
  private async backup(): Promise<void> {
    let current: string;
    try {
      current = await this.opts.fs.readFile(this.opts.layout.state);
    } catch {
      return; // Chưa có gì để sao lưu.
    }
    if (!current.trim()) return;

    const dir = this.opts.layout.backups;
    try {
      await this.opts.fs.writeFile(join(dir, `state.json.backup.${this.now()}`), current);
      const entries = await this.opts.fs.readDir(dir);
      const backups = entries
        .filter((e) => e.type === 'file' && e.name.startsWith('state.json.backup.'))
        .map((e) => e.name)
        .sort();
      for (const name of backups.slice(0, Math.max(0, backups.length - this.maxBackups))) {
        await this.opts.fs.deleteFile(join(dir, name));
      }
    } catch {
      /* Không sao lưu được thì vẫn ghi bản mới — mất backup nhẹ hơn mất state. */
    }
  }

  private async loadBackup(): Promise<AstraState | undefined> {
    try {
      const entries = await this.opts.fs.readDir(this.opts.layout.backups);
      const names = entries
        .filter((e) => e.type === 'file' && e.name.startsWith('state.json.backup.'))
        .map((e) => e.name)
        .sort()
        .reverse();
      for (const name of names) {
        const raw = await this.opts.fs.readFile(join(this.opts.layout.backups, name));
        const parsed = parseState(raw);
        if (parsed) return parsed;
      }
    } catch {
      /* không có backup nào dùng được */
    }
    return undefined;
  }

  private newMachineId(): string {
    return `m${this.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Tiện dụng: dựng store từ một thư mục nhà. */
export function stateStoreAt(opts: {
  fs: FileSystem;
  home: string;
  logger: Logger;
}): StateStore {
  return new StateStore({ fs: opts.fs, layout: astraLayout(opts.home), logger: opts.logger });
}

/**
 * Đọc state từ JSON thô.
 *
 * `schemaVersion` lớn hơn bản đang chạy ⇒ `undefined`: bản cũ đọc file của bản
 * mới sẽ hiểu nhầm rồi ghi đè, và ghi đè state của bản mới là cách làm hỏng cấu
 * hình của một người dùng đang cài song song hai bản.
 */
export function parseState(raw: string): AstraState | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;

  const version = typeof d.schemaVersion === 'number' ? d.schemaVersion : 0;
  if (version > STATE_SCHEMA_VERSION) return undefined;

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    machineId: typeof d.machineId === 'string' && d.machineId ? d.machineId : 'unknown',
    startups: num(d.startups) ?? 0,
    ...(typeof d.lastVersion === 'string' ? { lastVersion: d.lastVersion } : {}),
    nativeToolsUnsupported: strings(d.nativeToolsUnsupported),
    projects: parseProjects(d.projects),
  };
}

function parseProjects(raw: unknown): Record<string, AstraProjectState> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, AstraProjectState> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const v = value as Record<string, unknown>;
    out[key] = {
      lastUsedAt: num(v.lastUsedAt) ?? 0,
      sessions: num(v.sessions) ?? 0,
      turns: num(v.turns) ?? 0,
      ...(num(v.trustAcceptedAt) !== undefined ? { trustAcceptedAt: num(v.trustAcceptedAt)! } : {}),
      ...(Array.isArray(v.enabledMcpServers)
        ? { enabledMcpServers: strings(v.enabledMcpServers) }
        : {}),
    };
  }
  return out;
}

function pruneProjects(state: AstraState, max: number): void {
  const entries = Object.entries(state.projects);
  if (entries.length <= max) return;
  entries.sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt);
  state.projects = Object.fromEntries(entries.slice(0, max));
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
