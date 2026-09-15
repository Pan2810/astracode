/**
 * task_status / task_kill — cách agent nói chuyện với tác vụ nền.
 *
 * `bash(run_in_background: true)` bật lệnh rồi trả về ngay; hai tool ở đây là
 * đầu kia của sợi dây. Chúng cố tình rất ít: một tool để hỏi/chờ, một tool để
 * dừng. Mỗi tool thêm vào bộ đều tốn context ở MỌI lượt, kể cả những lượt
 * không có tác vụ nền nào.
 *
 * `task_status` là `readOnly: true` — nó không chạy lệnh mới, chỉ đọc kết quả
 * của lệnh mà người dùng ĐÃ duyệt lúc start. Bắt duyệt lại ở đây thì cơ chế
 * chờ trở nên vô dụng: agent sẽ phải xin phép mỗi lần muốn biết build xong
 * chưa.
 */
import { z } from 'zod';
import type { Tool, ToolContext, ToolIntent, ToolResult } from './Tool.js';
import { describeJob, type BackgroundJob } from './background.js';

/** Trần ký tự output mỗi tác vụ trả về trong MỘT lần hỏi. */
const MAX_OUTPUT_PER_JOB = 20_000;

const DEFAULT_WAIT_MS = 120_000;

const statusSchema = z.object({
  task_id: z
    .string()
    .optional()
    .describe('Id tác vụ cần xem, ví dụ "bg1". Bỏ trống = xem tất cả tác vụ nền.'),
  wait: z
    .boolean()
    .optional()
    .describe(
      'true = chờ tới khi có một tác vụ kết thúc rồi mới trả về. ' +
        'Dùng khi không còn việc gì khác để làm trong lúc chờ.',
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .optional()
    .describe('Chờ tối đa bao lâu khi wait=true, ms. Mặc định 120000.'),
});

const killSchema = z.object({
  task_id: z.string().min(1).describe('Id tác vụ cần dừng, ví dụ "bg1"'),
});

function noJobs(): ToolResult {
  return {
    content:
      'Chưa có tác vụ nền nào trong phiên này. ' +
      'Bật bằng bash với run_in_background: true nếu lệnh chạy lâu.',
    untrusted: false,
    meta: { running: 0, finished: 0 },
  };
}

/**
 * Ghép báo cáo cho một tác vụ: một dòng trạng thái, rồi phần output MỚI.
 *
 * Chỉ phần mới, vì lần hỏi thứ ba của một lệnh build dài mà lại chép lại từ
 * đầu thì context hết trước khi lệnh chạy xong.
 */
function report(job: BackgroundJob, ctx: ToolContext): string {
  const head = describeJob(job);
  const chunk = ctx.jobs?.readNew(job.id);
  if (!chunk) return head;

  let text = chunk.text;
  let note = '';
  if (text.length > MAX_OUTPUT_PER_JOB) {
    text = text.slice(text.length - MAX_OUTPUT_PER_JOB);
    note = '\n… (chỉ giữ phần cuối)';
  }
  if (chunk.dropped > 0) {
    note += `\n… (đã bỏ ${chunk.dropped} ký tự đầu — log dài hơn bộ đệm)`;
  }

  if (text.trim() === '') {
    return `${head}\n(chưa có output mới)${note}`;
  }
  return `${head}\n${text.trimEnd()}${note}`;
}

export const taskStatusTool: Tool<typeof statusSchema> = {
  name: 'task_status',
  description:
    'Xem tác vụ nền đang chạy tới đâu và lấy phần output MỚI của nó. ' +
    'Đặt wait: true để ngủ cho tới khi một tác vụ kết thúc thay vì hỏi lại ' +
    'nhiều lần. Chỉ dùng được cho tác vụ bật bằng bash(run_in_background).',
  schema: statusSchema,
  readOnly: true,

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const jobs = ctx.jobs;
    if (!jobs) return noJobs();

    if (args.task_id !== undefined && !jobs.get(args.task_id)) {
      const known = jobs.list().map((j) => j.id);
      return {
        content:
          `Không có tác vụ nền nào tên "${args.task_id}". ` +
          (known.length ? `Đang có: ${known.join(', ')}.` : 'Sổ tác vụ đang rỗng.'),
        isError: true,
        untrusted: false,
      };
    }

    const targets = (): BackgroundJob[] =>
      args.task_id !== undefined
        ? [jobs.get(args.task_id)!]
        : jobs.list();

    if (targets().length === 0) return noJobs();

    // Chỉ chờ khi thật sự còn thứ để chờ. Có tác vụ vừa xong mà chưa báo lần
    // nào thì trả về NGAY: chờ tiếp là bỏ lỡ đúng cái tin agent đang cần.
    let waited = false;
    if (args.wait === true) {
      const list = targets();
      const runningIds = list.filter((j) => j.status === 'running').map((j) => j.id);
      const freshNews = list.some((j) => j.status !== 'running' && !isReported(jobs, j.id));
      if (runningIds.length > 0 && !freshNews) {
        waited = await jobs.wait(
          runningIds,
          args.timeout_ms ?? DEFAULT_WAIT_MS,
          ctx.signal,
        );
      }
    }

    const list = targets();
    const blocks = list.map((job) => report(job, ctx));
    for (const job of list) jobs.markReported(job.id);

    const running = list.filter((j) => j.status === 'running').length;
    const finished = list.length - running;
    const tail =
      args.wait === true && !waited && running > 0
        ? '\n\nHết giờ chờ mà tác vụ vẫn chạy. Làm việc khác rồi hỏi lại, hoặc dừng nó bằng task_kill.'
        : running > 0
          ? `\n\nCòn ${running} tác vụ đang chạy — làm việc khác đi, đừng hỏi lại ngay.`
          : '';

    return {
      content: `${blocks.join('\n\n')}${tail}`,
      // Output lệnh là dữ liệu do thứ khác sinh ra, y như `bash`.
      untrusted: true,
      meta: { running, finished, waited },
    };
  },
};

