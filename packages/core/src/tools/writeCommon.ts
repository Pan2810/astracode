/**
 * Phần dùng chung của mọi tool có ghi file (M4).
 *
 * Tồn tại để không tool nào tự nghĩ ra trình tự riêng. Trình tự đúng là:
 *
 *   pathGuard.resolveForWrite  →  denylist  →  đọc bản gốc  →  ghi  →  vào sổ
 *
 * Hai chỗ dễ làm sai nếu mỗi tool tự viết:
 *
 *   - Đọc bản gốc PHẢI xảy ra trước khi ghi. Bỏ qua là mất khả năng revert, và
 *     mất im lặng: mọi thứ vẫn chạy cho tới lúc người dùng bấm "hoàn tác".
 *   - Denylist phải chặn cả GHI, không chỉ đọc. Không cho agent đọc `.env`
 *     nhưng cho nó ghi đè `.env` thì lớp bảo vệ chỉ là nửa vời.
 */
import type { ToolContext, ToolResult } from './Tool.js';
import type { ChangeStatus } from '../changes/ChangeLedger.js';
import { PathGuardError } from '../security/pathGuard.js';
import { describeEscapes, isExecutablePath, scanEscapes } from '../security/workspaceEscape.js';

export interface ResolvedTarget {
  absolute: string;
  relative: string;
  /** Nội dung hiện tại, `null` nếu file chưa tồn tại. */
  original: string | null;
}

export type TargetResult =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; result: ToolResult };

/** Giải và kiểm tra một đường dẫn sắp bị ghi. Đọc luôn bản gốc nếu có. */
export async function resolveWriteTarget(
  path: string,
  ctx: ToolContext,
): Promise<TargetResult> {
  let absolute: string;
  try {
    absolute = await ctx.pathGuard.resolveForWrite(path);
  } catch (err) {
    if (err instanceof PathGuardError) {
      return { ok: false, result: { content: err.message, isError: true, untrusted: false } };
    }
    throw err;
  }

  const relative = await ctx.pathGuard.toRelative(absolute);

  const deny = ctx.denylist.check(relative);
  if (deny.denied) {
    ctx.logger.warn('chặn ghi file theo denylist', { path: relative, source: deny.source });
    return {
      ok: false,
      result: {
        content:
          `Không được ghi vào ${relative}: ${ctx.denylist.explain(relative)} ` +
          `File loại này nằm ngoài phạm vi agent được phép đụng tới.`,
        isError: true,
        untrusted: false,
      },
    };
  }

  let original: string | null = null;
  if (await ctx.fs.exists(absolute)) {
    const stat = await ctx.fs.stat(absolute);
    if (stat.type === 'directory') {
      return {
        ok: false,
        result: {
          content: `${relative} là thư mục, không ghi đè được.`,
          isError: true,
          untrusted: false,
        },
      };
    }
    original = await ctx.fs.readFile(absolute);
  }

  return { ok: true, target: { absolute, relative, original } };
}

/** Ghi xuống filesystem rồi vào sổ. Một chỗ duy nhất làm cặp việc này. */
export async function commitWrite(
  target: ResolvedTarget,
  next: string | null,
  ctx: ToolContext,
): Promise<ChangeStatus> {
  const status: ChangeStatus =
    next === null ? 'deleted' : target.original === null ? 'created' : 'modified';

  if (next === null) {
    await ctx.fs.deleteFile(target.absolute);
  } else {
    await ctx.fs.writeFile(target.absolute, next);
  }

  ctx.ledger?.record({
    uri: target.absolute,
    relativePath: target.relative,
    status,
    originalContent: target.original,
    currentContent: next,
    turnId: ctx.turnId ?? 'unknown',
  });

  ctx.logger.info('ghi file', { path: target.relative, status });
  return status;
}

/**
 * Cảnh báo cho hộp duyệt khi file sắp ghi là thứ SẼ ĐƯỢC ĐEM CHẠY.
 *
 * Chỉ soi file chạy được (`.py`, `.sh`, `.ps1`, …). Một file `.md` hay `.json`
 * có nhắc tới `C:\Windows` là tài liệu, không phải hành vi — gắn cờ nó là cách
 * nhanh nhất để người dùng học rằng cảnh báo này không đáng đọc.
 *
 * Điểm mấu chốt của việc đặt nó ở ĐÂY, trên đường ghi file, chứ không chỉ ở
 * tool chạy lệnh: chế độ `acceptEdits` tự duyệt mọi lần ghi. Không có chỗ này
 * thì agent viết ra một script đọc `~/.ssh` mà không ai được hỏi, và lần chạy
 * nó có thể xảy ra ở một lượt khác, một ngày khác, qua một lệnh trông vô hại.
 * Cảnh báo ở cổng quyền ép lần ghi ấy phải đi qua mắt người dùng — xem
 * `PermissionManager.check`.
 */
export function scriptWriteWarnings(
  relativePath: string,
  content: string,
  ctx: ToolContext,
): string[] {
  if (!isExecutablePath(relativePath)) return [];
  const findings = describeEscapes(scanEscapes(content, { workspaceRoot: ctx.workspaceRoot }));
  if (findings.length === 0) return [];
  return [
    `${relativePath} is a script that reaches outside this workspace:`,
    ...findings,
  ];
}

/** Chuẩn hoá xuống dòng theo bản gốc — tránh diff giả toàn file trên Windows. */
export function matchLineEndings(original: string | null, next: string): string {
  if (original === null) return next;
  const originalUsesCrlf = /\r\n/.test(original);
  const nextUsesCrlf = /\r\n/.test(next);
  if (originalUsesCrlf && !nextUsesCrlf) return next.replace(/\n/g, '\r\n');
  if (!originalUsesCrlf && nextUsesCrlf) return next.replace(/\r\n/g, '\n');
  return next;
}
