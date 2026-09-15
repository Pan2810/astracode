/**
 * Tác vụ nền — lệnh chạy lâu không giữ chân vòng lặp agent.
 *
 * Vấn đề nó giải: `bash` chạy đồng bộ. Một `pnpm test` bốn phút nghĩa là bốn
 * phút agent không làm được gì khác, và mọi việc còn lại trong plan phải xếp
 * hàng sau nó dù chẳng liên quan. Với hai lệnh dài thì thời gian cộng lại.
 *
 * Cơ chế ở đây có ba phần, và cả ba đều cần thiết:
 *
 *   1. CHẠY SONG SONG. `start()` trả về ngay với một id; tiến trình sống tiếp
 *      trong nền, output chảy vào bộ đệm của nó. Nhiều tác vụ chạy cùng lúc.
 *   2. LIÊN LẠC. `wait()` cho agent ngủ tới đúng lúc một tác vụ xong, thay vì
 *      hỏi vòng vòng mỗi giây — hỏi vòng vòng tốn một request lên model cho
 *      mỗi lần hỏi, và đó là thứ đắt nhất trong cả cơ chế này.
 *   3. ĐỌC TỪNG PHẦN. Mỗi tác vụ giữ một con trỏ đọc: lần hỏi sau chỉ nhận
 *      phần output MỚI. Không có nó thì mỗi lần hỏi lại nhét cả log build vào
 *      context, và context hết trước khi build xong.
 *
 * Ranh giới an toàn không đổi so với `bash`: lệnh vẫn chạy qua `Sandbox`, vẫn
 * phải được người dùng duyệt TRƯỚC khi start (cổng quyền nằm ở AgentLoop, và
 * `bash` không bao giờ được tự duyệt — xem `ALWAYS_ASK`). Chạy nền không nới
 * bất cứ ràng buộc nào; nó chỉ đổi chỗ chờ.
 */
import type { ExecResult, Sandbox } from '../sandbox/Sandbox.js';
import type { Logger } from '../telemetry/logger.js';

/**
 * `done` = thoát mã 0. `failed` = mã khác 0 hoặc bị giết vì quá giờ.
 * `killed` = người dùng/agent dừng, hoặc phiên đóng.
 */
export type JobStatus = 'running' | 'done' | 'failed' | 'killed';

export interface BackgroundJob {
  id: string;
  command: string;
  description?: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  timedOut: boolean;
  /** Lỗi không chạy nổi lệnh (không tìm thấy shell, sandbox chết giữa chừng). */
  error?: string;
}

/**
 * Trần số tác vụ chạy CÙNG LÚC.
 *
 * Có trần vì model không tự đếm: gặp mười file test nó sẽ bật mười tiến trình
 * rồi máy người dùng lịm đi, mà nguyên nhân thì không hiện ra ở đâu cả. Năm là
 * đủ cho mọi việc thật (build + test + lint + hai thứ nữa).
 */
export const MAX_CONCURRENT_JOBS = 5;

/** Trần bộ đệm output MỖI tác vụ. Vượt thì bỏ phần ĐẦU, giữ phần mới nhất. */
const MAX_JOB_OUTPUT = 120_000;

/** Số tác vụ đã xong còn giữ lại để hỏi kết quả. Cũ hơn thì quên. */
const MAX_JOBS_KEPT = 30;

/**
 * Trần thời gian mặc định cho tác vụ nền: 30 phút.
 *
 * Dài hơn `bash` đồng bộ (2 phút) vì đây đúng là chỗ dành cho việc dài. Vẫn
 * PHẢI có trần: một tiến trình quên chết sẽ giữ cổng và giữ file cho tới lúc
 * người dùng khởi động lại VS Code, và họ sẽ không đoán ra vì sao.
 */
export const DEFAULT_BACKGROUND_TIMEOUT = 1_800_000;

export interface StartJobOptions {
  sandbox: Sandbox;
  command: string;
  description?: string;
  cwd?: string;
  timeoutMs?: number;
}

/** Sự kiện cho host (extension) — để nói cho NGƯỜI DÙNG biết, không phải model. */
export type JobEvent = { type: 'started' | 'finished'; job: BackgroundJob };

export type JobListener = (event: JobEvent) => void;

