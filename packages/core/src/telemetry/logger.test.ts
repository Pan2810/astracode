import { describe, expect, it } from 'vitest';
import { ExchangeRecorder, Logger, MemorySink, newTraceId } from './logger.js';
import { Redactor } from '../security/redactor.js';

describe('Logger', () => {
  it('redact message và fields — không có đường vòng ra sink', () => {
    const sink = new MemorySink();
    const log = new Logger({ sink, level: 'debug' });

    log.info('gọi với AKIAIOSFODNN7EXAMPLE', { authorization: 'Bearer abc', ok: 1 });

    const rec = sink.records[0]!;
    expect(rec.msg).toContain('[REDACTED:aws-access-key]');
    expect(rec.msg).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(rec.authorization).toBe('[REDACTED:key:authorization]');
    expect(rec.ok).toBe(1);
  });

  it('lọc theo mức log', () => {
    const sink = new MemorySink();
    const log = new Logger({ sink, level: 'warn' });
    log.debug('bỏ');
    log.info('bỏ');
    log.warn('giữ');
    log.error('giữ');
    expect(sink.records.map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('child kế thừa traceId và bindings', () => {
    const sink = new MemorySink();
    const root = new Logger({ sink, level: 'debug', traceId: 'trace-1' });
    const child = root.child({ model: 'm1' });
    child.info('xong');

    const rec = sink.records[0]!;
    expect(rec.traceId).toBe('trace-1');
    expect(rec.model).toBe('m1');
  });

  it('child ghi đè được traceId', () => {
    const sink = new MemorySink();
    const child = new Logger({ sink, traceId: 'a' }).child({ traceId: 'b' });
    child.info('x');
    expect(sink.records[0]!.traceId).toBe('b');
  });

  it('child giữ nguyên mức log của cha', () => {
    const sink = new MemorySink();
    const child = new Logger({ sink, level: 'error' }).child({ k: 1 });
    child.warn('không được ghi');
    child.error('được ghi');
    expect(sink.records).toHaveLength(1);
  });

  it('dùng redactor được tiêm vào, kể cả literal đăng ký sau', () => {
    const redactor = new Redactor();
    const sink = new MemorySink();
    const log = new Logger({ sink, redactor });

    redactor.addLiteral('jwt-token-value-long-enough');
    log.info('token là jwt-token-value-long-enough');

    expect(sink.records[0]!.msg).toContain('[REDACTED:literal]');
  });

  it('MemorySink giữ tối đa `limit` bản ghi', () => {
    const sink = new MemorySink(3);
    const log = new Logger({ sink });
    for (let i = 0; i < 5; i++) log.info(`m${i}`);
    expect(sink.records.map((r) => r.msg)).toEqual(['m2', 'm3', 'm4']);
  });
});

describe('newTraceId', () => {
  it('sinh id khác nhau', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newTraceId()));
    expect(ids.size).toBe(100);
  });
});

describe('ExchangeRecorder', () => {
  it('redact nội dung được ghi lại', () => {
    const rec = new ExchangeRecorder();
    rec.record({
      traceId: 't1',
      ts: new Date().toISOString(),
      model: 'm',
      request: { authorization: 'Bearer secret', prompt: 'AKIAIOSFODNN7EXAMPLE' },
      events: [],
      durationMs: 5,
    });

    const stored = rec.all()[0]!.request as Record<string, string>;
    expect(stored.authorization).toBe('[REDACTED:key:authorization]');
    expect(stored.prompt).toContain('[REDACTED:aws-access-key]');
  });

  it('giới hạn số bản ghi giữ lại', () => {
    const rec = new ExchangeRecorder(new Redactor(), 2);
    for (let i = 0; i < 4; i++) {
      rec.record({
        traceId: `t${i}`,
        ts: '',
        model: 'm',
        request: {},
        events: [],
        durationMs: 0,
      });
    }
    expect(rec.all().map((e) => e.traceId)).toEqual(['t2', 't3']);
  });
});
