import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../fs/FileSystem.js';
import { PathGuard } from '../security/pathGuard.js';
import { Denylist } from '../security/denylist.js';
import { Logger, MemorySink } from '../telemetry/logger.js';
import { BackgroundJobs, MAX_CONCURRENT_JOBS } from './background.js';
import { bashTool } from './bash.js';
import { pythonTool } from './python.js';
import { taskKillTool, taskStatusTool } from './taskTools.js';
import type { ToolContext } from './Tool.js';
import type { ExecOptions, ExecResult, OutputChunk, Sandbox } from '../sandbox/Sandbox.js';

const ROOT = '/work/app';

/** Điều khiển một "tiến trình" giả từ trong test. */
interface Handle {
  command: string;
  emit(text: string): void;
  finish(exitCode?: number): void;
}

/**
 * Sandbox giả: không spawn gì cả, test tự quyết định lúc nào lệnh in ra gì và
 * lúc nào nó chết. Chỗ duy nhất còn thật là hình dạng của `exec` — nếu nó lệch
 * với `Sandbox` thì test này vô nghĩa, nên nó vẫn khai đúng kiểu.
 */
function fakeSandbox(): { sandbox: Sandbox; handles: Handle[] } {
  const handles: Handle[] = [];

  const sandbox: Sandbox = {
    info: () => ({
      kind: 'host',
      label: 'fake',
      network: 'full',
      isolated: false,
      shell: 'bash',
    }),
    isAvailable: async () => true,
    exec: (command: string, opts: ExecOptions = {}) => {
      const queue: OutputChunk[] = [];
      let notify: (() => void) | undefined;
      let closed = false;
      let settle!: (r: ExecResult) => void;
      const result = new Promise<ExecResult>((r) => {
        settle = r;
      });

      const end = (r: ExecResult): void => {
        if (closed) return;
        closed = true;
        notify?.();
        settle(r);
      };

      opts.signal?.addEventListener('abort', () =>
        end({ exitCode: 143, timedOut: false, aborted: true, durationMs: 1 }),
      );

      handles.push({
        command,
        emit(text) {
          queue.push({ stream: 'stdout', text });
          notify?.();
        },
        finish(exitCode = 0) {
          end({ exitCode, timedOut: false, aborted: false, durationMs: 10 });
        },
      });

      return {
        async *[Symbol.asyncIterator](): AsyncIterator<OutputChunk> {
          for (;;) {
            const chunk = queue.shift();
            if (chunk) {
              yield chunk;
              continue;
            }
            if (closed) return;
            await new Promise<void>((r) => {
              notify = r;
            });
          }
        },
        result,
      };
    },
    dispose: async () => {},
  };

  return { sandbox, handles };
}

function makeCtx(extra: Partial<ToolContext> = {}): ToolContext {
  const fs = new MemoryFileSystem({ files: {} });
  return {
    workspaceRoot: ROOT,
    fs,
    pathGuard: new PathGuard({ workspaceRoot: ROOT, fs }),
    denylist: new Denylist(),
    logger: new Logger({ sink: new MemorySink() }),
    ...extra,
  };
}

