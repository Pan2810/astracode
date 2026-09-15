/**
 * Đối chiếu câu trả lời webview gửi lên với ĐÚNG câu hỏi đã đưa ra.
 *
 * Tách khỏi `ChatController.ts` (import `vscode`, không mock được trong test
 * của repo này) để logic lọc — chỗ nhạy cảm nhất về ranh giới tin cậy của tính
 * năng này — test được trực tiếp, không cần dựng giả `vscode`.
 */
import type { AskUserAnswer, AskUserQuestion } from '@astra/core';

/**
 * `undefined` = số câu trả lời không khớp số câu hỏi đã gửi ra — coi như
 * không trả lời được, không đoán ghép bừa vào câu hỏi sai.
 *
 * Không tin thẳng nhãn webview echo lại: lọc bỏ nhãn lạ (không nằm trong đúng
 * `options` đã gửi), và câu không `multiSelect` chỉ giữ lựa chọn đầu tiên.
 */
export function reconcileAnswers(
  questions: AskUserQuestion[],
  selections: string[][],
): AskUserAnswer[] | undefined {
  if (selections.length !== questions.length) return undefined;

  return questions.map((q, i) => {
    const valid = new Set(q.options.map((o) => o.label));
    let selected = selections[i]!.filter((label) => valid.has(label));
    if (!q.multiSelect && selected.length > 1) selected = selected.slice(0, 1);
    return { header: q.header, selected };
  });
}
