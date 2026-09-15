/**
 * Kiểu dữ liệu cho năng lực "hỏi người dùng chọn qua nút bấm" (ask_user_question).
 *
 * Tách riêng khỏi `askUserQuestion.ts` vì `Tool.ts` cần import các kiểu này để
 * khai báo `ToolContext.askUser` — để tool tự import ngược `Tool.ts` thì vòng
 * lặp import xuất hiện ngay. Cùng lý do `BackgroundJobs` tách khỏi `taskTools.ts`.
 */

export interface AskUserOption {
  label: string;
  // `| undefined` rõ ràng vì exactOptionalPropertyTypes: kiểu suy ra từ zod
  // `.optional()` (tools/askUserQuestion.ts) cho phép giá trị `undefined`
  // tường minh, không chỉ vắng mặt key.
  description?: string | undefined;
}

export interface AskUserQuestion {
  header: string;
  question: string;
  options: AskUserOption[];
  multiSelect?: boolean | undefined;
}

export interface AskUserAnswer {
  header: string;
  /** Nhãn các lựa chọn đã chọn, theo thứ tự bấm. Rỗng = không chọn gì. */
  selected: string[];
}

/**
 * `cancelled: true` khi KHÔNG có câu trả lời thật (Dừng, đóng panel) — tách
 * hẳn khỏi "đã trả lời nhưng chọn rỗng" để execute() không lẫn hai trường hợp
 * đó thành một, và model không suy diễn nhầm một câu trả lời không hề có.
 */
export type AskUserResult = { cancelled: false; answers: AskUserAnswer[] } | { cancelled: true };

export type AskUserFn = (questions: AskUserQuestion[]) => Promise<AskUserResult>;
