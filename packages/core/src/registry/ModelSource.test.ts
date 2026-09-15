import { describe, expect, it } from 'vitest';
import { FptModelSource, GatewayModelSource } from './ModelSource.js';
import { ConfigError, GatewayUnreachableError } from '../errors.js';

function json(body: unknown, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GatewayModelSource', () => {
  it('gọi GET {baseURL}/models kèm Bearer token', async () => {
    let seenUrl = '';
    let seenAuth = '';
    const src = new GatewayModelSource({
      baseURL: 'http://gw.test/',
      getToken: () => Promise.resolve('tok-123'),
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenAuth = String((init?.headers as Record<string, string>).Authorization);
        return json([
          {
            name: 'coder-32b',
            description: 'd',
            context_limit: 32768,
            online: true,
            allowed: true,
            input_price_vnd: 1,
            output_price_vnd: 2,
          },
        ]);
      },
    });

    const list = await src.list();
    expect(seenUrl).toBe('http://gw.test/models');
    expect(seenAuth).toBe('Bearer tok-123');
    expect(list[0]).toMatchObject({ name: 'coder-32b', allowed: true, input_price_vnd: 1 });
    expect(src.governed).toBe(true);
  });

  it('shape lạ -> ConfigError kèm trường nào hỏng', async () => {
    const src = new GatewayModelSource({
      baseURL: 'http://gw.test',
      getToken: () => Promise.resolve('t'),
      fetchImpl: async () => json([{ name: 'x' }]),
    });
    await expect(src.list()).rejects.toThrow(ConfigError);
  });

  it('không kết nối được -> GatewayUnreachableError', async () => {
    const src = new GatewayModelSource({
      baseURL: 'http://gw.test',
      getToken: () => Promise.resolve('t'),
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(src.list()).rejects.toThrow(GatewayUnreachableError);
  });

  it('HTTP lỗi -> ConfigError kèm mã trạng thái', async () => {
    const src = new GatewayModelSource({
      baseURL: 'http://gw.test',
      getToken: () => Promise.resolve('t'),
      fetchImpl: async () => json({}, 500, 'Server Error'),
    });
    await expect(src.list()).rejects.toThrow(/500/);
  });
});

describe('FptModelSource', () => {
  it('chuyển shape OpenAI {data:[{id}]} sang AvailableModel', async () => {
    const src = new FptModelSource({
      baseURL: 'https://mkp-api.example/v1',
      getToken: () => Promise.resolve('fpt-key'),
      fetchImpl: async () =>
        json({ data: [{ id: 'Qwen2.5-Coder-32B', owned_by: 'fpt' }, { id: 'Llama-3.3-70B' }] }),
    });

    const list = await src.list();
    expect(list.map((m) => m.name)).toEqual(['Qwen2.5-Coder-32B', 'Llama-3.3-70B']);
    // FPT không có khái niệm quyền theo user — mọi model đều coi như dùng được.
    expect(list.every((m) => m.allowed && m.online)).toBe(true);
    expect(list[0]!.description).toContain('fpt');
  });

  it('đánh dấu governed = false để UI cảnh báo bỏ qua RBAC/audit', () => {
    const src = new FptModelSource({
      baseURL: 'https://x/v1',
      getToken: () => Promise.resolve('k'),
      fetchImpl: async () => json({ data: [] }),
    });
    expect(src.governed).toBe(false);
  });

  it('shape không phải OpenAI -> ConfigError', async () => {
    const src = new FptModelSource({
      baseURL: 'https://x/v1',
      getToken: () => Promise.resolve('k'),
      fetchImpl: async () => json([{ id: 'a' }]),
    });
    await expect(src.list()).rejects.toThrow(ConfigError);
  });
});
