import { describe, expect, it } from 'vitest';
import { summarizeToolResult } from './summary.js';

describe('summarizeToolResult', () => {
  it('read_file: đường dẫn và số dòng', () => {
    expect(
      summarizeToolResult({
        name: 'read_file',
        meta: { path: 'src/auth.ts', totalLines: 120, truncated: false },
      }),
    ).toBe('src/auth.ts · 120 lines');
  });

  it('read_file: nói rõ khi bị cắt', () => {
    expect(
      summarizeToolResult({
        name: 'read_file',
        meta: { path: 'a.ts', totalLines: 9000, truncated: true },
      }),
    ).toContain('truncated');
  });

  it('grep: số kết quả và số file', () => {
    expect(
      summarizeToolResult({ name: 'grep', meta: { count: 12, files: 3 } }),
    ).toBe('12 matches · 3 files');
  });

  it('chạy nền thì nói đang chạy, không bịa ra mã thoát', () => {
    for (const name of ['bash', 'python']) {
      expect(summarizeToolResult({ name, meta: { background: true, taskId: 'bg1' } })).toBe(
        'running in background · bg1',
      );
    }
  });

  it('task_status: bao nhiêu đang chạy, bao nhiêu đã xong', () => {
    expect(
      summarizeToolResult({ name: 'task_status', meta: { running: 1, finished: 2, waited: true } }),
    ).toBe('1 running · 2 finished · waited');
  });

  it('task_kill: dừng được hay đã xong từ trước', () => {
    expect(summarizeToolResult({ name: 'task_kill', meta: { killed: true } })).toBe('stopped');
    expect(summarizeToolResult({ name: 'task_kill', meta: { killed: false } })).toBe(
      'already finished',
    );
  });

  it('grep: không khớp gì', () => {
    expect(summarizeToolResult({ name: 'grep', meta: { count: 0 } })).toBe('no matches');
  });

  it('edit_file: số dòng thêm/bớt', () => {
    expect(
      summarizeToolResult({
        name: 'edit_file',
        meta: { path: 'src/x.ts', added: 3, removed: 1, fuzzy: false },
      }),
    ).toBe('src/x.ts · +3 −1');
  });

  it('edit_file: nói rõ khi phải khớp mờ', () => {
    expect(
      summarizeToolResult({
        name: 'edit_file',
        meta: { path: 'x.ts', added: 1, removed: 1, fuzzy: true },
      }),
    ).toContain('ignoring whitespace');
  });

  it('write_file: phân biệt tạo mới và ghi đè', () => {
    expect(
      summarizeToolResult({ name: 'write_file', meta: { path: 'a.ts', status: 'created', lines: 4 } }),
    ).toBe('a.ts · created · 4 lines');
    expect(
      summarizeToolResult({ name: 'write_file', meta: { path: 'a.ts', status: 'modified', lines: 4 } }),
    ).toBe('a.ts · overwritten · 4 lines');
  });

  it('bash: mã thoát và thời gian', () => {
    expect(
      summarizeToolResult({ name: 'bash', meta: { exitCode: 0, durationMs: 1200 } }),
    ).toBe('ok · 1.2s');
    expect(
      summarizeToolResult({ name: 'bash', meta: { exitCode: 2, durationMs: 500 } }),
    ).toBe('exit code 2 · 0.5s');
    expect(
      summarizeToolResult({ name: 'bash', meta: { exitCode: 1, timedOut: true, durationMs: 120000 } }),
    ).toContain('timed out');
  });

  it('bash/python: mã thoát thật, kể cả khi isError — không phải chữ error rỗng', () => {
    for (const name of ['bash', 'python']) {
      expect(
        summarizeToolResult({ name, isError: true, meta: { exitCode: 1, durationMs: 100 } }),
      ).toBe('exit code 1 · 0.1s');
      expect(
        summarizeToolResult({ name, isError: true, meta: { exitCode: 127, durationMs: 50 } }),
      ).toBe('exit code 127 · 0.1s');
    }
  });

  it('todo_write: tiến độ', () => {
    expect(summarizeToolResult({ name: 'todo_write', meta: { total: 5, done: 2 } })).toBe(
      '2/5 done',
    );
  });

  it('ask_user_question: đã trả lời', () => {
    expect(
      summarizeToolResult({
        name: 'ask_user_question',
        meta: { questionCount: 1, answered: 1 },
      }),
    ).toBe('answered');
    expect(
      summarizeToolResult({
        name: 'ask_user_question',
        meta: { questionCount: 3, answered: 2 },
      }),
    ).toBe('2/3 answered');
  });

  it('ask_user_question: cancelled/noCapability không lẫn vào chữ "error" chung', () => {
    expect(
      summarizeToolResult({
        name: 'ask_user_question',
        isError: true,
        meta: { cancelled: true, questionCount: 1 },
      }),
    ).toBe('no answer — stopped');
    expect(
      summarizeToolResult({
        name: 'ask_user_question',
        isError: true,
        meta: { noCapability: true },
      }),
    ).toBe('not supported here');
  });

  it('lỗi thì nói lỗi, bất kể meta', () => {
    expect(
      summarizeToolResult({ name: 'read_file', isError: true, meta: { totalLines: 3 } }),
    ).toBe('error');
  });

  it('tool lạ hoặc thiếu meta vẫn ra được một dòng', () => {
    expect(summarizeToolResult({ name: 'mcp__git__status', contentLength: 42 })).toBe('42 chars');
    expect(summarizeToolResult({ name: 'mcp__git__status' })).toBe('done');
    expect(summarizeToolResult({ name: 'list_dir', meta: {} })).toBe('done');
  });
});
