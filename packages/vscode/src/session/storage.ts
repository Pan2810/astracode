/**
 * Phiên chat nằm ở đâu — và vì sao không còn nằm trong `globalStorageUri`.
 *
 * Trước đây extension ghi phiên vào `globalStorageUri` còn CLI trỏ vào
 * `~/.astra/sessions`. Hai chỗ khác nhau, nên chat trong VS Code xong mở
 * terminal lên là không thấy gì — đúng thứ mà `~/.astra` tuyên bố sẽ không xảy
 * ra ("hai công cụ, một sự thật").
 *
 * Giờ cả hai dùng `~/.astra/projects/<slug>/`, tách theo THƯ MỤC dự án chứ không
 * lọc theo trường trong file. Xem `FsSessionStorage` để biết vì sao chỗ đặt lại
 * quan trọng hơn code.
 *
 * `globalStorageUri` vẫn còn, làm đường lùi. Lý do chọn nó ban đầu là thật:
 * `vscode.workspace.fs` chạy được cả ở nơi extension host không có filesystem
 * cục bộ. Ở đó `~/.astra` không tồn tại, và một extension không mở nổi chat chỉ
 * vì không ghi được vào home là cái giá không đáng.
 */
import { mkdirSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  FsSessionStorage,
  NodeFileSystem,
  astraHome,
  astraLayout,
  parseSession,
  projectDir,
  type AstraLayout,
  type Logger,
  type SessionStorage,
} from '@astra/core';
import { VsCodeSessionStorage } from './VsCodeSessionStorage.js';

export interface ResolvedSessionStorage {
  storage: SessionStorage;
  /** `home` = `~/.astra`, dùng chung với CLI. `globalStorage` = đường lùi. */
  kind: 'home' | 'globalStorage';
  /** Thư mục thật, chỉ có khi `kind === 'home'`. Dùng để migrate. */
  dir?: string;
}

/** Layout `~/.astra` của máy đang chạy. */
export function homeLayout(): AstraLayout {
  return astraLayout(astraHome({ homeDir: os.homedir(), override: process.env.ASTRA_HOME }));
}

/**
 * Chọn nơi lưu phiên. Đồng bộ vì `activate()` đồng bộ.
 *
 * Phép thử là `mkdirSync`, không phải `existsSync`: câu hỏi cần trả lời là "có
 * GHI được không", và một thư mục tồn tại nhưng chỉ đọc sẽ vượt qua phép thử
 * kia rồi hỏng ở lần lưu phiên đầu tiên — tức là sau khi người dùng đã gõ xong
 * một lượt chat.
 */
export function resolveSessionStorage(opts: {
  workspaceRoot: string | undefined;
  globalStorage: vscode.Uri;
  logger: Logger;
}): ResolvedSessionStorage {
  try {
    const dir = projectDir(homeLayout(), opts.workspaceRoot ?? '');
    mkdirSync(dir, { recursive: true });
    return { storage: new FsSessionStorage(new NodeFileSystem(), dir), kind: 'home', dir };
  } catch (err) {
    opts.logger.warn('cannot use the AstraCode home directory, keeping sessions in extension storage', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return {
      storage: new VsCodeSessionStorage(vscode.Uri.joinPath(opts.globalStorage, 'sessions')),
      kind: 'globalStorage',
    };
  }
}

/**
 * Chuyển phiên cũ trong `globalStorageUri` sang `~/.astra/projects/<slug>/`.
 *
 * Không nằm trong `migrateHome` của core vì nó cần `vscode.workspace.fs`, và
 * core không được import `vscode`.
 *
 * Thư mục đích lấy từ `workspaceRoot` GHI TRONG chính file phiên, nên phiên của
 * mọi thư mục từng mở đều về đúng chỗ — không chỉ thư mục đang mở lúc chạy
 * migrate. Chép xong mới xoá; đứt giữa chừng thì lần sau chạy lại.
 */
export async function migrateGlobalStorageSessions(opts: {
  globalStorage: vscode.Uri;
  logger: Logger;
}): Promise<number> {
  const from = vscode.Uri.joinPath(opts.globalStorage, 'sessions');
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(from);
  } catch {
    return 0; // Chưa từng có phiên nào ở đây.
  }

  const fs = new NodeFileSystem();
  const layout = homeLayout();
  let moved = 0;

  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
    const source = vscode.Uri.joinPath(from, name);

    try {
      const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(source));
      const session = parseSession(raw);
      // Phiên không đọc được thì để nguyên: xoá dữ liệu mình không hiểu là cách
      // tệ nhất để kết thúc một lần migrate.
      if (!session?.workspaceRoot) continue;

      const target = join(projectDir(layout, session.workspaceRoot), name);
      if (!(await fs.exists(target))) await fs.writeFile(target, raw);
      await vscode.workspace.fs.delete(source);
      moved++;
    } catch {
      /* phiên này để lần sau */
    }
  }

  if (moved > 0) {
    opts.logger.info('moved chat sessions into the shared AstraCode home directory', { moved });
  }
  return moved;
}
