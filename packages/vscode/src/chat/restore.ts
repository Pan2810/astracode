/**
 * Vẽ lại một phiên cũ — RÚT GỌN.
 *
 * History là thứ gửi cho MODEL đọc, không phải thứ người dùng đọc. Ở đường XML
 * nó chứa nguyên văn lời gọi tool (`<read_file>…`) trong message assistant, và
 * cả một message `user` giả do AgentLoop chèn để trả kết quả tool. Đổ thẳng ra
 * màn hình thì hội thoại cũ hiện thành một bãi XML lẫn với `<tool_result>` —
 * và tệ hơn: kết quả tool trông y như lời người dùng từng nói.
 *
 * Nên ở đây: giữ lời người dùng thật và phần văn xuôi của câu trả lời, còn mọi
 * thứ thuộc về cơ chế thì gộp thành các dòng `tool`. Hộp duyệt quyền và cảnh
 * báo injection vẫn không dựng lại — chúng gắn với thời điểm chạy, vẽ lại chỉ
 * trông như đang chờ bấm trong khi không còn nối với gì cả.
 *
 * File này KHÔNG import `vscode`. Toàn bộ phần rút gọn là biến đổi văn bản
 * thuần, và nó hỏng theo kiểu im lặng: phiên vẫn mở được, chỉ là những gì hiện
 * ra không còn đọc nổi. Tách ra để vitest chạy thẳng vào nó.
 */
import {
  parseXmlToolCalls,
  readXmlToolResults,
  type ChatMessage,
  type PersistedToolSummary,
} from '@astra/core';
import type { RestoredMessage, RestoredToolWire } from './protocol.js';

/** Trần cho một dòng tóm tắt trong phiên cũ. Dài hơn thì UI cắt bằng ellipsis. */
export const RESTORED_SUMMARY_CHARS = 80;

/**
 * @param summaries Tóm tắt UI đã lưu, khoá theo `ToolCall.id` (phiên v2 trở đi).
 * Có thì dùng — đó là ĐÚNG chuỗi người dùng đã nhìn thấy lúc tool chạy. Không
 * có (phiên v1, hoặc đường XML không mang id) thì rút từ nội dung gửi model như
 * cũ, và chấp nhận rằng chuỗi đó là tiếng Việt của prompt layer.
 */
export function renderRestored(
  messages: ChatMessage[],
  toolNames: string[],
  summaries: Record<string, PersistedToolSummary> = {},
): RestoredMessage[] {
  const out: RestoredMessage[] = [];

  /**
   * Lời gọi đã thấy nhưng chưa có kết quả.
   *
   * Kết quả luôn đến ở message SAU lời gọi, ở cả hai đường: XML gộp chúng vào
   * một message `user` giả, native rải thành các message `tool`. Nên phải giữ
   * lời gọi lại một nhịp rồi mới ghép được input với output.
   */
  let pending: RestoredToolWire[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    out.push({ role: 'tool', tools: pending });
    pending = [];
  };

  for (const m of messages) {
    if (m.role === 'user') {
      // Kết quả tool do AgentLoop chèn dưới vai `user` — không phải lời người dùng.
      const results = readXmlToolResults(m.content);
      if (results) {
        // Ghép theo chỉ số: AgentLoop giữ nguyên thứ tự gọi khi dựng message này.
        results.forEach((r, i) => {
          const target = pending[i];
          if (target) target.output = summarizeRestoredOutput(r.content);
          else pending.push({ name: r.name, input: '', output: summarizeRestoredOutput(r.content) });
        });
        flush();
        continue;
      }
      flush();
      out.push({ role: 'user', content: m.content });
      continue;
    }

    // Đường native: mỗi kết quả một message, và nó mang `toolCallId` — nên ở
    // đây ghép được theo ID chứ không phải theo thứ tự.
    if (m.role === 'tool') {
      const saved = summaries[m.toolCallId];
      const target = pending.find((t) => t.callId === m.toolCallId) ?? pending.find((t) => !t.output);
      if (!target) continue;

      target.output = saved ? saved.summary : summarizeRestoredOutput(m.content);
      if (saved?.isError) target.isError = true;
      continue;
    }

    if (m.role !== 'assistant') continue;

    // Sang lượt assistant mới nghĩa là loạt tool trước đã xong.
    flush();

    // Đường native: lời gọi nằm ở `toolCalls`. Đường XML: nằm trong `content`.
    for (const c of m.toolCalls ?? []) {
      pending.push({
        name: c.name,
        input: summarizeRestoredInput(c.arguments),
        output: '',
        callId: c.id,
      });
    }

    const raw = m.content ?? '';
    if (!raw.trim()) continue;

    const parsed = parseXmlToolCalls(raw, toolNames);
    if (parsed.text.trim()) out.push({ role: 'assistant', content: parsed.text.trim() });
    for (const c of parsed.calls) {
      pending.push({ name: c.name, input: summarizeRestoredInput(c.args), output: '' });
    }
  }

  flush();
  return out;
}

/**
 * Tham số nào nhận diện được lời gọi này.
 *
 * Ưu tiên theo danh sách vì đó là thứ người ta nhớ về một lần gọi: đường dẫn,
 * mẫu tìm, lệnh đã chạy. Không có cái nào thì lấy chuỗi đầu tiên — thà hiện
 * một tham số hơi lạ còn hơn để trống và bắt người đọc đoán.
 */
export function summarizeRestoredInput(args: unknown): string {
  // Đường native đưa vào đây một chuỗi: `ToolCall.arguments` là JSON THÔ (xem
  // provider/types.ts), việc parse là của agent loop. Không parse lại ở đây thì
  // mọi lời gọi trong phiên cũ hiện nguyên khối `{"limit":8,"path":"…"}` — đúng
  // thứ hàm này sinh ra để tránh, và nó cắt ngang giữa chuỗi nên đường dẫn còn
  // không đọc được. Đường XML không dính vì `parseXmlToolCalls` trả về object.
  if (typeof args === 'string') {
    const parsed = parseArgsObject(args);
    return parsed ? summarizeRestoredInput(parsed) : clampLine(args);
  }
  if (typeof args !== 'object' || args === null) return '';

  const record = args as Record<string, unknown>;
  const preferred = ['path', 'file_path', 'file', 'pattern', 'query', 'command', 'url', 'content'];

  for (const key of preferred) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return clampLine(value);
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.trim()) return clampLine(value);
  }
  return '';
}

/**
 * JSON đối số → object, hoặc `undefined` nếu không phải object.
 *
 * Lời gọi hỏng vẫn nằm trong phiên cũ — model từng sinh ra JSON sai và
 * `AgentLoop` từng phải sửa nó. Nuốt lỗi ở đây rồi hiện chuỗi thô là đúng: một
 * phiên cũ không mở lại được vì một lời gọi hỏng ba tháng trước là hỏng nặng
 * hơn nhiều so với một dòng khó đọc.
 */
function parseArgsObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Kết quả tool thành một dòng.
 *
 * Nội dung nhiều dòng thành "N dòng" chứ không phải dòng đầu tiên: dòng đầu của
 * một file hay một kết quả grep hầu như không nói được gì, còn kích thước thì
 * cho biết lần gọi đó tìm được nhiều hay ít.
 */
export function summarizeRestoredOutput(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';

  const lines = trimmed.split('\n');
  if (lines.length > 1) return `${lines.length} lines`;
  return clampLine(trimmed);
}

function clampLine(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > RESTORED_SUMMARY_CHARS
    ? `${line.slice(0, RESTORED_SUMMARY_CHARS - 1)}…`
    : line;
}
