/**
 * Chuyển `~/.astra` từ layout cũ sang layout mới. Chạy một lần, tự nhận biết.
 *
 * Ba nguyên tắc, đều xuất phát từ việc đây là dữ liệu của người dùng chứ không
 * phải cache:
 *
 *   1. **Chép rồi mới xoá.** Ghi bản mới thành công thì mới bỏ bản cũ. Đứt giữa
 *      chừng thì lần sau chạy lại, không mất gì.
 *   2. **Không bao giờ ghi đè bản mới bằng bản cũ.** Người dùng đã chạy bản mới
 *      rồi mở lại bản cũ (cài song song hai bản) là chuyện có thật.
 *   3. **Lỗi thì bỏ qua, không ném.** Migrate hỏng làm mất tiện nghi; migrate
 *      ném làm hỏng cả lần khởi động.
 *
 * Migrate của bề mặt VS Code (phiên nằm trong `globalStorageUri`) KHÔNG ở đây:
 * nó cần `vscode.workspace.fs`, và core không được import `vscode`.
 */
import { join } from 'node:path';
import type { FileSystem } from '../fs/FileSystem.js';
import type { Logger } from '../telemetry/logger.js';
import { parseSession } from '../session/types.js';
import { projectDir, type AstraLayout } from './layout.js';

export interface MigrateOptions {
  fs: FileSystem;
  layout: AstraLayout;
  logger: Logger;
}

export interface MigrateReport {
  settings: boolean;
  credentials: boolean;
  /** Số phiên chuyển từ `sessions/` phẳng sang `projects/<slug>/`. */
  sessions: number;
}

export async function migrateHome(opts: MigrateOptions): Promise<MigrateReport> {
  const report: MigrateReport = { settings: false, credentials: false, sessions: 0 };

  report.settings = await moveJson(opts, opts.layout.legacyConfig, opts.layout.settings);
  report.credentials = await migrateToken(opts);
  report.sessions = await migrateSessions(opts);

  if (report.settings || report.credentials || report.sessions > 0) {
    opts.logger.info('migrated the AstraCode home directory to the new layout', { ...report });
  }
  return report;
}

/** `config.json` → `settings.json`. Giữ nguyên nội dung, chỉ đổi tên. */
async function moveJson(opts: MigrateOptions, from: string, to: string): Promise<boolean> {
  try {
    if (!(await opts.fs.exists(from))) return false;
    if (await opts.fs.exists(to)) return false; // Bản mới thắng, luôn luôn.

    const raw = await opts.fs.readFile(from);
    JSON.parse(raw); // File hỏng thì để nguyên chỗ cũ cho người dùng tự xem.
    await opts.fs.writeFile(to, raw);
    await opts.fs.deleteFile(from);
    return true;
  } catch {
    return false;
  }
}

/**
 * `token` (JWT trần) → `credentials.json`.
 *
 * Đổi sang JSON vì file này sẽ còn giữ thêm thứ khác (thời điểm lấy token, và
 * sau này là tài khoản nào nếu có nhiều). Một file chứa đúng một chuỗi trần thì
 * không có chỗ nào thêm trường mà không phá bản cũ.
 */
async function migrateToken(opts: MigrateOptions): Promise<boolean> {
  try {
    if (!(await opts.fs.exists(opts.layout.legacyToken))) return false;
    if (await opts.fs.exists(opts.layout.credentials)) return false;

    const token = (await opts.fs.readFile(opts.layout.legacyToken)).trim();
    if (!token) {
      await opts.fs.deleteFile(opts.layout.legacyToken);
      return false;
    }

    await opts.fs.writeFile(
      opts.layout.credentials,
      `${JSON.stringify({ astrawork: { accessToken: token, savedAt: Date.now() } }, null, 2)}\n`,
    );
    await opts.fs.deleteFile(opts.layout.legacyToken);
    return true;
  } catch {
    return false;
  }
}

/**
 * `sessions/session-*.json` phẳng → `projects/<slug>/session-*.json`.
 *
 * Thư mục đích lấy từ `workspaceRoot` GHI TRONG chính file phiên — đó là nguồn
 * duy nhất biết phiên này thuộc repo nào. Phiên không đọc được hoặc không có
 * workspaceRoot thì để nguyên: xoá dữ liệu mình không hiểu là cách tệ nhất để
 * kết thúc một lần migrate.
 */
async function migrateSessions(opts: MigrateOptions): Promise<number> {
  let names: string[];
  try {
    const entries = await opts.fs.readDir(opts.layout.legacySessions);
    names = entries.filter((e) => e.type === 'file' && e.name.endsWith('.json')).map((e) => e.name);
  } catch {
    return 0;
  }

  let moved = 0;
  for (const name of names) {
    const from = join(opts.layout.legacySessions, name);
    try {
      const raw = await opts.fs.readFile(from);
      const session = parseSession(raw);
      if (!session?.workspaceRoot) continue;

      const to = join(projectDir(opts.layout, session.workspaceRoot), name);
      if (await opts.fs.exists(to)) {
        await opts.fs.deleteFile(from);
        continue;
      }

      await opts.fs.writeFile(to, raw);
      await opts.fs.deleteFile(from);
      moved++;
    } catch {
      /* phiên này không chuyển được — để nguyên, lần sau thử lại */
    }
  }
  return moved;
}
