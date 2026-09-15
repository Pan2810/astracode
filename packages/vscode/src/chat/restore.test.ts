/**
 * Rút gọn phiên cũ hỏng theo kiểu im lặng nhất trong cả extension: phiên vẫn mở
 * được, không có lỗi nào, chỉ là những gì hiện ra không còn đọc nổi. Không ai
 * phát hiện ra trừ khi có người mở lại một phiên cũ và ngồi nhìn.
 *
 * Đó đúng là chuyện đã xảy ra: `ToolCall.arguments` là JSON THÔ, nên mọi lời
 * gọi ở đường native hiện nguyên khối `{"limit":8,"path":"docs/…"}` cắt ngang
 * giữa chuỗi. Bộ test này giữ cho nó không quay lại.
 */
import { describe, it, expect } from 'vitest';
import {
  XML_TOOL_RESULT_HEADING,
  XML_TOOL_RESULT_OPEN,
  XML_TOOL_RESULT_PREFIX,
  type ChatMessage,
} from '@astra/core';
import {
  RESTORED_SUMMARY_CHARS,
  renderRestored,
  summarizeRestoredInput,
  summarizeRestoredOutput,
} from './restore.js';

describe('summarizeRestoredInput — đối số của đường native', () => {
  it('parse JSON thô rồi mới chọn tham số, không hiện nguyên khối', () => {
    const raw = JSON.stringify({ limit: 8, path: 'docs/PLAN-V2.md', offset: 28 });

    expect(summarizeRestoredInput(raw)).toBe('docs/PLAN-V2.md');
  });

  it('lấy đúng đường dẫn kể cả khi đối số dài đứng trước', () => {
    const raw = JSON.stringify({
      new_string: '| 5 | Task Automation 1 | **Còn thiếu mẫu** | `todo_write` + UI checklist |',
      path: 'docs/PLAN-V2.md',
      old_string: '| 5 | Task Automation |',
    });

    // `path` được ưu tiên dù nằm sau `new_string` trong JSON — thứ người ta nhớ
    // về một lần sửa là file nào, không phải chuỗi thay thế.
    expect(summarizeRestoredInput(raw)).toBe('docs/PLAN-V2.md');
  });

  it('object (đường XML) vẫn chạy như cũ', () => {
    expect(summarizeRestoredInput({ pattern: 'Task Automation' })).toBe('Task Automation');
  });

  /**
   * Model từng sinh ra JSON sai và `AgentLoop` từng phải sửa nó, nên phiên cũ
   * có chứa lời gọi hỏng. Ném ở đây nghĩa là phiên đó không mở lại được nữa.
   */
  it('JSON hỏng thì trả chuỗi thô, không ném', () => {
    expect(summarizeRestoredInput('{"path": "a.ts"')).toBe('{"path": "a.ts"');
  });

  it('chuỗi thường không phải JSON thì giữ nguyên', () => {
    expect(summarizeRestoredInput('pnpm test')).toBe('pnpm test');
  });

  it('cắt dòng quá dài kèm ellipsis', () => {
    const out = summarizeRestoredInput(JSON.stringify({ command: 'x'.repeat(200) }));
    expect(out).toHaveLength(RESTORED_SUMMARY_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('không có tham số chuỗi nào thì để trống', () => {
    expect(summarizeRestoredInput(JSON.stringify({ limit: 8, offset: 28 }))).toBe('');
  });
});

describe('summarizeRestoredOutput', () => {
  it('nhiều dòng thành số dòng', () => {
    expect(summarizeRestoredOutput('a\nb\nc')).toBe('3 lines');
  });

  it('một dòng thì giữ nguyên văn', () => {
    expect(summarizeRestoredOutput('  Edited docs/PLAN-V2.md  ')).toBe('Edited docs/PLAN-V2.md');
  });

  it('rỗng thì để trống, không sinh dòng thừa', () => {
    expect(summarizeRestoredOutput('   \n  ')).toBe('');
  });
});

describe('renderRestored — ghép lời gọi với kết quả', () => {
  it('đường native: ghép theo thứ tự gọi', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'sửa file' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: '1', name: 'read_file', arguments: JSON.stringify({ path: 'a.ts' }) },
          { id: '2', name: 'edit_file', arguments: JSON.stringify({ path: 'b.ts' }) },
        ],
      },
      { role: 'tool', toolCallId: '1', content: 'x\ny' },
      { role: 'tool', toolCallId: '2', content: 'Edited b.ts' },
    ];

    const out = renderRestored(history, ['read_file', 'edit_file']);
    const tools = out.find((m) => m.role === 'tool');

    expect(tools).toEqual({
      role: 'tool',
      tools: [
        { name: 'read_file', input: 'a.ts', output: '2 lines', callId: '1' },
        { name: 'edit_file', input: 'b.ts', output: 'Edited b.ts', callId: '2' },
      ],
    });
  });

  it('ghép theo ID, không theo thứ tự message', () => {
    const history: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', name: 'read_file', arguments: '{"path":"a.ts"}' },
          { id: 'b', name: 'read_file', arguments: '{"path":"b.ts"}' },
        ],
      },
      // Gateway trả kết quả không đúng thứ tự gọi — ghép theo thứ tự thì hai
      // dòng đổi chỗ cho nhau, và không có gì trên màn hình nói rằng đã đổi.
      { role: 'tool', toolCallId: 'b', content: 'nội dung của b' },
      { role: 'tool', toolCallId: 'a', content: 'nội dung của a' },
    ];

    const out = renderRestored(history, []);
    const tools = out.find((m) => m.role === 'tool');

    expect(tools?.role === 'tool' && tools.tools.map((t) => [t.input, t.output])).toEqual([
      ['a.ts', 'nội dung của a'],
      ['b.ts', 'nội dung của b'],
    ]);
  });
});

