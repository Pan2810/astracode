/**
 * Path guard — docs/SECURITY.md §5.
 *
 * Việc duy nhất: quyết định một đường dẫn có nằm trong workspace root không.
 * Nghe đơn giản, nhưng `path.resolve()` rồi `startsWith()` là SAI, và sai theo
 * bảy cách khác nhau trên Windows:
 *
 *   junction/symlink    mklink /J inner C:\Users  -> resolve() không đi theo link
 *   drive-relative      C:foo                     -> giải theo cwd của ổ đĩa
 *   UNC                 \\server\share\x          -> không prefix nào khớp
 *   device path         \\?\C:\Windows            -> bỏ qua chuẩn hoá Win32
 *   tên 8.3             PROGRA~1                  -> chuỗi khác, cùng đích
 *   prefix trùng        root C:\a, target C:\a-b  -> startsWith khớp nhầm
 *   hoa thường          c:\WORK vs C:\work        -> Windows không phân biệt
 *
 * Thứ tự đúng: chuẩn hoá cú pháp -> từ chối dạng nguy hiểm -> realpath ->
 * so sánh có biên. realpath phải đứng TRƯỚC so sánh, nếu không junction lọt.
 */
import * as nodePath from 'node:path';
import type { FileSystem } from '../fs/FileSystem.js';

export type PathRejectReason =
  | 'outside-root'
  | 'unc-path'
  | 'device-path'
  | 'drive-relative'
  | 'not-found'
  | 'empty';

export class PathGuardError extends Error {
  readonly reason: PathRejectReason;
  readonly requested: string;

  constructor(reason: PathRejectReason, requested: string, message: string) {
    super(message);
    this.name = 'PathGuardError';
    this.reason = reason;
    this.requested = requested;
  }
}

const WINDOWS = nodePath.sep === '\\';

/** `\\?\C:\...`, `\\.\PIPE\...` — bỏ qua lớp chuẩn hoá của Win32. */
function isDevicePath(p: string): boolean {
  return /^[\\/]{2}[?.][\\/]/.test(p);
}

/** `\\server\share\...` — không thuộc ổ đĩa nào, mọi so prefix đều vô nghĩa. */
function isUncPath(p: string): boolean {
  return /^[\\/]{2}[^\\/?.]/.test(p);
}

/** `C:foo` (không có separator) — giải theo thư mục hiện tại CỦA Ổ ĐĨA đó. */
function isDriveRelative(p: string): boolean {
  return /^[a-zA-Z]:(?![\\/])/.test(p);
}

/** Windows không phân biệt hoa thường; so sánh phải theo đó. */
function canon(p: string): string {
  return WINDOWS ? p.toLowerCase() : p;
}

/**
 * Điểm mấu chốt: so sánh có BIÊN. `root + sep` chứ không phải `root`, nếu
 * không thì root `C:\work\app` sẽ nuốt luôn `C:\work\app-secrets`.
 */
export function isWithin(root: string, target: string): boolean {
  const r = canon(nodePath.normalize(root).replace(/[\\/]+$/, ''));
  const t = canon(nodePath.normalize(target).replace(/[\\/]+$/, ''));
  if (t === r) return true;
  return t.startsWith(r + nodePath.sep);
}

export interface PathGuardOptions {
  workspaceRoot: string;
  fs: FileSystem;
}

export class PathGuard {
  private readonly fs: FileSystem;
  private rootReal: string | undefined;

  constructor(private readonly opts: PathGuardOptions) {
    this.fs = opts.fs;
  }

  /** Root đã đi hết symlink. Cache vì nó không đổi trong một phiên. */
  private async realRoot(): Promise<string> {
    if (this.rootReal === undefined) {
      try {
        this.rootReal = await this.fs.realpath(this.opts.workspaceRoot);
      } catch {
        // Root không tồn tại thì vẫn phải có gì đó để so — dùng dạng chuẩn hoá.
        this.rootReal = nodePath.resolve(this.opts.workspaceRoot);
      }
    }
    return this.rootReal;
  }

  /**
   * Kiểm tra cú pháp, không chạm đĩa. Tách riêng để chặn được các dạng nguy
   * hiểm TRƯỚC khi gọi realpath — realpath trên UNC có thể treo vì I/O mạng.
   */
  private assertShape(requested: string): void {
    if (!requested || !requested.trim()) {
      throw new PathGuardError('empty', requested, 'Đường dẫn rỗng.');
    }
    if (isDevicePath(requested)) {
      throw new PathGuardError(
        'device-path',
        requested,
        `Từ chối device path (${requested}): nó bỏ qua chuẩn hoá đường dẫn của Windows.`,
      );
    }
    if (isUncPath(requested)) {
      throw new PathGuardError(
        'unc-path',
        requested,
        `Từ chối đường dẫn UNC (${requested}): nằm ngoài mọi ổ đĩa cục bộ.`,
      );
    }
    if (isDriveRelative(requested)) {
      throw new PathGuardError(
        'drive-relative',
        requested,
        `Từ chối đường dẫn drive-relative (${requested}): thiếu separator nên nó ` +
          `giải theo thư mục hiện tại của ổ đĩa, không phải theo workspace.`,
      );
    }
  }

