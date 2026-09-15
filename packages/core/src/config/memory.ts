/**
 * ASTRA.md — bộ nhớ dài hạn của project và của người dùng (mốc M6).
 *
 * Hai nguồn, KHÔNG cùng mức tin cậy:
 *
 *   `~/.astra/ASTRA.md`   — người dùng tự viết trên máy mình. Tin cậy.
 *   `<repo>/ASTRA.md`     — đến từ repo, tức là từ bất kỳ ai từng gửi PR vào
 *                           đó. KHÔNG tin cậy (nguyên tắc #8).
 *
 * Nội dung này được nhét thẳng vào system prompt, nên nó là vector injection
 * đắt giá nhất trong cả sản phẩm: một dòng trong ASTRA.md có sức nặng ngang
 * với lời của chính hệ thống. Ba lớp chắn, không lớp nào thay được lớp nào:
 *
 *   1. Trần kích thước. File 2 MB không phải "ghi chú project", nó là tấn công
 *      hoặc là tai nạn — cả hai đều phải bị cắt trước khi tới model.
 *   2. Quét injection, và báo lên UI. Không tự ý bỏ file: người dùng có thể có
 *      lý do chính đáng, nhưng họ phải BIẾT.
 *   3. Hash. Đổi nội dung là sự kiện đáng chú ý — `git pull` một nhánh lạ có
 *      thể lặng lẽ thay đổi chỉ dẫn mà agent đang tuân theo.
 *
 * Việc bọc delimiter khi ghép vào prompt nằm ở `prompts/system.ts`.
 */
import { createHash } from 'node:crypto';
import type { FileSystem } from '../fs/FileSystem.js';
import { scanForInjection, type InjectionScanResult } from '../security/injectionScan.js';

/** Trần ký tự cho mỗi file. Vượt thì cắt và nói rõ là đã cắt. */
export const MEMORY_MAX_CHARS = 12_000;

export type MemorySource = 'user' | 'project';

export interface MemoryFile {
  source: MemorySource;
  /** Đường dẫn tuyệt đối, để UI mở được. */
  path: string;
  content: string;
  truncated: boolean;
  /** Độ dài thật trước khi cắt. */
  originalChars: number;
  /** sha256 của nội dung GỐC — đổi nội dung là đổi hash, kể cả phần bị cắt. */
  hash: string;
  scan: InjectionScanResult;
}

export interface LoadMemoryOptions {
  fs: FileSystem;
  /** Gốc workspace. Bỏ trống nếu chưa mở thư mục nào. */
  workspaceRoot?: string;
  /** Thư mục nhà của người dùng. Bỏ trống thì không nạp bộ nhớ cá nhân. */
  homeDir?: string;
  /** Tên file. Đổi được để test, và để sau này đọc cả `.claude/CLAUDE.md` (M8). */
  fileNames?: string[];
  maxChars?: number;
}

export interface MemoryBundle {
  files: MemoryFile[];
  /** Nội dung ghép sẵn để nhét vào system prompt. Rỗng nếu không có file nào. */
  combined: string;
  /** File có dấu hiệu injection — UI phải hiện cảnh báo. */
  flagged: MemoryFile[];
}

const DEFAULT_NAMES = ['ASTRA.md'];

export async function loadMemory(opts: LoadMemoryOptions): Promise<MemoryBundle> {
  const names = opts.fileNames ?? DEFAULT_NAMES;
  const maxChars = opts.maxChars ?? MEMORY_MAX_CHARS;
  const files: MemoryFile[] = [];

  // Thứ tự có ý nghĩa: bộ nhớ cá nhân trước, project sau. Model đọc phần sau
  // như phần cụ thể hoá phần trước — quy ước của repo thắng thói quen cá nhân.
  if (opts.homeDir) {
    for (const name of names) {
      const file = await read(opts.fs, join(opts.homeDir, '.astra', name), 'user', maxChars);
      if (file) files.push(file);
    }
  }

  if (opts.workspaceRoot) {
    for (const name of names) {
      const file = await read(opts.fs, join(opts.workspaceRoot, name), 'project', maxChars);
      if (file) files.push(file);
    }
  }

  return {
    files,
    combined: files.map(render).join('\n\n'),
    flagged: files.filter((f) => f.scan.suspicious),
  };
}

async function read(
  fs: FileSystem,
  path: string,
  source: MemorySource,
  maxChars: number,
): Promise<MemoryFile | undefined> {
  let raw: string;
  try {
    if (!(await fs.exists(path))) return undefined;
    raw = await fs.readFile(path);
  } catch {
    // Không đọc được không phải lỗi cần báo: file có thể vừa bị xoá, hoặc
    // không có quyền. Phiên vẫn chạy được mà không có bộ nhớ.
    return undefined;
  }

  if (!raw.trim()) return undefined;

  const truncated = raw.length > maxChars;
  const content = truncated
    ? `${raw.slice(0, maxChars)}\n\n… (đã cắt ${raw.length - maxChars} ký tự — ASTRA.md nên ngắn)`
    : raw;

  return {
    source,
    path,
    content,
    truncated,
    originalChars: raw.length,
    hash: createHash('sha256').update(raw).digest('hex').slice(0, 16),
    // Quét trên nội dung GỐC: cắt xong mới quét thì phần bị cắt thành điểm mù.
    scan: scanForInjection(raw),
  };
}

function render(file: MemoryFile): string {
  const label = file.source === 'user' ? 'Ghi chú cá nhân của người dùng' : 'Ghi chú của project';
  return `### ${label} (${file.path})\n\n${file.content.trim()}`;
}

/**
 * Ghép đường dẫn không cần node:path.
 *
 * core chạy được cả trên Windows lẫn POSIX, và `node:path` ở đây chỉ dùng để
 * nối chuỗi. Dấu `/` hoạt động trên cả hai; giữ nguyên separator sẵn có của
 * gốc để đường dẫn hiện ra UI trông đúng kiểu của hệ điều hành.
 */
function join(root: string, ...parts: string[]): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  return [base, ...parts].join(sep);
}

/**
 * So hai lần nạp để biết bộ nhớ có đổi không.
 *
 * Dùng khi mở lại workspace hoặc sau `git pull`: chỉ dẫn mà agent tuân theo
 * vừa bị thay mà người dùng không hay là tình huống đáng báo.
 */
export function diffMemory(
  before: MemoryFile[],
  after: MemoryFile[],
): Array<{ path: string; change: 'added' | 'removed' | 'changed' }> {
  const out: Array<{ path: string; change: 'added' | 'removed' | 'changed' }> = [];
  const beforeMap = new Map(before.map((f) => [f.path, f.hash]));
  const afterMap = new Map(after.map((f) => [f.path, f.hash]));

  for (const [path, hash] of afterMap) {
    const old = beforeMap.get(path);
    if (old === undefined) out.push({ path, change: 'added' });
    else if (old !== hash) out.push({ path, change: 'changed' });
  }
  for (const path of beforeMap.keys()) {
    if (!afterMap.has(path)) out.push({ path, change: 'removed' });
  }

  return out;
}
