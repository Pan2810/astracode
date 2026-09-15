/**
 * Cổng duy nhất ra filesystem — nguyên tắc bảo mật #7.
 *
 * Vì sao một cửa: path guard phải nằm ở đúng MỘT chỗ. Nếu mỗi tool tự gọi
 * node:fs rồi tự kiểm tra đường dẫn thì chỉ cần một tool quên là thủng, và
 * "quên" là chuyện chắc chắn xảy ra khi thêm tool thứ mười.
 *
 * Eslint chặn `node:fs` ở mọi nơi trong core trừ thư mục này
 * (xem eslint.config.js).
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

export interface FileStat {
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtimeMs: number;
}

export interface DirEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
}

/**
 * M2 chỉ có thao tác đọc. M4 thêm ghi/xoá — sau khi đã có permission layer,
 * đúng thứ tự: API ghi ra đời khi đã có thứ kiểm soát nó.
 *
 * Ghi nằm ở CÙNG interface chứ không tách `WritableFileSystem` riêng, vì tách
 * ra sẽ tạo hai cổng ra filesystem và phá nguyên tắc "một cửa". Thứ quyết định
 * được ghi hay không là PermissionManager, không phải kiểu dữ liệu.
 */
export interface FileSystem {
  /** Đường dẫn thật sau khi đi hết symlink/junction. Ném nếu không tồn tại. */
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FileStat>;
  readFile(path: string): Promise<string>;
  readDir(path: string): Promise<DirEntry[]>;
  exists(path: string): Promise<boolean>;

  /** Ghi đè hoặc tạo mới. Tự tạo thư mục cha còn thiếu. */
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
}

function toEntryType(d: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): DirEntry['type'] {
  if (d.isSymbolicLink()) return 'symlink';
  if (d.isDirectory()) return 'directory';
  if (d.isFile()) return 'file';
  return 'other';
}

/** Bản chạy thật trên đĩa. Test dùng MemoryFileSystem thay cho cái này. */
export class NodeFileSystem implements FileSystem {
  async realpath(path: string): Promise<string> {
    return nodeFs.promises.realpath(path);
  }

  async stat(path: string): Promise<FileStat> {
    // lstat, không stat: cần biết bản thân đường dẫn CÓ PHẢI symlink không,
    // chứ không phải nó trỏ tới cái gì. Việc đi theo link là của realpath và
    // phải qua pathGuard trước.
    const s = await nodeFs.promises.lstat(path);
    return {
      type: toEntryType(s),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  }

  async readFile(path: string): Promise<string> {
    return nodeFs.promises.readFile(path, 'utf8');
  }

  async readDir(path: string): Promise<DirEntry[]> {
    const entries = await nodeFs.promises.readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, type: toEntryType(e) }));
  }

  async exists(path: string): Promise<boolean> {
    try {
      await nodeFs.promises.lstat(path);
      return true;
    } catch {
      return false;
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.mkdirp(nodePath.dirname(path));
    await nodeFs.promises.writeFile(path, content, 'utf8');
  }

  async deleteFile(path: string): Promise<void> {
    await nodeFs.promises.rm(path, { force: true });
  }

  async mkdirp(path: string): Promise<void> {
    await nodeFs.promises.mkdir(path, { recursive: true });
  }
}

// ─── Bản trong bộ nhớ, cho test ────────────────────────────────────────────

export interface MemoryFsOptions {
  /** Ánh xạ đường dẫn -> nội dung. Thư mục được suy ra từ đường dẫn file. */
  files: Record<string, string>;
  /** Ánh xạ đường dẫn link -> đích. Dùng để test path guard với junction. */
  symlinks?: Record<string, string>;
  /** Windows không phân biệt hoa thường; bật để mô phỏng đúng. */
  caseInsensitive?: boolean;
}

/**
 * FileSystem giả cho test. Cố ý mô phỏng được symlink và case-insensitive vì
 * đó chính là hai thứ làm path guard trên Windows khó (documents/SECURITY.md §5).
 */
export class MemoryFileSystem implements FileSystem {
  /**
   * Khoá tra cứu viết thường (khi mô phỏng Windows) nhưng GIỮ nguyên dạng gốc
   * để trả về. Đây đúng là cách Windows hoạt động: so sánh không phân biệt hoa
   * thường, hiển thị theo đúng tên đã đặt. Nếu fake này viết thường cả tên trả
   * về thì test sẽ thấy `readme.md` và ta sẽ đi sửa nhầm chỗ.
   */
  private readonly files = new Map<string, { original: string; content: string }>();
  private readonly dirs = new Map<string, string>();
  private readonly links = new Map<string, string>();
  private readonly caseInsensitive: boolean;

