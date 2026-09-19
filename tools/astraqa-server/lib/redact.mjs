/**
 * Che bí mật trước khi bất cứ chuỗi nào rời khỏi tiến trình.
 *
 * Mọi thứ đi ra ngoài — log khởi động, message lỗi trả về AstraQA, stderr của
 * tiến trình con — đều phải đi qua đây. Đặt ở một chỗ để không có đường vòng:
 * thêm một dòng `console.log(err.message)` ở nơi khác là mở lại đúng cái lỗ mà
 * file này bịt.
 *
 * Hai lớp: literal (giá trị thật của job hiện tại) và pattern (hình dạng chung
 * của secret, bắt cả những thứ ta không biết trước — key LLM lọt vào stderr
 * của CLI chẳng hạn).
 */

const PATTERNS = [
  // userinfo trong URL: https://x-access-token:ghp_xxx@github.com/...
  [/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***:***@'],
  [/(https?:\/\/)[^/\s:@]+@/gi, '$1***@'],
  // API key kiểu OpenAI/FCI
  [/\bsk-[A-Za-z0-9_\-=]{8,}/g, 'sk-***'],
  // token GitHub/GitLab
  [/\bgh[pousr]_[A-Za-z0-9]{10,}/g, 'gh*_***'],
  [/\bglpat-[A-Za-z0-9_-]{10,}/g, 'glpat-***'],
  // JWT ba khúc
  [/\bey[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '<jwt>***'],
  // Bearer <bất kỳ>
  [/(Bearer\s+)[A-Za-z0-9._\-=]{8,}/gi, '$1***'],
];

/**
 * Dựng hàm che với danh sách secret cụ thể của một job.
 *
 * Bỏ qua chuỗi ngắn hơn 6 ký tự: che một chuỗi 3 ký tự sẽ băm nát mọi message
 * mà không bảo vệ gì — và một "secret" 3 ký tự thì vấn đề nằm ở chỗ khác.
 */
export function makeRedactor(secrets = []) {
  const literals = [...new Set(secrets)]
    .filter((s) => typeof s === 'string' && s.trim().length >= 6)
    .map((s) => s.trim())
    .sort((a, b) => b.length - a.length);

  return function redact(input) {
    let s = typeof input === 'string' ? input : String(input ?? '');
    for (const lit of literals) s = s.split(lit).join('***');
    for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
    return s;
  };
}

/** Message của một Error, đã che. Không bao giờ kèm stack — stack chứa đường dẫn và đôi khi cả argv. */
export function redactMessage(err, redact) {
  const raw = err instanceof Error ? err.message : String(err ?? 'lỗi không rõ');
  return redact(raw);
}
