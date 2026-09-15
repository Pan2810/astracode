/**
 * GatewayProvider — gọi model qua gateway AstraWork (ADR-011).
 *
 * Phụ thuộc vào endpoint `POST /v1/chat/completions` mà M0.5 thêm vào AstraWork:
 * shape OpenAI-compatible, truyền nguyên vẹn tools/tool_calls.
 *
 * KHÔNG có đường gọi thẳng FPT ở đây. Gateway chết thì báo lỗi rõ ràng — âm
 * thầm đổi đích sẽ vượt qua RBAC, audit và redaction của gateway mà không ai
 * biết (documents/SECURITY.md §2).
 */
import OpenAI from 'openai';
import type {
  ChatMessage,
  FinishReason,
  Provider,
  ProviderEvent,
  StreamRequest,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from './types.js';
import { backoffDelay, classifyHttpError, delay, RAW_ERROR_BODY } from './retry.js';
import {
  AbortedError,
  AuthRequiredError,
  ConfigError,
  GatewayUnreachableError,
  isAbortError,
  ProviderError,
  StreamInterruptedError,
} from '../errors.js';
import type { Logger } from '../telemetry/logger.js';
import { newTraceId } from '../telemetry/logger.js';
import type { ModelRegistry } from '../registry/ModelRegistry.js';

export interface GatewayProviderOptions {
  /** Gốc gateway KÈM /v1. Ví dụ: http://localhost:8000/v1 */
  baseURL: string;
  /** Lấy JWT hiện hành. Ném AuthRequiredError nếu chưa đăng nhập. */
  getToken: () => Promise<string>;
  /** Gọi khi gateway trả 401 — xóa token, báo UI cần đăng nhập lại. */
  onUnauthorized?: () => Promise<void> | void;
  registry: ModelRegistry;
  logger: Logger;
  maxRetriesPerModel?: number;
  timeoutMs?: number;
  /** Nguồn ngẫu nhiên cho jitter — tiêm vào để test tất định. */
  random?: () => number;
  /** Delay gốc của backoff. Test đặt xuống ~1ms để không chờ thật. */
  backoffBaseMs?: number;
}

export class GatewayProvider implements Provider {
  private readonly opts: Required<Omit<GatewayProviderOptions, 'onUnauthorized'>> &
    Pick<GatewayProviderOptions, 'onUnauthorized'>;

  constructor(opts: GatewayProviderOptions) {
    if (!opts.baseURL) throw new ConfigError('The AstraWork gateway baseURL is missing');
    this.opts = {
      maxRetriesPerModel: 3,
      timeoutMs: 180_000,
      random: Math.random,
      backoffBaseMs: 500,
      ...opts,
      baseURL: opts.baseURL.replace(/\/+$/, ''),
    };
  }

  async *stream(req: StreamRequest): AsyncIterable<ProviderEvent> {
    const traceId = req.traceId ?? newTraceId();
    const log = this.opts.logger.child({ traceId });

    const chain = this.resolveChain(req);
    if (chain.length === 0) {
      throw new ConfigError(
        'No model is available. Check that you are signed in and that the gateway serves GET /models.',
      );
    }

    let lastError: unknown;

    for (let i = 0; i < chain.length; i++) {
      const model = chain[i]!;
      if (i > 0) {
        yield {
          type: 'model_switched',
          from: chain[i - 1]!,
          to: model,
          reason: describeError(lastError),
        };
        log.warn('chuyển model dự phòng', { from: chain[i - 1], to: model, reason: describeError(lastError) });
      }

      try {
        yield* this.streamOneModel(model, req, log, traceId);
        return;
      } catch (err) {
        if (isAbortError(err)) throw new AbortedError();
        lastError = err;

        const classified = classifyHttpError(err);
        log.error('model lỗi', { model, code: classified.code, message: classified.message });

        // Không failover được thì dừng luôn — đổi model không cứu được
        // 401 (chưa đăng nhập) hay budget (tính theo user, không theo model).
        // `StreamInterruptedError` cũng vào đây: đã phát nội dung ra ngoài rồi
        // thì đổi model chỉ làm bên nhận có hai câu trả lời chắp vào nhau.
        if (!classified.failoverable) throw classified;
      }
    }

    throw classifyHttpError(lastError);
  }

  /** Model chính + các model dự phòng, đã lọc trùng. */
  private resolveChain(req: StreamRequest): string[] {
    const primary = req.model ?? this.opts.registry.resolve(req.role ?? 'editor');
    const chain = primary ? [primary] : [];
    for (const fallback of this.opts.registry.fallbackChain()) {
      if (!chain.includes(fallback)) chain.push(fallback);
    }
    return chain;
  }

  private async *streamOneModel(
    model: string,
    req: StreamRequest,
    log: Logger,
    traceId: string,
  ): AsyncIterable<ProviderEvent> {
    const max = this.opts.maxRetriesPerModel;

    for (let attempt = 1; ; attempt++) {
      /**
       * Đã có nội dung của LẦN THỬ NÀY chảy ra ngoài chưa.
       *
       * Đặt lại ở mỗi lần thử, và chỉ cần bật một lần là mọi đường retry/failover
       * bị đóng — xem `StreamInterruptedError`. Vì thế vòng lặp này lặp lại
       * `attempt()` bằng `for await` chứ không phải `yield*`: `yield*` không cho
       * chỗ nào quan sát xem đã phát được gì.
       */
      let emitted = false;

      try {
        for await (const event of this.attempt(model, req, log, traceId)) {
          // `usage`, `retrying`, `model_switched` không phải nội dung câu trả lời;
          // phát lại chúng vô hại. `text` và tool call thì không.
          if (
            event.type === 'text' ||
            event.type === 'tool_call' ||
            event.type === 'tool_call_delta'
          ) {
            emitted = true;
          }
          yield event;
        }
        return;
      } catch (err) {
        if (isAbortError(err)) throw new AbortedError();

        const classified = classifyHttpError(err);

        if (emitted) {
          // Đây là chỗ sửa lỗi "retry giữa stream làm lặp chữ": tới đây thì bên
          // nhận đã giữ một phần câu trả lời, nên gửi lại request là nhân đôi
          // nó. Ném ra để tầng trên quyết định, kèm nói rõ là bản dở.
          log.warn('stream đứt sau khi đã phát nội dung, KHÔNG thử lại', {
            model,
            attempt,
            code: classified.code,
          });
          throw new StreamInterruptedError(
            classified.message,
            classified instanceof ProviderError ? classified.status : undefined,
            err,
          );
        }

        if (classified instanceof AuthRequiredError) {
          await this.opts.onUnauthorized?.();
          throw classified;
        }
        if (!classified.retryable || attempt > max) throw classified;

        const explicit =
          'retryAfterMs' in classified ? (classified.retryAfterMs as number | undefined) : undefined;
        const wait =
          explicit ??
          backoffDelay(attempt, {
            random: this.opts.random,
            baseMs: this.opts.backoffBaseMs,
          });

        log.warn('thử lại', { model, attempt, delayMs: wait, code: classified.code });
        yield { type: 'retrying', attempt, delayMs: wait, reason: classified.message };
        await delay(wait, req.signal);
      }
    }
  }

  private async *attempt(
    model: string,
    req: StreamRequest,
    log: Logger,
    traceId: string,
  ): AsyncIterable<ProviderEvent> {
    const token = await this.opts.getToken();

    // Chỗ giữ body của response lỗi. Phải chụp ở tầng fetch vì SDK đọc xong là
    // bỏ — xem `capturingFetch`.
    const errorBody: ErrorBodySink = {};

    const client = new OpenAI({
      apiKey: token,
      baseURL: this.opts.baseURL,
      maxRetries: 0, // Retry do lớp này quản, để phát được sự kiện `retrying`.
      timeout: this.opts.timeoutMs,
      defaultHeaders: { 'X-Astra-Trace-Id': traceId },
      fetch: capturingFetch(errorBody),
    });

    const started = Date.now();
    log.debug('gọi model', { model, messages: req.messages.length, tools: req.tools?.length ?? 0 });

    let stream;
    try {
      stream = await client.chat.completions.create(
        {
          model,
          messages: toOpenAIMessages(req.messages),
          ...(req.tools?.length ? { tools: toOpenAITools(req.tools) } : {}),
          ...(req.toolChoice ? { tool_choice: req.toolChoice } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
          stream: true,
          stream_options: { include_usage: true },
        },
        req.signal ? { signal: req.signal } : {},
      );
    } catch (err) {
      throw wrapNetworkError(err, this.opts.baseURL, errorBody.raw);
    }

    // Tool call về theo từng mẩu, gộp theo index. Chỉ phát `tool_call` hoàn
    // chỉnh khi stream kết thúc — agent loop không nên thấy JSON dở dang.
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: FinishReason = 'unknown';
    /**
     * Usage gom lại, phát MỘT lần khi stream xong.
     *
     * vLLM — thứ FPT Cloud chạy — gắn usage TÍCH LUỸ vào mọi chunk khi bật
     * `include_usage`, chứ không chỉ chunk cuối. Phát từng chunk thì bên nhận
     * phải tự đoán là nên cộng hay nên thay; đoán sai một lượt ngắn ra vài
     * trăm nghìn token. Ở đây quyết luôn: một request, một sự kiện usage.
     */
    let lastUsage: TokenUsage | undefined;

    try {
      for await (const chunk of stream) {
        const choice = chunk.choices[0];

        if (choice?.delta?.content) {
          yield { type: 'text', delta: choice.delta.content };
        }

        for (const tc of choice?.delta?.tool_calls ?? []) {
          const index = tc.index;
          const slot = pending.get(index) ?? { id: '', name: '', args: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          pending.set(index, slot);

          yield {
            type: 'tool_call_delta',
            index,
            ...(tc.id ? { id: tc.id } : {}),
            ...(tc.function?.name ? { name: tc.function.name } : {}),
            ...(tc.function?.arguments ? { argumentsDelta: tc.function.arguments } : {}),
          };
        }

        if (choice?.finish_reason) {
          finishReason = normalizeFinishReason(choice.finish_reason);
        }

        if (chunk.usage) {
          const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
          lastUsage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
            ...(cachedTokens !== undefined ? { cachedTokens } : {}),
          };
        }
      }
    } catch (err) {
      throw wrapNetworkError(err, this.opts.baseURL, errorBody.raw);
    }

    if (lastUsage) yield { type: 'usage', usage: lastUsage };

    for (const [index, slot] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      const call: ToolCall = {
        id: slot.id || `call_${index}`,
        name: slot.name,
        arguments: slot.args || '{}',
      };
      yield { type: 'tool_call', index, call };
    }

    log.debug('xong', {
      model,
      durationMs: Date.now() - started,
      finishReason,
      toolCalls: pending.size,
      promptTokens: lastUsage?.promptTokens,
      cachedTokens: lastUsage?.cachedTokens,
    });
    yield { type: 'done', model, finishReason };
  }
}

// ─── Chuyển đổi sang shape của OpenAI SDK ────────────────────────────────────

function toOpenAIMessages(
  messages: ChatMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user':
        // Không ảnh thì giữ nguyên dạng chuỗi: gateway nào cũng nuốt được, còn
        // mảng content part thì không phải bản nào cũng hỗ trợ.
        if (!m.images?.length) return { role: 'user', content: m.content };
        return {
          role: 'user',
          content: [
            ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
            ...m.images.map((img) => ({
              type: 'image_url' as const,
              image_url: { url: `data:${img.mediaType};base64,${img.data}` },
            })),
          ],
        };
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content,
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function' as const,
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        };
    }
  });
}

