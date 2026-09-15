/**
 * Bóc credential AstraWork ra khỏi một đoạn văn bản bất kỳ.
 *
 * Tách khỏi SignInFlow.ts để module này KHÔNG import 'vscode' — nhờ vậy test
 * được bằng vitest thuần Node. Cùng lý do với `webview/parse.ts` trước đây.
 *
 * Đầu vào là CLIPBOARD của người dùng, tức là văn bản tuỳ ý: có thể là cả thanh
 * địa chỉ họ copy, có thể là mã trần, có thể là một đoạn code họ vừa chép cho
 * việc khác. Nên hàm này phải dễ tính với ba dạng đầu và dứt khoát từ chối mọi
 * thứ còn lại — nhận nhầm chỉ tốn một request 401, nhưng nhận sót thì người
 * dùng ngồi đợi một thứ không bao giờ tới.
 */

export type Credential =
  /** JWT của phiên AstraWork, dùng thẳng được. */
  | { kind: 'token'; value: string }
  /** Mã một lần của luồng SSO, phải đổi qua `/auth/sso/exchange`. */
  | { kind: 'code'; value: string };

/** Clipboard dài hơn mức này chắc chắn không phải mã đăng nhập. */
const MAX_INPUT = 8192;
/** JWT ba phần base64url. Không xác thực chữ ký — đó là việc của gateway. */
const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;
/** Mã một lần: đủ dài để không đụng phải một từ người ta vừa copy. */
const CODE = /^[A-Za-z0-9._~-]{16,512}$/;

export function extractCredential(raw: string): Credential | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_INPUT) return undefined;

  const text = raw.trim().replace(/^Bearer\s+/i, '');
  if (!text) return undefined;

  // 1. Cả thanh địa chỉ — dạng hay gặp nhất, vì copy URL dễ hơn bôi đen đúng mã.
  const fromUrl = fromQuery(text);
  if (fromUrl) return fromUrl;

  // 2. JWT trần: người dùng lấy token của phiên web ra.
  if (JWT.test(text)) return { kind: 'token', value: text };

  // 3. Mã trần.
  if (CODE.test(text)) return { kind: 'code', value: text };

  return undefined;
}

/**
 * Đọc `token`/`access_token`/`code` từ query HOẶC fragment của một URL.
 *
 * Fragment cũng phải đọc: luồng OAuth implicit trả token sau dấu `#`, và một
 * URL như vậy sẽ có query rỗng — chỉ nhìn query là bỏ sót toàn bộ trường hợp đó.
 */
function fromQuery(text: string): Credential | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }

  const params = [url.searchParams, new URLSearchParams(url.hash.replace(/^#/, ''))];

  for (const source of params) {
    const token = source.get('token') ?? source.get('access_token');
    if (token && JWT.test(token)) return { kind: 'token', value: token };

    const code = source.get('code');
    if (code && CODE.test(code)) return { kind: 'code', value: code };
  }
  return undefined;
}
