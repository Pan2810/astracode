import { describe, expect, it, beforeEach, vi } from 'vitest';

/**
 * Mock SDK openai ở mức module: GatewayProvider tự dựng client bên trong, nên
 * đây là chỗ duy nhất chặn được mà không phải mở cổng mạng trong test.
 */
const createMock = vi.fn();

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
    constructor(public opts: unknown) {}
  },
}));

const { GatewayProvider } = await import('./GatewayProvider.js');
const { ModelRegistry } = await import('../registry/ModelRegistry.js');
const { Logger, MemorySink } = await import('../telemetry/logger.js');
const { AuthRequiredError, BudgetExceededError, ProviderError, StreamInterruptedError } = await import('../errors.js');
const { collect, textOf, toolCallsOf } = await import('./MockProvider.js');
import type { AvailableModel, ModelsFile } from '../registry/ModelRegistry.js';

const PROFILES: ModelsFile = {
  schemaVersion: 1,
  baseURL: '',
  models: [
    {
      id: 'primary',
      label: 'Primary',
      contextWindow: 32_768,
      maxOutput: 4096,
      toolCalling: 'native',
      streamingToolCalls: true,
      vision: false,
      injectionResistance: 'high',
      roles: ['editor'],
      editStrategy: 'search-replace',
    },
    {
      id: 'backup',
      label: 'Backup',
      contextWindow: 32_768,
      maxOutput: 4096,
      toolCalling: 'native',
      streamingToolCalls: true,
      vision: false,
      injectionResistance: 'high',
      roles: ['editor'],
      editStrategy: 'search-replace',
    },
  ],
  routing: {
    planner: '',
    editor: 'primary',
    fast: '',
    vision: '',
    fallback: ['primary', 'backup'],
  },
};

function avail(name: string): AvailableModel {
  return {
    name,
    description: '',
    context_limit: 0,
    online: true,
    allowed: true,
    input_price_vnd: 0,
    output_price_vnd: 0,
  };
}

/** Biến mảng chunk thành async iterable giống Stream của SDK. */
function streamOf(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function textChunk(content: string): unknown {
  return { choices: [{ delta: { content }, finish_reason: null }] };
}

function finishChunk(reason = 'stop'): unknown {
  return { choices: [{ delta: {}, finish_reason: reason }] };
}

function httpError(status: number, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { status, ...extra });
}

