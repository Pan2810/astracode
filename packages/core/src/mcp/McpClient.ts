/**
 * Client MCP — nói chuyện với một server qua stdio (mốc M7).
 *
 * Client nhận `McpTransport` chứ không tự spawn tiến trình. Hai lý do, cái thứ
 * hai quan trọng hơn:
 *
 *   1. Test được toàn bộ handshake và timeout bằng transport giả, không cần
 *      Docker — mà máy phát triển hiện chưa có Docker.
 *   2. Việc sinh tiến trình chỉ nằm ở core/sandbox/ (eslint ép). Client không
 *      được phép biết mình đang chạy trong container hay trên máy trần: nếu nó
 *      biết, sớm muộn sẽ có một nhánh `if` chọn đường ít cách ly hơn.
 *
 * Mọi thứ server trả về là DỮ LIỆU KHÔNG TIN CẬY, kể cả `serverInfo.name`.
 * Client không diễn giải, không nâng quyền; nó chỉ chuyển tiếp lên McpManager.
 */
import type { Logger } from '../telemetry/logger.js';
import {
  LineDecoder,
  encodeMessage,
  isResponse,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from './protocol.js';
import type { McpToolInfo } from './types.js';

/** Phiên bản giao thức AstraCode nói. Server trả bản khác thì vẫn thử tiếp. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

export interface McpTransport {
  /** Gửi một dòng xuống stdin của server. */
  send(line: string): void;
  /** Đăng ký nhận stdout. Gọi một lần, trước khi gửi gì. */
  onData(cb: (chunk: string) => void): void;
  /** Đăng ký nhận stderr — chỉ để log, server MCP hay dùng nó làm nhật ký. */
  onStderr(cb: (chunk: string) => void): void;
  /** Tiến trình kết thúc (hoặc kết nối đứt). */
  onExit(cb: (info: { code: number; reason?: string }) => void): void;
  close(): Promise<void>;
}

export interface McpClientOptions {
  name: string;
  transport: McpTransport;
  logger: Logger;
  /** Trần thời gian cho một request. Mặc định 30s. */
  timeoutMs?: number;
  /** Trần ký tự cho nội dung một lời gọi tool trả về. */
  maxResultChars?: number;
}

export interface McpServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
  capabilities: Record<string, unknown>;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
  /** Số phần nội dung không phải text bị bỏ (ảnh, resource...). */
  droppedParts: number;
}

export class McpClientError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'McpClientError';
  }
}

interface Pending {
  resolve: (r: JsonRpcResponse) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_RESULT = 100_000;

export class McpClient {
  private readonly decoder = new LineDecoder();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private exitReason: string | undefined;
  private stderrTail = '';
  private initialized = false;

  constructor(private readonly opts: McpClientOptions) {
    opts.transport.onData((chunk) => this.onData(chunk));
    opts.transport.onStderr((chunk) => {
      // Giữ đuôi stderr để khi server chết còn nói được vì sao. Không log từng
      // mẩu: server MCP nói nhiều, và log của chúng không phải log của ta.
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    opts.transport.onExit((info) => this.onExit(info));
  }

  /** Handshake. Phải gọi trước mọi request khác. */
  async initialize(): Promise<McpServerInfo> {
    const res = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'AstraCode', version: '0.0.0' },
    });

    const result = (res.result ?? {}) as Record<string, unknown>;
    const info = (result['serverInfo'] ?? {}) as Record<string, unknown>;

    // Thông báo `initialized` là bắt buộc theo spec: nhiều server chặn mọi
    // request khác cho tới khi nhận được nó.
    this.notify('notifications/initialized');
    this.initialized = true;

    return {
      name: typeof info['name'] === 'string' ? info['name'] : this.opts.name,
      version: typeof info['version'] === 'string' ? info['version'] : '?',
      protocolVersion:
        typeof result['protocolVersion'] === 'string' ? result['protocolVersion'] : '?',
      capabilities: (result['capabilities'] ?? {}) as Record<string, unknown>,
    };
  }

