/**
 * Gợi ý ngắn cho những mã thoát hay bị hiểu nhầm là "môi trường trống".
 *
 * Sự cố gốc: `ls /usr/bin/ | grep -iE "python|pdf"` không khớp gì — grep trả
 * mã 1, không phải lỗi. Agent đọc mã khác 0 với output rỗng rồi kết luận sai
 * rằng môi trường không có công cụ nào. Dùng chung cho `bash.ts` và `python.ts`
 * vì hai tool này lặp lại gần như nguyên vẹn cùng một khối xử lý kết quả.
 */
export function exitCodeHint(exitCode: number, hasOutput: boolean): string {
  if (exitCode === 127) {
    return '\n\n(mã 127: thiếu MỘT chương trình cụ thể trong PATH, không phải môi trường trống — kiểm tra lại tên lệnh.)';
  }
  if (exitCode === 1 && !hasOutput) {
    return '\n\n(mã 1 không có output: nhiều lệnh dùng nó để báo "không tìm thấy/không khớp" — ví dụ grep/rg không khớp gì, diff có khác biệt — không nhất thiết là lỗi.)';
  }
  return '';
}