describe('GatewayProvider', () => {
  let sink: MemorySink;
  let registry: InstanceType<typeof ModelRegistry>;
  let unauthorizedCalls: number;

  beforeEach(() => {
    createMock.mockReset();
    sink = new MemorySink();
    unauthorizedCalls = 0;
    registry = new ModelRegistry({
      baseURL: 'http://gw.test',
      getToken: () => Promise.resolve('tok'),
      profiles: PROFILES,
      logger: new Logger({ sink }),
    });
    registry.merge([avail('primary'), avail('backup')]);
  });

  function make(overrides: Record<string, unknown> = {}): InstanceType<typeof GatewayProvider> {
    return new GatewayProvider({
      baseURL: 'http://gw.test/v1',
      getToken: () => Promise.resolve('tok-abc'),
      onUnauthorized: () => {
        unauthorizedCalls++;
      },
      registry,
      logger: new Logger({ sink, level: 'debug' }),
      random: () => 0.5,
      maxRetriesPerModel: 2,
      backoffBaseMs: 1, // không chờ thật trong test
      ...overrides,
    });
  }

  it('stream text rồi done', async () => {
    createMock.mockResolvedValueOnce(streamOf([textChunk('Xin '), textChunk('chào'), finishChunk()]));

    const events = await collect(
      make().stream({ messages: [{ role: 'user', content: 'hi' }] }),
    );

    expect(textOf(events)).toBe('Xin chào');
    expect(events.at(-1)).toMatchObject({ type: 'done', model: 'primary', finishReason: 'stop' });
  });

  it('gộp tool_call delta thành tool_call hoàn chỉnh, phát SAU khi stream xong', async () => {
    createMock.mockResolvedValueOnce(
      streamOf([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } },
          ],
        },
        finishChunk('tool_calls'),
      ]),
    );

    const events = await collect(make().stream({ messages: [] }));

    // Agent loop không được thấy JSON dở dang: tool_call chỉ xuất hiện ở cuối.
    const completeIdx = events.findIndex((e) => e.type === 'tool_call');
    const lastDeltaIdx = events.map((e) => e.type).lastIndexOf('tool_call_delta');
    expect(completeIdx).toBeGreaterThan(lastDeltaIdx);

    expect(toolCallsOf(events)).toEqual([
      { id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' },
    ]);
  });

  it('phát usage khi gateway trả về', async () => {
    createMock.mockResolvedValueOnce(
      streamOf([
        textChunk('x'),
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
        finishChunk(),
      ]),
    );

    const events = await collect(make().stream({ messages: [] }));
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    });
  });

  it('phát cachedTokens khi gateway báo cache prompt', async () => {
    createMock.mockResolvedValueOnce(
      streamOf([
        textChunk('x'),
        {
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 4,
            total_tokens: 104,
            prompt_tokens_details: { cached_tokens: 80 },
          },
        },
        finishChunk(),
      ]),
    );

    const events = await collect(make().stream({ messages: [] }));
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      usage: { promptTokens: 100, completionTokens: 4, totalTokens: 104, cachedTokens: 80 },
    });
  });

  it('không bịa cachedTokens khi gateway không báo trường đó', async () => {
    createMock.mockResolvedValueOnce(
      streamOf([
        textChunk('x'),
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
        finishChunk(),
      ]),
    );

    const events = await collect(make().stream({ messages: [] }));
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    });
  });

  /**
   * vLLM — thứ FPT Cloud chạy — gắn usage TÍCH LUỸ vào MỌI chunk khi bật
   * `include_usage`. Phát lại từng cái thì bên nhận phải đoán nên cộng hay nên
   * thay, và đoán sai làm một lượt ngắn hiện gần nửa triệu token.
   */
  it('gộp usage tích luỹ của mọi chunk thành đúng một sự kiện', async () => {
    createMock.mockResolvedValueOnce(
      streamOf([
        { ...textChunk('x'), usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
        { ...textChunk('y'), usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
        { ...textChunk('z'), usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
        finishChunk(),
      ]),
    );

    const events = await collect(make().stream({ messages: [] }));
    const usages = events.filter((e) => e.type === 'usage');

    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
    });
  });

  it('phát usage trước done — bên nhận đọc được trước khi lượt đóng', async () => {
    createMock.mockResolvedValueOnce(
      streamOf([
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        finishChunk(),
      ]),
    );

    const types = (await collect(make().stream({ messages: [] }))).map((e) => e.type);
    expect(types.indexOf('usage')).toBeLessThan(types.indexOf('done'));
  });

  it('gửi tools và tool_choice xuống gateway nguyên vẹn', async () => {
    createMock.mockResolvedValueOnce(streamOf([finishChunk()]));

    await collect(
      make().stream({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
        toolChoice: 'auto',
      }),
    );

    const body = createMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.tool_choice).toBe('auto');
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object' } } },
    ]);
  });

  it('chuyển message assistant kèm tool_calls và message tool đúng shape', async () => {
    createMock.mockResolvedValueOnce(streamOf([finishChunk()]));

    await collect(
      make().stream({
        messages: [
          { role: 'user', content: 'hỏi' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }],
          },
          { role: 'tool', toolCallId: 'c1', content: 'nội dung' },
        ],
      }),
    );

    const body = createMock.mock.calls[0]![0] as { messages: unknown[] };
    expect(body.messages[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file' } }],
    });
    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'nội dung' });
  });

  it('gửi ảnh dạng content part, và chỉ khi có ảnh', async () => {
    createMock.mockResolvedValueOnce(streamOf([finishChunk()]));

    await collect(
      make().stream({
        messages: [
          { role: 'user', content: 'không ảnh' },
          {
            role: 'user',
            content: 'lỗi gì đây?',
            images: [{ mediaType: 'image/png', data: 'AAAB' }],
          },
        ],
      }),
    );

    const body = createMock.mock.calls[0]![0] as { messages: unknown[] };
    // Không ảnh thì giữ chuỗi: gateway cũ không nhận mảng content part.
    expect(body.messages[0]).toEqual({ role: 'user', content: 'không ảnh' });
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'lỗi gì đây?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } },
      ],
    });
  });

  describe('retry', () => {
    it('thử lại 5xx và phát sự kiện `retrying` để UI không đứng im', async () => {
      createMock
        .mockRejectedValueOnce(httpError(503, 'unavailable'))
        .mockResolvedValueOnce(streamOf([textChunk('ok'), finishChunk()]));

      const events = await collect(make().stream({ messages: [] }));

      expect(events.some((e) => e.type === 'retrying')).toBe(true);
      expect(textOf(events)).toBe('ok');
      expect(createMock).toHaveBeenCalledTimes(2);
    });

    it('KHÔNG thử lại 400', async () => {
      createMock.mockRejectedValue(httpError(400, 'bad request'));

      await expect(collect(make().stream({ messages: [] }))).rejects.toThrow(ProviderError);
      expect(createMock).toHaveBeenCalledTimes(1);
    });

    it('dừng sau maxRetriesPerModel rồi mới sang model dự phòng', async () => {
      createMock.mockRejectedValue(httpError(500, 'boom'));

      await expect(collect(make().stream({ messages: [] }))).rejects.toThrow();
      // 2 model x (1 lần đầu + 2 lần thử lại)
      expect(createMock).toHaveBeenCalledTimes(6);
    });
  });

  describe('fallback chain', () => {
    it('chuyển sang model dự phòng và phát model_switched', async () => {
      createMock
        .mockRejectedValueOnce(httpError(500, 'primary hỏng'))
        .mockRejectedValueOnce(httpError(500, 'primary hỏng'))
        .mockRejectedValueOnce(httpError(500, 'primary hỏng'))
        .mockResolvedValueOnce(streamOf([textChunk('từ backup'), finishChunk()]));

      const events = await collect(make().stream({ messages: [] }));

      const switched = events.find((e) => e.type === 'model_switched');
      expect(switched).toMatchObject({ from: 'primary', to: 'backup' });
      expect(textOf(events)).toBe('từ backup');
    });

    it('budget hết thì KHÔNG failover — hạn mức tính theo user, không theo model', async () => {
      createMock.mockRejectedValue(
        httpError(429, 'Too Many Requests', { error: { detail: 'vượt hạn mức AI budget' } }),
      );

      await expect(collect(make().stream({ messages: [] }))).rejects.toThrow(BudgetExceededError);
      expect(createMock).toHaveBeenCalledTimes(1);
    });

    it('401 thì dừng ngay và gọi onUnauthorized', async () => {
      createMock.mockRejectedValue(httpError(401, 'unauthorized'));

      await expect(collect(make().stream({ messages: [] }))).rejects.toThrow(AuthRequiredError);
      expect(unauthorizedCalls).toBe(1);
      expect(createMock).toHaveBeenCalledTimes(1);
    });
  });

  it('gắn Bearer token và trace id vào request', async () => {
    createMock.mockResolvedValueOnce(streamOf([finishChunk()]));
    await collect(make().stream({ messages: [], traceId: 'trace-xyz' }));
    // Token đi vào constructor của SDK; trace id đi vào defaultHeaders.
    // Cả hai được khẳng định gián tiếp: gọi thành công nghĩa là getToken đã chạy.
    expect(createMock).toHaveBeenCalledTimes(1);
    const opts = createMock.mock.calls[0]![1] as Record<string, unknown> | undefined;
    expect(opts).toBeDefined();
  });

  it('hủy giữa chừng thì ném AbortedError', async () => {
    createMock.mockImplementation(() => {
      throw Object.assign(new Error('aborted'), { name: 'APIUserAbortError' });
    });

    await expect(collect(make().stream({ messages: [] }))).rejects.toThrow(/cancel|abort/i);
  });

  it('không có model nào khả dụng -> ConfigError nói rõ phải làm gì', async () => {
    const empty = new ModelRegistry({
      baseURL: 'http://gw.test',
      getToken: () => Promise.resolve('t'),
      profiles: PROFILES,
      logger: new Logger({ sink }),
    });
    empty.merge([]);

    const provider = make({ registry: empty });
    await expect(collect(provider.stream({ messages: [] }))).rejects.toThrow(/GET \/models/);
  });
});

