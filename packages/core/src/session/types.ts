/**
 * Định dạng phiên lưu trên đĩa.
 *
 * `schemaVersion` có NGAY từ bản đầu tiên, kèm hàm migrate, dù bản đầu tiên
 * chưa cần migrate gì. Lý do: định dạng này chắc
 * chắn đổi (skill, subagent, MCP đều muốn nhét thêm thứ vào phiên), và lúc đó
 * mà không có version thì mọi phiên cũ của chính người dùng thành rác không đọc
 * được — không có đường sửa ngược.
 *
 * Quy tắc đọc: KHÔNG BAO GIỜ tin file trên đĩa. Nó có thể do bản cũ ghi, do bản
 * mới hơn ghi, hoặc bị sửa tay. `parseSession` trả `undefined` thay vì ném, và
 * người gọi bỏ qua phiên hỏng chứ không chết theo nó.
 */
import type { ChatMessage, ToolCall } from '../provider/types.js';

export const SESSION_SCHEMA_VERSION = 2;

/**
 * Tóm tắt MỘT lần gọi tool, dạng người dùng đọc.
 *
 * Vì sao phải lưu riêng thay vì rút ra từ `messages`: `messages` là thứ gửi cho
 * MODEL, và văn bản trong đó là tiếng Việt của prompt layer ("Đã sửa a.ts
 * (+1/−1)", "Không tìm thấy…"). Mở lại phiên cũ mà lấy nó ra hiện thẳng thì
 * người dùng nhận một giao diện tiếng Anh chen lẫn tiếng Việt, và phần tiếng
 * Việt lại đúng là phần nói kết quả.
 *
 * Bản người dùng đọc (`summarizeToolResult`) chỉ tồn tại lúc chạy, trong sự kiện
 * `tool_end`. Không chụp lại lúc đó thì nó mất hẳn — không có đường dựng lại từ
 * `messages`, vì hai chuỗi không phải bản dịch của nhau.
 */
export interface PersistedToolSummary {
  /** Đúng chuỗi UI đã hiện lúc tool chạy xong. */
  summary: string;
  isError: boolean;
}

/** Thống kê một lượt — để hiện token/thời gian/chi phí và để `/undo`. */
export interface PersistedTurn {
  id: string;
  /** Nguyên văn người dùng gõ, chưa ghép attachment. */
  prompt: string;
  startedAt: number;
  durationMs: number;
  iterations: number;
  toolCalls: number;
  totalTokens: number;
  /**
   * `'error'` thêm ở bản 2026-09-07: lượt gặp lỗi giữa chừng nay TRẢ VỀ kèm
   * `messages` đã làm được thay vì ném (sổ nợ #10), nên nó là một lượt có thật
   * trong phiên và phải ghi lại đúng lý do dừng. Ghi thành `'answer'` sẽ nói dối
   * chính người dùng đang xem lại phiên cũ.
   */
  stoppedBy: 'answer' | 'iteration_limit' | 'aborted' | 'error';
  /** Số file agent đụng trong lượt. Chi tiết nằm ở checkpoint, không lưu ở đây. */
  filesTouched: number;
}

export interface PersistedSession {
  schemaVersion: number;
  id: string;
  /** Câu đầu của người dùng, cắt ngắn — để chọn phiên khi mở lại. */
  title: string;
  workspaceRoot: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  /** Lịch sử KHÔNG bao gồm system prompt: nó được dựng lại mỗi lượt. */
  messages: ChatMessage[];
  turns: PersistedTurn[];
  totalTokens: number;
  /** Đã bị nén bao nhiêu lần — để biết phiên đã mất chi tiết phần đầu. */
  compactions: number;
  /**
   * Tóm tắt tool đã hiện trên UI, khoá theo `ToolCall.id` (v2).
   *
   * Chỉ có ở đường native — đường XML không mang id nào xuống `messages`, nên ở
   * đó phiên cũ vẫn rơi về bản rút từ nội dung. Chấp nhận được vì native là
   * đường mặc định; điều KHÔNG chấp nhận được là bịa ra id để ghép theo thứ tự,
   * vì nén ngữ cảnh cắt mất phần đầu `messages` và mọi phép ghép theo thứ tự sẽ
   * lệch đúng một đoạn mà không ai nhận ra.
   */
  toolSummaries?: Record<string, PersistedToolSummary>;
}

