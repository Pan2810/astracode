/**
 * ask_user_question — hỏi người dùng chọn qua nút bấm thay vì gõ lại chữ.
 *
 * readOnly: true có chủ ý — hỏi không có tác dụng phụ nào lên file/hệ thống,
 * nên nó bỏ qua cổng quyền hoàn toàn, giống hệt todo_write/task_status. Một
 * hộp duyệt quyền hỏi "có cho phép hỏi người dùng không?" sẽ vô lý.
 */
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from './Tool.js';

const optionSchema = z.object({
  label: z.string().min(1).max(80).describe('Nhãn ngắn hiện trên nút bấm'),
  description: z.string().max(400).optional().describe('Giải thích thêm, hiện dưới nhãn'),
});

const questionSchema = z
  .object({
    header: z.string().min(1).max(40).describe('Tiêu đề rất ngắn, dùng làm nhãn câu hỏi'),
    question: z.string().min(1).max(500).describe('Nội dung đầy đủ của câu hỏi'),
    options: z.array(optionSchema).min(2).max(4),
    multiSelect: z.boolean().optional().describe('true = cho phép chọn nhiều lựa chọn'),
  })
  // Nhãn trùng nhau trong CÙNG một câu hỏi làm mất khả năng phân biệt hai lựa
  // chọn khác nhau — cả webview (bấm một nút thì cả hai nút cùng nhãn cùng
  // sáng) lẫn answerQuestion ở host (Set theo nhãn) đều không tách được chúng.
  .refine((q) => new Set(q.options.map((o) => o.label)).size === q.options.length, {
    message: 'Các lựa chọn trong một câu hỏi phải có nhãn khác nhau',
    path: ['options'],
  });

const schema = z.object({
  questions: z
    .array(questionSchema)
    .min(1)
    .max(4)
    .describe('1-4 câu hỏi hỏi cùng lúc. Ưu tiên MỘT câu hỏi single-select khi có thể.'),
});

export const askUserQuestionTool: Tool<typeof schema> = {
  name: 'ask_user_question',
  description:
    'Hỏi người dùng chọn giữa vài phương án CỤ THỂ, đếm được (2-4 lựa chọn mỗi câu), ' +
    'qua nút bấm thay vì để họ gõ lại câu trả lời. Dùng khi có vài hướng đi rõ ràng cần ' +
    'người dùng quyết định (ví dụ: vài nguyên nhân gốc khả dĩ, vài cách sửa khác nhau). ' +
    'KHÔNG dùng cho câu hỏi mở.',
  schema,
  readOnly: true,

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.askUser) {
      return {
        content:
          'Phiên này không có kênh hỏi qua nút bấm. Trình bày lựa chọn bằng chữ trong ' +
          'câu trả lời và chờ người dùng gõ lại.',
        isError: true,
        untrusted: false,
        meta: { noCapability: true },
      };
    }

    const result = await ctx.askUser(args.questions);

    if (result.cancelled) {
      return {
        content:
          'Người dùng KHÔNG trả lời — họ đã bấm Dừng hoặc đóng cửa sổ chat trước khi chọn. ' +
          'KHÔNG suy diễn đây là một lựa chọn nào (không phải "không", không phải lựa chọn ' +
          'đầu tiên). Hỏi lại bằng lời hoặc chờ người dùng tự nói tiếp.',
        isError: true,
        untrusted: false,
        meta: { cancelled: true, questionCount: args.questions.length },
      };
    }

    const lines = result.answers.map(
      (a) => `- ${a.header}: ${a.selected.length ? a.selected.join(', ') : '(không chọn gì)'}`,
    );
    return {
      content: `Người dùng đã chọn:\n${lines.join('\n')}`,
      // Lựa chọn do chính model soạn ra rồi người dùng bấm chọn — không phải
      // nội dung lạ, nên bỏ qua quét injection và bọc delimiter (như todo_write).
      untrusted: false,
      meta: {
        questionCount: args.questions.length,
        answered: result.answers.filter((a) => a.selected.length > 0).length,
      },
    };
  },
};
