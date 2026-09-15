import { describe, expect, it, vi } from 'vitest';
import { ChangeLedger, summarizeChanges } from './ChangeLedger.js';
import { diffLines, diffStat, formatUnifiedDiff } from './diff.js';

function ledger(): ChangeLedger {
  return new ChangeLedger({ caseInsensitive: true });
}

describe('ChangeLedger — gộp thay đổi', () => {
  it('giữ bản gốc ĐẦU TIÊN qua nhiều lần sửa cùng file', () => {
    const l = ledger();
    l.record({
      uri: 'C:/repo/a.ts',
      relativePath: 'a.ts',
      status: 'modified',
      originalContent: 'v0',
      currentContent: 'v1',
      turnId: 't1',
    });
    l.record({
      uri: 'C:/repo/a.ts',
      relativePath: 'a.ts',
      status: 'modified',
      // Lần thứ hai "bản gốc" chính là v1 — sổ phải bỏ qua nó.
      originalContent: 'v1',
      currentContent: 'v2',
      turnId: 't1',
    });

    const change = l.get('C:/repo/a.ts');
    expect(change?.originalContent).toBe('v0');
    expect(change?.currentContent).toBe('v2');
    expect(l.size).toBe(1);
  });

  it('tạo rồi sửa vẫn là "created", không phải "modified"', () => {
    const l = ledger();
    l.record({
      uri: 'C:/repo/new.ts',
      relativePath: 'new.ts',
      status: 'created',
      originalContent: null,
      currentContent: 'a',
      turnId: 't1',
    });
    l.record({
      uri: 'C:/repo/new.ts',
      relativePath: 'new.ts',
      status: 'modified',
      originalContent: 'a',
      currentContent: 'ab',
      turnId: 't1',
    });

    expect(l.get('C:/repo/new.ts')?.status).toBe('created');
    expect(l.get('C:/repo/new.ts')?.originalContent).toBeNull();
  });

  it('tạo rồi xoá thì biến mất khỏi sổ — kết quả ròng là không có gì', () => {
    const l = ledger();
    l.record({
      uri: 'C:/repo/tmp.ts',
      relativePath: 'tmp.ts',
      status: 'created',
      originalContent: null,
      currentContent: 'x',
      turnId: 't1',
    });
    l.record({
      uri: 'C:/repo/tmp.ts',
      relativePath: 'tmp.ts',
      status: 'deleted',
      originalContent: 'x',
      currentContent: null,
      turnId: 't1',
    });

    expect(l.size).toBe(0);
  });

  it('so khoá không phân biệt hoa thường trên Windows', () => {
    const l = ledger();
    l.record({
      uri: 'C:/Repo/A.ts',
      relativePath: 'A.ts',
      status: 'modified',
      originalContent: 'v0',
      currentContent: 'v1',
      turnId: 't1',
    });
    l.record({
      uri: 'c:/repo/a.ts',
      relativePath: 'A.ts',
      status: 'modified',
      originalContent: 'v1',
      currentContent: 'v2',
      turnId: 't1',
    });

    expect(l.size).toBe(1);
    // Đường dẫn hiển thị giữ dạng đã ghi lần đầu.
    expect(l.get('C:/REPO/A.TS')?.uri).toBe('C:/Repo/A.ts');
  });

  it('sửa lại sau khi đã duyệt thì phải duyệt lại', () => {
    const l = ledger();
    const base = {
      uri: 'C:/repo/a.ts',
      relativePath: 'a.ts',
      status: 'modified' as const,
      turnId: 't1',
    };
    l.record({ ...base, originalContent: 'v0', currentContent: 'v1' });
    l.accept('C:/repo/a.ts');
    expect(l.get('C:/repo/a.ts')?.approved).toBe(true);

    l.record({ ...base, originalContent: 'v1', currentContent: 'v2' });
    expect(l.get('C:/repo/a.ts')?.approved).toBe(false);
  });
});