  /** Danh sách tool, đi hết phân trang. */
  async listTools(maxTools = 200): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 20; page++) {
      const res = await this.request('tools/list', cursor ? { cursor } : {});
      const result = (res.result ?? {}) as Record<string, unknown>;
      const tools = Array.isArray(result['tools']) ? result['tools'] : [];

      for (const t of tools) {
        if (typeof t !== 'object' || t === null) continue;
        const rec = t as Record<string, unknown>;
        if (typeof rec['name'] !== 'string') continue;
        out.push({
          name: rec['name'],
          description: typeof rec['description'] === 'string' ? rec['description'] : '',
          inputSchema:
            typeof rec['inputSchema'] === 'object' && rec['inputSchema'] !== null
              ? (rec['inputSchema'] as Record<string, unknown>)
              : { type: 'object' },
        });
        if (out.length >= maxTools) return out;
      }

      const next = result['nextCursor'];
      if (typeof next !== 'string' || !next) break;
      cursor = next;
    }

    return out;
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    const res = await this.request('tools/call', { name, arguments: args ?? {} }, signal);

    if (res.error) {
      return {
        text: `Error from the MCP server: ${res.error.message}`,
        isError: true,
        droppedParts: 0,
      };
    }

    const result = (res.result ?? {}) as Record<string, unknown>;
    const content = Array.isArray(result['content']) ? result['content'] : [];
    const parts: string[] = [];
    let dropped = 0;

    for (const c of content) {
      if (typeof c !== 'object' || c === null) {
        dropped++;
        continue;
      }
      const rec = c as Record<string, unknown>;
      if (rec['type'] === 'text' && typeof rec['text'] === 'string') parts.push(rec['text']);
      else dropped++;
    }

    const max = this.opts.maxResultChars ?? DEFAULT_MAX_RESULT;
    let text = parts.join('\n');
    if (text.length > max) {
      text = `${text.slice(0, max)}\n… result truncated at ${max} characters`;
    }
    if (!text && dropped > 0) {
      text =
        `The server returned ${dropped} non-text content parts (image/resource) — ` +
        `AstraCode does not support those yet.`;
    }

    return { text, isError: result['isError'] === true, droppedParts: dropped };
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(new McpClientError('The MCP connection is closed'));
    await this.opts.transport.close();
  }

  // ── nội bộ ──────────────────────────────────────────────────────────────

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<JsonRpcResponse> {
    if (this.closed) {
      return Promise.reject(
        new McpClientError(
          `MCP server "${this.opts.name}" has stopped${this.exitReason ? `: ${this.exitReason}` : ''}`,
          this.stderrTail ? `last stderr: ${this.stderrTail.slice(-400)}` : undefined,
        ),
      );
    }

    const id = this.nextId++;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT;

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new McpClientError(
            `MCP server "${this.opts.name}" did not answer ${method} within ${timeoutMs}ms`,
            'Turn that server off in the MCP settings if it hangs often.',
          ),
        );
      }, timeoutMs);

      const onAbort = (): void => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new McpClientError('The turn was cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(id, {
        resolve: (r) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(r);
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
        timer,
        method,
      });

      try {
        this.opts.transport.send(encodeMessage({ jsonrpc: '2.0', id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    try {
      this.opts.transport.send(encodeMessage({ jsonrpc: '2.0', method, params }));
    } catch (err) {
      this.opts.logger.warn('không gửi được thông báo MCP', {
        server: this.opts.name,
        method,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private onData(chunk: string): void {
    const { messages, junk } = this.decoder.push(chunk);

    for (const j of junk) {
      this.opts.logger.debug('dòng không phải JSON-RPC từ server MCP', {
        server: this.opts.name,
        line: j,
      });
    }

    for (const msg of messages) this.dispatch(msg);
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (!isResponse(msg)) {
      // Server gọi ngược lại client (sampling, roots...). AstraCode KHÔNG cài
      // các năng lực đó: `capabilities: {}` lúc initialize đã nói vậy. Trả lỗi
      // đúng chuẩn thay vì im lặng — im lặng làm server treo chờ.
      const rec = msg as unknown as Record<string, unknown>;
      if (typeof rec['id'] === 'number') {
        this.opts.transport.send(
          encodeMessage({
            jsonrpc: '2.0',
            id: rec['id'],
            error: { code: -32601, message: 'AstraCode does not implement this capability' },
          }),
        );
      }
      return;
    }

    const p = this.pending.get(msg.id);
    if (!p) {
      this.opts.logger.debug('phản hồi MCP không khớp request nào', {
        server: this.opts.name,
        id: msg.id,
      });
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve(msg);
  }

  private onExit(info: { code: number; reason?: string }): void {
    this.closed = true;
    this.exitReason = info.reason ?? `exited with code ${info.code}`;
    this.opts.logger.warn('server MCP dừng', {
      server: this.opts.name,
      code: info.code,
      stderr: this.stderrTail.slice(-400),
    });
    this.failAllPending(
      new McpClientError(
        `MCP server "${this.opts.name}" stopped mid-run (${this.exitReason})`,
        this.stderrTail ? `last stderr: ${this.stderrTail.slice(-400)}` : undefined,
      ),
    );
  }

  private failAllPending(err: unknown): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
