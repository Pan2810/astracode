/**
 * Khớp mờ cho ô gợi ý — dùng chung cho menu `/` và menu `@`.
 *
 * Một hàm, hai chỗ dùng, vì hai menu đó phải "cảm giác" giống nhau: gõ `spkpl`
 * ra `speckit-plan`, gõ `chatts` ra `packages/cli/src/chat.ts`. Nếu mỗi menu tự
 * viết luật khớp thì người dùng phải học hai phản xạ cho cùng một thao tác.
 *
 * Thuật toán là khớp dãy con (subsequence) có tính điểm, không phải Levenshtein:
 * người ta gõ tắt bằng cách BỎ BỚT chữ chứ không gõ sai chữ, nên khoảng cách sửa
 * đổi trả lời sai câu hỏi. Điểm thưởng cho khớp liền mạch, khớp đầu từ và khớp
 * ở phần đuôi đường dẫn — ba thứ quyết định xem kết quả đầu tiên có phải thứ
 * người dùng đang nghĩ tới hay không.
 */

export interface FuzzyMatch {
  /** Điểm càng cao càng hợp. */
  score: number;
  /** Vị trí các ký tự khớp, để tô đậm. */
  positions: number[];
}

/** Ranh giới từ: đầu chuỗi, hoặc ngay sau một trong các ký tự này. */
const BOUNDARY = new Set(['/', '\\', '-', '_', '.', ':', ' ']);

/**
 * Khớp `query` vào `candidate`. Trả `undefined` khi không khớp.
 *
 * Query rỗng khớp mọi thứ với điểm 0 — ô gợi ý vừa mở phải hiện đủ danh sách,
 * không phải hiện rỗng cho tới khi gõ chữ đầu tiên.
 */
export function fuzzyMatch(candidate: string, query: string): FuzzyMatch | undefined {
  if (query === '') return { score: 0, positions: [] };

  const hay = candidate.toLowerCase();
  const needle = query.toLowerCase();

  // Hai lượt, và lượt thứ hai mới là lượt quan trọng.
  //
  // Đi tham lam từ trái chỉ tìm được MỘT khớp bất kỳ, thường là khớp trải rộng
  // nhất: gõ `plan` vào `speckit-plan` thì chữ `p` đầu tiên nằm ở `s-p-eckit`,
  // và cụm `plan` thật ở cuối bị bỏ lỡ. Nên lượt một chỉ để biết khớp KẾT THÚC
  // ở đâu, rồi lượt hai đi ngược từ đó về để siết lấy cụm gần nhau nhất.
  let end = -1;
  let cursor = 0;
  for (const ch of needle) {
    const at = hay.indexOf(ch, cursor);
    if (at === -1) return undefined;
    cursor = at + 1;
    end = at;
  }

  const positions: number[] = [];
  let back = end;
  for (let i = needle.length - 1; i >= 0; i--) {
    const at = hay.lastIndexOf(needle[i]!, back);
    positions.unshift(at);
    back = at - 1;
  }

  let score = 0;
  let previous = -2;
  for (const at of positions) {
    // Liền ngay ký tự trước: đây là tín hiệu mạnh nhất rằng người dùng đang gõ
    // một khúc có thật của tên, không phải nhặt chữ cái rải rác.
    if (at === previous + 1) score += 8;
    if (at === 0 || BOUNDARY.has(hay[at - 1] ?? '')) score += 6;
    previous = at;
  }

  // Khớp gọn hơn thì hơn: `chat.ts` phải thắng `charts/attributes.ts` khi gõ
  // `chatts`, dù cả hai đều khớp.
  const span = positions[positions.length - 1]! - positions[0]! + 1;
  score += Math.max(0, 30 - (span - needle.length));
  score += Math.max(0, 20 - candidate.length / 4);
  if (hay.startsWith(needle)) score += 25;

  return { score, positions };
}

export interface RankedItem<T> {
  item: T;
  score: number;
  positions: number[];
}

/**
 * Lọc và xếp hạng. `key` lấy chuỗi đem khớp; `tieBreak` giữ thứ tự ổn định khi
 * điểm bằng nhau — danh sách nhảy loạn giữa hai lần gõ là thứ khiến ô gợi ý
 * không dùng được.
 */
export function fuzzyRank<T>(
  items: readonly T[],
  query: string,
  key: (item: T) => string,
  limit = 50,
): RankedItem<T>[] {
  const out: RankedItem<T>[] = [];
  for (const item of items) {
    const m = fuzzyMatch(key(item), query);
    if (m) out.push({ item, score: m.score, positions: m.positions });
  }
  out.sort((a, b) => b.score - a.score || key(a.item).localeCompare(key(b.item)));
  return out.slice(0, limit);
}