/** Nhường vòng lặp sự kiện cho tiến trình giả chạy tới nơi. */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('BackgroundJobs', () => {
  it('start trả về ngay, không chờ lệnh xong', async () => {
    const { sandbox, handles } = fakeSandbox();
    const jobs = new BackgroundJobs();

    const job = jobs.start({ sandbox, command: 'pnpm test' });

    expect(job.status).toBe('running');
    expect(handles).toHaveLength(1);
    expect(jobs.running()).toHaveLength(1);

    handles[0]!.finish(0);
    await tick();
    expect(jobs.get(job.id)?.status).toBe('done');
  });

  it('mã thoát khác 0 là failed, bị giết là killed', async () => {
    const { sandbox, handles } = fakeSandbox();
    const jobs = new BackgroundJobs();

    const failing = jobs.start({ sandbox, command: 'pnpm build' });
    const killed = jobs.start({ sandbox, command: 'pnpm dev' });

    handles[0]!.finish(1);
    jobs.kill(killed.id);
    await tick();

    expect(jobs.get(failing.id)?.status).toBe('failed');
    expect(jobs.get(failing.id)?.exitCode).toBe(1);
    expect(jobs.get(killed.id)?.status).toBe('killed');
  });

  it('readNew chỉ trả phần output mới — nếu không context hết trước khi build xong', async () => {
    const { sandbox, handles } = fakeSandbox();
    const jobs = new BackgroundJobs();
    const job = jobs.start({ sandbox, command: 'pnpm build' });

    handles[0]!.emit('phần một\n');
    await tick();
    expect(jobs.readNew(job.id)?.text).toBe('phần một\n');

    handles[0]!.emit('phần hai\n');
    await tick();
    expect(jobs.readNew(job.id)?.text).toBe('phần hai\n');
    expect(jobs.readNew(job.id)?.text).toBe('');
  });

  it('wait ngủ tới đúng lúc tác vụ kết thúc, không hỏi vòng vòng', async () => {
    const { sandbox, handles } = fakeSandbox();
    const jobs = new BackgroundJobs();
    const job = jobs.start({ sandbox, command: 'pnpm test' });

    let woke = false;
    const waiting = jobs.wait([job.id], 5000).then((v) => {
      woke = v;
      return v;
    });

    await tick();
    expect(woke).toBe(false);

    handles[0]!.finish(0);
    await expect(waiting).resolves.toBe(true);
  });

  it('wait trả false khi hết giờ chờ mà tác vụ vẫn chạy', async () => {
    const { sandbox } = fakeSandbox();
    const jobs = new BackgroundJobs();
    const job = jobs.start({ sandbox, command: 'pnpm dev' });

    await expect(jobs.wait([job.id], 5)).resolves.toBe(false);
    expect(jobs.get(job.id)?.status).toBe('running');
  });

  it('wait bị cắt bởi signal của lượt — bấm Stop không được để agent treo', async () => {
    const { sandbox } = fakeSandbox();
    const jobs = new BackgroundJobs();
    const job = jobs.start({ sandbox, command: 'pnpm dev' });
    const abort = new AbortController();

    const waiting = jobs.wait([job.id], 60_000, abort.signal);
    abort.abort();
    await expect(waiting).resolves.toBe(false);
  });

  it('chặn ở trần tác vụ chạy cùng lúc', () => {
    const { sandbox } = fakeSandbox();
    const jobs = new BackgroundJobs();

    for (let i = 0; i < MAX_CONCURRENT_JOBS; i++) {
      jobs.start({ sandbox, command: `lệnh ${i}` });
    }
    expect(() => jobs.start({ sandbox, command: 'một lệnh nữa' })).toThrow(/trần của phiên/);
  });

  it('dispose giết mọi tác vụ còn chạy', async () => {
    const { sandbox } = fakeSandbox();
    const jobs = new BackgroundJobs();
    jobs.start({ sandbox, command: 'pnpm dev' });

    await jobs.dispose();
    expect(jobs.list()).toHaveLength(0);
  });
});

