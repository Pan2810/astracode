/**
 * Kiểu dữ liệu của eval harness — mốc M2.5.
 *
 * Nguyên tắc chấm: hàm chấm phải TẤT ĐỊNH. Không dùng LLM để chấm ở v1 —
 * chấm bằng LLM thì khi pass-rate tụt, bạn không biết là agent tệ đi hay giám
 * khảo đổi ý, và đó đúng là câu hỏi mà eval sinh ra để trả lời.
 */
import type { AgentEvent, AgentRunResult, ToolResult } from '@astra/core';

export interface Fixture {
  name: string;
  description: string;
  /** Đường dẫn tương đối -> nội dung. Thư mục được suy ra từ đường dẫn. */
  files: Record<string, string>;
  /**
   * Chuỗi bí mật có trong fixture. Harness tự kiểm tra chúng KHÔNG xuất hiện
   * trong bất kỳ message nào — một lớp chặn chung cho mọi task, không phụ
   * thuộc vào việc từng hàm chấm có nhớ kiểm tra hay không.
   */
  secrets?: string[];
}

export interface RecordedToolCall {
  name: string;
  args: unknown;
  result: ToolResult | undefined;
}

export interface GradeContext {
  result: AgentRunResult;
  events: AgentEvent[];
  toolCalls: RecordedToolCall[];
  /** Câu trả lời cuối, đã chuẩn hoá về chữ thường để so cho dễ. */
  text: string;
  /** Toàn bộ message của lượt, JSON hoá — dùng để soát rò rỉ. */
  transcript: string;
  fixture: Fixture;
}

export interface GradeResult {
  pass: boolean;
  /** Nói rõ vì sao trượt. Đây là thứ người đọc báo cáo cần nhất. */
  reason: string;
}

export type Grader = (ctx: GradeContext) => GradeResult;

export type TaskGroup = 'codebase' | 'security';

export interface EvalTask {
  id: string;
  group: TaskGroup;
  fixture: Fixture;
  prompt: string;
  /** Mô tả ngắn cái đang được đo. */
  intent: string;
  grade: Grader;
  /** Trần vòng lặp riêng nếu task cần khác mặc định. */
  maxIterations?: number;
  /**
   * Kịch bản MockProvider để tự kiểm chứng harness mà không cần model thật.
   * Chỉ dùng ở chế độ `--provider mock`; chạy thật thì bỏ qua.
   */
  mockTurns?: unknown[];
}

export interface TaskOutcome {
  taskId: string;
  group: TaskGroup;
  pass: boolean;
  reason: string;
  toolCalls: number;
  iterations: number;
  totalTokens: number;
  durationMs: number;
  stoppedBy: AgentRunResult['stoppedBy'];
  injectionWarnings: number;
  /** Lỗi ném ra ngoài vòng chấm (mạng, cấu hình...). */
  error?: string;
}

export interface EvalRun {
  model: string;
  protocol: 'native' | 'xml';
  provider: string;
  startedAt: string;
  durationMs: number;
  outcomes: TaskOutcome[];
  summary: {
    total: number;
    passed: number;
    passRate: number;
    byGroup: Record<string, { total: number; passed: number; passRate: number }>;
    avgToolCalls: number;
    avgTokens: number;
    avgDurationMs: number;
  };
}
