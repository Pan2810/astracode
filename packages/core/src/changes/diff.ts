/**
 * Diff theo dòng — dùng cho ba chỗ ở M4: xem trước khi duyệt quyền, tô màu
 * dòng thêm/xoá trong editor, và tóm tắt `+n/-m` trên TreeView.
 *
 * Tự viết thay vì kéo thư viện: cần đúng một thuật toán LCS trên dòng, và một
 * dependency mới ở đây phải qua kiểm duyệt supply chain (documents/SECURITY.md §7)
 * cho vài chục dòng code.
 *
 * Có trần độ dài: LCS là O(n·m) bộ nhớ. Với file lớn thì rơi về diff thô theo
 * tiền tố/hậu tố chung — kém đẹp nhưng không làm treo extension host.
 */

export type DiffOp = 'equal' | 'add' | 'remove';

export interface DiffLine {
  op: DiffOp;
  /** Số dòng trong bản GỐC, đánh số từ 1. undefined với dòng thêm mới. */
  oldLine?: number;
  /** Số dòng trong bản MỚI, đánh số từ 1. undefined với dòng bị xoá. */
  newLine?: number;
  text: string;
}

export interface DiffStat {
  added: number;
  removed: number;
}

/** Trên ngưỡng này thì không chạy LCS đầy đủ nữa. */
const MAX_LCS_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  // Cắt phần đầu và phần đuôi giống nhau trước. Với một lần sửa nhỏ trong file
  // 2000 dòng, bước này thường làm bài toán còn lại nhỏ đi vài trăm lần.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) {
    out.push({ op: 'equal', oldLine: i + 1, newLine: i + 1, text: a[i]! });
  }

  const middle =
    midA.length * midB.length > MAX_LCS_CELLS
      ? coarseDiff(midA, midB, head)
      : lcsDiff(midA, midB, head);
  out.push(...middle);

  for (let i = 0; i < tail; i++) {
    const oldIdx = a.length - tail + i;
    const newIdx = b.length - tail + i;
    out.push({ op: 'equal', oldLine: oldIdx + 1, newLine: newIdx + 1, text: a[oldIdx]! });
  }

  return out;
}

/** Khoảng cách chỉnh sửa đầy đủ trên phần giữa. */
function lcsDiff(a: string[], b: string[], offset: number): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // table[i][j] = độ dài LCS của a[i..] và b[j..]
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'equal', oldLine: offset + i + 1, newLine: offset + j + 1, text: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ op: 'remove', oldLine: offset + i + 1, text: a[i]! });
      i++;
    } else {
      out.push({ op: 'add', newLine: offset + j + 1, text: b[j]! });
      j++;
    }
  }
  while (i < n) {
    out.push({ op: 'remove', oldLine: offset + i + 1, text: a[i]! });
    i++;
  }
  while (j < m) {
    out.push({ op: 'add', newLine: offset + j + 1, text: b[j]! });
    j++;
  }
  return out;
}

/** Dự phòng cho file quá lớn: xoá cả khối cũ, thêm cả khối mới. */
function coarseDiff(a: string[], b: string[], offset: number): DiffLine[] {
  const out: DiffLine[] = [];
  a.forEach((text, i) => out.push({ op: 'remove', oldLine: offset + i + 1, text }));
  b.forEach((text, j) => out.push({ op: 'add', newLine: offset + j + 1, text }));
  return out;
}

export function diffStat(lines: DiffLine[]): DiffStat {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === 'add') added++;
    else if (l.op === 'remove') removed++;
  }
  return { added, removed };
}

export interface UnifiedDiffOptions {
  /** Số dòng ngữ cảnh quanh mỗi cụm thay đổi. Mặc định 3. */
  context?: number;
  /** Trần số dòng in ra, tránh nhét cả file vào hộp duyệt quyền. */
  maxLines?: number;
}

/**
 * Diff dạng unified, để người dùng đọc trong hộp duyệt quyền và để model
 * nhận lại xác nhận đã sửa gì.
 */
export function formatUnifiedDiff(
  before: string,
  after: string,
  opts: UnifiedDiffOptions = {},
): string {
  const context = opts.context ?? 3;
  const maxLines = opts.maxLines ?? 200;
  const lines = diffLines(before, after);

  // Đánh dấu dòng nào cần in: dòng thay đổi và ngữ cảnh quanh nó.
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.op === 'equal') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
      keep[k] = true;
    }
  });

  const out: string[] = [];
  let skipping = false;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      if (!skipping) {
        out.push('…');
        skipping = true;
      }
      continue;
    }
    skipping = false;
    const l = lines[i]!;
    const sign = l.op === 'add' ? '+' : l.op === 'remove' ? '-' : ' ';
    const num = l.op === 'add' ? l.newLine : l.oldLine;
    out.push(`${sign}${String(num ?? '').padStart(5)} ${l.text}`);

    if (out.length >= maxLines) {
      out.push(`… (còn ${lines.length - i - 1} dòng nữa)`);
      break;
    }
  }

  return out.join('\n');
}