interface JobRecord {
  job: BackgroundJob;
  /** Output đã gom, có thể đã bị cắt đầu. */
  output: string;
  /** Số ký tự đã rơi khỏi bộ đệm ở đầu. */
  dropped: number;
  /** Vị trí đọc lần trước, tính trên chuỗi `output` hiện tại. */
  cursor: number;
  /** Trạng thái cuối đã báo cho model chưa. Xem `wait()`. */
  reported: boolean;
  abort: AbortController;
  finished: Promise<void>;
}

export class BackgroundJobsError extends Error {}

/**
 * Sổ tác vụ nền của MỘT phiên chat.
 *
 * Sống trong bộ nhớ, chết cùng phiên: `dispose()` giết mọi tiến trình còn
 * chạy. Không có đường nào để một tác vụ sống lâu hơn cửa sổ VS Code đã mở nó.
 */
export class BackgroundJobs {
  private readonly records = new Map<string, JobRecord>();
  private readonly listeners = new Set<JobListener>();
  private readonly waiters = new Set<() => void>();
  private counter = 0;

  constructor(private readonly logger?: Logger) {}

  /** Bật một tác vụ. Trả về ngay, không chờ lệnh chạy xong. */
  start(opts: StartJobOptions): BackgroundJob {
    if (this.running().length >= MAX_CONCURRENT_JOBS) {
      throw new BackgroundJobsError(
        `Đã có ${MAX_CONCURRENT_JOBS} tác vụ nền đang chạy — trần của phiên. ` +
          `Chờ một tác vụ xong (task_status wait=true) hoặc dừng bớt (task_kill).`,
      );
    }

    const id = `bg${++this.counter}`;
    const abort = new AbortController();
    const job: BackgroundJob = {
      id,
      command: opts.command,
      ...(opts.description ? { description: opts.description } : {}),
      status: 'running',
      startedAt: Date.now(),
      timedOut: false,
    };

    const record: JobRecord = {
      job,
      output: '',
      dropped: 0,
      cursor: 0,
      reported: false,
      abort,
      finished: Promise.resolve(),
    };
    record.finished = this.pump(record, opts, abort.signal);

    this.records.set(id, record);
    this.forget();
    this.logger?.info('bật tác vụ nền', { id, command: opts.command.slice(0, 120) });
    this.emit({ type: 'started', job: { ...job } });
    return { ...job };
  }

  /**
   * Đọc tiến trình chạy, gom output, chốt trạng thái.
   *
   * KHÔNG bao giờ ném ra ngoài: nó chạy tách khỏi lượt chat, nên một promise
   * hỏng ở đây là unhandled rejection giết cả extension host chứ không phải
   * một lượt chat hỏng.
   */
  private async pump(
    record: JobRecord,
    opts: StartJobOptions,
    signal: AbortSignal,
  ): Promise<void> {
    const { job } = record;
    let result: ExecResult | undefined;
    try {
      const proc = opts.sandbox.exec(opts.command, {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        timeoutMs: opts.timeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT,
        signal,
      });
      for await (const chunk of proc) this.append(record, chunk.text);
      result = await proc.result;
    } catch (err) {
      job.error = err instanceof Error ? err.message : String(err);
    }

    job.endedAt = Date.now();
    if (result) {
      job.exitCode = result.exitCode;
      job.timedOut = result.timedOut;
      job.status = result.aborted ? 'killed' : result.timedOut || result.exitCode !== 0 ? 'failed' : 'done';
    } else {
      job.status = signal.aborted ? 'killed' : 'failed';
    }

    this.logger?.info('tác vụ nền kết thúc', { id: job.id, status: job.status });
    // Đánh thức người đang chờ TRƯỚC khi báo host: agent đang ngủ trong `wait()`
    // là thứ duy nhất còn giữ lượt chat lại.
    this.wake();
    this.emit({ type: 'finished', job: { ...job } });
  }

  private append(record: JobRecord, text: string): void {
    record.output += text;
    if (record.output.length > MAX_JOB_OUTPUT) {
      const cut = record.output.length - MAX_JOB_OUTPUT;
      record.output = record.output.slice(cut);
      record.dropped += cut;
      record.cursor = Math.max(0, record.cursor - cut);
    }
  }

  list(): BackgroundJob[] {
    return [...this.records.values()].map((r) => ({ ...r.job }));
  }

  get(id: string): BackgroundJob | undefined {
    const record = this.records.get(id);
    return record ? { ...record.job } : undefined;
  }

  running(): BackgroundJob[] {
    return this.list().filter((j) => j.status === 'running');
  }

