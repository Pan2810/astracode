/**
 * Đọc mức dùng CỦA TÀI KHOẢN từ AstraWork (M10, phần 2 — chiều ngược lại).
 *
 * ## Vì sao phần này tồn tại
 *
 * Phần 1 (`OtlpExporter`) chỉ đẩy đi. Mục "Usage" trong bảng cài đặt vì thế
 * từng hiện một con số AstraCode tự đếm trên máy — một sổ riêng, không ai đối
 * chiếu được với thẻ "AI 利用状況" trên trang cá nhân AstraWork. Hai con số cạnh
 * nhau mà không bao giờ bằng nhau thì cả hai đều mất giá trị.
 *
 * Nguồn sự thật là NHẬT KÝ AUDIT CỦA GATEWAY: mỗi lượt gọi model —
 * `/v1/chat/completions` của AstraCode cũng như `/chat` của web — ghi một dòng
 * kèm token và `cost_vnd`. `GET /auth/me/usage` cộng đúng bảng đó cho chính
 * người đang đăng nhập, và trang cá nhân AstraWork vẽ thẻ của nó từ cùng một
 * lời gọi. Đọc lại chỗ đó nghĩa là hai bề mặt không thể lệch nhau: chúng không
 * "đồng bộ" với nhau, chúng đọc chung một con số.
 *
 * Hệ quả về hướng đi: AstraCode không cần đẩy gì để AstraWork thấy số của mình
 * — lượt chat đi qua gateway ĐÃ là hành động ghi sổ. Chiều còn lại là lời gọi
 * dưới đây.
 *
 * ## Xác thực bằng JWT, không phải ingest token
 *
 * Đây là dữ liệu của một NGƯỜI, nên nó phải đi theo phiên đăng nhập của người
 * đó. Ingest token (`awtl_…`) là danh tính của một cỗ máy gửi số đo và cố ý
 * không đọc được gì.
 *
 * ## Đọc dè chừng
 *
 * Schema nằm ở repo AstraWork. Thiếu một trường thì coi là 0 và vẫn vẽ được
 * bảng, thay vì ném và biến một thay đổi nhỏ bên kia thành một mục Usage trống
 * không giải thích được.
 */
import { AstraError } from '../errors.js';
import { usdFromVnd } from '../config/pricing.js';

export interface AccountUsage {
  /** Số lượt gọi model của tài khoản này — 対話数 trên thẻ AstraWork. */
  turns: number;
  totalTokens: number;
  /**
   * Chi phí quy đổi, USD. Giá marketplace của gateway, không phải hoá đơn.
   *
   * Gateway đang chuyển sang USD: đọc `cost_usd` nếu có, còn không thì quy từ
   * `cost_vnd` — xem `config/pricing.ts`.
   */
  costUsd: number;
  /** Số ngày có dùng. */
  daysActive: number;
  /** Lần dùng gần nhất, epoch ms. Không có = chưa dùng lần nào. */
  lastUsed?: number;
  /**
   * Số lượt tách theo nơi phát sinh: `astracode` (IDE) và `astrawork` (web).
   * Tên nguồn do server đặt — nhận nguyên văn, đừng ép về một tập cố định.
   */
  bySource: Record<string, number>;
  /**
   * Hạn mức tiền của tài khoản trong kỳ, USD. Thiếu = gateway KHÔNG nói.
   *
   * "Thiếu" và "bằng 0" là hai chuyện khác nhau và UI phải phân biệt được: một
   * tài khoản hết sạch hạn mức phải hiện 0%, còn một gateway không báo hạn mức
   * thì không được vẽ ra một thanh 0% trông như đã cháy túi. Nên trường này
   * optional chứ không mặc định 0 như các trường đếm ở trên.
   */
  budgetUsd?: number;
  /** Còn lại tiêu được, USD. Thiếu = không suy ra được. Xem `budget()`. */
  remainingUsd?: number;
}