  constructor(opts: MemoryFsOptions) {
    this.caseInsensitive = opts.caseInsensitive ?? nodePath.sep === '\\';

    for (const [p, content] of Object.entries(opts.files)) {
      const original = nodePath.resolve(p);
      this.files.set(this.key(original), { original, content });

      let dir = nodePath.dirname(original);
      while (dir && dir !== nodePath.dirname(dir)) {
        this.dirs.set(this.key(dir), dir);
        dir = nodePath.dirname(dir);
      }
      this.dirs.set(this.key(dir), dir);
    }
    for (const [link, target] of Object.entries(opts.symlinks ?? {})) {
      this.links.set(this.key(link), nodePath.resolve(target));
    }
  }

  /** Khoá tra cứu — chỉ dùng để so sánh, không bao giờ trả ra ngoài. */
  private key(p: string): string {
    const resolved = nodePath.resolve(p);
    return this.caseInsensitive ? resolved.toLowerCase() : resolved;
  }

  private norm(p: string): string {
    return this.key(p);
  }

  /** Đi theo link ở mọi thành phần của đường dẫn, giống realpath thật. */
  async realpath(path: string): Promise<string> {
    let current = nodePath.resolve(path);

    for (let hops = 0; hops < 40; hops++) {
      const direct = this.links.get(this.key(current));
      if (direct !== undefined) {
        current = direct;
        continue;
      }

      // Link nằm ở thành phần cha: /a/link/b -> giải /a/link rồi ghép lại 'b'.
      const parts = current.split(nodePath.sep);
      let replaced = false;
      for (let i = parts.length - 1; i > 0; i--) {
        const prefix = parts.slice(0, i).join(nodePath.sep);
        const target = this.links.get(this.key(prefix));
        if (target !== undefined) {
          current = nodePath.join(target, ...parts.slice(i));
          replaced = true;
          break;
        }
      }
      if (!replaced) break;
    }

    const k = this.key(current);
    const entry = this.files.get(k)?.original ?? this.dirs.get(k);
    if (entry === undefined) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    }
    return entry;
  }

  async stat(path: string): Promise<FileStat> {
    const k = this.norm(path);
    if (this.links.has(k)) return { type: 'symlink', size: 0, mtimeMs: 0 };
    const file = this.files.get(k);
    if (file !== undefined) {
      return { type: 'file', size: Buffer.byteLength(file.content, 'utf8'), mtimeMs: 0 };
    }
    if (this.dirs.has(k)) return { type: 'directory', size: 0, mtimeMs: 0 };
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  }

  async readFile(path: string): Promise<string> {
    const real = await this.realpath(path);
    const file = this.files.get(this.key(real));
    if (file === undefined) {
      throw Object.assign(new Error(`EISDIR hoặc ENOENT: ${path}`), { code: 'ENOENT' });
    }
    return file.content;
  }

  async readDir(path: string): Promise<DirEntry[]> {
    const real = await this.realpath(path);
    const prefixKey = this.key(real).replace(/[\\/]+$/, '') + nodePath.sep;
    const names = new Map<string, DirEntry>();

    const addFrom = (originalPath: string, leafType: DirEntry['type']): void => {
      const k = this.key(originalPath);
      if (!k.startsWith(prefixKey)) return;
      const restKey = k.slice(prefixKey.length);
      if (!restKey) return;
      const depth = restKey.split(nodePath.sep).length;
      // Tên hiển thị lấy từ đường dẫn GỐC, không phải từ khoá viết thường.
      const head = originalPath.slice(originalPath.length - restKey.length).split(nodePath.sep)[0]!;
      names.set(this.key(head), { name: head, type: depth === 1 ? leafType : 'directory' });
    };

    for (const { original } of this.files.values()) addFrom(original, 'file');
    for (const original of this.dirs.values()) addFrom(original, 'directory');
    for (const [k, target] of this.links) {
      if (!k.startsWith(prefixKey) || k.slice(prefixKey.length).includes(nodePath.sep)) continue;
      void target;
      const head = k.slice(prefixKey.length);
      names.set(head, { name: head, type: 'symlink' });
    }

    return [...names.values()];
  }

  async exists(path: string): Promise<boolean> {
    const k = this.norm(path);
    return this.files.has(k) || this.dirs.has(k) || this.links.has(k);
  }

  async writeFile(path: string, content: string): Promise<void> {
    // Đi theo link nếu đường dẫn là link — giống ghi thật trên đĩa. Việc chặn
    // link trỏ ra ngoài workspace là của PathGuard, đã chạy trước khi tới đây.
    const original = this.links.get(this.key(path)) ?? nodePath.resolve(path);
    this.files.set(this.key(original), { original, content });
    await this.mkdirp(nodePath.dirname(original));
  }

  async deleteFile(path: string): Promise<void> {
    this.files.delete(this.norm(path));
  }

  async mkdirp(path: string): Promise<void> {
    let dir = nodePath.resolve(path);
    while (dir && dir !== nodePath.dirname(dir)) {
      this.dirs.set(this.key(dir), dir);
      dir = nodePath.dirname(dir);
    }
    this.dirs.set(this.key(dir), dir);
  }
}
