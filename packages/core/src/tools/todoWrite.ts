/**
 * todo_write — checklist tiến độ của agent (M5).
 *
 * Không đụng filesystem, nên `readOnly: true` và không cần duyệt. Giá trị của
 * nó nằm ở chỗ khác: một model làm việc nhiều bước rất hay quên mất bước thứ
 * tư sau khi bước thứ ba sinh chuyện. Bắt nó viết ra danh sách và cập nhật
 * từng mục là cách rẻ nhất để giữ nó đi đúng đường — và người dùng cũng nhìn
 * thấy nó đang ở đâu thay vì ngồi đoán.
 *
 * Danh sách sống trong bộ nhớ phiên (`TodoStore`), không ghi ra file: nó là
 * trạng thái của MỘT lượt làm việc, không phải tài liệu của repo.
 */
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from './Tool.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

const itemSchema = z.object({
  content: z.string().min(1).describe('Việc cần làm, viết ở dạng mệnh lệnh ngắn'),
  status: z.enum(['pending', 'in_progress', 'completed']),
});

const schema = z.object({
  todos: z.array(itemSchema).max(50).describe('Toàn bộ danh sách, gửi lại đầy đủ mỗi lần'),
});

export type TodoListener = (todos: TodoItem[]) => void;

/** Danh sách của phiên. Extension gắn listener để đẩy lên UI. */
export class TodoStore {
  private todos: TodoItem[] = [];
  private readonly listeners = new Set<TodoListener>();

  list(): TodoItem[] {
    return [...this.todos];
  }

  replace(todos: TodoItem[]): void {
    this.todos = todos;
    for (const l of this.listeners) {
      try {
        l(this.list());
      } catch {
        /* bỏ qua có chủ ý */
      }
    }
  }

  clear(): void {
    this.replace([]);
  }

  onChange(listener: TodoListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function createTodoWriteTool(store: TodoStore): Tool<typeof schema> {
  return {
    name: 'todo_write',
    description:
      'Ghi lại danh sách việc cần làm cho task hiện tại và cập nhật trạng thái ' +
      'từng việc. Dùng khi task có từ 3 bước trở lên. Gửi LẠI TOÀN BỘ danh sách ' +
      'mỗi lần gọi — nó thay thế danh sách cũ. Đúng một việc được để in_progress.',
    schema,
    readOnly: true,

    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const running = args.todos.filter((t) => t.status === 'in_progress');
      if (running.length > 1) {
        return {
          content:
            `Có ${running.length} việc cùng ở trạng thái in_progress. ` +
            `Chỉ được một — đánh dấu những việc còn lại là pending rồi gọi lại.`,
          isError: true,
          untrusted: false,
        };
      }

      store.replace(args.todos);
      ctx.logger.debug('cập nhật todo', { count: args.todos.length });

      const done = args.todos.filter((t) => t.status === 'completed').length;
      const current = running[0]?.content;

      return {
        content:
          `Đã ghi ${args.todos.length} việc (${done} xong).` +
          (current ? ` Đang làm: ${current}` : ''),
        untrusted: false,
        meta: { total: args.todos.length, done },
      };
    },
  };
}
