/**
 * Đọc/ghi ASTRA.md của workspace.
 *
 * Hai nơi dùng: lệnh `astra.editMemory` trong Command Palette và builtin
 * `/memory` trong ô chat. Gộp ở đây để bản mẫu và đường dẫn chỉ có MỘT bản —
 * hai chỗ tự tạo file theo cách riêng thì sớm muộn cũng lệch tiêu đề mục, và
 * lúc đó `/memory <rule>` ghi vào một mục mà lệnh kia không tạo ra.
 */
import * as vscode from 'vscode';
import { MEMORY_FILE_NAME, MEMORY_TEMPLATE, withConvention } from './memoryText.js';

export function memoryFileUri(root: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(root, MEMORY_FILE_NAME);
}

/** Nội dung ASTRA.md, tạo từ bản mẫu nếu file chưa có. */
export async function readOrCreateMemoryFile(
  root: vscode.Uri,
): Promise<{ uri: vscode.Uri; content: string; created: boolean }> {
  const uri = memoryFileUri(root);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return { uri, content: new TextDecoder().decode(bytes), created: false };
  } catch {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(MEMORY_TEMPLATE));
    return { uri, content: MEMORY_TEMPLATE, created: true };
  }
}

/**
 * Nối một quy ước vào mục "Project conventions" rồi ghi lại file.
 *
 * Trả `chars` để nơi gọi so được với trần của `loadMemory`: vượt trần thì phần
 * đuôi bị cắt trước khi tới model, tức là rule vừa lưu có thể không bao giờ có
 * hiệu lực — im lặng đúng vào việc mà lệnh này sinh ra để làm.
 */
export async function appendConvention(
  root: vscode.Uri,
  rule: string,
): Promise<{ uri: vscode.Uri; chars: number; created: boolean }> {
  const { uri, content, created } = await readOrCreateMemoryFile(root);
  const next = withConvention(content, rule);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next));
  return { uri, chars: next.length, created };
}
