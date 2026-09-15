import { describe, expect, it, beforeEach } from 'vitest';
import { AstraWorkAuth, decodeJwtClaims } from './AstraWorkAuth.js';
import { MemoryTokenStore } from './types.js';
import { Redactor } from '../security/redactor.js';
import {
  AuthRequiredError,
  ConfigError,
  GatewayUnreachableError,
  ProviderError,
} from '../errors.js';

/** JWT giả — chỉ phần payload là thật, chữ ký không dùng đến ở phía client. */
function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown): string =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(claims)}.signature-not-verified-here`;
}

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AstraWorkAuth', () => {
  let store: MemoryTokenStore;
  let redactor: Redactor;

  beforeEach(() => {
    store = new MemoryTokenStore();
    redactor = new Redactor();
  });

  function make(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): AstraWorkAuth {
    return new AstraWorkAuth({
      baseURL: 'http://gw.test/',
      tokenStore: store,
      fetchImpl,
      redactor,
    });
  }

  describe('exchangeSsoCode — đường đăng nhập của user thường', () => {
    it('đổi code lấy token và lưu lại', async () => {
      const token = makeJwt({ sub: 'quang', role: 'DEVELOPER', exp: FUTURE });
      let seenPath = '';
      let seenBody = '';
      const auth = make(async (url, init) => {
        seenPath = url;
        seenBody = String(init?.body);
        return jsonResponse({ access_token: token, token_type: 'bearer' });
      });

      await auth.exchangeSsoCode('one-time-code');

      expect(seenPath).toBe('http://gw.test/auth/sso/exchange');
      expect(JSON.parse(seenBody)).toEqual({ code: 'one-time-code' });
      expect(await store.get()).toBe(token);
    });

    it('nạp token vào redactor NGAY — trước khi log nào chạm được vào nó', async () => {
      const token = makeJwt({ sub: 'quang', exp: FUTURE });
      const auth = make(async () => jsonResponse({ access_token: token }));

      await auth.exchangeSsoCode('code');

      expect(redactor.redactText(`gọi với ${token}`)).toContain('[REDACTED:');
      expect(redactor.redactText(`gọi với ${token}`)).not.toContain(token);
    });

    it('code hết hạn -> AuthRequiredError kèm thông báo của gateway', async () => {
      const auth = make(async () =>
        jsonResponse({ detail: 'Mã đăng nhập không hợp lệ hoặc đã hết hạn.' }, 401),
      );
      await expect(auth.exchangeSsoCode('cũ')).rejects.toThrow(AuthRequiredError);
    });
  });

  describe('loginWithPassword — chỉ admin dùng được', () => {
    it('403 của gateway được giữ nguyên thông báo (nó đã nói rõ phải làm gì)', async () => {
      const auth = make(async () =>
        jsonResponse(
          { detail: 'Tài khoản này đăng nhập bằng Microsoft. Vui lòng dùng nút Microsoft.' },
          403,
        ),
      );
      await expect(auth.loginWithPassword('member', 'pw')).rejects.toThrow(/Microsoft/);
      await expect(auth.loginWithPassword('member', 'pw')).rejects.toThrow(ProviderError);
    });

    it('admin đăng nhập được', async () => {
      const token = makeJwt({ sub: 'admin', role: 'ADMIN', exp: FUTURE });
      const auth = make(async () => jsonResponse({ access_token: token }));
      await auth.loginWithPassword('admin', 'pw');
      expect((await auth.state()).username).toBe('admin');
    });
  });

  describe('acceptAccessToken — mang token của phiên web sang IDE', () => {
    it('nhận JWT còn hạn, lưu lại và nạp vào redactor', async () => {
      const token = makeJwt({ sub: 'quang', role: 'DEVELOPER', exp: FUTURE });
      const auth = make(async () => {
        throw new Error('không được gọi mạng');
      });

      await auth.acceptAccessToken(token);

      expect(await store.get()).toBe(token);
      expect((await auth.state()).username).toBe('quang');
      expect(redactor.redact(token).hits.map((h) => h.rule)).toContain('literal');
    });

    it('bỏ tiền tố Bearer mà người dùng copy kèm', async () => {
      const token = makeJwt({ sub: 'q', exp: FUTURE });
      const auth = make(async () => jsonResponse({}));
      await auth.acceptAccessToken(`  Bearer ${token}  `);
      expect(await store.get()).toBe(token);
    });

    it('chuỗi không phải JWT bị từ chối tại chỗ, không lưu gì', async () => {
      const auth = make(async () => jsonResponse({}));
      await expect(auth.acceptAccessToken('mã-đăng-nhập-một-lần')).rejects.toThrow(ConfigError);
      expect(await store.get()).toBeUndefined();
    });

    it('token hết hạn bị từ chối — dán vào cũng chỉ đổi lấy một chuỗi 401', async () => {
      const auth = make(async () => jsonResponse({}));
      await expect(auth.acceptAccessToken(makeJwt({ sub: 'q', exp: PAST }))).rejects.toThrow(
        AuthRequiredError,
      );
      expect(await store.get()).toBeUndefined();
    });
  });

  describe('vòng đời token', () => {
    it('getToken trả token còn hạn', async () => {
      const token = makeJwt({ sub: 'q', exp: FUTURE });
      await store.set(token);
      const auth = make(async () => jsonResponse({}));
      expect(await auth.getToken()).toBe(token);
    });

    it('token hết hạn bị xoá và trả undefined — quá muộn để gia hạn', async () => {
      await store.set(makeJwt({ sub: 'q', exp: PAST }));
      const auth = make(async () => jsonResponse({}));

      expect(await auth.getToken()).toBeUndefined();
      expect(await store.get()).toBeUndefined();
    });

    it('requireToken ném AuthRequiredError khi chưa đăng nhập', async () => {
      const auth = make(async () => jsonResponse({}));
      await expect(auth.requireToken()).rejects.toThrow(AuthRequiredError);
    });

    it('handleUnauthorized xoá token', async () => {
      await store.set(makeJwt({ sub: 'q', exp: FUTURE }));
      const auth = make(async () => jsonResponse({}));
      await auth.handleUnauthorized();
      expect(await store.get()).toBeUndefined();
    });

    it('logout gỡ literal khỏi redactor', async () => {
      const token = makeJwt({ sub: 'q', exp: FUTURE });
      const auth = make(async () => jsonResponse({ access_token: token }));

      await auth.exchangeSsoCode('c');
      expect(redactor.redact(token).hits.map((h) => h.rule)).toContain('literal');

      await auth.logout();
      // Literal đã gỡ. Token vẫn bị che — nhưng bởi rule `jwt`, không phải
      // literal. Đây là hành vi mong muốn: gỡ literal không được làm rò rỉ
      // thứ mà rule thường vẫn bắt được.
      const after = redactor.redact(token);
      expect(after.hits.map((h) => h.rule)).not.toContain('literal');
      expect(after.hits.map((h) => h.rule)).toContain('jwt');
    });

    it('logout gỡ literal với token không phải JWT', async () => {
      const opaque = 'opaque-session-token-value-1234567890';
      const auth = make(async () => jsonResponse({ access_token: opaque }));
      await auth.exchangeSsoCode('c');
      expect(redactor.redactText(opaque)).toContain('[REDACTED:literal]');

      await auth.logout();
      expect(redactor.redactText(opaque)).toBe(opaque);
    });

    it('phát sự kiện khi trạng thái đổi', async () => {
      const token = makeJwt({ sub: 'q', role: 'BUL', exp: FUTURE });
      const auth = make(async () => jsonResponse({ access_token: token }));
      const seen: boolean[] = [];
      auth.onStateChange((s) => seen.push(s.authenticated));

      await auth.exchangeSsoCode('c');
      await auth.logout();

      expect(seen).toEqual([true, false]);
    });

    it('state đọc được username, role và hạn dùng', async () => {
      const token = makeJwt({ sub: 'quang', role: 'DEVELOPER', exp: FUTURE });
      await store.set(token);
      const auth = make(async () => jsonResponse({}));

      const s = await auth.state();
      expect(s).toMatchObject({ authenticated: true, username: 'quang', role: 'DEVELOPER' });
      expect(s.expiresAt).toBeInstanceOf(Date);
    });
  });

  describe('gia hạn phiên', () => {
    /** Còn 5 phút — nằm trong cửa sổ gia hạn mặc định (10 phút). */
    const SOON = Math.floor(Date.now() / 1000) + 5 * 60;

    it('còn xa hạn thì ensureFresh trả thẳng token, không gọi mạng', async () => {
      const token = makeJwt({ sub: 'q', exp: FUTURE });
      await store.set(token);
      let calls = 0;
      const auth = make(async () => {
        calls++;
        return jsonResponse({});
      });

      expect(await auth.ensureFresh()).toBe(token);
      expect(calls).toBe(0);
    });

    it('sắp hết hạn thì POST /auth/refresh kèm Bearer và lưu token mới', async () => {
      const old = makeJwt({ sub: 'q', role: 'DEVELOPER', exp: SOON });
      const fresh = makeJwt({ sub: 'q', role: 'DEVELOPER', exp: FUTURE });
      await store.set(old);
      let seenPath = '';
      let seenAuth: string | null = null;
      let seenMethod = '';
      const auth = make(async (url, init) => {
        seenPath = url;
        seenMethod = String(init?.method);
        seenAuth = new Headers(init?.headers).get('authorization');
        return jsonResponse({ access_token: fresh, token_type: 'bearer' });
      });

      expect(await auth.ensureFresh()).toBe(fresh);
      expect(seenPath).toBe('http://gw.test/auth/refresh');
      expect(seenMethod).toBe('POST');
      expect(seenAuth).toBe(`Bearer ${old}`);
      expect(await store.get()).toBe(fresh);
    });

    it('nhiều lời gọi song song gộp thành MỘT request', async () => {
      await store.set(makeJwt({ sub: 'q', exp: SOON }));
      const fresh = makeJwt({ sub: 'q', exp: FUTURE });
      let calls = 0;
      const auth = make(async () => {
        calls++;
        return jsonResponse({ access_token: fresh });
      });

      const all = await Promise.all([auth.ensureFresh(), auth.ensureFresh(), auth.ensureFresh()]);

      expect(calls).toBe(1);
      expect(all).toEqual([fresh, fresh, fresh]);
    });

    it('token mới được che, token cũ thôi là literal', async () => {
      const old = makeJwt({ sub: 'q', exp: SOON });
      const fresh = makeJwt({ sub: 'q', exp: FUTURE });
      const auth = make(async () => jsonResponse({ access_token: fresh }));

      // Nạp token cũ đúng đường thật (qua acceptToken) để nó vào redactor.
      await auth.acceptAccessToken(old);
      expect(redactor.redact(old).hits.map((h) => h.rule)).toContain('literal');

      await auth.ensureFresh();

      expect(redactor.redact(fresh).hits.map((h) => h.rule)).toContain('literal');
      expect(redactor.redact(old).hits.map((h) => h.rule)).not.toContain('literal');
      // Gỡ literal không được làm rò rỉ: rule `jwt` vẫn bắt token cũ.
      expect(redactor.redact(old).hits.map((h) => h.rule)).toContain('jwt');
    });

    it('401 khi gia hạn -> xoá token và ném AuthRequiredError', async () => {
      await store.set(makeJwt({ sub: 'q', exp: SOON }));
      const auth = make(async () => jsonResponse({ detail: 'Session no longer valid' }, 401));

      await expect(auth.ensureFresh()).rejects.toThrow(AuthRequiredError);
      expect(await store.get()).toBeUndefined();
    });

    it('403 (tài khoản bị khoá) cũng kết thúc phiên chứ không trả token cũ', async () => {
      await store.set(makeJwt({ sub: 'q', exp: SOON }));
      const auth = make(async () => jsonResponse({ detail: 'Tài khoản đang bị khoá' }, 403));

      await expect(auth.ensureFresh()).rejects.toThrow(AuthRequiredError);
      expect(await store.get()).toBeUndefined();
    });

    it('mất mạng lúc gia hạn -> dùng tiếp token cũ, KHÔNG đăng xuất', async () => {
      const old = makeJwt({ sub: 'q', exp: SOON });
      await store.set(old);
      const auth = make(async () => {
        throw new Error('ECONNREFUSED');
      });

      expect(await auth.ensureFresh()).toBe(old);
      expect(await store.get()).toBe(old);
    });

    it('token đã hết hạn hẳn -> AuthRequiredError, không thử gia hạn', async () => {
      await store.set(makeJwt({ sub: 'q', exp: PAST }));
      let calls = 0;
      const auth = make(async () => {
        calls++;
        return jsonResponse({});
      });

      await expect(auth.ensureFresh()).rejects.toThrow(AuthRequiredError);
      expect(calls).toBe(0);
    });

    it('chưa đăng nhập -> AuthRequiredError, không gọi mạng', async () => {
      let calls = 0;
      const auth = make(async () => {
        calls++;
        return jsonResponse({});
      });

      await expect(auth.ensureFresh()).rejects.toThrow(AuthRequiredError);
      expect(calls).toBe(0);
    });

    it('gia hạn phát sự kiện state mới (role đọc lại từ token gateway cấp)', async () => {
      await store.set(makeJwt({ sub: 'q', role: 'DEVELOPER', exp: SOON }));
      const auth = make(async () =>
        jsonResponse({ access_token: makeJwt({ sub: 'q', role: 'BUL', exp: FUTURE }) }),
      );
      const seen: (string | undefined)[] = [];
      auth.onStateChange((s) => seen.push(s.role));

      await auth.ensureFresh();

      expect(seen).toEqual(['BUL']);
    });
  });

  describe('ssoLoginUrl', () => {
    it('dựng URL đúng', () => {
      const auth = make(async () => jsonResponse({}));
      expect(auth.ssoLoginUrl('/projects')).toBe(
        'http://gw.test/auth/sso/login?next=%2Fprojects',
      );
    });

    it('chặn open redirect giống _safe_next của gateway', () => {
      const auth = make(async () => jsonResponse({}));
      expect(auth.ssoLoginUrl('//evil.com')).toContain('next=%2F');
      expect(auth.ssoLoginUrl('https://evil.com')).toContain('next=%2F');
    });
  });

  it('gateway không kết nối được -> GatewayUnreachableError', async () => {
    const auth = make(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(auth.exchangeSsoCode('c')).rejects.toThrow(GatewayUnreachableError);
  });
});

describe('decodeJwtClaims', () => {
  it('đọc claim từ payload base64url', () => {
    expect(decodeJwtClaims(makeJwt({ sub: 'a', exp: 123 }))).toEqual({ sub: 'a', exp: 123 });
  });

  it('trả undefined với chuỗi không phải JWT', () => {
    expect(decodeJwtClaims('không-phải-jwt')).toBeUndefined();
    expect(decodeJwtClaims('a.b')).toBeUndefined();
    expect(decodeJwtClaims('a.@@@.c')).toBeUndefined();
  });
});
