/**
 * Pin file/đoạn code vào chat — người dùng chủ động gắn đúng phần cần cho
 * agent, thay vì để nó tự dò bằng read_file/grep mỗi lượt. Mục đích là tiết
 * kiệm token: agent thấy sẵn nội dung, không cần một vòng lặp riêng để đọc nó.
 *
 * Đọc lại TỪ ĐĨA mỗi lượt qua chính `readFileTool` — không có đường tắt riêng
 * bỏ qua pathGuard/denylist. Hai lý do:
 *
 *   1. File có thể đã đổi giữa hai lượt; một pin trỏ tới nội dung CŨ (cache)
 *      sẽ khiến model sửa nhầm trên bản đã lỗi thời.
 *   2. Pin trỏ tới `.env` hay file bị `.astraignore` chặn phải bị từ chối
 *      giống hệt như khi agent tự gọi read_file — quyền không được yếu đi chỉ
 *      vì đường vào là một cái pin thay vì một lời gọi tool.
 */
import { readFileTool } from '../tools/readFile.js';
import type { ToolContext } from '../tools/Tool.js';

/** Trần dòng cho một pin nguyên file — khớp trần tuyệt đối của read_file. */
const WHOLE_FILE_LIMIT = 5000;

export interface PinnedRef {
  /** Đường dẫn tương đối so với workspace root. */
  path: string;
  /** Dòng bắt đầu/kết thúc, đánh số từ 1. Bỏ trống cả hai = pin cả file. */
  startLine?: number;
  endLine?: number;
}

export interface ResolvedPin extends PinnedRef {
  content: string;
  /** File dài hơn phần đã đọc (chỉ có thể xảy ra ở pin cả file, chạm trần 5000 dòng). */
  truncated: boolean;
  /** Có khi pin không đọc được — path guard chặn, denylist chặn, file không còn tồn tại... */
  error?: string;
}

/** Đọc nội dung hiện tại của từng pin, qua đúng lớp chắn của read_file. */
export async function resolvePins(
  pins: PinnedRef[],
  ctx: ToolContext,
): Promise<ResolvedPin[]> {
  const out: ResolvedPin[] = [];
  for (const pin of pins) {
    const ranged = pin.startLine !== undefined && pin.endLine !== undefined;
    const result = await readFileTool.execute(
      {
        path: pin.path,
        ...(pin.startLine !== undefined ? { offset: pin.startLine } : {}),
        limit: ranged ? Math.max(1, pin.endLine! - pin.startLine! + 1) : WHOLE_FILE_LIMIT,
      },
      ctx,
    );

    if (result.isError) {
      out.push({ ...pin, content: '', truncated: false, error: result.content });
      continue;
    }
    out.push({
      ...pin,
      content: result.content,
      truncated: (result.meta?.truncated as boolean | undefined) ?? false,
    });
  }
  return out;
}

function renderOne(pin: ResolvedPin): string {
  const label =
    pin.startLine !== undefined && pin.endLine !== undefined
      ? `${pin.path} (dòng ${pin.startLine}–${pin.endLine})`
      : pin.path;
  return `<pinned_context untrusted="true">\n### ${label}\n\n${pin.content}\n</pinned_context>`;
}

/** Ghép các pin đọc thành công thành một khối, sẵn sàng gắn vào đầu tin nhắn user (xem `ChatController.pinnedPreamble`). */
export function renderPinnedContext(resolved: ResolvedPin[]): string {
  const ok = resolved.filter((p) => !p.error);
  if (ok.length === 0) return '';
  return ok.map(renderOne).join('\n\n');
}