/**
 * Đã báo trạng thái cuối của tác vụ này chưa.
 *
 * `BackgroundJobs` không phơi cờ đó ra trực tiếp — `unreported()` là danh sách,
 * và hỏi qua danh sách giữ được một nguồn sự thật duy nhất ở đó.
 */
function isReported(jobs: NonNullable<ToolContext['jobs']>, id: string): boolean {
  return !jobs.unreported().some((j) => j.id === id);
}

export const taskKillTool: Tool<typeof killSchema> = {
  name: 'task_kill',
  description:
    'Dừng một tác vụ nền đang chạy (giết cả cây tiến trình của nó). ' +
    'Dùng khi tác vụ treo, chạy nhầm, hoặc không còn cần kết quả nữa.',
  schema: killSchema,
  readOnly: false,

  async describe(args, ctx: ToolContext): Promise<ToolIntent> {
    const job = ctx.jobs?.get(args.task_id);
    return {
      summary: `Stop background task ${args.task_id}`,
      ...(job ? { preview: job.command, previewKind: 'command' as const } : {}),
    };
  },

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const jobs = ctx.jobs;
    const job = jobs?.get(args.task_id);
    if (!jobs || !job) {
      return {
        content: `Không có tác vụ nền nào tên "${args.task_id}".`,
        isError: true,
        untrusted: false,
      };
    }

    if (!jobs.kill(args.task_id)) {
      return {
        content: `Tác vụ ${args.task_id} đã kết thúc từ trước: ${describeJob(job)}`,
        untrusted: false,
        meta: { killed: false },
      };
    }

    ctx.logger.info('dừng tác vụ nền', { id: args.task_id });
    return {
      content: `Đã dừng tác vụ ${args.task_id} (${job.command}).`,
      untrusted: false,
      meta: { killed: true },
    };
  },
};
