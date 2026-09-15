/**
 * Tiền trong AstraCode tính bằng USD.
 *
 * ## Vì sao USD chứ không phải VND
 *
 * Board "Năng suất" của AstraWork đo bằng `cost.usage`, và metric đó là USD —
 * đó là đơn vị Claude Code đẩy lên, nên cột tiền trên board chỉ so sánh được
 * giữa hai công cụ khi cả hai nói cùng một thứ tiền. AstraWork cũng đang chuyển
 * toàn bộ sang USD.
 *
 * ## Vì sao vẫn còn tỉ giá ở đây
 *
 * Gateway hiện vẫn trả `input_price_vnd` / `cost_vnd` cho tới khi bản USD bên
 * đó lên. Trong quãng giao thời ấy có ba lựa chọn, và hai trong số đó tệ:
 *
 *   · Hiện 0 → mọi cột tiền trống, người dùng tưởng tính năng hỏng.
 *   · Gửi thẳng số VND vào một trường USD → sai 26.000 lần, và sai IM LẶNG:
 *     một dòng "chi phí $312.000" trông như một sự cố thật.
 *   · Quy đổi bằng ĐÚNG tỉ giá gateway đang dùng → số đúng ngay, và tự hết
 *     tác dụng khi trường USD xuất hiện.
 *
 * Con số dưới đây KHÔNG phải tôi đặt: nó là mặc định `fx_vnd_per_usd` trong
 * `schemas.py` của gateway, cùng tỉ giá mà `core/kpi.py` bên ấy quy đổi. Khi
 * gateway trả trường USD thì đường quy đổi này không chạy nữa — và lúc mọi
 * endpoint đã đổi xong thì xoá luôn được cả hằng số.
 */

/** Tỉ giá dự phòng, khớp `fx_vnd_per_usd` mặc định của gateway. */
export const FX_VND_PER_USD = 26_000;

/** Quy VND sang USD. Trả 0 cho số không dùng được, không trả NaN. */
export function usdFromVnd(vnd: number): number {
  if (!Number.isFinite(vnd) || vnd <= 0) return 0;
  return vnd / FX_VND_PER_USD;
}

/**
 * Chi phí một lượt, USD.
 *
 * Giá của gateway tính TRÊN 1 TRIỆU TOKEN (`schemas.py`: "per 1M tokens") —
 * quên chia 1e6 ở đây là báo một con số lớn hơn sự thật một triệu lần, và không
 * ai nhìn bảng mà đoán ra lỗi nằm ở phép chia nào.
 */
export function turnCostUsd(opts: {
  promptTokens: number;
  completionTokens: number;
  inputPriceUsd: number;
  outputPriceUsd: number;
}): number {
  const input = Math.max(0, opts.promptTokens) * Math.max(0, opts.inputPriceUsd);
  const output = Math.max(0, opts.completionTokens) * Math.max(0, opts.outputPriceUsd);
  const cost = (input + output) / 1_000_000;
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}
