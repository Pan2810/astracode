/**
 * Ai được xem `/admin`: một lần Bearer đúng, rồi mười lăm phút bằng cookie.
 *
 * Route admin đòi `ASTRACODE_SERVICE_TOKEN` kể cả từ loopback — trang đó liệt
 * kê mọi job, mọi repo và mọi ticket, mà "chạy trên localhost" gồm cả một tab
 * đang mở trang lạ. Nhưng trình duyệt KHÔNG gắn `Authorization` vào một lần
 * điều hướng thường, nên bắt token ở mọi request là biến trang theo dõi thành
 * thứ không mở được bằng cách mở nó.
 *
 * Nên: gửi Bearer đúng một lần (curl, hoặc một extension gắn header) thì server
 * đặt một cookie, và mười lăm phút sau đó trình duyệt tự mở được trang.
 *
 * Bốn điều kiện, cả bốn đều là hàng rào:
 *
 *   * **HttpOnly** — JavaScript trên trang không đọc được nó, nên một XSS ở đâu
 *     đó không mang được phiên này đi.
 *   * **SameSite=Strict** — trang khác không làm cho cookie này được gửi kèm,
 *     nên không ai lừa trình duyệt đọc `/api/v1/jobs` thay mình được.
 *   * **Chỉ GET** — cookie này không cho phép bất cứ gì khác. Hôm nay route
 *     admin vốn chỉ đọc, nên đây là hàng rào cho ngày mai: một route admin ghi
 *     được, nếu có, sẽ vẫn phải có Bearer.
 *   * **Không phải service token.** Giá trị cookie là một chuỗi ngẫu nhiên sinh
 *     riêng cho lần cấp đó và chỉ sống trong bộ nhớ tiến trình. Đặt chính token
 *     vào cookie là đem bí mật dài hạn đi rải vào profile trình duyệt.
 *
 * Mười lăm phút tính từ lúc cấp, KHÔNG gia hạn theo mỗi lần dùng: một cửa sổ cố
 * định là thứ nói được thành câu ("token đúng mở ra mười lăm phút"), còn cửa sổ
 * trượt thì hết hạn vào lúc không ai đoán được.
 *
 * `Secure` không đặt: server chỉ `listen` trên 127.0.0.1 và nói HTTP, mà một
 * cookie `Secure` trên http thì có trình duyệt nhận có trình duyệt bỏ. Thà
 * không đặt còn hơn đặt một thuộc tính có thể làm cookie bị bỏ im lặng.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'astracode_admin';
export const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * So sánh hai bí mật mà không rò rỉ thời gian. Độ dài lệch thì thôi khỏi so.
 *
 * Cổng chính ở `server.mjs` dùng chung hàm này: hai bản so sánh token là hai
 * chỗ để một bản lặng lẽ trở thành `===`.
 */
export function sameSecret(given, expected) {
  const a = Buffer.from(given ?? '', 'utf8');
  const b = Buffer.from(expected ?? '', 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** `Authorization: Bearer <...>` → `<...>`, hoặc rỗng. */
export function bearerOf(req) {
  const raw = req?.headers?.authorization ?? '';
  const found = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return found ? found[1].trim() : '';
}

/**
 * Giá trị cookie `astracode_admin` trong header, hoặc rỗng.
 *
 * Tự tách chứ không dùng thư viện: chỉ cần một tên, và một header cookie hỏng
 * phải ra rỗng chứ không được ném lỗi — nó là dữ liệu của người lạ.
 */
export function cookieOf(req) {
  const raw = String(req?.headers?.cookie ?? '');
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== COOKIE_NAME) continue;
    return part.slice(at + 1).trim();
  }
  return '';
}

/**
 * Cổng của route admin.
 *
 * `devMode` (chưa đặt token) thì mở, và KHÔNG cấp cookie: không có gì để giữ,
 * và một cookie trong chế độ dev chỉ là thứ sống sót sang lần chạy sau.
 *
 * `mint` và `now` tiêm được để test dựng cảnh hết hạn mà không phải đợi.
 */
export function createAdminAuth({
  serviceToken,
  devMode = false,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  mint = () => randomBytes(32).toString('base64url'),
} = {}) {
  /** @type {Map<string, number>} giá trị cookie → thời điểm hết hạn */
  const live = new Map();

  function prune() {
    const at = now();
    for (const [value, until] of live) if (until <= at) live.delete(value);
  }

  /** Cấp một phiên mới và trả về đúng dòng `Set-Cookie`. */
  function grant() {
    prune();
    const value = mint();
    live.set(value, now() + ttlMs);
    const seconds = Math.floor(ttlMs / 1000);
    return {
      value,
      cookie: `${COOKIE_NAME}=${value}; Max-Age=${seconds}; Path=/; HttpOnly; SameSite=Strict`,
    };
  }

  /** Cookie này còn hạn không. Hết hạn thì bỏ luôn khỏi sổ. */
  function accepts(value) {
    if (!value) return false;
    prune();
    // Duyệt cả sổ với so sánh không rò rỉ thời gian: `Map.has` sẽ so bằng cách
    // ngắn mạch, và sổ này nhiều nhất là vài phiên.
    for (const known of live.keys()) if (sameSecret(value, known)) return true;
    return false;
  }

  /**
   * Cho qua hay không, và đặt cookie khi vừa nhận được Bearer đúng.
   *
   * `res` có thể thiếu (test gọi trực tiếp): khi đó chỉ trả quyết định.
   */
  function authorize(req, res) {
    if (devMode) return true;
    if (sameSecret(bearerOf(req), serviceToken)) {
      const { cookie } = grant();
      // `setHeader` trước `writeHead`: Set-Cookie không nằm trong object mà
      // `send()` truyền cho `writeHead`, nên nó sống sót.
      res?.setHeader?.('Set-Cookie', cookie);
      return true;
    }
    // Cookie chỉ mở đường đọc. Một route admin ghi được, nếu ngày nào đó có,
    // vẫn phải có Bearer.
    if (String(req?.method ?? '').toUpperCase() !== 'GET') return false;
    return accepts(cookieOf(req));
  }

  return { authorize, grant, accepts, ttlMs, size: () => live.size };
}
