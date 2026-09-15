import { describe, expect, it } from 'vitest';
import { MockProvider, collect, textOf, toolCallsOf } from './MockProvider.js';

describe('MockProvider', () => {
  it('phát text theo từng mẩu rồi done', async () => {
    const p = new MockProvider({ turns: [{ text: ['Xin ', 'chào'] }] });
    const events = await collect(p.stream({ messages: [{ role: 'user', content: 'hi' }] }));

    expect(events.map((e) => e.type)).toEqual(['text', 'text', 'done']);
    expect(textOf(events)).toBe('Xin chào');
  });

  it('phát tool_call_delta trước rồi tool_call hoàn chỉnh', async () => {
    const p = new MockProvider({
      turns: [
        {
          toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
        },
      ],
    });
    const events = await collect(p.stream({ messages: [] }));

    expect(events.map((e) => e.type)).toEqual(['tool_call_delta', 'tool_call', 'done']);
    expect(toolCallsOf(events)).toEqual([
      { id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' },
    ]);
    const done = events.at(-1);
    expect(done).toMatchObject({ type: 'done', finishReason: 'tool_calls' });
  });

  it('ghi lại mọi request để test khẳng định được cái gì đã gửi', async () => {
    const p = new MockProvider({ turns: [{ text: ['a'] }, { text: ['b'] }] });
    await collect(p.stream({ messages: [{ role: 'user', content: 'một' }] }));
    await collect(p.stream({ messages: [{ role: 'user', content: 'hai' }] }));

    expect(p.requests).toHaveLength(2);
    expect(p.requests[1]!.messages[0]).toMatchObject({ content: 'hai' });
  });

  it('ném lỗi theo kịch bản — để test retry và fallback', async () => {
    const boom = Object.assign(new Error('server error'), { status: 503 });
    const p = new MockProvider({ turns: [{ error: boom }] });
    await expect(collect(p.stream({ messages: [] }))).rejects.toThrow('server error');
  });

  it('hết kịch bản thì báo lỗi rõ ràng thay vì im lặng', async () => {
    const p = new MockProvider({ turns: [{ text: ['a'] }] });
    await collect(p.stream({ messages: [] }));
    await expect(collect(p.stream({ messages: [] }))).rejects.toThrow(/hết kịch bản/);
  });

  it('repeatLast cho phép lặp turn cuối', async () => {
    const p = new MockProvider({ turns: [{ text: ['x'] }], repeatLast: true });
    await collect(p.stream({ messages: [] }));
    const second = await collect(p.stream({ messages: [] }));
    expect(textOf(second)).toBe('x');
  });

  it('tôn trọng AbortSignal', async () => {
    const p = new MockProvider({ turns: [{ text: ['a', 'b'], delayMs: 50 }] });
    const ac = new AbortController();
    const promise = collect(p.stream({ messages: [], signal: ac.signal }));
    ac.abort();
    await expect(promise).rejects.toThrow(/abort/i);
  });

  it('reset đưa về turn đầu', async () => {
    const p = new MockProvider({ turns: [{ text: ['1'] }, { text: ['2'] }] });
    await collect(p.stream({ messages: [] }));
    p.reset();
    expect(textOf(await collect(p.stream({ messages: [] })))).toBe('1');
    expect(p.requests).toHaveLength(1);
  });
});
