/**
 * Logging có cấu trúc + ghi lại exchange để replay — mốc M1.
 *
 * Vì sao làm ngay ở M1 chứ không để sau: debug một agent loop 40 bước bằng
 * console.log là địa ngục, và nhét traceId vào sau khi code đã rải rác thì
 * phải sửa mọi call site.
 *
 * Ràng buộc cứng: MỌI log đi qua Redactor. Không có đường vòng.
 */
import type { Redactor } from '../security/redactor.js';
import { defaultRedactor } from '../security/redactor.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  traceId?: string;
  /** Trường tự do, đã redact. */
  [key: string]: unknown;
}

/** Nơi log chảy tới. Core không biết gì về filesystem — sink do lớp ngoài cấp. */
export interface LogSink {
  write(record: LogRecord): void;
}

export class ConsoleSink implements LogSink {
  constructor(private readonly stream: { write(s: string): void } = process.stderr) {}

  write(record: LogRecord): void {
    const { ts, level, msg, traceId, ...rest } = record;
    const extra = Object.keys(rest).length > 0 ? ' ' + JSON.stringify(rest) : '';
    const trace = traceId ? ` [${traceId}]` : '';
    this.stream.write(`${ts} ${level.toUpperCase().padEnd(5)}${trace} ${msg}${extra}\n`);
  }
}

/** Giữ log trong bộ nhớ — dùng cho test và cho panel "xem log" ở M3. */
export class MemorySink implements LogSink {
  readonly records: LogRecord[] = [];
  constructor(private readonly limit = 5_000) {}

  write(record: LogRecord): void {
    this.records.push(record);
    if (this.records.length > this.limit) this.records.shift();
  }

  clear(): void {
    this.records.length = 0;
  }
}

export class MultiSink implements LogSink {
  constructor(private readonly sinks: LogSink[]) {}
  write(record: LogRecord): void {
    for (const s of this.sinks) s.write(record);
  }
}

export interface LoggerOptions {
  sink?: LogSink;
  level?: LogLevel;
  redactor?: Redactor;
  traceId?: string;
  /** Trường gắn kèm mọi record của logger này. */
  bindings?: Record<string, unknown>;
}

export class Logger {
  private readonly sink: LogSink;
  private readonly redactor: Redactor;
  private readonly bindings: Record<string, unknown>;
  readonly level: LogLevel;
  readonly traceId: string | undefined;

  constructor(opts: LoggerOptions = {}) {
    this.sink = opts.sink ?? new ConsoleSink();
    this.level = opts.level ?? 'info';
    this.redactor = opts.redactor ?? defaultRedactor;
    this.bindings = opts.bindings ?? {};
    this.traceId = opts.traceId;
  }

  /** Logger con cho một turn — mọi record thừa hưởng traceId. */
  child(bindings: Record<string, unknown> & { traceId?: string }): Logger {
    const { traceId, ...rest } = bindings;
    const nextTrace = traceId ?? this.traceId;
    return new Logger({
      sink: this.sink,
      level: this.level,
      redactor: this.redactor,
      ...(nextTrace !== undefined ? { traceId: nextTrace } : {}),
      bindings: { ...this.bindings, ...rest },
    });
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.log('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.log('error', msg, fields);
  }

  private log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    // Redact ở đây là điểm duy nhất — không ai được ghi thẳng vào sink.
    const merged = { ...this.bindings, ...(fields ?? {}) };
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      msg: this.redactor.redactText(msg),
      ...this.redactor.redactObject(merged),
    };
    if (this.traceId !== undefined) record.traceId = this.traceId;

    this.sink.write(record);
  }
}

/**
 * Một lượt gọi model, đã redact, đủ để replay lại mà không cần gọi mạng.
 * Đây là thứ MockProvider ăn vào trong test và trong eval harness (M2.5).
 */
export interface RecordedExchange {
  traceId: string;
  ts: string;
  model: string;
  request: unknown;
  events: unknown[];
  error?: { name: string; message: string; code?: string };
  durationMs: number;
}

export class ExchangeRecorder {
  private readonly items: RecordedExchange[] = [];

  constructor(
    private readonly redactor: Redactor = defaultRedactor,
    private readonly limit = 200,
  ) {}

  record(exchange: RecordedExchange): void {
    this.items.push(this.redactor.redactObject(exchange));
    if (this.items.length > this.limit) this.items.shift();
  }

  all(): readonly RecordedExchange[] {
    return this.items;
  }

  /** Xuất ra JSON để dán vào fixture của test hoặc gửi kèm bug report. */
  toJSON(): string {
    return JSON.stringify(this.items, null, 2);
  }

  clear(): void {
    this.items.length = 0;
  }
}

let counter = 0;

/** ID ngắn, đọc được, đủ phân biệt trong một phiên. Không cần crypto ở đây. */
export function newTraceId(prefix = 't'): string {
  counter = (counter + 1) % 100_000;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}${counter.toString(36)}${rand}`;
}
