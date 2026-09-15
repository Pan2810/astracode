/**
 * Cache ngữ cảnh tĩnh — cơ chế cache riêng của AstraCode, KHÔNG phụ thuộc gateway.
 *
 * Mỗi lượt chat, `computeContextBreakdown` (ChatController) dựng lại system
 * prompt, tool registry, memory, skill catalog thành chuỗi rồi ước lượng token
 * bằng `estimateTokens`. Phần lớn các đoạn này KHÔNG đổi giữa hai lượt liên
 * tiếp trong cùng phiên — system prompt, tool registry, AGENTS.md hiếm khi đổi
 * giữa chừng một cuộc hội thoại. Cache này so sánh nội dung từng đoạn với lượt
 * trước theo đúng chuỗi ký tự; đoạn nào giống hệt được tính là "cache hit" của
 * AstraCode — độc lập với việc gateway có báo `usage.prompt_tokens_details.
 * cached_tokens` hay không (gateway có thể không hỗ trợ prompt cache, hoặc báo
 * miss dù nội dung phía AstraCode gửi lên không đổi).
 *
 * Đây KHÔNG phải cache giảm băng thông gửi lên gateway — API chat completion là
 * stateless nên vẫn phải gửi đủ ngữ cảnh mỗi lượt. Đây là cache ĐO LƯỜNG: cho
 * người dùng thấy bao nhiêu token ngữ cảnh của họ ổn định lượt-qua-lượt, tức
 * phần lẽ ra nhà cung cấp nào có prompt cache cũng nên tính rẻ, bất kể gateway
 * hiện tại có báo đúng hay không.
 */

export interface StaticContextSegment {
  /** Định danh đoạn — ví dụ 'systemPrompt', 'systemTools'. Cố định trong suốt phiên. */
  key: string;
  /** Nội dung đã dựng của đoạn ở lượt này (chuỗi rỗng nếu đoạn không có mặt). */
  content: string;
  /** Token đã ước lượng của `content` — cộng vào `hitTokens` nếu trùng lượt trước. */
  tokens: number;
}

export interface StaticContextCacheResult {
  /** Tổng token của các đoạn giống hệt lượt ngay trước đó. */
  hitTokens: number;
  /** Số đoạn trùng nội dung / tổng số đoạn có nội dung khác rỗng xét trong lượt này. */
  hits: number;
  misses: number;
}

/**
 * Trạng thái sống theo phiên chat (một `ChatController` một cache) — reset khi
 * mở phiên mới, không lưu xuống đĩa vì chỉ có giá trị đo lường tạm thời.
 */
export class StaticContextCache {
  private last = new Map<string, string>();

  /** Ghi nhận nội dung lượt hiện tại, trả về phần trùng khớp so với lượt trước. */
  update(segments: StaticContextSegment[]): StaticContextCacheResult {
    let hitTokens = 0;
    let hits = 0;
    let misses = 0;
    for (const seg of segments) {
      const prev = this.last.get(seg.key);
      const matched = prev !== undefined && prev === seg.content && seg.content !== '';
      if (matched) {
        hitTokens += seg.tokens;
        hits++;
      } else if (seg.content !== '') {
        misses++;
      }
      this.last.set(seg.key, seg.content);
    }
    return { hitTokens, hits, misses };
  }
}