/**
 * `messages` là thứ gửi cho MODEL: văn bản trong đó là tiếng Việt của prompt
 * layer. Mở lại phiên cũ mà lấy thẳng ra hiện thì giao diện tiếng Anh chen lẫn
 * tiếng Việt, và phần tiếng Việt lại đúng là phần nói kết quả.
 */
describe('renderRestored — tóm tắt đã lưu thắng nội dung gửi model', () => {
  const history: ChatMessage[] = [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'edit_file', arguments: '{"path":"docs/PLAN-V2.md"}' }],
    },
    { role: 'tool', toolCallId: 'c1', content: 'Đã sửa docs/PLAN-V2.md (+1/−1).' },
  ];

  function firstTool(summaries?: Record<string, { summary: string; isError: boolean }>) {
    const out = renderRestored(history, [], summaries);
    const tools = out.find((m) => m.role === 'tool');
    return tools?.role === 'tool' ? tools.tools[0] : undefined;
  }

  it('dùng chuỗi UI đã lưu thay cho chuỗi gửi model', () => {
    const tool = firstTool({ c1: { summary: 'Edited docs/PLAN-V2.md (+1/−1)', isError: false } });

    expect(tool?.output).toBe('Edited docs/PLAN-V2.md (+1/−1)');
    expect(tool?.output).not.toContain('Đã sửa');
  });

  it('giữ được trạng thái hỏng', () => {
    expect(firstTool({ c1: { summary: 'File not found', isError: true } })?.isError).toBe(true);
  });

  /**
   * Phiên v1 không có trường này. Nó phải mở được như cũ — mất bản tiếng Anh là
   * chấp nhận được, mở không ra thì không.
   */
  it('phiên cũ không có tóm tắt thì rơi về nội dung gửi model', () => {
    const tool = firstTool();

    expect(tool?.output).toBe('Đã sửa docs/PLAN-V2.md (+1/−1).');
    expect(tool?.isError).toBeUndefined();
  });

  it('không biết hỏng hay không thì để trống, không khai là thành công', () => {
    expect(firstTool({ c1: { summary: 'Edited a file', isError: false } })?.isError).toBeUndefined();
  });

  it('giữ lời người dùng và văn xuôi của assistant', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'câu hỏi' },
      { role: 'assistant', content: 'câu trả lời' },
    ];

    expect(renderRestored(history, [])).toEqual([
      { role: 'user', content: 'câu hỏi' },
      { role: 'assistant', content: 'câu trả lời' },
    ]);
  });

  /**
   * Kết quả tool ở đường XML đi dưới vai `user`. Để lọt là hội thoại cũ hiện
   * một khối `<tool_result>` trông y như lời người dùng từng nói.
   */
  it('không nhầm kết quả tool ở vai user thành lời người dùng', () => {
    // Khuôn do chính AgentLoop dựng — dùng hằng của core chứ không chép tay,
    // để đổi khuôn bên đó thì ca này vỡ ngay thay vì âm thầm hết kiểm gì.
    const result =
      `${XML_TOOL_RESULT_PREFIX}\n` +
      `${XML_TOOL_RESULT_HEADING}grep\n` +
      `${XML_TOOL_RESULT_OPEN}\na\nb\n</tool_result>`;

    const history: ChatMessage[] = [
      { role: 'user', content: 'tìm giúp' },
      { role: 'assistant', content: '<grep><pattern>foo</pattern></grep>' },
      { role: 'user', content: result },
    ];

    const out = renderRestored(history, ['grep']);
    const users = out.filter((m) => m.role === 'user');

    expect(users).toHaveLength(1);
    expect(users[0]).toEqual({ role: 'user', content: 'tìm giúp' });
  });
});