  /** Tác vụ đã xong mà chưa lần nào báo lại cho model. */
  unreported(): BackgroundJob[] {
    return [...this.records.values()]
      .filter((r) => r.job.status !== 'running' && !r.reported)
      .map((r) => ({ ...r.job }));
  }

  /**
   * Phần output MỚI kể từ lần đọc trước, và đánh dấu đã đọc tới đây.
   *
   * `dropped` đi kèm để người đọc biết mình đang xem khúc giữa của một log dài
   * chứ không phải cả log — im lặng cắt đầu là cách chắc chắn nhất để model
   * kết luận sai về một lỗi xảy ra ở phút đầu tiên.
   */
  readNew(id: string): { text: string; dropped: number } | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    const text = record.output.slice(record.cursor);
    const dropped = record.dropped;
    record.cursor = record.output.length;
    return { text, dropped };
  }

  /** Đánh dấu đã báo trạng thái cuối của tác vụ này cho model. */
  markReported(id: string): void {
    const record = this.records.get(id);
    if (record && record.job.status !== 'running') record.reported = true;
  }

  /**
   * Ngủ tới khi MỘT trong các tác vụ đang chạy kết thúc, hoặc hết giờ chờ.
   *
   * Trả về `true` nếu có tác vụ vừa xong. Chờ chứ không hỏi vòng vòng: mỗi
   * vòng hỏi là một request lên model, và một lệnh mười phút sẽ tốn hàng trăm
   * request chỉ để biết nó chưa xong.
   */
  async wait(ids: string[], timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const watched = ids.filter((id) => this.records.get(id)?.job.status === 'running');
    if (watched.length === 0) return true;
    if (signal?.aborted) return false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(check);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };

      const check = (): void => {
        if (watched.some((id) => this.records.get(id)?.job.status !== 'running')) done(true);
      };
      const onAbort = (): void => done(false);
      const timer = setTimeout(() => done(false), timeoutMs);

      this.waiters.add(check);
      signal?.addEventListener('abort', onAbort, { once: true });
      // Có thể đã xong ngay giữa lúc dựng promise này.
      check();
    });
  }

  /** Giết một tác vụ. Trả về false nếu không có id đó hoặc nó đã xong. */
  kill(id: string): boolean {
    const record = this.records.get(id);
    if (!record || record.job.status !== 'running') return false;
    record.abort.abort();
    return true;
  }

  /**
   * Giết mọi tác vụ còn chạy và quên cả sổ. Dùng khi hội thoại bị xoá.
   *
   * Chờ chứ không bắn rồi bỏ đi: `killTree` là bất đồng bộ, và một tiến trình
   * chưa chết hẳn vẫn giữ file lock trong thư mục người dùng sắp mở lại.
   */
  async killAll(): Promise<void> {
    const pending = [...this.records.values()].filter((r) => r.job.status === 'running');
    for (const record of pending) record.abort.abort();
    await Promise.all(pending.map((r) => r.finished));
    this.records.clear();
  }

  /** Đóng phiên hẳn: giết hết và bỏ luôn kênh báo cho host. */
  async dispose(): Promise<void> {
    await this.killAll();
    this.listeners.clear();
    this.waiters.clear();
  }

  onEvent(listener: JobListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: JobEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* một listener hỏng không được kéo theo tác vụ */
      }
    }
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  /** Quên tác vụ cũ nhất đã xong khi sổ quá dài. Tác vụ đang chạy không bị quên. */
  private forget(): void {
    if (this.records.size <= MAX_JOBS_KEPT) return;
    for (const [id, record] of this.records) {
      if (this.records.size <= MAX_JOBS_KEPT) return;
      if (record.job.status !== 'running') this.records.delete(id);
    }
  }
}

/** Một dòng "tác vụ này đang ở đâu" cho model đọc. */
export function describeJob(job: BackgroundJob, now = Date.now()): string {
  const seconds = Math.round(((job.endedAt ?? now) - job.startedAt) / 1000);
  const head =
    job.status === 'running'
      ? `đang chạy ${seconds}s`
      : job.status === 'killed'
        ? `đã bị dừng sau ${seconds}s`
        : job.timedOut
          ? `bị giết sau ${seconds}s vì quá giờ`
          : `kết thúc với mã ${job.exitCode ?? '?'} sau ${seconds}s`;
  const label = job.description ? `${job.description} — ${job.command}` : job.command;
  return `[${job.id}] ${head}: ${label}${job.error ? ` (lỗi: ${job.error})` : ''}`;
}
