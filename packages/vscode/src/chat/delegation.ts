/**
 * Subagent là opt-in theo từng lượt.
 *
 * Chỉ nhìn câu người dùng, không đoán từ việc câu hỏi "có vẻ lớn": nếu chỉ
 * dựa vào độ phức tạp thì model có thể tự đẩy cả yêu cầu sửa code sang agent
 * con, trong khi agent con của AstraCode cố ý chỉ có tool đọc.
 */
export function isDelegationRequested(conversation: string, agentNames: string[] = []): boolean {
  const text = conversation.trim();
  if (!text) return false;

  const explicitPatterns = [
    /^\/delegate(?:\s|$)/iu,
    /^(?:hãy\s+|please\s+)?delegate(?:\s|$)/iu,
    /\bdelegate\s+(?:this|it|the\s+task|a\s+task|to|cho|việc|task|giúp)\b/iu,
    /\bgiao\s+(?:(?:việc|task)(?:\s+(?:này|đó|ấy))?\s+)?cho\s+(?:một\s+)?(?:agent\s+con|sub-?agent)\b/iu,
    /\b(?:gọi|dùng|sử\s+dụng|nhờ|chạy|tạo)\s+(?:một\s+)?(?:agent\s+con|sub-?agent)\b/iu,
    /\b(?:use|ask|spawn|run)\s+(?:a\s+|an\s+|the\s+)?sub-?agent\b/iu,
    /\bhand\s+(?:this|it|the\s+task)\s+(?:off\s+)?to\s+(?:a\s+|an\s+|the\s+)?(?:sub-?agent|agent)\b/iu,
  ];
  if (explicitPatterns.some((pattern) => pattern.test(text))) return true;

  // Gọi đích danh một agent cũng là opt-in, nhưng phải đi cùng động từ gọi;
  // chỉ nhắc tên agent trong log/câu hỏi chẩn đoán không được tự bật delegate.
  const names = agentNames.map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) return false;
  const alternatives = names.map(escapeRegex).join('|');
  return new RegExp(
    `(?:gọi|dùng|sử\\s+dụng|nhờ|chạy|use|ask|run)\\s+(?:agent\\s+)?(?:${alternatives})(?=\\s|$|[.,!?])`,
    'iu',
  ).test(text);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
