/**
 * Chạy một bộ task và chấm điểm — mốc M2.5.
 *
 * Mỗi task chạy trên một bản sao fixture mới trong thư mục tạm, nên một task
 * không thể làm bẩn task sau. Đây là điều kiện để pass-rate có nghĩa: nếu thứ
 * tự chạy ảnh hưởng kết quả thì con số không so sánh được giữa các lần.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  AgentLoop,
  Logger,
  MemorySink,
  buildSystemPrompt,
  createReadOnlyRegistry,
  createToolContext,
  type AgentEvent,
  type Provider,
} from '@astra/core';
import { noSecretLeak } from './graders.js';
import type {
  EvalRun,
  EvalTask,
  Fixture,
  GradeContext,
  RecordedToolCall,
  TaskOutcome,
} from './types.js';

export interface RunnerOptions {
  /** Tạo provider mới cho MỖI task — tránh state của MockProvider rò sang task sau. */
  makeProvider: (task: EvalTask) => Provider;
  model: string;
  protocol?: 'native' | 'xml';
  providerLabel: string;
  /** Chạy từng task xong thì gọi, để CLI in tiến trình. */
  onTaskDone?: (outcome: TaskOutcome, index: number, total: number) => void;
  /** Giữ lại thư mục tạm để soi khi debug. */
  keepWorkdir?: boolean;
}

/** Ghi fixture ra một thư mục tạm mới. */
export async function materialize(fixture: Fixture): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `astra-eval-${fixture.name}-`));
  for (const [relative, content] of Object.entries(fixture.files)) {
    const target = resolve(dir, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return dir;
}

export async function runTask(
  task: EvalTask,
  opts: RunnerOptions,
): Promise<TaskOutcome> {
  const started = Date.now();
  const workdir = await materialize(task.fixture);

  const base: Omit<TaskOutcome, 'pass' | 'reason'> = {
    taskId: task.id,
    group: task.group,
    toolCalls: 0,
    iterations: 0,
    totalTokens: 0,
    durationMs: 0,
    stoppedBy: 'answer',
    injectionWarnings: 0,
  };

  try {
    const logger = new Logger({ sink: new MemorySink(), level: 'warn' });
    const loop = new AgentLoop({
      provider: opts.makeProvider(task),
      tools: createReadOnlyRegistry(),
      toolContext: createToolContext({ workspaceRoot: workdir, logger }),
      logger,
      systemPrompt: buildSystemPrompt({
        workspaceRoot: workdir,
        platform: process.platform,
      }),
      model: opts.model,
      ...(opts.protocol ? { protocol: opts.protocol } : {}),
      ...(task.maxIterations ? { maxIterations: task.maxIterations } : {}),
    });

    const events: AgentEvent[] = [];
    const toolCalls: RecordedToolCall[] = [];

    const gen = loop.run(task.prompt);
    let next = await gen.next();
    while (!next.done) {
      const event = next.value;
      events.push(event);
      if (event.type === 'tool_start') {
        toolCalls.push({ name: event.toolName ?? '?', args: event.toolArgs, result: undefined });
      }
      if (event.type === 'tool_end') {
        const last = [...toolCalls].reverse().find((c) => c.name === event.toolName && !c.result);
        if (last) last.result = event.toolResult;
      }
      next = await gen.next();
    }
    const result = next.value;

    // Lượt dừng vì lỗi provider nay TRẢ VỀ kèm tiến độ thay vì ném (core, sổ nợ
    // #10). Với eval thì đó vẫn là task hỏng, và phải chặn TRƯỚC khi chấm: một
    // hàm chấm chỉ soi phần việc đã làm được sẽ cho "đạt" cho một lượt bị cắt
    // giữa chừng, và pass-rate của cả suite thành con số vô nghĩa.
    if (result.error) {
      return {
        ...base,
        pass: false,
        reason: 'lỗi khi chạy',
        error: result.error.message,
        toolCalls: result.toolCalls,
        iterations: result.iterations,
        totalTokens: result.usage.totalTokens,
        stoppedBy: result.stoppedBy,
        injectionWarnings: result.injectionWarnings,
        durationMs: Date.now() - started,
      };
    }

    const ctx: GradeContext = {
      result,
      events,
      toolCalls,
      text: result.text.toLowerCase(),
      transcript: JSON.stringify(result.messages),
      fixture: task.fixture,
    };

    // Kiểm tra rò rỉ bí mật cho MỌI task, không chỉ nhóm bảo mật. Một task
    // "tìm hàm login" mà làm lọt JWT_SECRET vào transcript thì vẫn là hỏng.
    const leak = noSecretLeak(ctx);
    const graded = leak.pass ? task.grade(ctx) : leak;

    return {
      ...base,
      pass: graded.pass,
      reason: graded.reason,
      toolCalls: result.toolCalls,
      iterations: result.iterations,
      totalTokens: result.usage.totalTokens,
      stoppedBy: result.stoppedBy,
      injectionWarnings: result.injectionWarnings,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ...base,
      pass: false,
      reason: 'lỗi khi chạy',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  } finally {
    if (!opts.keepWorkdir) {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function runSuite(
  tasks: EvalTask[],
  opts: RunnerOptions,
): Promise<EvalRun> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const outcomes: TaskOutcome[] = [];

  for (const [index, task] of tasks.entries()) {
    const outcome = await runTask(task, opts);
    outcomes.push(outcome);
    opts.onTaskDone?.(outcome, index + 1, tasks.length);
  }

  return {
    model: opts.model,
    protocol: opts.protocol ?? 'native',
    provider: opts.providerLabel,
    startedAt,
    durationMs: Date.now() - started,
    outcomes,
    summary: summarize(outcomes),
  };
}

export function summarize(outcomes: TaskOutcome[]): EvalRun['summary'] {
  const total = outcomes.length;
  const passed = outcomes.filter((o) => o.pass).length;

  const byGroup: EvalRun['summary']['byGroup'] = {};
  for (const o of outcomes) {
    const g = (byGroup[o.group] ??= { total: 0, passed: 0, passRate: 0 });
    g.total++;
    if (o.pass) g.passed++;
  }
  for (const g of Object.values(byGroup)) {
    g.passRate = g.total === 0 ? 0 : g.passed / g.total;
  }

  const avg = (pick: (o: TaskOutcome) => number): number =>
    total === 0 ? 0 : outcomes.reduce((sum, o) => sum + pick(o), 0) / total;

  return {
    total,
    passed,
    passRate: total === 0 ? 0 : passed / total,
    byGroup,
    avgToolCalls: avg((o) => o.toolCalls),
    avgTokens: avg((o) => o.totalTokens),
    avgDurationMs: avg((o) => o.durationMs),
  };
}
