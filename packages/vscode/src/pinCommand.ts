/**
 * Lệnh "AstraCode: Add to Chat" (editor context menu) — ghim đoạn đang chọn,
 * hoặc cả file nếu không chọn gì, vào hội thoại đang mở. Xem `ChatController.addPin`.
 *
 * `refForSelection` cũng được `ChatViewProvider` dùng lại cho gợi ý pin xuất
 * hiện ngay trong panel chat khi selection không rỗng — hai đường vào cùng một
 * `PinnedRef`, khác nhau ở chỗ chuột phải báo lỗi còn gợi ý thì lặng lẽ bỏ qua.
 */
import * as vscode from 'vscode';
import type { PinnedRef } from '@astra/core';
import type { ChatViewProvider } from './chatView.js';

export async function addSelectionToChat(chat: ChatViewProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('Open a file to pin it to the chat.');
    return;
  }

  const ref = refForSelection(editor);
  if (!ref) {
    // Chỉ nhận file TRONG workspace: pin trỏ ra ngoài luôn bị pathGuard của
    // read_file từ chối khi `resolvePins` chạy — tạo một pin chắc chắn hỏng chỉ
    // để báo lỗi ngay sau đó là trải nghiệm tệ hơn không tạo gì cả.
    void vscode.window.showWarningMessage(
      'This file is outside the open workspace, so it cannot be pinned.',
    );
    return;
  }

  await chat.addPin(ref);
}

/**
 * `PinnedRef` cho selection hiện tại của một editor, hoặc `undefined` nếu file
 * nằm ngoài workspace đang mở. Dùng chung bởi lệnh "AstraCode: Add to Chat"
 * (cảnh báo khi `undefined`) và gợi ý pin trong panel chat, nơi im lặng bỏ qua
 * thay vì làm phiền bằng cảnh báo mỗi lần selection đổi.
 */
export function refForSelection(editor: vscode.TextEditor): PinnedRef | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!folder) return undefined;

  // Cùng chuẩn hoá `pickAttachment()` đã dùng cho `@mention`/`filePicked`, để
  // đường dẫn agent thấy khớp với đường dẫn nó đọc bằng read_file.
  const path = vscode.workspace.asRelativePath(editor.document.uri, false).replace(/\\/g, '/');
  return selectionToPinnedRef(path, editor.selection);
}

/**
 * Selection trống = pin cả file. Khác thì lấy đúng khoảng dòng đã BÔI ĐEN.
 *
 * VS Code đánh dấu "chọn hết dòng N" bằng `end.line = N+1, end.character = 0`
 * (con trỏ đứng ở đầu dòng kế tiếp) — không trừ lại thì pin sẽ dư một dòng
 * người dùng chưa từng chọn.
 */
function selectionToPinnedRef(path: string, selection: vscode.Selection): PinnedRef {
  if (selection.isEmpty) return { path };

  const startLine = selection.start.line;
  const endsAtLineStart = selection.end.character === 0 && selection.end.line > startLine;
  const endLine = endsAtLineStart ? selection.end.line - 1 : selection.end.line;

  // Dòng đánh số từ 1, khớp `read_file`/`PinnedRef`.
  return { path, startLine: startLine + 1, endLine: endLine + 1 };
}