  /**
   * Giải một đường dẫn tương đối/tuyệt đối thành đường dẫn thật, đã xác minh
   * nằm trong workspace. Ném PathGuardError nếu không.
   *
   * Dùng cho đường dẫn PHẢI tồn tại (đọc file, liệt kê thư mục).
   */
  async resolveExisting(requested: string): Promise<string> {
    this.assertShape(requested);

    const root = await this.realRoot();
    const joined = nodePath.isAbsolute(requested)
      ? nodePath.normalize(requested)
      : nodePath.resolve(root, requested);

    // Chặn sớm theo cú pháp để không realpath một đường dẫn rõ ràng ở ngoài.
    if (!isWithin(root, joined)) {
      throw new PathGuardError(
        'outside-root',
        requested,
        `Đường dẫn nằm ngoài workspace: ${requested}`,
      );
    }

    let real: string;
    try {
      real = await this.fs.realpath(joined);
    } catch {
      throw new PathGuardError('not-found', requested, `Không tìm thấy: ${requested}`);
    }

    // Kiểm tra LẠI sau realpath — đây là bước bắt junction/symlink trỏ ra ngoài.
    if (!isWithin(root, real)) {
      throw new PathGuardError(
        'outside-root',
        requested,
        `Đường dẫn đi ra ngoài workspace qua symlink/junction: ${requested} -> ${real}`,
      );
    }

    return real;
  }

  /**
   * Giải đường dẫn cho thao tác GHI — file có thể chưa tồn tại (M4).
   *
   * `resolveExisting` không dùng được ở đây vì realpath ném ENOENT với file
   * mới. Nhưng bỏ realpath đi thì thủng: thư mục CHA có thể là junction trỏ ra
   * ngoài workspace, và lúc đó `C:\repo\link\evil.ts` trông vô hại còn file
   * thật rơi vào `C:\Windows\System32`.
   *
   * Cách làm: leo lên tới tổ tiên GẦN NHẤT có thật, realpath tổ tiên đó, ghép
   * lại phần đuôi chưa tồn tại, rồi mới so biên. Phần đuôi không tồn tại thì
   * không thể là link, nên nó an toàn để ghép chuỗi.
   */
  async resolveForWrite(requested: string): Promise<string> {
    this.assertShape(requested);

    const root = await this.realRoot();
    const joined = nodePath.isAbsolute(requested)
      ? nodePath.normalize(requested)
      : nodePath.resolve(root, requested);

    if (!isWithin(root, joined)) {
      throw new PathGuardError(
        'outside-root',
        requested,
        `Đường dẫn nằm ngoài workspace: ${requested}`,
      );
    }

    const tail: string[] = [];
    let cursor = joined;

    for (let depth = 0; depth < 64; depth++) {
      let real: string | undefined;
      try {
        real = await this.fs.realpath(cursor);
      } catch {
        real = undefined;
      }

      if (real !== undefined) {
        if (!isWithin(root, real)) {
          throw new PathGuardError(
            'outside-root',
            requested,
            `Thư mục cha đi ra ngoài workspace qua symlink/junction: ${requested} -> ${real}`,
          );
        }
        const resolved = tail.length === 0 ? real : nodePath.join(real, ...tail.reverse());
        // Ghép xong vẫn so lại: tail có thể chứa `..` mà normalize đưa ra ngoài.
        if (!isWithin(root, resolved)) {
          throw new PathGuardError(
            'outside-root',
            requested,
            `Đường dẫn nằm ngoài workspace: ${requested}`,
          );
        }
        return resolved;
      }

      const parent = nodePath.dirname(cursor);
      if (parent === cursor) break;
      tail.push(nodePath.basename(cursor));
      cursor = parent;
    }

    throw new PathGuardError(
      'not-found',
      requested,
      `Không tìm thấy thư mục cha nào có thật cho: ${requested}`,
    );
  }

  /** Dạng không ném, tiện cho chỗ chỉ cần lọc. */
  async isAllowed(requested: string): Promise<boolean> {
    try {
      await this.resolveExisting(requested);
      return true;
    } catch {
      return false;
    }
  }

  /** Đường dẫn tương đối so với root — dùng để hiển thị cho model và cho UI. */
  async toRelative(absolute: string): Promise<string> {
    const root = await this.realRoot();
    const rel = nodePath.relative(root, absolute);
    return rel === '' ? '.' : rel.split(nodePath.sep).join('/');
  }
}
