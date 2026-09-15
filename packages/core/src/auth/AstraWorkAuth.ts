/**
 * Đăng nhập vào gateway AstraWork — mốc M1.
 *
 * Contract lấy từ backend/gateway/app/routers/{auth,sso}.py của AstraWork:
 *
 *   POST /auth/login          {username, password} -> {access_token, token_type}
 *                             CHỈ DÀNH CHO ADMIN. Tài khoản thường bị 403 kèm
 *                             thông báo "đăng nhập bằng Microsoft".
 *   GET  /auth/sso/config     -> cấu hình SSO (bật/tắt, tên tenant)
 *   GET  /auth/sso/login?next=/path
 *                             -> redirect sang Microsoft Entra ID
 *   POST /auth/sso/exchange   {code} -> {access_token, token_type}
 *                             Code dùng MỘT LẦN và hết hạn nhanh.
 *   POST /auth/refresh        (Bearer) -> {access_token, token_type}
 *                             Gia hạn phiên. Claim được ĐỌC LẠI TỪ DB, nên mất
 *                             quyền (bị vô hiệu hoá, bị gỡ khỏi dự án, bị khoá)
 *                             là mất ngay ở lần gia hạn kế tiếp chứ không đi
 *                             theo token cũ tới hết giờ.
 *
 * Hai điều quan trọng, cùng bắt nguồn từ thiết kế của AstraWork:
 *
 * 1. KHÔNG CÓ REFRESH TOKEN, nhưng CÓ gia hạn. TokenResponse chỉ có
 *    access_token; cách duy nhất kéo dài phiên là gọi /auth/refresh bằng một
 *    token CÒN HẠN. Hết hạn rồi thì /auth/refresh cũng trả 401 và không còn
 *    đường nào ngoài đăng nhập lại — nên `ensureFresh()` gia hạn TRƯỚC khi hạn
 *    tới, và quanh 401 vẫn không có vòng retry nào.
 *
 * 2. `next` của /auth/sso/login bị _safe_next() ép phải là path bắt đầu bằng "/"
 *    trên frontend. Không thể trỏ thẳng về `vscode://`. Nên luồng cho extension
 *    là: mở trình duyệt -> đăng nhập -> lấy code -> đưa code vào VS Code.
 *
 *    Hệ quả: khi người dùng đăng nhập ở TRANG WEB AstraWork (không phải qua
 *    ssoLoginUrl của extension), thứ họ có trong tay là access token chứ không
 *    phải code — `acceptAccessToken` là đường cho trường hợp đó.
 */
import { z } from 'zod';
import { AuthRequiredError, ConfigError, GatewayUnreachableError, ProviderError } from '../errors.js';
import type { AuthState, TokenStore } from './types.js';
import type { Redactor } from '../security/redactor.js';
import { defaultRedactor } from '../security/redactor.js';

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default('bearer'),
});

const SsoConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    tenant: z.string().optional(),
  })
  .passthrough();

export type SsoConfig = z.infer<typeof SsoConfigSchema>;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Còn dưới ngần này thì `ensureFresh` đi gia hạn.
 *
 * Rộng tay có chủ ý. Thứ đáng sợ là token chết GIỮA một lượt agent — lượt ấy
 * gồm nhiều request nối nhau và có thể chạy hàng chục phút — chứ không phải một
 * lần gọi /auth/refresh thừa. Và vì chỉ request model mới đi qua đường này (xem
 * `AstraSession.rebuild`), số lần gia hạn bám theo mức dùng thật chứ không theo
 * đồng hồ.
 */
const DEFAULT_REFRESH_WINDOW_MS = 10 * 60_000;

export interface AstraWorkAuthOptions {
  /** Gốc gateway, KHÔNG kèm /v1. Ví dụ: http://localhost:8000 */
  baseURL: string;
  tokenStore: TokenStore;
  fetchImpl?: Fetch;
  redactor?: Redactor;
  /** Coi như hết hạn sớm hơn `exp` chừng này để tránh đua với server. */
  expirySkewMs?: number;
}

export class AstraWorkAuth {
  private readonly baseURL: string;
  private readonly store: TokenStore;
  private readonly fetchImpl: Fetch;
  private readonly redactor: Redactor;
  private readonly skewMs: number;
  private readonly listeners = new Set<(state: AuthState) => void>();
  /** Lần gia hạn đang bay — xem `refresh()`. */
  private refreshing: Promise<string> | undefined;

  constructor(opts: AstraWorkAuthOptions) {
    if (!opts.baseURL) throw new ConfigError('ASTRAWORK_BASE_URL is missing');
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.store = opts.tokenStore;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.redactor = opts.redactor ?? defaultRedactor;
    this.skewMs = opts.expirySkewMs ?? 30_000;
  }