function toOpenAITools(
  tools: ToolDefinition[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function normalizeFinishReason(raw: string): FinishReason {
  switch (raw) {
    case 'stop':
    case 'tool_calls':
    case 'length':
    case 'content_filter':
      return raw;
    // Một số endpoint tương thích OpenAI vẫn trả tên cũ.
    case 'function_call':
      return 'tool_calls';
    default:
      return 'unknown';
  }
}

interface ErrorBodySink {
  raw?: string;
}

/** Kiểu `fetch` mà SDK openai nhận. Lấy từ chính option của nó để không phải
 * import subpath `openai/core`. */
type SdkFetch = NonNullable<NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetch']>;

/**
 * Trần cho body lỗi được chụp lại. Body lỗi thật của gateway là vài trăm byte;
 * ngần này chỉ để một response lỗi bất thường (trang HTML của proxy, stack trace
 * dài) không kéo cả một khối vào bộ nhớ chỉ để rồi bị parse hỏng.
 */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/**
 * `fetch` chụp lại body của response lỗi trước khi SDK openai kịp bỏ nó.
 *
 * Vì sao phải làm ở tầng này: `APIError.makeMessage` chỉ đọc `body.error`, nên
 * mọi lỗi kiểu FastAPI (`{"detail": ..., "findings": ...}` — chính là shape của
 * AstraWork) rơi vào nhánh cuối và biến thành đúng một câu
 * `"422 status code (no body)"`. Thông tin để biết phải làm gì bị bỏ ở đây, và
 * `AgentLoop` ở trên chỉ còn cách đoán. Có body thì `classifyHttpError` phân biệt
 * được "che nội dung rồi gửi lại" với "sai shape request".
 *
 * Chỉ `clone()` khi response KHÔNG ok: clone một response 200 đang stream sẽ đệm
 * toàn bộ câu trả lời vào bộ nhớ, đúng thứ streaming sinh ra để tránh.
 */
function capturingFetch(sink: ErrorBodySink): SdkFetch {
  const impl = async (
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const res = await fetch(url, init);
    if (res.ok) return res;

    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_ERROR_BODY_BYTES) return res;

    try {
      const text = await res.clone().text();
      sink.raw = text.length > MAX_ERROR_BODY_BYTES ? text.slice(0, MAX_ERROR_BODY_BYTES) : text;
    } catch {
      // Không đọc được body thì đường cũ vẫn chạy — chỉ là không có thêm thông
      // tin. Không được để việc chụp log làm hỏng chính lời gọi.
    }
    return res;
  };

  // Một lần cast, có lý do: kiểu `Fetch` của SDK dựng trên `@types/node-fetch`
  // còn `fetch` toàn cục của Node dựng trên `undici-types`. Hai bộ type khác
  // nhau mô tả cùng một object lúc chạy, và không có cách nào khớp chúng ở tầng
  // type mà không kéo `node-fetch` vào làm dependency thật.
  return impl as unknown as SdkFetch;
}

/**
 * Lỗi mạng (ECONNREFUSED, DNS, TLS) không có `status` — SDK bọc thành
 * APIConnectionError. Phân biệt với lỗi HTTP để thông báo cho user đúng việc
 * cần làm: "gateway không chạy" khác hẳn "model lỗi".
 *
 * `rawBody` là body đã chụp ở `capturingFetch`, gắn lên chính error object để
 * `classifyHttpError` đọc được — xem `RAW_ERROR_BODY`.
 */
function wrapNetworkError(err: unknown, baseURL: string, rawBody?: string): unknown {
  if (isAbortError(err)) return err;
  const e = err as { status?: number; name?: string };
  if (rawBody !== undefined && typeof err === 'object' && err !== null) {
    (err as Record<symbol, unknown>)[RAW_ERROR_BODY] = rawBody;
  }
  if (e?.status === 401) return new AuthRequiredError();
  if (e?.status === undefined && e?.name === 'APIConnectionError') {
    return new GatewayUnreachableError(baseURL, err);
  }
  return err;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? 'unknown');
}
