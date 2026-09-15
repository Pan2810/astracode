/**
 * FileSystem đọc bản đang mở trong editor trước, rồi mới tới đĩa.
 *
 * Vì sao cần: người dùng sửa file, CHƯA lưu, rồi hỏi agent về đúng file đó.
 * Nếu agent đọc từ đĩa, nó thấy bản cũ và trả lời về code không còn tồn tại —
 * kiểu sai lầm khó phát hiện nhất vì câu trả lời trông vẫn hợp lý.
 *
 * Chỉ ghi đè phần ĐỌC NỘI DUNG. Mọi thứ liên quan tới cấu trúc thư mục và
 * realpath vẫn đi qua NodeFileSystem, nên pathGuard hoạt động y hệt.
 */
import * as vscode from 'vscode';
import { NodeFileSystem, type DirEntry, type FileStat, type FileSystem } from '@astra/core';

export class VsCodeFileSystem implements FileSystem {
  private readonly disk = new NodeFileSystem();

  realpath(path: string): Promise<string> {
    return this.disk.realpath(path);
  }

  readDir(path: string): Promise<DirEntry[]> {
    return this.disk.readDir(path);
  }

  exists(path: string): Promise<boolean> {
    return this.disk.exists(path);
  }

  async stat(path: string): Promise<FileStat> {
    const doc = this.openDocument(path);
    if (doc?.isDirty) {
      const text = doc.getText();
      return {
        type: 'file',
        size: Buffer.byteLength(text, 'utf8'),
        mtimeMs: Date.now(),
      };
    }
    return this.disk.stat(path);
  }

  async readFile(path: string): Promise<string> {
    const doc = this.openDocument(path);
    if (doc?.isDirty) return doc.getText();
    return this.disk.readFile(path);
  }

  /**
   * Ghi qua WorkspaceEdit, KHÔNG qua fs.writeFile.
   *
   * Ba thứ có được nhờ đường này, và mất sạch nếu ghi thẳng xuống đĩa:
   *
   *   1. Ctrl+Z hoàn tác được. Thay đổi của agent nằm cùng undo stack với thay
   *      đổi người dùng tự gõ — đúng thứ họ phản xạ bấm khi thấy sai.
   *   2. Không ghi đè bản chưa lưu của người dùng. `fs.writeFile` lên một file
   *      đang dirty sẽ tạo xung đột "file đã đổi trên đĩa" và một trong hai bản
   *      sẽ mất, thường là bản họ đang gõ dở.
   *   3. Editor thấy thay đổi ngay, không phải chờ file watcher.
   *
   * File không mở sẵn thì vẫn dùng WorkspaceEdit — VS Code tự mở ngầm và giữ ở
   * trạng thái chưa lưu, nên `saveAll` bên dưới là phần bắt buộc, không phải
   * tiện thể: agent chạy test ngay sau khi sửa phải thấy nội dung trên đĩa.
   */
  async writeFile(path: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(path);
    const edit = new vscode.WorkspaceEdit();

    if (await this.disk.exists(path)) {
      const doc = await vscode.workspace.openTextDocument(uri);
      const whole = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length),
      );
      edit.replace(uri, whole, content);
    } else {
      // `ignoreIfExists` để tránh đua với thứ khác vừa tạo file cùng lúc.
      edit.createFile(uri, { ignoreIfExists: true, contents: Buffer.from(content, 'utf8') });
    }

    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error(`VS Code refused to apply the edit to ${path}`);
    }
    await this.save(uri);
  }

  async deleteFile(path: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(vscode.Uri.file(path), { ignoreIfNotExists: true });
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error(`VS Code refused to delete ${path}`);
    }
  }

  async mkdirp(path: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path));
  }

  /**
   * Lưu xuống đĩa. Bỏ qua lỗi có chủ ý: file vẫn đúng trong editor, và một lần
   * lưu hỏng (file read-only, ổ đĩa đầy) không đáng để huỷ cả lượt chat — người
   * dùng sẽ thấy tab dirty và tự xử lý.
   */
  private async save(uri: vscode.Uri): Promise<void> {
    try {
      const doc = vscode.workspace.textDocuments.find(
        (d) => normalize(d.uri.fsPath) === normalize(uri.fsPath),
      );
      if (doc?.isDirty) await doc.save();
    } catch {
      /* xem chú thích trên */
    }
  }

  /**
   * Chỉ nhận tài liệu có scheme `file`. Tài liệu ảo (git diff, output channel,
   * webview) trùng đường dẫn về mặt chuỗi nhưng không phải file thật.
   */
  private openDocument(path: string): vscode.TextDocument | undefined {
    const target = normalize(path);
    return vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === 'file' && normalize(d.uri.fsPath) === target,
    );
  }
}

/** Windows không phân biệt hoa thường; so sánh đường dẫn phải theo đó. */
function normalize(p: string): string {
  const unified = p.replace(/\\/g, '/');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}
