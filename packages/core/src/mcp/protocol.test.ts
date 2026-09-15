import { describe, expect, it } from 'vitest';
import { LineDecoder, MAX_LINE_CHARS, encodeMessage, isResponse } from './protocol.js';

describe('encodeMessage', () => {
  it('kết thúc bằng đúng một xuống dòng', () => {
    const line = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1).includes('\n')).toBe(false);
  });

  it('nội dung có xuống dòng vẫn nằm gọn trên một dòng', () => {
    const line = encodeMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { text: 'dòng 1\ndòng 2' },
    });
    expect(line.split('\n')).toHaveLength(2);
    expect(JSON.parse(line)).toMatchObject({ params: { text: 'dòng 1\ndòng 2' } });
  });
});

describe('LineDecoder', () => {
  it('gộp được thông điệp bị cắt làm nhiều mẩu', () => {
    const d = new LineDecoder();
    expect(d.push('{"jsonrpc":"2.0",').messages).toEqual([]);
    expect(d.push('"id":1,"result":{"ok"').messages).toEqual([]);
    const r = d.push(':true}}\n');
    expect(r.messages).toHaveLength(1);
    expect((r.messages[0] as { result: unknown }).result).toEqual({ ok: true });
  });

  it('tách được nhiều thông điệp trong một mẩu', () => {
    const d = new LineDecoder();
    const r = d.push('{"jsonrpc":"2.0","id":1,"result":1}\n{"jsonrpc":"2.0","id":2,"result":2}\n');
    expect(r.messages).toHaveLength(2);
  });

  it('bỏ qua dòng rác mà không ném — server MCP hay in log ra stdout', () => {
    const d = new LineDecoder();
    const r = d.push('Server listening on stdio\n{"jsonrpc":"2.0","id":1,"result":{}}\n');
    expect(r.messages).toHaveLength(1);
    expect(r.junk).toEqual(['Server listening on stdio']);
  });

  it('bỏ qua JSON hợp lệ nhưng không phải JSON-RPC', () => {
    const d = new LineDecoder();
    const r = d.push('{"hello":"world"}\n');
    expect(r.messages).toEqual([]);
    expect(r.junk).toHaveLength(1);
  });

  it('chịu được CRLF', () => {
    const d = new LineDecoder();
    const r = d.push('{"jsonrpc":"2.0","id":7,"result":{}}\r\n');
    expect(r.messages).toHaveLength(1);
    expect((r.messages[0] as { id: number }).id).toBe(7);
  });

  it('dòng dài vô hạn không làm phình bộ đệm mãi', () => {
    const d = new LineDecoder();
    const r = d.push('x'.repeat(MAX_LINE_CHARS + 10));
    expect(r.messages).toEqual([]);
    expect(r.junk[0]).toContain('vượt');
    expect(d.pending()).toBe('');
  });

  it('phân biệt phản hồi với lời gọi ngược từ server', () => {
    const d = new LineDecoder();
    const r = d.push(
      '{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","id":2,"method":"sampling/createMessage"}\n{"jsonrpc":"2.0","method":"notifications/progress"}\n',
    );
    expect(r.messages.map(isResponse)).toEqual([true, false, false]);
  });
});
