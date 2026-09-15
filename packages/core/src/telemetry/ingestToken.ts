/**
 * Xin ingest token cho đường OTLP (M10, phần 1).
 *
 * Vì sao có hai loại token: JWT của phiên đăng nhập hết hạn theo giờ và phải
 * làm mới, còn `OtlpExporter` chỉ gắn được một header cố định — nó không đăng
 * nhập, không làm mới, không thử lại khi bị thách thức. AstraWork vì thế phát
 * riêng một token dài hạn (`awtl_…`) cho đường telemetry, đổi bằng JWT qua
 * `POST /telemetry/token`.
 *
 * ## Vì sao đọc response một cách dè chừng
 *
 * Đầu phát nằm ở repo AstraWork, và AstraCode chỉ biết đường đi chứ không giữ
 * schema của nó. Chấp nhận vài tên trường thường gặp rồi *nói ra* khi không
 * nhận được token, thay vì bám cứng một tên rồi hỏng im lặng: telemetry hỏng im
 * lặng là loại lỗi không ai phát hiện cho tới lúc có người hỏi vì sao board
 * trống.
 */
import { AstraError } from '../errors.js';

export interface IngestToken {
  /** Chuỗi để gắn vào header `Authorization: Bearer …`. */
  token: string;
  /** Epoch ms, nếu server nói. Không nói thì coi như dài hạn. */
  expiresAt?: number;
}

export interface MintIngestTokenOptions {
  /** Gốc gateway, KHÔNG kèm `/v1`. */
  baseURL: string;
  /** JWT của phiên đăng nhập. Đây là thứ duy nhất chứng minh danh tính ở đây. */
  getToken: () => Promise<string>;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Tên trường có thể chứa token, xếp theo mức chắc chắn giảm dần. */
const TOKEN_KEYS = ['ingest_token', 'ingestToken', 'token', 'access_token'] as const;

function pickToken(body: Record<string, unknown>): string | undefined {
  for (const key of TOKEN_KEYS) {
    const value = body[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function pickExpiry(body: Record<string, unknown>): number | undefined {
  // `expires_in` là số giây kể từ bây giờ; `expires_at` là mốc tuyệt đối và có
  // thể ở giây hoặc mili — số nhỏ hơn ngưỡng này chắc chắn là giây.
  const inSeconds = body.expires_in ?? body.expiresIn;
  if (typeof inSeconds === 'number' && inSeconds > 0) return Date.now() + inSeconds * 1000;

  const at = body.expires_at ?? body.expiresAt;
  if (typeof at === 'number' && at > 0) return at < 1e12 ? at * 1000 : at;
  if (typeof at === 'string') {
    const parsed = Date.parse(at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

export async function mintIngestToken(opts: MintIngestTokenOptions): Promise<IngestToken> {
  const base = opts.baseURL.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  const jwt = await opts.getToken();

  const res = await fetchImpl(`${base}/telemetry/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: '{}',
  });

  if (!res.ok) {
    throw new AstraError(
      res.status === 401 || res.status === 403 ? 'auth_required' : 'provider_error',
      `AstraWork refused to issue a telemetry ingest token (HTTP ${res.status}).`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AstraError('provider_error', 'The ingest token endpoint returned something that is not JSON.');
  }

  const token =
    typeof body === 'object' && body !== null
      ? pickToken(body as Record<string, unknown>)
      : undefined;

  if (!token) {
    throw new AstraError(
      'provider_error',
      'The ingest token endpoint returned JSON with no recognizable token field.',
    );
  }

  const expiresAt = pickExpiry(body as Record<string, unknown>);
  return expiresAt === undefined ? { token } : { token, expiresAt };
}