export function newSessionId(now = Date.now()): string {
  return `s${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Tiêu đề phiên lấy từ câu đầu tiên của người dùng. */
export function titleFrom(prompt: string, max = 80): string {
  const line = prompt.trim().split(/\r?\n/)[0] ?? '';
  const clean = line.replace(/\s+/g, ' ').trim();
  if (!clean) return 'Phiên trống';
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Đọc và migrate một phiên từ JSON thô.
 *
 * Trả `undefined` cho mọi thứ không dùng được: JSON hỏng, thiếu trường bắt
 * buộc, hoặc `schemaVersion` MỚI HƠN bản đang chạy. Trường hợp cuối đáng nói
 * riêng — bản cũ đọc file của bản mới sẽ hiểu nhầm chứ không phải đọc thiếu,
 * và hiểu nhầm một lịch sử hội thoại là cách tạo ra hành vi không giải thích
 * được.
 */
export function parseSession(raw: string): PersistedSession | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return migrateSession(data);
}

export function migrateSession(data: unknown): PersistedSession | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;

  const version = typeof d.schemaVersion === 'number' ? d.schemaVersion : 0;
  if (version > SESSION_SCHEMA_VERSION) return undefined;

  // v1 → v2 thêm `toolSummaries`. Không cần biến đổi gì: thiếu trường thì phiên
  // cũ rơi về bản rút từ nội dung, đúng như nó vẫn chạy trước đây. Ghi ra đây
  // thay vì im lặng để lần sau còn biết chuỗi migrate nối vào chỗ nào.

  if (typeof d.id !== 'string' || !d.id) return undefined;
  const messages = parseMessages(d.messages);
  if (!messages) return undefined;

  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: d.id,
    title: typeof d.title === 'string' ? d.title : 'Phiên không tên',
    workspaceRoot: typeof d.workspaceRoot === 'string' ? d.workspaceRoot : '',
    createdAt: num(d.createdAt) ?? Date.now(),
    updatedAt: num(d.updatedAt) ?? Date.now(),
    ...(typeof d.model === 'string' ? { model: d.model } : {}),
    messages,
    turns: parseTurns(d.turns),
    totalTokens: num(d.totalTokens) ?? 0,
    compactions: num(d.compactions) ?? 0,
    ...(parseToolSummaries(d.toolSummaries) ?? {}),
  };
}

/**
 * `toolSummaries` từ đĩa, đã lọc.
 *
 * Trả `undefined` khi không có gì dùng được, để người gọi bỏ hẳn trường thay vì
 * ghi một object rỗng — cùng khuôn `exactOptionalPropertyTypes` với `model`.
 */
function parseToolSummaries(
  raw: unknown,
): { toolSummaries: Record<string, PersistedToolSummary> } | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;

  const out: Record<string, PersistedToolSummary> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const v = value as Record<string, unknown>;
    if (typeof v.summary !== 'string') continue;
    out[id] = { summary: v.summary, isError: v.isError === true };
  }

  return Object.keys(out).length > 0 ? { toolSummaries: out } : undefined;
}

/**
 * Lọc lịch sử về đúng shape ChatMessage.
 *
 * Bỏ message hỏng thay vì bỏ cả phiên — nhưng nếu bỏ xong mà cặp
 * tool_call/tool_result không còn khớp thì phiên KHÔNG dùng lại được: gửi lên
 * API sẽ bị từ chối cả request. Thà mở phiên mới còn hơn một phiên gửi đâu lỗi
 * đó mà người dùng không hiểu vì sao.
 */
function parseMessages(raw: unknown): ChatMessage[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const out: ChatMessage[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const m = item as Record<string, unknown>;

    switch (m.role) {
      case 'system':
      case 'user':
        if (typeof m.content === 'string') out.push({ role: m.role, content: m.content });
        break;

      case 'assistant': {
        const content = typeof m.content === 'string' ? m.content : null;
        const calls = parseToolCalls(m.toolCalls);
        out.push({ role: 'assistant', content, ...(calls.length ? { toolCalls: calls } : {}) });
        break;
      }

      case 'tool':
        if (typeof m.toolCallId === 'string' && typeof m.content === 'string') {
          out.push({ role: 'tool', toolCallId: m.toolCallId, content: m.content });
        }
        break;

      default:
        break;
    }
  }

  return toolCallsBalanced(out) ? out : undefined;
}

function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const c = item as Record<string, unknown>;
    if (typeof c.id === 'string' && typeof c.name === 'string' && typeof c.arguments === 'string') {
      out.push({ id: c.id, name: c.name, arguments: c.arguments });
    }
  }
  return out;
}

/** Mọi message `tool` phải có lời gọi tương ứng đứng trước. */
export function toolCallsBalanced(messages: ChatMessage[]): boolean {
  const announced = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const c of m.toolCalls ?? []) announced.add(c.id);
    } else if (m.role === 'tool') {
      if (!announced.has(m.toolCallId)) return false;
    }
  }
  return true;
}

function parseTurns(raw: unknown): PersistedTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: PersistedTurn[] = [];

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const t = item as Record<string, unknown>;
    if (typeof t.id !== 'string') continue;

    out.push({
      id: t.id,
      prompt: typeof t.prompt === 'string' ? t.prompt : '',
      startedAt: num(t.startedAt) ?? 0,
      durationMs: num(t.durationMs) ?? 0,
      iterations: num(t.iterations) ?? 0,
      toolCalls: num(t.toolCalls) ?? 0,
      totalTokens: num(t.totalTokens) ?? 0,
      stoppedBy:
        t.stoppedBy === 'iteration_limit' || t.stoppedBy === 'aborted' || t.stoppedBy === 'error'
          ? t.stoppedBy
          : 'answer',
      filesTouched: num(t.filesTouched) ?? 0,
    });
  }
  return out;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
