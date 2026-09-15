/**
 * Tiền là chỗ sai thầm lặng: một phép chia sót không làm vỡ gì, chỉ làm mọi
 * bảng chi phí sai đi một triệu lần. Ba ca dưới đây canh đúng ba chỗ đó.
 */
import { describe, it, expect } from 'vitest';
import { FX_VND_PER_USD, turnCostUsd, usdFromVnd } from './pricing.js';

describe('quy đổi tiền', () => {
  it('VND sang USD theo tỉ giá của gateway', () => {
    expect(usdFromVnd(26_000)).toBeCloseTo(1, 9);
    expect(usdFromVnd(FX_VND_PER_USD * 3)).toBeCloseTo(3, 9);
  });

  it('số không dùng được thành 0, không thành NaN', () => {
    expect(usdFromVnd(0)).toBe(0);
    expect(usdFromVnd(-5)).toBe(0);
    expect(usdFromVnd(Number.NaN)).toBe(0);
  });
});

describe('chi phí một lượt', () => {
  /**
   * Giá của gateway tính TRÊN 1 TRIỆU TOKEN. Đây là ca canh phép chia 1e6 —
   * quên nó thì một lượt bình thường hiện thành hàng nghìn đô, và con số đó đi
   * thẳng lên board Năng suất.
   */
  it('giá tính trên 1 triệu token', () => {
    const cost = turnCostUsd({
      promptTokens: 1_000_000,
      completionTokens: 0,
      inputPriceUsd: 3,
      outputPriceUsd: 15,
    });
    expect(cost).toBeCloseTo(3, 9);
  });

  it('cộng cả hai chiều vào và ra', () => {
    const cost = turnCostUsd({
      promptTokens: 500_000,
      completionTokens: 100_000,
      inputPriceUsd: 3,
      outputPriceUsd: 15,
    });
    // 0.5 × 3 + 0.1 × 15 = 3.0
    expect(cost).toBeCloseTo(3, 9);
  });

  it('gateway không nói giá thì chi phí là 0, không phải một con số đoán', () => {
    expect(
      turnCostUsd({
        promptTokens: 10_000,
        completionTokens: 10_000,
        inputPriceUsd: 0,
        outputPriceUsd: 0,
      }),
    ).toBe(0);
  });
});
