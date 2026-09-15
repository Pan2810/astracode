/**
 * Kiểu dữ liệu cho tầng provider.
 *
 * Cố ý KHÔNG dùng thẳng kiểu của openai SDK ở biên: agent loop (M2) và UI (M3)
 * không nên phụ thuộc vào shape của một SDK cụ thể. Chuyển đổi diễn ra trong
 * GatewayProvider và chỉ ở đó.
 */

export type ModelRole = 'planner' | 'editor' | 'fast' | 'vision';

export interface ToolCall {
  id: string;
  name: string;
  /** JSON thô. Việc parse và validate là của agent loop (M2). */
  arguments: string;
}

/**
 * Ảnh người dùng đính kèm (ảnh dán từ clipboard, ảnh chọn từ đĩa).
 *
 * Giữ base64 THÔ, không kèm tiền tố `data:`: chỗ duy nhất biết cách bọc nó là
 * GatewayProvider. Ảnh không bao giờ do model sinh ra — chỉ đi một chiều từ
 * người dùng lên, nên ở đây không có nhánh nào cho ảnh trong output.
 */
export interface ImageAttachment {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** Base64 thuần, không có `data:...;base64,`. */
  data: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  /**
   * `images` là phần đính kèm của ĐÚNG lượt đó. Mọi nơi đọc `content` vẫn đọc
   * được nguyên văn câu hỏi, nên tóm tắt/nén/ghi phiên không cần biết gì về ảnh.
   */
  | { role: 'user'; content: string; images?: ImageAttachment[] }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema. Sinh từ zod bằng zod-to-json-schema ở M2. */
  parameters: Record<string, unknown>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Subset của `promptTokens` được nhà cung cấp phục vụ từ cache prompt, tính
   * giá rẻ hơn (OpenAI-compatible `usage.prompt_tokens_details.cached_tokens`).
   * `undefined` nghĩa là gateway/model không báo trường này — khác `0` (có báo
   * nhưng cache miss hoàn toàn).
   */
  cachedTokens?: number;
}

/**
 * Sự kiện stream. Union đóng — thêm nhánh mới sẽ làm switch ở nơi tiêu thụ
 * báo lỗi biên dịch, đó là điều mong muốn.
 */
export type ProviderEvent =
  /** Một mẩu text. */
  | { type: 'text'; delta: string }
  /** Một mẩu tool call đang hình thành — dùng để UI hiện tiến trình. */
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  /** Tool call đã hoàn chỉnh. Agent loop chỉ cần lắng nghe sự kiện này. */
  | { type: 'tool_call'; index: number; call: ToolCall }
  | { type: 'usage'; usage: TokenUsage }
  /** Model chính hỏng, đã chuyển sang model dự phòng. */
  | { type: 'model_switched'; from: string; to: string; reason: string }
  /** Đang thử lại cùng model. Để UI nói "đang thử lại" thay vì đứng im. */
  | { type: 'retrying'; attempt: number; delayMs: number; reason: string }
  | { type: 'done'; model: string; finishReason: FinishReason };

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown';

export interface StreamRequest {
  /** Chỉ định model cụ thể. Không có thì lấy theo `role`. */
  model?: string;
  role?: ModelRole;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Gắn vào log để lần ngược được một turn. */
  traceId?: string;
}

export interface Provider {
  stream(req: StreamRequest): AsyncIterable<ProviderEvent>;
}