describe('ChangeLedger — hoàn tác', () => {
  it('reject trả về nội dung gốc và gỡ khỏi sổ', () => {
    const l = ledger();
    l.record({
      uri: 'C:/repo/a.ts',
      relativePath: 'a.ts',
      status: 'modified',
      originalContent: 'gốc',
      currentContent: 'mới',
      turnId: 't1',
    });

    expect(l.reject('C:/repo/a.ts')).toEqual({ uri: 'C:/repo/a.ts', content: 'gốc' });
    expect(l.size).toBe(0);
  });

  it('reject file mới tạo trả content null — nghĩa là xoá đi', () => {
    const l = ledger();
    l.record({
      uri: 'C:/repo/new.ts',
      relativePath: 'new.ts',
      status: 'created',
      originalContent: null,
      currentContent: 'x',
      turnId: 't1',
    });

    expect(l.reject('C:/repo/new.ts')?.content).toBeNull();
  });

  it('revertTurn chỉ đụng lượt được chỉ định', () => {
    const l = ledger();
    l.record({
      uri: 'C:/repo/a.ts',
      relativePath: 'a.ts',
      status: 'modified',
      originalContent: 'a0',
      currentContent: 'a1',
      turnId: 't1',
    });
    l.record({
      uri: 'C:/repo/b.ts',
      relativePath: 'b.ts',
      status: 'modified',
      originalContent: 'b0',
      currentContent: 'b1',
      turnId: 't2',
    });

    const ops = l.revertTurn('t2');
    expect(ops).toEqual([{ uri: 'C:/repo/b.ts', content: 'b0' }]);
    expect(l.size).toBe(1);
    expect(l.get('C:/repo/a.ts')).toBeDefined();
  });

  it('revertAll trả cả file đã duyệt', () => {
    const l = ledger();
    l.record({
      uri: 'C:/repo/a.ts',
      relativePath: 'a.ts',
      status: 'modified',
      originalContent: 'a0',
      currentContent: 'a1',
      turnId: 't1',
    });
    l.accept('C:/repo/a.ts');

    expect(l.revertAll()).toHaveLength(1);
    expect(l.size).toBe(0);
  });
});

describe('ChangeLedger — thông báo', () => {
  it('một listener ném lỗi không làm chết listener còn lại', () => {
    const l = ledger();
    const good = vi.fn();
    l.onChange(() => {
      throw new Error('vỡ');
    });
    l.onChange(good);

    l.record({
      uri: 'C:/repo/a.ts',
      relativePath: 'a.ts',
      status: 'created',
      originalContent: null,
      currentContent: 'x',
      turnId: 't1',
    });

    expect(good).toHaveBeenCalledOnce();
  });

  it('tóm tắt đếm đúng từng loại', () => {
    const l = ledger();
    for (const [name, status] of [
      ['a.ts', 'created'],
      ['b.ts', 'modified'],
      ['c.ts', 'modified'],
      ['d.ts', 'deleted'],
    ] as const) {
      l.record({
        uri: `C:/repo/${name}`,
        relativePath: name,
        status,
        originalContent: status === 'created' ? null : 'x',
        currentContent: status === 'deleted' ? null : 'y',
        turnId: 't1',
      });
    }

    expect(summarizeChanges(l.list())).toBe('1 new, 2 edited, 1 deleted');
    expect(summarizeChanges([])).toBe('No files changed');
  });
});

describe('diff theo dòng', () => {
  it('đếm đúng dòng thêm và xoá', () => {
    const stat = diffStat(diffLines('a\nb\nc', 'a\nB\nc\nd'));
    expect(stat).toEqual({ added: 2, removed: 1 });
  });

  it('file không đổi thì không có dòng nào được đánh dấu', () => {
    expect(diffStat(diffLines('a\nb', 'a\nb'))).toEqual({ added: 0, removed: 0 });
  });

  it('giữ đúng số dòng của cả hai bản', () => {
    const lines = diffLines('a\nb\nc', 'a\nc');
    const removed = lines.find((l) => l.op === 'remove');
    expect(removed?.text).toBe('b');
    expect(removed?.oldLine).toBe(2);
    expect(removed?.newLine).toBeUndefined();
  });

  it('unified diff chỉ in quanh chỗ đổi, phần giữa thu lại', () => {
    const before = Array.from({ length: 40 }, (_, i) => `dòng ${i}`).join('\n');
    const after = before.replace('dòng 20', 'DÒNG HAI MƯƠI');
    const out = formatUnifiedDiff(before, after);

    expect(out).toContain('-   21 dòng 20');
    expect(out).toContain('+   21 DÒNG HAI MƯƠI');
    expect(out).toContain('…');
    expect(out).not.toContain('dòng 5');
  });
});
