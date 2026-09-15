/**
 * Khung giao thức MCP trên stdio (mốc M7).
 *
 * MCP dùng JSON-RPC 2.0, mỗi thông điệp một DÒNG. Không có Content-Length như
 * LSP — nên nguyên tắc duy nhất phải giữ đúng là: thông điệp không bao giờ chứa
 * ký tự xuống dòng thô. `JSON.stringify` escape sẵn `\n` bên trong chuỗi nên
 * điều đó tự đúng, và `encodeMessage` kiểm lại lần nữa cho chắc.
 *
 * Tách riêng khỏi McpClient để test được phần dễ sai nhất mà không cần tiến
 * trình nào: gộp mẩu, dòng bị cắt giữa chừng, rác lẫn vào stdout. Server MCP in
 * log ra stdout là chuyện xảy ra thật, và một dòng rác không được phép làm chết
 * cả phiên kết nối.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Trần độ dài một dòng. Vượt thì bỏ dòng đó, không để bộ đệm phình vô hạn. */
export const MAX_LINE_CHARS = 4_000_000;

export function encodeMessage(msg: JsonRpcMessage): string {
  const line = JSON.stringify(msg);
  if (line.includes('\n')) {
    // Không thể xảy ra với JSON.stringify, nhưng nếu có ai đó đổi cách mã hoá
    // thì lỗi phải nổ ở đây chứ không phải thành một thông điệp bị cắt đôi.
    throw new Error('Thông điệp JSON-RPC chứa xuống dòng thô');
  }
  return `${line}\n`;
}

export interface DecodeResult {
  messages: JsonRpcMessage[];
  /** Dòng không parse được — giữ lại để log, không ném. */
  junk: string[];
}

export class LineDecoder {
  private buffer = '';

  push(chunk: string): DecodeResult {
    const messages: JsonRpcMessage[] = [];
    const junk: string[] = [];

    this.buffer += chunk;

    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) break;
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;

      const msg = parseLine(line);
      if (msg) messages.push(msg);
      else junk.push(line.slice(0, 500));
    }

    if (this.buffer.length > MAX_LINE_CHARS) {
      junk.push(`… một dòng vượt ${MAX_LINE_CHARS} ký tự, bị bỏ`);
      this.buffer = '';
    }

    return { messages, junk };
  }

  /** Phần còn dở trong bộ đệm — dùng khi tiến trình chết giữa chừng. */
  pending(): string {
    return this.buffer;
  }
}

function parseLine(line: string): JsonRpcMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v['jsonrpc'] !== '2.0') return undefined;

  const hasId = typeof v['id'] === 'number';
  const hasMethod = typeof v['method'] === 'string';

  if (hasId && !hasMethod) return v as unknown as JsonRpcResponse;
  if (hasMethod) return v as unknown as JsonRpcRequest | JsonRpcNotification;
  return undefined;
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && !('method' in msg);
}