  onStateChange(fn: (state: AuthState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** URL để mở trong trình duyệt ngoài. `next` bắt buộc là path trên frontend. */
  ssoLoginUrl(next = '/'): string {
    const safe = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    return `${this.baseURL}/auth/sso/login?next=${encodeURIComponent(safe)}`;
  }

  async ssoConfig(): Promise<SsoConfig> {
    const res = await this.request('GET', '/auth/sso/config');
    return SsoConfigSchema.parse(res);
  }

  /**
   * Đổi code một lần từ luồng SSO lấy JWT.
   * Đây là đường đăng nhập của người dùng thường.
   */
  async exchangeSsoCode(code: string): Promise<void> {
    const body = await this.request('POST', '/auth/sso/exchange', { code });
    await this.acceptToken(TokenResponseSchema.parse(body).access_token);
  }

  /**
   * Đăng nhập bằng mật khẩu. CHỈ tài khoản admin dùng được — AstraWork trả 403
   * cho mọi role khác, cố ý, để không tồn tại đường vào yếu hơn Entra ID.
   * Giữ hàm này cho dev/test và cho tài khoản admin nền tảng.
   */
  async loginWithPassword(username: string, password: string): Promise<void> {
    const body = await this.request('POST', '/auth/login', { username, password });
    await this.acceptToken(TokenResponseSchema.parse(body).access_token);
  }

  /**
   * Nhận thẳng access token của phiên AstraWork đang mở trên trình duyệt.
   *
   * Đây là đường dùng khi người dùng đăng nhập ở trang web AstraWork rồi mang
   * token sang IDE: frontend giữ JWT trong bộ nhớ của trình duyệt, mà extension
   * không có cách nào đọc được chỗ đó. Token vẫn phải là JWT còn hạn — kiểm ở
   * đây để người dùng biết ngay mình dán nhầm, thay vì rơi vào một chuỗi 401
   * không giải thích được về sau.
   *
   * Chữ ký KHÔNG được xác thực ở đây: đó là việc của gateway (xem
   * decodeJwtClaims). Việc kiểm này chỉ để bắt lỗi dán nhầm.
   */
  async acceptAccessToken(token: string): Promise<void> {
    const trimmed = token.trim().replace(/^Bearer\s+/i, '');
    if (!decodeJwtClaims(trimmed)) {
      throw new ConfigError(
        'That is not an AstraWork access token (a JWT with three parts is required).',
      );
    }
    if (this.isExpired(trimmed)) {
      throw new AuthRequiredError('The token has expired — sign in again on the AstraWork site.');
    }
    await this.acceptToken(trimmed);
  }

  /** Token hiện có, hoặc undefined. KHÔNG tự đăng nhập lại. */
  async getToken(): Promise<string | undefined> {
    const token = await this.store.get();
    if (!token) return undefined;
    if (this.isExpired(token)) {
      await this.logout();
      return undefined;
    }
    return token;
  }

  /** Token, hoặc ném AuthRequiredError. Dùng ở chỗ bắt buộc phải có. */
  async requireToken(): Promise<string> {
    const token = await this.getToken();
    if (!token) throw new AuthRequiredError();
    return token;
  }

  /**
   * Token còn dùng được, tự gia hạn nếu sắp hết hạn. Đây là đường mà request
   * tới model đi qua.
   *
   * Vì sao tách khỏi `getToken` thay vì gia hạn ở đó cho tiện: `getToken` cũng
   * là đường của các tác vụ NỀN — nạp danh sách model, tải policy, đồng bộ
   * usage. Nếu chúng cũng gia hạn thì một cửa sổ VS Code bỏ quên vẫn giữ phiên
   * sống mãi, đúng thứ mà hạn token sinh ra để tránh. Chia đôi như thế này biến
   * hạn cố định thành idle timeout mà không cần đếm giờ ở đâu cả: gọi model là
   * người dùng đang làm việc, poll nền thì không.
   *
   * Gia hạn hỏng vì MẠNG thì trả lại token cũ — nó còn hạn, lượt vẫn chạy được,
   * và request sau sẽ thử lại. Chỉ 401/403 mới là hết đường, và lúc đó
   * `doRefresh` đã đăng xuất rồi.
   */
  async ensureFresh(withinMs = DEFAULT_REFRESH_WINDOW_MS): Promise<string> {
    const token = await this.getToken();
    if (!token) throw new AuthRequiredError();
    if (!this.expiresWithin(token, withinMs)) return token;
    try {
      return await this.refresh();
    } catch (err) {
      if (err instanceof AuthRequiredError) throw err;
      return token;
    }
  }

  /**
   * Đổi token đang giữ lấy token mới. Thường thì dùng `ensureFresh`; gọi thẳng
   * hàm này khi muốn ép gia hạn ngay.
   *
   * Nhiều lời gọi song song gộp về MỘT request. Một lượt agent bắn vài request
   * cùng lúc, và hai lần /auth/refresh chồng nhau sẽ cấp hai token khác nhau —
   * cái lưu sau ghi đè cái trước, để lại một token hợp lệ mà không ai giữ.
   */
  async refresh(): Promise<string> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<string> {
    const current = await this.store.get();
    if (!current) throw new AuthRequiredError();
    try {
      const body = await this.request('POST', '/auth/refresh', undefined, current);
      const next = TokenResponseSchema.parse(body).access_token;
      await this.acceptToken(next);
      // Token cũ hết vai trò. Gỡ khỏi redactor SAU khi đã nạp cái mới, để không
      // có khoảnh khắc nào cả hai đều không được che.
      this.redactor.removeLiteral(current);
      return next;
    } catch (err) {
      // 401 (hết hạn, tài khoản đã tắt, đã bị gỡ khỏi dự án) và 403 (đang bị
      // khoá) đều nghĩa là phiên hỏng thật. Xóa token để UI hỏi đăng nhập lại
      // thay vì để mọi request sau đó rơi vào một chuỗi 401 không giải thích.
      if (err instanceof AuthRequiredError) {
        await this.logout();
        throw err;
      }
      if (err instanceof ProviderError && err.status === 403) {
        await this.logout();
        throw new AuthRequiredError(err.message, err);
      }
      throw err;
    }
  }

  /**
   * Gọi khi gateway trả 401. Token đã hết hạn thì /auth/refresh cũng 401, nên
   * việc duy nhất làm được là xóa token và báo cho UI biết cần đăng nhập lại.
   * Chỗ để cứu phiên là `ensureFresh`, TRƯỚC khi hạn tới — không phải ở đây.
   */
  async handleUnauthorized(): Promise<void> {
    await this.logout();
  }

  async logout(): Promise<void> {
    const old = await this.store.get();
    if (old) this.redactor.removeLiteral(old);
    await this.store.clear();
    this.emit({ authenticated: false });
  }

  async state(): Promise<AuthState> {
    const token = await this.store.get();
    if (!token) return { authenticated: false };
    const claims = decodeJwtClaims(token);
    const expiresAt = claims?.exp ? new Date(claims.exp * 1000) : undefined;
    if (expiresAt && expiresAt.getTime() - this.skewMs <= Date.now()) {
      return { authenticated: false, ...(expiresAt ? { expiresAt } : {}) };
    }
    return {
      authenticated: true,
      ...(claims?.sub ? { username: claims.sub } : {}),
      ...(claims?.role ? { role: claims.role } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(typeof claims?.project_id === 'number' ? { projectId: claims.project_id } : {}),
    };
  }

  isExpired(token: string): boolean {
    return this.expiresWithin(token, 0);
  }

  /** Token hết hạn trong `withinMs` tới không? Không có `exp` thì coi như không. */
  private expiresWithin(token: string, withinMs: number): boolean {
    const claims = decodeJwtClaims(token);
    if (!claims?.exp) return false; // Không có exp thì để server phán xử.
    return claims.exp * 1000 - this.skewMs <= Date.now() + withinMs;
  }

  private async acceptToken(token: string): Promise<void> {
    // Nạp vào redactor NGAY, trước khi bất cứ log nào có cơ hội chạm vào nó.
    this.redactor.addLiteral(token);
    await this.store.set(token);
    this.emit(await this.state());
  }

  private emit(state: AuthState): void {
    for (const fn of this.listeners) fn(state);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    bearer?: string,
  ): Promise<unknown> {
    const url = `${this.baseURL}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new GatewayUnreachableError(this.baseURL, err);
    }

    if (res.status === 401) {
      throw new AuthRequiredError(await detail(res), undefined);
    }
    if (!res.ok) {
      // 403 ở /auth/login là trường hợp thường gặp nhất: tài khoản không phải
      // admin. Giữ nguyên thông báo của gateway vì nó đã nói rõ phải làm gì.
      throw new ProviderError(await detail(res), res.status);
    }
    return (await res.json()) as unknown;
  }
}

async function detail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === 'string') return body.detail;
    return `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

interface JwtClaims {
  sub?: string;
  role?: string;
  exp?: number;
  /** Dự án token này mở. `null` khi tài khoản chưa thuộc dự án nào. */
  project_id?: number | null;
}

/**
 * Đọc claim để biết token còn hạn không và hiển thị tên user.
 * KHÔNG xác thực chữ ký — đó là việc của gateway. Ở đây chỉ dùng để tránh gửi
 * một request chắc chắn sẽ 401.
 */
export function decodeJwtClaims(token: string): JwtClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const pad = payload.length % 4 === 0 ? '' : '='.repeat(4 - (payload.length % 4));
    const json = Buffer.from(payload + pad, 'base64').toString('utf8');
    return JSON.parse(json) as JwtClaims;
  } catch {
    return undefined;
  }
}
