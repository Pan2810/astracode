/**
 * Biên dịch regex đến từ nguồn không tin cậy — model hoặc file cấu hình của dự án.
 *
 * ## Vì sao cần một cửa riêng cho việc này
 *
 * Engine regex của JavaScript là backtracking, không phải automaton tuyến tính.
 * `(a+)+b` gặp một dòng 40 ký tự `a` là 2^40 nhánh — luồng duy nhất của
 * extension host đứng lại và không có gì cắt được, kể cả nút Stop: `signal.aborted`
 * là một biến, và biến đó chỉ đổi được khi vòng lặp của ta nhường lại event loop.
 *
 * Hai chỗ nhận regex từ ngoài: `tools/grep.ts` (model gõ `pattern`) và
 * `hooks/hooks.ts` (trường `match` trong `.astra/hooks.json`). Cả hai từng chỉ
 * kiểm "có compile được không" — mà `(a+)+$` thì compile được.
 *
 * ## Đây là GIẢM THIỆT HẠI, không phải chứng minh an toàn
 *
 * Không có cách nào quyết định trong thời gian đa thức rằng một regex JS bất kỳ
 * chạy trong thời gian đa thức. Ba lớp dưới đây chặn những khuôn thật sự gặp,
 * không chặn được người cố tình:
 *
 *   1. trần độ dài — mẫu dài không tự nhiên sinh ra từ model đang tìm code;
 *   2. quét tĩnh lượng từ LỒNG NHAU (`(a+)+`, `(a*|b)*`, `((x+))+`) và lượng từ
 *      có biên quá lớn (`a{5000}`) — hai khuôn chiếm gần hết ca thực tế;
 *   3. trần độ dài ĐẦU VÀO ở nơi gọi (xem `MAX_LINE_CHARS` trong `grep.ts`) —
 *      chi phí backtracking là hàm của độ dài input, nên chặn input là chặn
 *      trần trên của thiệt hại kể cả khi lớp 2 bỏ sót.
 *
 * Lớp 3 là lớp duy nhất không dựa vào việc đoán đúng hình dạng mẫu. Đừng bỏ nó
 * đi vì "đã có lớp 2".
 */

/** Trần mặc định cho độ dài mẫu. `hooks` dùng chặt hơn — xem `HOOK_MAX_PATTERN`. */
const DEFAULT_MAX_LENGTH = 500;

/**
 * Biên trên của `{n,m}` coi là hợp lý. `\d{1,6}` là bình thường; `(ab){5000}`
 * thì không phải chuyện model đang tìm code viết ra.
 */
const MAX_QUANTIFIER_BOUND = 1_000;

export interface SafeRegexOptions {
  /** Cờ truyền cho `RegExp`. */
  flags?: string;
  /** Trần độ dài mẫu. Mặc định 500. */
  maxLength?: number;
}

export type SafeRegexResult =
  | { ok: true; regex: RegExp }
  | { ok: false; reason: string };

/**
 * Biên dịch mẫu, hoặc từ chối kèm câu giải thích ĐỌC ĐƯỢC.
 *
 * Câu từ chối đi thẳng về cho model (grep) hoặc vào log (hook), nên nó phải nói
 * mẫu sai ở đâu và viết lại thế nào — "regex không an toàn" khiến model thử lại
 * đúng mẫu cũ.
 */
