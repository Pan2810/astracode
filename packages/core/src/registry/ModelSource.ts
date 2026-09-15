/**
 * Nguồn danh sách model.
 *
 * Hai nguồn trả shape khác nhau, nên tách interface thay vì nhét if/else vào
 * ModelRegistry:
 *
 *   - Gateway AstraWork: `AvailableModel[]` (schemas.py) — có `allowed` theo
 *     quyền của user, có giá tiền, có online/offline.
 *   - FPT trực tiếp: `{data: [{id, ...}]}` chuẩn OpenAI — không có khái niệm
 *     quyền, mọi model trả về đều coi như dùng được.
 *
 * Chế độ FPT trực tiếp là đường TẠM cho tới khi M0.5 xong. Nó bỏ qua RBAC,
 * audit, redaction và budget của gateway, và bắt dev giữ FPT key trên máy —
 * xem documents/SECURITY.md §2. UI phải hiện cảnh báo khi đang ở chế độ này.
 */
import { z } from 'zod';
import { ConfigError, GatewayUnreachableError } from '../errors.js';
import type { AvailableModel } from './ModelRegistry.js';
import { AvailableModelSchema } from './ModelRegistry.js';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ModelSource {
  /** Nhãn hiển thị trên UI, ví dụ "Gateway AstraWork". */
  readonly label: string;
  /** Có đi qua RBAC/audit/redaction của gateway không. */
  readonly governed: boolean;
  list(): Promise<AvailableModel[]>;
}

export interface SourceOptions {
  /** Gốc endpoint. Gateway: không kèm /v1. FPT: kèm /v1. */
  baseURL: string;
  getToken: () => Promise<string>;
  fetchImpl?: Fetch;
}

/** Nguồn chuẩn: gateway AstraWork. Đã lọc theo quyền của user. */
export class GatewayModelSource implements ModelSource {
  readonly label = 'Gateway AstraWork';
  readonly governed = true;
  private readonly fetchImpl: Fetch;

  constructor(private readonly opts: SourceOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  }

  async list(): Promise<AvailableModel[]> {
    const url = `${this.opts.baseURL.replace(/\/+$/, '')}/models`;
    const body = await getJson(this.fetchImpl, url, await this.opts.getToken(), this.opts.baseURL);

    const parsed = z.array(AvailableModelSchema).safeParse(body);
    if (!parsed.success) {
      throw new ConfigError(
        `GET ${url} returned an unexpected shape: ${describeIssues(parsed.error.issues)}`,
      );
    }
    return parsed.data;
  }
}

const OpenAIModelListSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string().min(1),
        owned_by: z.string().optional(),
      })
      .passthrough(),
  ),
});

/**
 * Nguồn tạm: gọi thẳng FPT. Chỉ dùng khi user CHỌN TƯỜNG MINH trong cài đặt —
 * không bao giờ được rơi vào đây tự động (ADR-011).
 */
export class FptModelSource implements ModelSource {
  readonly label = 'FPT Cloud (direct)';
  readonly governed = false;
  private readonly fetchImpl: Fetch;

  constructor(private readonly opts: SourceOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  }

  async list(): Promise<AvailableModel[]> {
    const url = `${this.opts.baseURL.replace(/\/+$/, '')}/models`;
    const body = await getJson(this.fetchImpl, url, await this.opts.getToken(), this.opts.baseURL);

    const parsed = OpenAIModelListSchema.safeParse(body);
    if (!parsed.success) {
      throw new ConfigError(
        `GET ${url} returned an unexpected shape: ${describeIssues(parsed.error.issues)}`,
      );
    }

    // FPT không có khái niệm quyền theo user — mọi model trả về đều dùng được.
    // Giá để 0: bảng giá nằm ở gateway, không ở endpoint này.
    return parsed.data.data.map((m) => ({
      name: m.id,
      description: m.owned_by ? `owned by ${m.owned_by}` : '',
      context_limit: 0,
      online: true,
      allowed: true,
      input_price_vnd: 0,
      output_price_vnd: 0,
    }));
  }
}

async function getJson(
  fetchImpl: Fetch,
  url: string,
  token: string,
  baseURL: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new GatewayUnreachableError(baseURL, err);
  }
  if (!res.ok) {
    throw new ConfigError(`GET ${url} returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as unknown;
}

function describeIssues(issues: z.ZodIssue[]): string {
  return issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
}