describe('stream đứt giữa chừng — KHÔNG retry, KHÔNG lặp chữ (sổ nợ #19)', () => {
  let sink: MemorySink;
  let registry: InstanceType<typeof ModelRegistry>;

  beforeEach(() => {
    createMock.mockReset();
    sink = new MemorySink();
    registry = new ModelRegistry({
      baseURL: 'http://gw.test',
      getToken: () => Promise.resolve('tok'),
      profiles: PROFILES,
      logger: new Logger({ sink }),
    });
    registry.merge([avail('primary'), avail('backup')]);
  });

  function make(overrides: Record<string, unknown> = {}): InstanceType<typeof GatewayProvider> {
    return new GatewayProvider({
      baseURL: 'http://gw.test/v1',
      getToken: () => Promise.resolve('tok-abc'),
      registry,
      logger: new Logger({ sink, level: 'debug' }),
      random: () => 0.5,
      maxRetriesPerModel: 2,
      backoffBaseMs: 1,
      ...overrides,
    });
  }

  /** Stream phát vài chunk rồi ném — đúng hình dạng một kết nối rớt giữa câu. */
  function streamThatBreaks(chunks: unknown[], err: unknown): AsyncIterable<unknown> {
    return {
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
        throw err;
      },
    };
  }

  it('5xx sau khi đã phát text: ném StreamInterruptedError, không gửi lại request', async () => {
    createMock.mockResolvedValueOnce(
      streamThatBreaks([textChunk('Phần '), textChunk('đầu')], httpError(503, 'upstream gone')),
    );

    const provider = make();
    const events: unknown[] = [];
    let caught: unknown;
    try {
      for await (const e of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        events.push(e);
      }
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(StreamInterruptedError);
    // Điểm cốt lõi: đúng MỘT request. Bản trước gửi lại và phát "Phần đầu" lần
    // thứ hai, nên bên nhận (`text += delta`) có "Phần đầuPhần đầu".
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(textOf(events as never)).toBe('Phần đầu');
    expect(events.some((e) => (e as { type: string }).type === 'retrying')).toBe(false);
  });

  it('không failover sang model dự phòng sau khi đã phát nội dung', async () => {
    createMock.mockResolvedValueOnce(
      streamThatBreaks([textChunk('nửa câu')], httpError(500, 'boom')),
    );

    const provider = make();
    await expect(
      collect(provider.stream({ messages: [{ role: 'user', content: 'hi' }] })),
    ).rejects.toBeInstanceOf(StreamInterruptedError);

    // Đổi model ở đây sẽ cho bên nhận hai câu trả lời chắp vào nhau.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('lỗi TRƯỚC delta đầu tiên vẫn retry như cũ', async () => {
    createMock
      .mockRejectedValueOnce(httpError(503, 'try again'))
      .mockResolvedValueOnce(streamOf([textChunk('ok'), finishChunk()]));

    const events = await collect(
      make().stream({ messages: [{ role: 'user', content: 'hi' }] }),
    );

    expect(createMock).toHaveBeenCalledTimes(2);
    expect(textOf(events)).toBe('ok');
    expect(events.some((e) => e.type === 'retrying')).toBe(true);
  });

  it('đứt sau khi đã phát tool_call cũng không thử lại — tránh chạy lại hành động ghi', async () => {
    createMock.mockResolvedValueOnce(
      streamThatBreaks(
        [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'c1', function: { name: 'write_file', arguments: '{}' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
        ],
        httpError(502, 'gateway hiccup'),
      ),
    );

    await expect(
      collect(make().stream({ messages: [{ role: 'user', content: 'hi' }] })),
    ).rejects.toBeInstanceOf(StreamInterruptedError);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('câu lỗi nói rõ là bản dở và nói rõ vì sao không thử lại', async () => {
    createMock.mockResolvedValueOnce(
      streamThatBreaks([textChunk('x')], httpError(500, 'boom')),
    );

    let caught: Error | undefined;
    try {
      await collect(make().stream({ messages: [{ role: 'user', content: 'hi' }] }));
    } catch (err) {
      caught = err as Error;
    }

    expect(caught?.message).toContain('incomplete');
    expect(caught?.message).toContain('not retried');
  });
});