export function compileSafeRegex(
  pattern: string,
  opts: SafeRegexOptions = {},
): SafeRegexResult {
  const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;

  if (pattern.length === 0) {
    return { ok: false, reason: 'Mẫu rỗng.' };
  }
  if (pattern.length > maxLength) {
    return {
      ok: false,
      reason: `Mẫu dài ${pattern.length} ký tự, vượt trần ${maxLength}. Thu hẹp lại.`,
    };
  }

  const risk = findCatastrophicRisk(pattern);
  if (risk) return { ok: false, reason: risk };

  try {
    return { ok: true, regex: new RegExp(pattern, opts.flags) };
  } catch (err) {
    return {
      ok: false,
      reason: `Regex không hợp lệ: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Tìm khuôn dễ gây backtracking thảm hoạ. Trả về câu giải thích, hoặc
 * `undefined` nếu không thấy gì.
 *
 * Tách khỏi `compileSafeRegex` để test được trực tiếp từng khuôn.
 */
export function findCatastrophicRisk(pattern: string): string | undefined {
  /** Nhóm đang mở. `hasQuantifier` = bên trong nó đã có một lượng từ nào đó. */
  const stack: Array<{ hasQuantifier: boolean }> = [];
  let inClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;

    // Escape: ký tự ngay sau `\` là nghĩa đen, kể cả `(`, `[`, `+`.
    if (ch === '\\') {
      i++;
      continue;
    }

    // Trong `[...]` thì `*`, `+`, `(` đều là ký tự thường.
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }

    if (ch === '(') {
      stack.push({ hasQuantifier: false });
      // `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<tên>` — dấu `?` ở đây là phần
      // của cú pháp mở nhóm, KHÔNG phải lượng từ. Không ăn nó thì `(?:a)` bị đọc
      // thành "nhóm có lượng từ bên trong" và mọi mẫu dùng non-capturing group
      // đều bị từ chối oan.
      const prefix = /^\((?:\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>))?/.exec(pattern.slice(i));
      if (prefix) i += prefix[0].length - 1;
      continue;
    }

    if (ch === ')') {
      const group = stack.pop();
      if (!group) continue; // Ngoặc lệch — để `new RegExp` báo lỗi cú pháp.

      const quantifier = quantifierAt(pattern, i + 1);

      if (quantifier) {
        if (group.hasQuantifier) {
          return (
            `Mẫu có lượng từ lồng nhau: nhóm (…)${quantifier} mà bên trong đã có ` +
            `lượng từ. Khuôn này có thể làm engine regex chạy theo hàm mũ ` +
            `(backtracking thảm hoạ). Viết lại không lồng, ví dụ (?:…)+ với thân ` +
            `không chứa +/*.`
          );
        }
        const bound = boundTooLarge(quantifier);
        if (bound) return bound;
      }

      // Nhóm này "có lượng từ" theo nghĩa của nhóm CHA nếu nó bị lượng từ hoá,
      // hoặc nếu bên trong nó đã có lượng từ — nhờ vậy `((a+))+` cũng bị bắt.
      if (quantifier || group.hasQuantifier) {
        const parent = stack[stack.length - 1];
        if (parent) parent.hasQuantifier = true;
      }

      if (quantifier) i += quantifier.length;
      continue;
    }

    const quantifier = quantifierAt(pattern, i);
    if (quantifier) {
      const bound = boundTooLarge(quantifier);
      if (bound) return bound;
      const top = stack[stack.length - 1];
      if (top) top.hasQuantifier = true;
      i += quantifier.length - 1;
      continue;
    }
  }

  return undefined;
}

/**
 * Lượng từ bắt đầu tại `i`, nguyên văn (`*`, `+?`, `{2,8}`), hoặc `undefined`.
 *
 * `?` một mình cũng là lượng từ, nhưng nó chỉ nhân đôi số nhánh nên KHÔNG đủ để
 * coi một nhóm là nguy hiểm. Vẫn nhận nó ở đây để `(a?)?` không bị đọc lệch, và
 * việc phân loại nặng/nhẹ nằm ở chỗ gọi.
 */
function quantifierAt(pattern: string, i: number): string | undefined {
  const ch = pattern[i];
  if (ch === undefined) return undefined;

  if (ch === '*' || ch === '+' || ch === '?') {
    // Hậu tố `?` = lazy (`+?`). Ăn luôn để con trỏ không dừng giữa lượng từ.
    return pattern[i + 1] === '?' ? `${ch}?` : ch;
  }

  if (ch === '{') {
    const m = /^\{\d+(?:,\d*)?\}\??/.exec(pattern.slice(i));
    return m ? m[0] : undefined;
  }

  return undefined;
}

/** `{n,m}` với biên quá lớn — trả câu giải thích, hoặc `undefined`. */
function boundTooLarge(quantifier: string): string | undefined {
  if (!quantifier.startsWith('{')) return undefined;
  const numbers = quantifier.match(/\d+/g) ?? [];
  for (const raw of numbers) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > MAX_QUANTIFIER_BOUND) {
      return (
        `Mẫu có lượng từ ${quantifier} với biên ${n}, vượt trần ${MAX_QUANTIFIER_BOUND}. ` +
        `Một mẫu tìm code không cần biên lớn như vậy.`
      );
    }
  }
  return undefined;
}