describe('bash(run_in_background)', () => {
  it('trả task_id ngay thay vì chờ lệnh chạy xong', async () => {
    const { sandbox, handles } = fakeSandbox();
    const jobs = new BackgroundJobs();
    const ctx = makeCtx({ sandbox, jobs });

    const result = await bashTool.execute(
      { command: 'pnpm test', run_in_background: true },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(result.meta?.background).toBe(true);
    expect(result.content).toContain('bg1');
    // Lệnh vẫn đang chạy: tool trả về mà tiến trình chưa kết thúc.
    expect(handles).toHaveLength(1);
    expect(jobs.running()).toHaveLength(1);
  });

  it('hộp duyệt nói rõ lệnh chạy nền', async () => {
    const ctx = makeCtx();
    const intent = await bashTool.describe!(
      { command: 'pnpm dev', description: 'Start the dev server', run_in_background: true },
      ctx,
    );
    expect(intent.summary).toContain('Run in background');
  });

  it('không có sổ tác vụ thì báo lỗi, không âm thầm chạy đồng bộ', async () => {
    const { sandbox } = fakeSandbox();
    const result = await bashTool.execute(
      { command: 'pnpm test', run_in_background: true },
      makeCtx({ sandbox }),
    );
    expect(result.isError).toBe(true);
  });

  it('python cũng chạy nền được, cùng đường với bash', async () => {
    const { sandbox, handles } = fakeSandbox();
    const jobs = new BackgroundJobs();

    const result = await pythonTool.execute(
      { script: 'print(1)', run_in_background: true },
      makeCtx({ sandbox, jobs }),
    );

    expect(result.meta?.background).toBe(true);
    expect(handles[0]?.command).toContain('python3 -c');
    expect(jobs.running()).toHaveLength(1);
  });
});

describe('task_status', () => {
  it('gộp trạng thái và output mới của mọi tác vụ', async () => {
    const { sandbox, handles } = fakeSandbox();
    const jobs = new BackgroundJobs();
    const ctx = makeCtx({ sandbox, jobs });

    jobs.start({ sandbox, command: 'pnpm build' });
    handles[0]!.emit('đang biên dịch\n');
    await tick();

    const result = await taskStatusTool.execute({}, ctx);
    expect(result.content).toContain('bg1');
    expect(result.content).toContain('đang biên dịch');
    expect(result.meta?.running).toBe(1);
    // Output lệnh phải đi qua đường không tin cậy y như bash.
    expect(result.untrusted).toBe(true);
  });

  it('wait: true chờ tác vụ xong rồi mới trả về', async () => {
    const { sandbox, handles } = fakeSandbox();
    const jobs = new BackgroundJobs();
    const ctx = makeCtx({ sandbox, jobs });
    const job = jobs.start({ sandbox, command: 'pnpm test' });

    const pending = taskStatusTool.execute({ task_id: job.id, wait: true }, ctx);
    await tick();
    handles[0]!.emit('12 passed\n');
    handles[0]!.finish(0);

    const result = await pending;
    expect(result.meta?.waited).toBe(true);
    expect(result.meta?.finished).toBe(1);
    expect(result.content).toContain('12 passed');
  });

  it('wait: true không treo khi tác vụ đã xong mà chưa báo lần nào', async () => {
    const { sandbox, handles } = fakeSandbox();
    const jobs = new BackgroundJobs();
    const ctx = makeCtx({ sandbox, jobs });
    const job = jobs.start({ sandbox, command: 'pnpm test' });

    handles[0]!.finish(0);
    await tick();

    const result = await taskStatusTool.execute(
      { task_id: job.id, wait: true, timeout_ms: 60_000 },
      ctx,
    );
    expect(result.meta?.finished).toBe(1);
  });

  it('id lạ là lỗi có kiểm soát, kèm danh sách id đang có', async () => {
    const { sandbox } = fakeSandbox();
    const jobs = new BackgroundJobs();
    jobs.start({ sandbox, command: 'pnpm dev' });

    const result = await taskStatusTool.execute({ task_id: 'bg99' }, makeCtx({ sandbox, jobs }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('bg1');
  });
});

describe('task_kill', () => {
  it('dừng tác vụ đang chạy', async () => {
    const { sandbox } = fakeSandbox();
    const jobs = new BackgroundJobs();
    const ctx = makeCtx({ sandbox, jobs });
    const job = jobs.start({ sandbox, command: 'pnpm dev' });

    const result = await taskKillTool.execute({ task_id: job.id }, ctx);
    await tick();

    expect(result.meta?.killed).toBe(true);
    expect(jobs.get(job.id)?.status).toBe('killed');
  });

  it('tác vụ đã xong thì nói thẳng, không báo lỗi giả', async () => {
    const { sandbox, handles } = fakeSandbox();
    const jobs = new BackgroundJobs();
    const ctx = makeCtx({ sandbox, jobs });
    const job = jobs.start({ sandbox, command: 'pnpm test' });

    handles[0]!.finish(0);
    await tick();

    const result = await taskKillTool.execute({ task_id: job.id }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.meta?.killed).toBe(false);
  });
});
