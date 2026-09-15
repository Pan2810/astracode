/**
 * Test cho việc xin ingest token (M10).
 *
 * Trọng tâm không phải "gọi đúng URL" mà là: shape của response đến từ repo
 * khác, nên hàm này phải đọc được vài cách viết thường gặp và phải KÊU khi
 * không đọc được. Im lặng trả về một token rỗng nghĩa là mọi lần đẩy sau đó
 * đều 401, và triệu chứng hiện ra cách nguyên nhân rất xa.
 */
import { describe, it, expect } from 'vitest';
import { mintIngestToken } from './ingestToken.js';

function respond(body: unknown, status = 200): () => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    );
}

describe('mintIngestToken', () => {
  it('đổi JWT lấy ingest token, gọi đúng đường', async () => {
    let seen: { url: string; auth: string } | undefined;
    const result = await mintIngestToken({
      baseURL: 'http://gw/',
      getToken: () => Promise.resolve('jwt-abc'),
      fetchImpl: (url, init) => {
        seen = {
          url: String(url),
          auth: String((init?.headers as Record<string, string>).Authorization),
        };
        return respond({ ingest_token: 'awtl_1' })();
      },
    });

    expect(seen?.url).toBe('http://gw/telemetry/token');
    // JWT là thứ chứng minh danh tính ở bước ĐỔI; ingest token mới là thứ dùng
    // để gửi sau đó. Lẫn hai cái là hoặc không đổi được, hoặc gửi bằng một
    // token hết hạn sau một giờ.
    expect(seen?.auth).toBe('Bearer jwt-abc');
    expect(result.token).toBe('awtl_1');
  });

  it('đọc được các tên trường thường gặp', async () => {
    for (const body of [
      { ingest_token: 'a' },
      { ingestToken: 'a' },
      { token: 'a' },
      { access_token: 'a' },
    ]) {
      const r = await mintIngestToken({
        baseURL: 'http://gw',
        getToken: () => Promise.resolve('j'),
        fetchImpl: respond(body),
      });
      expect(r.token).toBe('a');
    }
  });

  it('quy expires_in ra mốc tuyệt đối', async () => {
    const before = Date.now();
    const r = await mintIngestToken({
      baseURL: 'http://gw',
      getToken: () => Promise.resolve('j'),
      fetchImpl: respond({ token: 'a', expires_in: 3600 }),
    });
    expect(r.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
  });

  it('expires_at dạng giây được nhân lên mili', async () => {
    const r = await mintIngestToken({
      baseURL: 'http://gw',
      getToken: () => Promise.resolve('j'),
      fetchImpl: respond({ token: 'a', expires_at: 1_800_000_000 }),
    });
    expect(r.expiresAt).toBe(1_800_000_000_000);
  });

  it('server từ chối thì ném, không trả token rỗng', async () => {
    await expect(
      mintIngestToken({
        baseURL: 'http://gw',
        getToken: () => Promise.resolve('j'),
        fetchImpl: respond('nope', 403),
      }),
    ).rejects.toThrow(/403/);
  });

  it('JSON không có trường token nào nhận ra được thì ném', async () => {
    await expect(
      mintIngestToken({
        baseURL: 'http://gw',
        getToken: () => Promise.resolve('j'),
        fetchImpl: respond({ ok: true }),
      }),
    ).rejects.toThrow(/token/);
  });
});
