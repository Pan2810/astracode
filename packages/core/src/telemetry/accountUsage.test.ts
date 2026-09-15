/**
 * Test cho chiều đọc ngược: AstraWork -> AstraCode (M10, phần 2).
 *
 * Điều đáng canh ở đây không phải phép cộng — phép cộng nằm ở gateway. Là:
 * gọi đúng chỗ, mang đúng loại danh tính, và không vỡ khi bên kia đổi schema.
 */
import { describe, it, expect } from 'vitest';
import { FX_VND_PER_USD } from '../config/pricing.js';
import { fetchAccountUsage } from './accountUsage.js';

function stub(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, ...(init ? { init } : {}) });
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    );
  };
  return { calls, fetchImpl };
}

describe('đọc mức dùng của tài khoản', () => {
  it('gọi /auth/me/usage bằng JWT của phiên, không phải ingest token', async () => {
    const { calls, fetchImpl } = stub(200, { turns: 4, tokens: 1000, cost_vnd: 100 });
    await fetchAccountUsage({ baseURL: 'http://gw/', getToken: async () => 'jwt-abc', fetchImpl });

    expect(calls[0]!.url).toBe('http://gw/auth/me/usage');
    // Ingest token là danh tính của một cỗ máy gửi số đo; nó không đại diện cho
    // một người và không đọc được dữ liệu của người đó.
    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: 'Bearer jwt-abc' });
  });

  it('đọc đủ ba con số của thẻ AstraWork: lượt, token, chi phí', async () => {
    const { fetchImpl } = stub(200, {
      turns: 162,
      tokens: 15_215_617,
      cost_vnd: 61_690,
      days_active: 15,
      last_used: '2026-08-13T02:03:04+00:00',
      by_source: { astracode: 100, astrawork: 62 },
    });

    const usage = await fetchAccountUsage({
      baseURL: 'http://gw',
      getToken: async () => 'jwt',
      fetchImpl,
    });

    expect(usage.turns).toBe(162);
    expect(usage.totalTokens).toBe(15_215_617);
    // Gateway còn ở bản VND: quy sang USD bằng đúng tỉ giá của gateway, không
    // đưa thẳng số VND vào một trường USD.
    expect(usage.costUsd).toBeCloseTo(61_690 / FX_VND_PER_USD, 6);
    expect(usage.daysActive).toBe(15);
    expect(usage.lastUsed).toBe(Date.parse('2026-08-13T02:03:04+00:00'));
    expect(usage.bySource).toEqual({ astracode: 100, astrawork: 62 });
  });

  it('thiếu trường thì về 0, không ném — schema nằm ở repo bên kia', async () => {
    const { fetchImpl } = stub(200, { turns: 3 });
    const usage = await fetchAccountUsage({
      baseURL: 'http://gw',
      getToken: async () => 'jwt',
      fetchImpl,
    });

    expect(usage).toEqual({ turns: 3, totalTokens: 0, costUsd: 0, daysActive: 0, bySource: {} });
  });

  it('chưa dùng lần nào là trạng thái hợp lệ, không phải lỗi', async () => {
    const { fetchImpl } = stub(200, { turns: 0, tokens: 0, cost_vnd: 0, last_used: '' });
    const usage = await fetchAccountUsage({
      baseURL: 'http://gw',
      getToken: async () => 'jwt',
      fetchImpl,
    });

    expect(usage.turns).toBe(0);
    expect(usage.lastUsed).toBeUndefined();
  });

  it('401 báo là cần đăng nhập lại, không lẫn với lỗi gateway', async () => {
    const { fetchImpl } = stub(401, { detail: 'expired' });
    await expect(
      fetchAccountUsage({ baseURL: 'http://gw', getToken: async () => 'jwt', fetchImpl }),
    ).rejects.toMatchObject({ code: 'auth_required' });
  });

  it('404 nói thẳng là gateway cũ, thay vì "không lấy được số"', async () => {
    const { fetchImpl } = stub(404, { detail: 'Not Found' });
    // Một tổ chức chạy bản gateway cũ sẽ gặp đúng ca này; thông báo phải chỉ ra
    // được phải làm gì, nếu không nó thành một mục Usage trống bí ẩn.
    await expect(
      fetchAccountUsage({ baseURL: 'http://gw', getToken: async () => 'jwt', fetchImpl }),
    ).rejects.toThrow(/update/i);
  });

  it('JSON hỏng không làm sập bảng cài đặt', async () => {
    const { fetchImpl } = stub(200, 'không phải json');
    await expect(
      fetchAccountUsage({ baseURL: 'http://gw', getToken: async () => 'jwt', fetchImpl }),
    ).rejects.toMatchObject({ code: 'provider_error' });
  });
});

/**
 * Hạn mức tiền.
 *
 * Cùng một lý do với phần trên: schema nằm ở repo bên kia và đang chuyển VND →
 * USD, nên điều đáng canh là "đọc được từ mọi cách bên kia có thể nói" và "im
 * lặng đúng cách khi bên kia không nói gì".
 */
describe('hạn mức và số tiền còn lại', () => {
  const read = (body: unknown) =>
    fetchAccountUsage({
      baseURL: 'http://gw',
      getToken: async () => 'jwt',
      fetchImpl: stub(200, body).fetchImpl,
    });

  it('gateway không báo hạn mức thì hai trường vắng mặt, KHÔNG phải 0', async () => {
    const usage = await read({ turns: 2, cost_usd: 1 });
    // 0 sẽ vẽ ra một thanh cạn sạch cho một tài khoản không hề có hạn mức nào.
    expect(usage.budgetUsd).toBeUndefined();
    expect(usage.remainingUsd).toBeUndefined();
  });

  it('có hạn mức thì suy ra số còn lại từ phần đã tiêu', async () => {
    const usage = await read({ cost_usd: 2.5, budget_usd: 10 });
    expect(usage.budgetUsd).toBe(10);
    expect(usage.remainingUsd).toBe(7.5);
  });

  it('có số còn lại thì suy ngược ra tổng', async () => {
    const usage = await read({ cost_usd: 3, remaining_usd: 7 });
    expect(usage.budgetUsd).toBe(10);
    expect(usage.remainingUsd).toBe(7);
  });

  it('gateway nói cả hai thì tin gateway, không tự trừ lại', async () => {
    // Nạp thêm giữa kỳ: `remaining` của gateway đúng, còn `budget - cost` sai.
    const usage = await read({ cost_usd: 4, budget_usd: 10, remaining_usd: 9 });
    expect(usage.remainingUsd).toBe(9);
  });

  it('đọc được cả tên khác và cả bản VND', async () => {
    const byQuota = await read({ cost_usd: 1, quota_vnd: 260_000 });
    expect(byQuota.budgetUsd).toBeCloseTo(10, 6);

    const byBalance = await read({ cost_vnd: 26_000, balance_vnd: 234_000 });
    expect(byBalance.remainingUsd).toBeCloseTo(9, 6);
    expect(byBalance.budgetUsd).toBeCloseTo(10, 6);
  });

  it('tiêu quá hạn mức thì còn lại là 0, không phải số âm', async () => {
    const usage = await read({ cost_usd: 12, budget_usd: 10 });
    expect(usage.remainingUsd).toBe(0);
  });
});
