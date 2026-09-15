/**
 * Layout của `~/.astra` — MỘT nơi duy nhất biết file nào nằm ở đâu.
 *
 * Trước đây mỗi bề mặt tự ghép đường dẫn: CLI có `home.ts`, extension ghép
 * `globalStorageUri`. Hệ quả là hai công cụ ghi phiên vào hai chỗ khác nhau và
 * không bên nào thấy phiên của bên kia. File này là lời sửa: cả hai gọi cùng
 * một hàm, nên chúng KHÔNG THỂ lệch nhau nữa.
 *
 * Nguyên tắc phân chia (học từ `~/.claude`), theo vòng đời của dữ liệu:
 *
 *   người viết   → settings.json, settings.local.json
 *   bí mật       → credentials.json (tách khỏi settings để settings chép đi được)
 *   máy ghi      → state.json (+ backups/), models.json, policy.json
 *   theo dự án   → projects/<slug>/
 *   hoàn tác     → file-history/<sessionId>/
 *   gõ gì rồi    → history.jsonl
 *   mất được     → cache/, .last-cleanup
 *
 * Thuần đường dẫn: không import `node:fs`, không đụng đĩa. Nhờ vậy test tính
 * được slug và layout mà không cần thư mục thật.
 */
import { join } from 'node:path';

/** Tên thư mục quy ước, dùng cả ở HOME lẫn trong repo (`<repo>/.astra/`). */
export const ASTRA_DIR = '.astra';

export interface AstraLayout {
  /** Gốc: `~/.astra`, hoặc `ASTRA_HOME` nếu được đặt. */
  home: string;

  /** Người dùng viết tay. Chép sang máy khác được vì không chứa bí mật. */
  settings: string;
  /** Ghi đè settings, chỉ cho máy này. Không chép đi. */
  settingsLocal: string;
  /** JWT AstraWork. Tách riêng, quyền 0600. */
  credentials: string;

  /** Trạng thái do app tự ghi — người dùng không cần đọc, không nên sửa. */
  state: string;
  /** Bản sao xoay vòng của state.json. Hỏng một bản không mất cả lịch sử. */
  backups: string;

  /** Capability profile do `astracode measure` sinh. Tả MODEL, không tả dự án. */
  models: string;
  /** Bản policy tổ chức lấy được lần cuối. */
  policy: string;

  /** Gốc của dữ liệu theo dự án. */
  projects: string;
  /** Bản chụp file trước mỗi lượt, để `/undo` sống qua restart. */
  fileHistory: string;
  /**
   * Gốc cache CodeGraph theo workspace (M12). TÁCH khỏi `projects/`: đây là
   * cache dựng lại được từ chính source, không phải trạng thái phiên — dọn
   * dẹp của nó phải khác trục "tuổi 30 ngày" của `HomeCleanup`, xem GraphCache.
   */
  graphs: string;

  /** Mọi prompt người dùng đã gõ, một dòng JSON mỗi prompt. */
  historyLog: string;
  /** Thứ mất được bất cứ lúc nào. */
  cache: string;
  /** Mốc lần dọn dẹp gần nhất (ISO 8601). */
  lastCleanup: string;

  /** Người dùng mở rộng: lệnh, skill, sub-agent cá nhân. */
  commands: string;
  skills: string;
  agents: string;

  // ── Đường dẫn của bản cũ, chỉ để migrate rồi xoá ───────────────────────
  legacyConfig: string;
  legacyToken: string;
  legacySessions: string;
}

/**
 * Gốc của thư mục nhà.
 *
 * Nhận `home` qua tham số chứ không tự gọi `os.homedir()`: core không được phép
 * phụ thuộc vào môi trường chạy, và test cần trỏ nó vào thư mục tạm.
 */
export function astraHome(opts: { homeDir: string; override?: string | undefined }): string {
  const override = opts.override?.trim();
  return override ? override : join(opts.homeDir, ASTRA_DIR);
}

export function astraLayout(home: string): AstraLayout {
  return {
    home,
    settings: join(home, 'settings.json'),
    settingsLocal: join(home, 'settings.local.json'),
    credentials: join(home, 'credentials.json'),
    state: join(home, 'state.json'),
    backups: join(home, 'backups'),
    models: join(home, 'models.json'),
    policy: join(home, 'policy.json'),
    projects: join(home, 'projects'),
    fileHistory: join(home, 'file-history'),
    graphs: join(home, 'graph'),
    historyLog: join(home, 'history.jsonl'),
    cache: join(home, 'cache'),
    lastCleanup: join(home, '.last-cleanup'),
    commands: join(home, 'commands'),
    skills: join(home, 'skills'),
    agents: join(home, 'agents'),
    legacyConfig: join(home, 'config.json'),
    legacyToken: join(home, 'token'),
    legacySessions: join(home, 'sessions'),
  };
}

/** Thư mục chứa phiên của một workspace. */
export function projectDir(layout: AstraLayout, workspaceRoot: string): string {
  return join(layout.projects, projectSlug(workspaceRoot));
}

/** Thư mục chứa bản chụp file của một phiên. */
export function sessionHistoryDir(layout: AstraLayout, sessionId: string): string {
  return join(layout.fileHistory, safeName(sessionId));
}

/** Thư mục chứa cache CodeGraph của một workspace (M12). */
export function graphDir(layout: AstraLayout, workspaceRoot: string): string {
  return join(layout.graphs, projectSlug(workspaceRoot));
}

/**
 * Tên thư mục cho một workspace.
 *
 * Hai phần, và phần thứ hai mới là phần đúng:
 *
 *   1. Đường dẫn đã thay ký tự lạ bằng `-` — để người mở thư mục ra còn đoán
 *      được đây là repo nào. `~/.claude` dừng ở đây.
 *   2. Một hash 32-bit của đường dẫn đã chuẩn hoá. Bước 1 không đơn ánh:
 *      `C:\a\b-c` và `C:\a\b\c` cho cùng một chuỗi. Không có hash thì hai repo
 *      khác nhau dùng chung một thư mục phiên, và lần dọn dẹp của repo này xoá
 *      phiên của repo kia.
 *
 * Chuẩn hoá viết thường trước khi hash vì Windows không phân biệt hoa thường:
 * `C:\Work` và `c:\work` là một thư mục, phải ra một slug.
 */
export function projectSlug(workspaceRoot: string): string {
  const normalized = workspaceRoot.replace(/[\\/]+$/, '').toLowerCase();
  const readable = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${readable || 'workspace'}-${fnv1a(normalized).toString(36)}`;
}

/** Tên file/thư mục an toàn từ một chuỗi đến từ đĩa hoặc từ người dùng. */
export function safeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 120) || 'invalid';
}

/**
 * FNV-1a 32-bit. Tự viết chứ không dùng `node:crypto`.
 *
 * Đây là hash để tránh trùng tên thư mục, không phải để chống ai cả — kéo cả
 * `crypto` vào một file thuần đường dẫn chỉ để lấy 8 ký tự là không đáng.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
