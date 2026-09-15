/**
 * Server MCP giả, chạy trong bộ nhớ — chỉ dùng cho test (M7).
 *
 * Nằm ở src/ chứ không trong file .test.ts vì cả McpClient.test.ts lẫn
 * McpManager.test.ts đều cần nó. Nó không được export ra khỏi package
 * (mcp/index.ts không re-export) nên không lọt vào bề mặt công khai.
 */
import { LineDecoder, encodeMessage, type JsonRpcMessage } from './protocol.js';
import type { McpTransport } from './McpClient.js';
import type { McpToolInfo } from './types.js';

export interface FakeServerOptions {
  name?: string;
  version?: string;
  tools?: McpToolInfo[];
  /** Kết quả cho tools/call, theo tên tool. */
  results?: Record<string, { text: string; isError?: boolean }>;
  /** Method bị "nuốt" — không trả lời, để test timeout. */
  silentMethods?: string[];
  /** Trả lỗi JSON-RPC cho method này. */
  errorMethods?: Record<string, string>;
  /** Trả tool theo trang, mỗi trang bấy nhiêu cái. */
  pageSize?: number;
}

export interface FakeServer {
  transport: McpTransport;
  /** Mọi thông điệp client đã gửi — để assert handshake. */
  sent: JsonRpcMessage[];
  /** Giả lập server chết. */
  crash(reason?: string): void;
  /** Đẩy một dòng bất kỳ ra stdout (rác, log...). */
  emitRaw(text: string): void;
  closed: boolean;
}

export function createFakeServer(opts: FakeServerOptions = {}): FakeServer {
  const decoder = new LineDecoder();
  const sent: JsonRpcMessage[] = [];
  let onData: ((c: string) => void) | undefined;
  let onExit: ((i: { code: number; reason?: string }) => void) | undefined;
  const tools = opts.tools ?? [];
  const state = { closed: false };

  const emit = (msg: JsonRpcMessage): void => {
    // setTimeout(0) để phản hồi luôn tới SAU khi promise của request được tạo —
    // đúng như tiến trình thật, và bắt được lỗi đăng ký pending sai thứ tự.
    setTimeout(() => onData?.(encodeMessage(msg)), 0);
  };

  const handle = (msg: JsonRpcMessage): void => {
    sent.push(msg);
    if (!('id' in msg) || typeof msg.id !== 'number') return; // notification
    const id = msg.id;
    const method = (msg as { method?: string }).method ?? '';

    if (opts.silentMethods?.includes(method)) return;

    const errMsg = opts.errorMethods?.[method];
    if (errMsg !== undefined) {
      emit({ jsonrpc: '2.0', id, error: { code: -32000, message: errMsg } });
      return;
    }

    switch (method) {
      case 'initialize':
        emit({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: opts.name ?? 'fake', version: opts.version ?? '1.0.0' },
          },
        });
        return;

      case 'tools/list': {
        const size = opts.pageSize ?? tools.length;
        const cursor = ((msg as { params?: { cursor?: string } }).params?.cursor ?? '0');
        const start = Number(cursor) || 0;
        const page = tools.slice(start, start + Math.max(size, 1));
        const nextStart = start + page.length;
        emit({
          jsonrpc: '2.0',
          id,
          result: {
            tools: page,
            ...(nextStart < tools.length ? { nextCursor: String(nextStart) } : {}),
          },
        });
        return;
      }

      case 'tools/call': {
        const params = (msg as { params?: { name?: string } }).params ?? {};
        const r = opts.results?.[params.name ?? ''] ?? { text: `đã chạy ${params.name}` };
        emit({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: r.text }],
            ...(r.isError ? { isError: true } : {}),
          },
        });
        return;
      }

      default:
        emit({ jsonrpc: '2.0', id, error: { code: -32601, message: `không có ${method}` } });
    }
  };

  const transport: McpTransport = {
    send(line) {
      if (state.closed) throw new Error('server đã đóng');
      for (const msg of decoder.push(line).messages) handle(msg);
    },
    onData(cb) {
      onData = cb;
    },
    onStderr() {
      /* fake không sinh stderr trừ khi crash */
    },
    onExit(cb) {
      onExit = cb;
    },
    async close() {
      state.closed = true;
    },
  };

  return {
    transport,
    sent,
    get closed() {
      return state.closed;
    },
    crash(reason = 'server chết') {
      state.closed = true;
      onExit?.({ code: 1, reason });
    },
    emitRaw(text) {
      onData?.(text);
    },
  };
}