export interface FetchAccountUsageOptions {
  /** Gốc gateway, KHÔNG kèm `/v1`. */
  baseURL: string;
  /** JWT của phiên đăng nhập. */
  getToken: () => Promise<string>;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Tiền đọc từ một trong nhiều tên trường, USD.
 *
 * Vì sao một danh sách tên chứ không một tên: hạn mức bên AstraWork nằm ở
 * `core/budget.py` với hai tầng (project pot + member allowance) và endpoint
 * `/auth/me/usage` đang trong quãng chuyển VND → USD (xem `config/pricing.ts`).
 * Đoán một tên duy nhất rồi đoán trượt nghĩa là mục hạn mức trống trơn mà không
 * có gì nói vì sao. Đọc rộng, và nếu KHÔNG tên nào có mặt thì trả `undefined` —
 * "gateway không báo hạn mức" là một trạng thái hợp lệ, UI nói ra được.
 *
 * Thứ tự có ý nghĩa: tên USD trước, rồi mới tới bản VND quy đổi.
 */
function money(o: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const usd = num(o[`${name}_usd`]);
    if (usd > 0) return usd;
  }
  for (const name of names) {
    const vnd = num(o[`${name}_vnd`]);
    if (vnd > 0) return usdFromVnd(vnd);
  }
  return undefined;
}

function counts(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    // Tên nguồn hiện thẳng lên UI: cắt ngắn để một chuỗi rác bên kia không kéo
    // dài cả bảng. Việc escape là của webview (nó dựng DOM, không innerHTML).
    if (key.length <= 64) out[key] = num(raw);
  }
  return out;
}

export async function fetchAccountUsage(opts: FetchAccountUsageOptions): Promise<AccountUsage> {
  const base = opts.baseURL.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  const jwt = await opts.getToken();

  const res = await fetchImpl(`${base}/auth/me/usage`, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${jwt}` },
  });

  if (!res.ok) {
    throw new AstraError(
      res.status === 401 || res.status === 403 ? 'auth_required' : 'provider_error',
      res.status === 404
        ? 'This AstraWork gateway has no /auth/me/usage endpoint — it needs an update.'
        : `AstraWork refused to report this account's usage (HTTP ${res.status}).`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AstraError('provider_error', 'AstraWork returned something that is not JSON.');
  }

  const o = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const lastUsed = typeof o.last_used === 'string' ? Date.parse(o.last_used) : Number.NaN;
  const costUsd = num(o.cost_usd) || usdFromVnd(num(o.cost_vnd));

  return {
    turns: num(o.turns),
    totalTokens: num(o.tokens),
    costUsd,
    daysActive: num(o.days_active),
    ...(Number.isNaN(lastUsed) ? {} : { lastUsed }),
    bySource: counts(o.by_source),
    ...budget(o, costUsd),
  };
}

/**
 * Hạn mức và số còn lại, suy từ những gì gateway chịu nói.
 *
 * Một trong hai con số là đủ, vì con số kia suy ra được từ phần đã tiêu — và
 * suy ra ở ĐÂY chứ không ở webview, để hai bề mặt (bảng cài đặt, hàng trên ô
 * nhập) không tự làm phép trừ mỗi nơi một kiểu.
 *
 * Số còn lại KHÔNG bị kẹp về `budget - cost` khi gateway đã nói thẳng: tài
 * khoản có thể được nạp thêm giữa kỳ, và lúc ấy con số của gateway đúng còn
 * phép trừ của ta sai.
 */
function budget(
  o: Record<string, unknown>,
  costUsd: number,
): { budgetUsd?: number; remainingUsd?: number } {
  const total = money(o, ['budget', 'limit', 'quota', 'monthly_limit', 'allowance']);
  const left = money(o, ['remaining', 'balance', 'budget_remaining', 'remaining_budget']);

  if (total === undefined && left === undefined) return {};
  const budgetUsd = total ?? left! + costUsd;
  const remainingUsd = left ?? Math.max(0, total! - costUsd);
  return { budgetUsd, remainingUsd };
}
