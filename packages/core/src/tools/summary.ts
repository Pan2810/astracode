/**
 * Một dòng tóm tắt "tool vừa làm được gì" cho UI.
 *
 * Vì sao không để UI tự dựng: `meta` là hợp đồng giữa tool và người đọc, và
 * hợp đồng đó nên nằm cạnh tool. Đặt ở webview thì mỗi lần thêm tool mới, dòng
 * tóm tắt sẽ âm thầm rơi về mặc định mà không ai để ý.
 *
 * Vì sao không tóm tắt bằng `content`: content là nội dung KHÔNG TIN CẬY do
 * model hoặc file sinh ra. `meta` do chính tool ghi, nên nó là nguồn duy nhất
 * an toàn để nói về kết quả.
 */

export interface ToolSummaryInput {
  name: string;
  meta?: Record<string, unknown>;
  isError?: boolean;
  /** Số ký tự của kết quả — dùng khi tool không khai báo meta. */
  contentLength?: number;
}

export function summarizeToolResult(input: ToolSummaryInput): string {
  const meta = input.meta ?? {};
  const n = (key: string): number | undefined =>
    typeof meta[key] === 'number' ? (meta[key] as number) : undefined;
  const s = (key: string): string | undefined =>
    typeof meta[key] === 'string' ? (meta[key] as string) : undefined;

  // Tool vừa BẬT một tác vụ nền: chưa có mã thoát nào để nói, và nói "ok" ở đây
  // là báo xong một việc mới chỉ vừa bắt đầu. Đứng trước mọi nhánh khác vì mọi
  // tool chạy lệnh đều dùng được đường này.
  if (meta.background === true) return join(['running in background', s('taskId')]);

  // bash/python luôn có exitCode trong meta, THÀNH CÔNG hay THẤT BẠI như nhau —
  // đi qua nhánh riêng NGAY CẢ KHI isError, để "grep không khớp gì" (exit 1,
  // không phải hỏng) không biến thành chữ 'error' rỗng không nói lên điều gì.
  // Đứng TRƯỚC `if (input.isError)` là chủ ý: đó chính là lỗi đã gây ra sự cố
  // PDF.
  if (input.name === 'bash' || input.name === 'python') {
    const code = n('exitCode');
    const head =
      meta.timedOut === true ? 'timed out' : code === 0 ? 'ok' : `exit code ${code ?? '?'}`;
    return join([head, seconds(n('durationMs'))]);
  }

  // Đứng TRƯỚC nhánh isError chung, cùng lý do với bash/python ở trên: cancelled
  // và noCapability đều là isError nhưng KHÔNG phải "error" theo nghĩa người
  // dùng cần hiểu — nhánh chung sẽ nuốt mất sự khác biệt đó.
  if (input.name === 'ask_user_question') {
    if (meta.cancelled === true) return 'no answer — stopped';
    if (meta.noCapability === true) return 'not supported here';
    const total = n('questionCount') ?? 0;
    const answered = n('answered') ?? 0;
    return total <= 1 ? 'answered' : `${answered}/${total} answered`;
  }

  if (input.isError) return 'error';

  switch (input.name) {
    case 'read_file': {
      const parts = [s('path'), plural(n('totalLines'), 'lines')];
      if (meta.truncated === true) parts.push('truncated');
      return join(parts);
    }

    case 'grep': {
      const count = n('count') ?? 0;
      if (count === 0) return 'no matches';
      return join([plural(count, 'matches'), plural(n('files'), 'files')]);
    }

    case 'glob': {
      const count = n('count') ?? 0;
      return count === 0 ? 'no matches' : plural(count, 'files')!;
    }

    case 'list_dir':
      return join([s('path'), plural(n('dirs'), 'dirs'), plural(n('files'), 'files')]);

    case 'write_file':
      return join([
        s('path'),
        s('status') === 'created' ? 'created' : 'overwritten',
        plural(n('lines'), 'lines'),
      ]);

    case 'edit_file': {
      const added = n('added') ?? 0;
      const removed = n('removed') ?? 0;
      return join([
        s('path'),
        `+${added} −${removed}`,
        meta.fuzzy === true ? 'matched ignoring whitespace' : undefined,
      ]);
    }

    case 'find_references': {
      if (meta.found !== true) return 'not found';
      return join([meta.hasDefinition === true ? 'defined' : undefined, plural(n('references'), 'refs')]);
    }

    case 'impact_of': {
      if (meta.found !== true) return 'not indexed';
      return plural(n('impacted'), 'files affected')!;
    }

    case 'install_package':
      return join([s('manager'), s('packages'), s('target')]);

    case 'task_status': {
      const running = n('running') ?? 0;
      const finished = n('finished') ?? 0;
      return join([
        running > 0 ? plural(running, 'running') : undefined,
        finished > 0 ? plural(finished, 'finished') : undefined,
        meta.waited === true ? 'waited' : undefined,
      ]);
    }

    case 'task_kill':
      return meta.killed === true ? 'stopped' : 'already finished';

    case 'todo_write': {
      const total = n('total') ?? 0;
      return `${n('done') ?? 0}/${total} done`;
    }

    default: {
      const len = input.contentLength ?? 0;
      return len > 0 ? plural(len, 'chars')! : 'done';
    }
  }
}

function plural(value: number | undefined, unit: string): string | undefined {
  return value === undefined ? undefined : `${value} ${unit}`;
}

function seconds(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : `${(ms / 1000).toFixed(1)}s`;
}

function join(parts: Array<string | undefined>): string {
  const kept = parts.filter((p): p is string => p !== undefined && p !== '');
  return kept.length > 0 ? kept.join(' · ') : 'done';
}
