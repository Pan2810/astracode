/**
 * Test cho việc gộp chính sách tổ chức (M9).
 *
 * Một bất biến duy nhất, và mọi ca ở đây tồn tại để giữ nó: **kết quả không bao
 * giờ lỏng hơn cả hai đầu vào**. Policy siết được, không nới được — kể cả khi
 * gateway nói ngược lại, kể cả khi mạng chết.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_IDE_POLICY,
  IdePolicyClient,
  PERMISSION_MODES,
  SANDBOX_NETWORKS,
  applyIdePolicy,
  type IdePolicy,
  type UserPreferences,
} from './IdePolicy.js';

const OPEN_POLICY: IdePolicy = {
  min_permission_mode: 'acceptEdits',
  max_sandbox_network: 'full',
  allow_hooks: true,
  allow_mcp: true,
  extra_denylist: [],
};

const STRICT_POLICY: IdePolicy = {
  min_permission_mode: 'plan',
  max_sandbox_network: 'none',
  allow_hooks: false,
  allow_mcp: false,
  extra_denylist: ['*.pem', 'infra/**'],
};

const LOOSE_PREFS: UserPreferences = {
  permissionMode: 'acceptEdits',
  sandboxNetwork: 'full',
  hooksEnabled: true,
  mcpEnabled: true,
};

describe('policy siết được, không nới được', () => {
  it('policy chặt hơn thì thắng cài đặt lỏng của người dùng', () => {
    const eff = applyIdePolicy(STRICT_POLICY, LOOSE_PREFS);
    expect(eff.permissionMode).toBe('plan');
    expect(eff.sandboxNetwork).toBe('none');
    expect(eff.hooksEnabled).toBe(false);
    expect(eff.mcpEnabled).toBe(false);
  });

  it('policy lỏng KHÔNG nới cài đặt chặt của người dùng', () => {
    // Đây là ca quan trọng nhất. Một gateway bị chiếm quyền trả về policy mở
    // toang không được phép mở khoá máy của ai cả.
    const strictPrefs: UserPreferences = {
      permissionMode: 'plan',
      sandboxNetwork: 'none',
      hooksEnabled: false,
      mcpEnabled: false,
    };
    const eff = applyIdePolicy(OPEN_POLICY, strictPrefs);
    expect(eff.permissionMode).toBe('plan');
    expect(eff.sandboxNetwork).toBe('none');
    expect(eff.hooksEnabled).toBe(false);
    expect(eff.mcpEnabled).toBe(false);
    expect(eff.locked).toHaveLength(0);
  });

  it('không có tổ hợp nào cho ra kết quả lỏng hơn cả hai đầu vào', () => {
    // Quét toàn bộ không gian thay vì chọn vài ca — đây là bất biến, không
    // phải một ví dụ.
    for (const pMode of PERMISSION_MODES) {
      for (const uMode of PERMISSION_MODES) {
        for (const pNet of SANDBOX_NETWORKS) {
          for (const uNet of SANDBOX_NETWORKS) {
            const eff = applyIdePolicy(
              { ...OPEN_POLICY, min_permission_mode: pMode, max_sandbox_network: pNet },
              { ...LOOSE_PREFS, permissionMode: uMode, sandboxNetwork: uNet },
            );
            expect(PERMISSION_MODES.indexOf(eff.permissionMode)).toBeGreaterThanOrEqual(
              Math.max(PERMISSION_MODES.indexOf(pMode), PERMISSION_MODES.indexOf(uMode)),
            );
            expect(SANDBOX_NETWORKS.indexOf(eff.sandboxNetwork)).toBeGreaterThanOrEqual(
              Math.max(SANDBOX_NETWORKS.indexOf(pNet), SANDBOX_NETWORKS.indexOf(uNet)),
            );
          }
        }
      }
    }
  });

  it('policy cho phép hooks KHÔNG tự bật hộ khi người dùng đang tắt', () => {
    const eff = applyIdePolicy(OPEN_POLICY, { ...LOOSE_PREFS, hooksEnabled: false });
    expect(eff.hooksEnabled).toBe(false);
    expect(eff.locked).toHaveLength(0);
  });
});

describe('nói cho người dùng biết ô nào bị khoá', () => {
  it('mỗi ô bị siết có một dòng giải thích, kèm giá trị họ đã chọn', () => {
    const eff = applyIdePolicy(STRICT_POLICY, LOOSE_PREFS);
    const fields = eff.locked.map((l) => l.field);
    expect(fields).toContain('permissionMode');
    expect(fields).toContain('sandboxNetwork');
    expect(fields).toContain('hooks');
    expect(fields).toContain('mcp');

    const mode = eff.locked.find((l) => l.field === 'permissionMode')!;
    expect(mode.requested).toBe('acceptEdits');
    expect(mode.applied).toBe('plan');
    // Im lặng vô hiệu hoá một ô cài đặt là cách nhanh nhất để mất niềm tin.
    expect(mode.reason).toContain('plan');
  });

  it('không siết gì thì không báo gì', () => {
    const eff = applyIdePolicy(DEFAULT_IDE_POLICY, {
      permissionMode: 'ask',
      sandboxNetwork: 'none',
      hooksEnabled: false,
      mcpEnabled: false,
    });
    expect(eff.locked).toEqual([]);
  });

  it('denylist của tổ chức được cộng vào', () => {
    expect(applyIdePolicy(STRICT_POLICY, LOOSE_PREFS).extraDenylist).toEqual([
      '*.pem',
      'infra/**',
    ]);
  });
});

describe('IdePolicyClient', () => {
  const token = () => Promise.resolve('jwt');

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('lấy policy và ghi vào cache', async () => {
    const written: IdePolicy[] = [];
    const client = new IdePolicyClient({
      baseURL: 'http://gw',
      getToken: token,
      cache: { read: () => undefined, write: (p) => void written.push(p) },
      fetchImpl: () => Promise.resolve(jsonResponse(STRICT_POLICY)),
    });
    const { policy, stale } = await client.load();
    expect(stale).toBe(false);
    expect(policy.min_permission_mode).toBe('plan');
    expect(written).toHaveLength(1);
  });

  it('gateway chết → dùng cache cuối, KHÔNG rơi về mặc định lỏng hơn', () => {
    // Mất mạng không phải lý do để nới quyền: ai chặn được mạng sẽ dùng đúng
    // đường đó nếu ta để mở.
    const client = new IdePolicyClient({
      baseURL: 'http://gw',
      getToken: token,
      cache: { read: () => STRICT_POLICY, write: () => {} },
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    return client.load().then(({ policy, stale }) => {
      expect(stale).toBe(true);
      expect(policy.min_permission_mode).toBe('plan');
      expect(policy.allow_hooks).toBe(false);
    });
  });

  it('chưa từng có cache → mặc định, không khoá cứng người mới cài', async () => {
    const client = new IdePolicyClient({
      baseURL: 'http://gw',
      getToken: token,
      fetchImpl: () => Promise.reject(new Error('offline')),
    });
    const { policy, stale } = await client.load();
    expect(stale).toBe(true);
    expect(policy).toEqual(DEFAULT_IDE_POLICY);
  });

  it('gateway trả shape lạ → coi như hỏng, dùng cache', async () => {
    const client = new IdePolicyClient({
      baseURL: 'http://gw',
      getToken: token,
      cache: { read: () => STRICT_POLICY, write: () => {} },
      fetchImpl: () => Promise.resolve(jsonResponse({ min_permission_mode: 'siêu lỏng' })),
    });
    const { policy, stale } = await client.load();
    expect(stale).toBe(true);
    expect(policy.min_permission_mode).toBe('plan');
  });

  it('401 không được biến thành policy mở toang', async () => {
    const client = new IdePolicyClient({
      baseURL: 'http://gw',
      getToken: token,
      cache: { read: () => STRICT_POLICY, write: () => {} },
      fetchImpl: () => Promise.resolve(jsonResponse({ detail: 'unauthorized' }, 401)),
    });
    expect((await client.load()).policy.min_permission_mode).toBe('plan');
  });
});
