/**
 * edit_file — thay một đoạn văn bản trong file bằng đoạn khác (M4).
 *
 * Đây là tool sửa code CHÍNH. Cả chất lượng lẫn độ an toàn của agent phụ thuộc
 * vào việc nó khớp đúng chỗ, và báo lỗi tử tế khi không khớp.
 *
 * Ba tầng khớp, theo thứ tự:
 *
 *   1. Khớp CHÍNH XÁC. Yêu cầu đoạn cũ xuất hiện đúng một lần. Nhiều hơn một
 *      lần là từ chối, không phải "lấy cái đầu tiên": model thường gửi đoạn
 *      ngắn kiểu `return null;` và sửa nhầm chỗ là hỏng im lặng.
 *   2. Khớp bỏ qua KHOẢNG TRẮNG đầu/cuối dòng. Model tái tạo thụt lề sai là
 *      chuyện xảy ra liên tục, nhất là khi nó đọc file qua bản đánh số dòng.
 *      Vẫn giữ nguyên thụt lề THẬT của file khi ghi.
 *   3. Không khớp → lỗi kèm ĐOẠN GẦN ĐÚNG NHẤT trong file. Câu "không tìm
 *      thấy" trơ trọi khiến model đoán mò và thử lại y hệt; đưa đoạn thật ra
 *      thì nó sửa được ngay ở lần sau.
 */
import { z } from 'zod';
import type { Tool, ToolContext, ToolIntent, ToolResult } from './Tool.js';
import {
  commitWrite,
  matchLineEndings,
  resolveWriteTarget,
  scriptWriteWarnings,
} from './writeCommon.js';
import { diffLines, diffStat, formatUnifiedDiff, splitLines } from '../changes/diff.js';

const schema = z.object({
  path: z.string().min(1).describe('Đường dẫn file, tương đối so với thư mục làm việc'),
  old_string: z
    .string()
    .min(1)
    .describe(
      'Đoạn văn bản cần thay. Phải xuất hiện ĐÚNG MỘT LẦN trong file — ' +
        'thêm dòng ngữ cảnh phía trên/dưới cho đủ duy nhất. ' +
        'KHÔNG kèm số dòng của read_file.',
    ),
  new_string: z.string().describe('Đoạn thay thế. Chuỗi rỗng = xoá đoạn cũ.'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Thay mọi lần xuất hiện. Dùng khi đổi tên biến/hàm trên cả file.'),
});

type EditArgs = z.infer<typeof schema>;

export interface MatchResult {
  next: string;
  count: number;
  /** Đã phải dùng tầng khớp bỏ qua khoảng trắng. */
  fuzzy: boolean;
}

export type MatchOutcome =
  | { ok: true; match: MatchResult }
  | { ok: false; reason: 'not-found' | 'ambiguous'; count: number; nearest?: string };

/**
 * Bỏ số dòng mà model hay copy nguyên từ output của read_file
 * (`  12\tconst x = 1;`). Chỉ bỏ khi MỌI dòng đều có dạng đó — nếu không, một
 * file dữ liệu bắt đầu bằng số sẽ bị cắt mất cột đầu.
 */
export function stripLineNumbers(text: string): string {
  const lines = splitLines(text);
  if (lines.length === 0) return text;
  const re = /^\s*\d+\t/;
  if (!lines.every((l) => l === '' || re.test(l))) return text;
  return lines.map((l) => l.replace(re, '')).join('\n');
}

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

/** Tìm và thay. Không chạm filesystem — tách ra để test được thẳng. */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): MatchOutcome {
  // ── Tầng 1: khớp chính xác ────────────────────────────────────────────────
  const exactCount = countOccurrences(content, oldString);
  if (exactCount === 1 || (exactCount > 1 && replaceAll)) {
    return {
      ok: true,
      match: {
        next: replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString),
        count: exactCount,
        fuzzy: false,
      },
    };
  }
  if (exactCount > 1) {
    return { ok: false, reason: 'ambiguous', count: exactCount };
  }

  // ── Tầng 2: khớp bỏ qua khoảng trắng ──────────────────────────────────────
  const fuzzy = fuzzyReplace(content, oldString, newString, replaceAll);
  if (fuzzy.count === 1 || (fuzzy.count > 1 && replaceAll)) {
    return { ok: true, match: { next: fuzzy.next, count: fuzzy.count, fuzzy: true } };
  }
  if (fuzzy.count > 1) {
    return { ok: false, reason: 'ambiguous', count: fuzzy.count };
  }

  // ── Tầng 3: chịu thua, nhưng chỉ ra chỗ gần đúng nhất ─────────────────────
  return { ok: false, reason: 'not-found', count: 0, ...pickNearest(content, oldString) };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    count++;
    from = i + needle.length;
  }
  return count;
}

/**
 * Khớp theo dòng đã chuẩn hoá khoảng trắng, nhưng thay trên văn bản GỐC —
 * nên thụt lề thật của file không bị đoạn model gửi lên ghi đè.
 */
function fuzzyReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { next: string; count: number } {
  const contentLines = splitLines(content);
  const oldLines = splitLines(oldString);
  const normContent = contentLines.map(normalizeLine);
  const normOld = oldLines.map(normalizeLine);

  // Bỏ dòng rỗng ở hai đầu đoạn cần tìm — chúng chỉ là cách model xuống dòng.
  while (normOld.length > 0 && normOld[0] === '') {
    normOld.shift();
    oldLines.shift();
  }
  while (normOld.length > 0 && normOld[normOld.length - 1] === '') {
    normOld.pop();
    oldLines.pop();
  }
  if (normOld.length === 0) return { next: content, count: 0 };

  const hits: number[] = [];
  for (let i = 0; i + normOld.length <= normContent.length; i++) {
    let match = true;
    for (let j = 0; j < normOld.length; j++) {
      if (normContent[i + j] !== normOld[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      hits.push(i);
      i += normOld.length - 1;
    }
  }

  if (hits.length === 0) return { next: content, count: 0 };
  if (hits.length > 1 && !replaceAll) return { next: content, count: hits.length };

  // Giữ thụt lề của dòng đầu tiên chỗ khớp: đoạn thay thế model gửi thường
  // thụt lề theo cách nó tưởng tượng, không theo file thật.
  const targets = replaceAll ? hits : [hits[0]!];
  const out = [...contentLines];
  for (const start of [...targets].reverse()) {
    const indent = /^[ \t]*/.exec(contentLines[start] ?? '')?.[0] ?? '';
    const replacement = newString === '' ? [] : reindent(splitLines(newString), indent);
    out.splice(start, normOld.length, ...replacement);
  }

  return { next: out.join('\n'), count: hits.length };
}

/** Đưa khối thay thế về thụt lề gốc, giữ nguyên thụt lề TƯƠNG ĐỐI bên trong. */
function reindent(lines: string[], indent: string): string[] {
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  if (nonEmpty.length === 0) return lines;
  const base = Math.min(
    ...nonEmpty.map((l) => (/^[ \t]*/.exec(l)?.[0] ?? '').length),
  );
  return lines.map((l) => (l.trim() === '' ? l : indent + l.slice(base)));
}

/**
 * Đoạn trong file giống đoạn cần tìm nhất, để đưa vào thông báo lỗi.
 * Chấm điểm bằng số dòng chuẩn hoá trùng nhau — thô nhưng đủ để model nhận ra
 * "à, chỗ đó viết hơi khác".
 */
function pickNearest(content: string, oldString: string): { nearest?: string } {
  const contentLines = splitLines(content);
  const oldLines = splitLines(oldString).filter((l) => l.trim() !== '');
  if (oldLines.length === 0 || contentLines.length === 0) return {};

  const wanted = new Set(oldLines.map(normalizeLine));
  const window = Math.min(oldLines.length + 4, contentLines.length);

  let bestStart = -1;
  let bestScore = 0;
  for (let i = 0; i + window <= contentLines.length; i++) {
    let score = 0;
    for (let j = 0; j < window; j++) {
      if (wanted.has(normalizeLine(contentLines[i + j] ?? ''))) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }

  // Dưới một phần ba số dòng trùng thì "gần nhất" chỉ là nhiễu, đừng gợi ý bừa.
  if (bestStart === -1 || bestScore < Math.max(1, Math.ceil(oldLines.length / 3))) return {};

  const snippet = contentLines
    .slice(bestStart, bestStart + window)
    .map((l, k) => `${String(bestStart + k + 1).padStart(5)}\t${l}`)
    .join('\n');
  return { nearest: snippet };
}

async function prepare(
  args: EditArgs,
  ctx: ToolContext,
): Promise<
  | { ok: true; relative: string; original: string; next: string; count: number; fuzzy: boolean; target: Awaited<ReturnType<typeof resolveWriteTarget>> }
  | { ok: false; result: ToolResult }
> {
  const resolved = await resolveWriteTarget(args.path, ctx);
  if (!resolved.ok) return { ok: false, result: resolved.result };

  const { target } = resolved;
  if (target.original === null) {
    return {
      ok: false,
      result: {
        content:
          `${target.relative} chưa tồn tại nên không có gì để sửa. ` +
          `Dùng write_file nếu bạn muốn tạo mới.`,
        isError: true,
        untrusted: false,
      },
    };
  }

  const oldString = stripLineNumbers(args.old_string);
  const outcome = applyEdit(
    target.original,
    oldString,
    args.new_string,
    args.replace_all === true,
  );

  if (!outcome.ok) {
    return { ok: false, result: { content: explainMiss(target.relative, outcome, oldString), isError: true, untrusted: false } };
  }

  return {
    ok: true,
    relative: target.relative,
    original: target.original,
    next: matchLineEndings(target.original, outcome.match.next),
    count: outcome.match.count,
    fuzzy: outcome.match.fuzzy,
    target: resolved,
  };
}

function explainMiss(
  relative: string,
  outcome: Extract<MatchOutcome, { ok: false }>,
  oldString: string,
): string {
  if (outcome.reason === 'ambiguous') {
    return (
      `Đoạn cần thay xuất hiện ${outcome.count} lần trong ${relative}, không biết lấy cái nào. ` +
      `Thêm vài dòng ngữ cảnh phía trên hoặc dưới cho đủ duy nhất, ` +
      `hoặc đặt replace_all: true nếu thật sự muốn đổi hết.`
    );
  }

  // Đoạn model gửi lên có dấu vết của redactor. Nghĩa là nó đang cố khớp thứ
  // CHÍNH NÓ nhìn thấy, chứ không phải thứ nằm trên đĩa: mọi kết quả tool đi qua
  // redactor ở chế độ aggressive trước khi vào ngữ cảnh, nên một dòng như
  // `password: string;` tới model dưới dạng `password [REDACTED:...];`.
  //
  // Không nói ra thì thông báo "không tìm thấy, hãy read_file lại rồi thử lại"
  // dẫn model vào đúng vòng cũ: đọc lại cũng ra bản đã che, gửi lại cũng trượt.
  const masked = /\[REDACTED:([a-z-]+)\]/i.exec(oldString);
  if (masked) {
    return (
      `Đoạn bạn gửi có chứa ${masked[0]} — đó là chỗ AstraCode đã che trước khi ` +
      `nội dung tới bạn, không phải chữ có thật trong ${relative}. Đọc lại cũng ` +
      `sẽ ra đúng chuỗi đã che đó, nên đừng thử lại y nguyên.\n` +
      `Cách làm được: neo old_string vào những dòng LÂN CẬN không bị che (dòng ` +
      `phía trên hoặc phía dưới), rồi đưa cả khối vào new_string. Nếu chỗ cần ` +
      `sửa chính là dòng bị che, hãy nói cho người dùng biết và để họ tự sửa ` +
      `dòng đó.`
    );
  }

  const head = splitLines(oldString).slice(0, 3).join('\n');
  const base =
    `Không tìm thấy đoạn cần thay trong ${relative}. ` +
    `Đã thử cả cách bỏ qua khác biệt khoảng trắng.`;

  if (outcome.nearest === undefined) {
    return (
      `${base}\nĐoạn bạn gửi bắt đầu bằng:\n${head}\n` +
      `Hãy read_file lại để lấy đúng nội dung hiện tại rồi thử lại.`
    );
  }

  return (
    `${base}\nChỗ giống nhất trong file đang là:\n${outcome.nearest}\n` +
    `Chép chính xác từ đó (không kèm số dòng) rồi gọi lại.`
  );
}

export const editFileTool: Tool<typeof schema> = {
  name: 'edit_file',
  description:
    'Sửa một phần của file đã có bằng cách thay đoạn văn bản cũ bằng đoạn mới. ' +
    'Đây là cách sửa code được ưu tiên. Đoạn cũ phải khớp chính xác nội dung ' +
    'hiện tại và phải duy nhất trong file — hãy read_file trước khi sửa.',
  schema,
  readOnly: false,

  async describe(args, ctx: ToolContext): Promise<ToolIntent> {
    const prepared = await prepare(args, ctx);
    if (!prepared.ok) return { summary: `Edit ${args.path}`, path: args.path };

    const stat = diffStat(diffLines(prepared.original, prepared.next));
    // Quét ĐOẠN MỚI, không quét cả file: một script vốn đã đọc ra ngoài
    // workspace từ trước thì mỗi lần sửa một dấu phẩy trong đó lại hỏi lại một
    // lần, và cảnh báo lặp vô cớ là cảnh báo bị bỏ qua.
    const warnings = scriptWriteWarnings(prepared.relative, args.new_string, ctx);
    return {
      summary: `Edit ${prepared.relative} (+${stat.added}/−${stat.removed})`,
      path: prepared.relative,
      preview: formatUnifiedDiff(prepared.original, prepared.next),
      previewKind: 'diff',
      ...(warnings.length ? { warnings } : {}),
    };
  },

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const prepared = await prepare(args, ctx);
    if (!prepared.ok) return prepared.result;

    if (prepared.original === prepared.next) {
      return {
        content: `Đoạn mới giống hệt đoạn cũ, ${prepared.relative} không đổi.`,
        untrusted: false,
      };
    }

    const target = prepared.target;
    if (!target.ok) return target.result;

    await commitWrite(target.target, prepared.next, ctx);

    const stat = diffStat(diffLines(prepared.original, prepared.next));
    const notes: string[] = [];
    if (prepared.fuzzy) {
      notes.push('khớp sau khi bỏ qua khác biệt khoảng trắng — thụt lề của file được giữ nguyên');
    }
    if (prepared.count > 1) notes.push(`thay ${prepared.count} chỗ`);

    return {
      content:
        `Đã sửa ${prepared.relative} (+${stat.added}/−${stat.removed})` +
        (notes.length > 0 ? ` (${notes.join('; ')}).` : '.'),
      untrusted: false,
      meta: {
        path: prepared.relative,
        added: stat.added,
        removed: stat.removed,
        occurrences: prepared.count,
        fuzzy: prepared.fuzzy,
      },
    };
  },
};
