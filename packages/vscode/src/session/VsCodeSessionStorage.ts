/**
 * Nơi phiên chat nằm trên đĩa (M6).
 *
 * `globalStorageUri`, KHÔNG phải trong repo. Phiên chứa nguyên văn hội thoại,
 * trích đoạn file, đôi khi cả output lệnh — để nó trong repo là chờ ngày ai đó
 * `git add -A`. `.gitignore` không phải lời giải: nó là một
 * dòng người dùng có thể xoá, còn thư mục này thì họ không vô tình commit được.
 *
 * Dùng `vscode.workspace.fs` chứ không `node:fs` để chạy được cả trên
 * vscode.dev / remote — nơi extension host không có filesystem cục bộ.
 */
import * as vscode from 'vscode';
import type { SessionStorage } from '@astra/core';

export class VsCodeSessionStorage implements SessionStorage {
  private ready: Promise<void> | undefined;

  constructor(private readonly root: vscode.Uri) {}

  async read(key: string): Promise<string | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.uri(key));
      return new TextDecoder().decode(bytes);
    } catch {
      return undefined;
    }
  }

  async write(key: string, value: string): Promise<void> {
    await this.ensureDir();
    await vscode.workspace.fs.writeFile(this.uri(key), new TextEncoder().encode(value));
  }

  async remove(key: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.uri(key));
    } catch {
      /* đã không còn thì coi như xong */
    }
  }

  async keys(): Promise<string[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.root);
      return entries.filter(([, type]) => type === vscode.FileType.File).map(([name]) => name);
    } catch {
      // Thư mục chưa tồn tại = chưa có phiên nào. Không phải lỗi.
      return [];
    }
  }

  /**
   * Khoá đến từ `SessionStore`, nhưng cũng đến từ tên file có sẵn trong thư
   * mục. Chặn `..` và dấu phân cách ở đây là chốt chặn cuối trước khi một tên
   * bịa ra chạm tới đường dẫn thật.
   */
  private uri(key: string): vscode.Uri {
    const safe = key.replace(/[^a-zA-Z0-9._-]/g, '');
    return vscode.Uri.joinPath(this.root, safe || 'invalid.json');
  }

  private ensureDir(): Promise<void> {
    this.ready ??= (async () => {
      await vscode.workspace.fs.createDirectory(this.root);
    })();
    return this.ready;
  }
}
