/**
 * Provider giả cho test và cho eval harness (M2.5).
 *
 * Nguyên tắc: test dùng mock, KHÔNG gọi mạng thật. Không
 * có thứ này thì test agent loop ở M2 sẽ chậm, đắt và không tất định.
 */
import type { Provider, ProviderEvent, StreamRequest, ToolCall, TokenUsage } from './types.js';

export interface ScriptedTurn {
  /** Text phát ra theo từng mẩu, để mô phỏng streaming thật. */
  text?: string[];
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  finishReason?: 'stop' | 'tool_calls' | 'length';
  /** Ném lỗi này thay vì trả kết quả — để test retry và fallback. */
  error?: unknown;
  /** Trễ giả lập giữa các mẩu, mặc định 0 để test chạy nhanh. */
  delayMs?: number;
}

export interface MockProviderOptions {
  turns: ScriptedTurn[];
  model?: string;
  /** Lặp lại turn cuối khi hết kịch bản, thay vì ném lỗi. */
  repeatLast?: boolean;
}

export class MockProvider implements Provider {
  private index = 0;
  /** Mọi request đã nhận — để test khẳng định được cái gì đã gửi đi. */
  readonly requests: StreamRequest[] = [];

  constructor(private readonly opts: MockProviderOptions) {}

  reset(): void {
    this.index = 0;
    this.requests.length = 0;
  }

  async *stream(req: StreamRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req);

    const turn = this.nextTurn();
    const model = req.model ?? this.opts.model ?? 'mock-model';

    if (turn.error) throw turn.error;

    for (const piece of turn.text ?? []) {
      if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (turn.delayMs) await sleep(turn.delayMs, req.signal);
      yield { type: 'text', delta: piece };
    }

    const calls = turn.toolCalls ?? [];
    for (const [index, call] of calls.entries()) {
      // Phát delta trước rồi mới phát bản hoàn chỉnh — giống hệt gateway thật,
      // để test bắt được lỗi ở nơi tiêu thụ nếu nó xử lý delta sai.
      yield {
        type: 'tool_call_delta',
        index,
        id: call.id,
        name: call.name,
        argumentsDelta: call.arguments,
      };
      yield { type: 'tool_call', index, call };
    }

    if (turn.usage) yield { type: 'usage', usage: turn.usage };

    yield {
      type: 'done',
      model,
      finishReason: turn.finishReason ?? (calls.length > 0 ? 'tool_calls' : 'stop'),
    };
  }

  private nextTurn(): ScriptedTurn {
    const turn = this.opts.turns[this.index];
    if (turn) {
      this.index++;
      return turn;
    }
    const last = this.opts.turns[this.opts.turns.length - 1];
    if (this.opts.repeatLast && last) return last;
    throw new Error(
      `MockProvider hết kịch bản: đã dùng ${this.index} turn nhưng chỉ có ${this.opts.turns.length}.`,
    );
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/** Gom toàn bộ sự kiện của một stream — tiện cho test. */
export async function collect(
  stream: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

/** Ghép các mẩu text thành chuỗi hoàn chỉnh — tiện cho test và demo. */
export function textOf(events: ProviderEvent[]): string {
  return events
    .filter((e): e is Extract<ProviderEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.delta)
    .join('');
}

export function toolCallsOf(events: ProviderEvent[]): ToolCall[] {
  return events
    .filter((e): e is Extract<ProviderEvent, { type: 'tool_call' }> => e.type === 'tool_call')
    .map((e) => e.call);
}
