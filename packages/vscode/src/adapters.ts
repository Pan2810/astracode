/**
 * Cầu nối giữa @astra/core (thuần Node) và VS Code.
 *
 * Mọi thứ trong file này tồn tại vì nguyên tắc kiến trúc #1: core không được
 * import 'vscode'. Core khai báo interface, đây là chỗ cài đặt chúng.
 */
import * as vscode from 'vscode';
import { AstraError, type LogRecord, type LogSink, type TokenStore } from '@astra/core';

/** Lỗi thành một dòng đọc được. Giữ `code` vì nó nói người dùng phải làm gì. */
export function describeError(err: unknown): string {
  if (err instanceof AstraError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Token nằm trong SecretStorage — mã hoá bởi OS keychain, không bao giờ vào
 * settings.json hay file nào (documents/SECURITY.md §2.6).
 */
export class SecretStorageTokenStore implements TokenStore {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly key: string,
  ) {}

  async get(): Promise<string | undefined> {
    return this.secrets.get(this.key);
  }

  async set(token: string): Promise<void> {
    await this.secrets.store(this.key, token);
  }

  async clear(): Promise<void> {
    await this.secrets.delete(this.key);
  }
}

/**
 * Workspace root ĐANG ACTIVE — folder chứa editor đang focus, không phải folder
 * đầu tiên. Trong multi-root workspace mở nhiều folder, `@` và agent phải làm
 * việc trên folder người dùng đang nhìn, không phải folder khai báo đầu tiên.
 * Không có editor active thì fallback về folder đầu tiên.
 */
export function activeWorkspaceRoot(): vscode.WorkspaceFolder | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) return folder;
  }
  return vscode.workspace.workspaceFolders?.[0];
}

/** Log ra OutputChannel. Nội dung đã được Logger redact trước khi tới đây. */
export class OutputChannelSink implements LogSink {
  constructor(private readonly channel: vscode.OutputChannel) {}

  write(record: LogRecord): void {
    const { ts, level, msg, traceId, ...rest } = record;
    const trace = traceId ? ` [${String(traceId)}]` : '';
    const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
    this.channel.appendLine(`${ts} ${level.toUpperCase().padEnd(5)}${trace} ${msg}${extra}`);
  }
}

/**
 * Nonce cho CSP. Bắt buộc phải ngẫu nhiên mỗi lần render — dùng lại một nonce
 * cố định thì `script-src 'nonce-...'` không còn tác dụng gì.
 */
export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

