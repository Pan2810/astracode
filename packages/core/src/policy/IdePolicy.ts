/**
 * Chính sách tổ chức từ gateway (M9).
 *
 * AstraCode tự quyết mọi thứ trong settings của nó: chế độ duyệt quyền, mạng
 * sandbox, hooks, MCP. Với một sản phẩm nội bộ đi qua gateway có RBAC, đó là
 * cái lỗ — policy ở server nghiêm đến mấy cũng vô nghĩa nếu client tự hạ chuẩn.
 *
 * Quy tắc DUY NHẤT của module này: **giá trị hiệu lực là phần siết chặt hơn**
 * giữa policy và cài đặt của người dùng. Policy được phép siết, không được phép
 * nới. Một gateway bị chiếm quyền mà trả về "cho phép acceptEdits, tắt denylist,
 * bật sandbox full" thì không được nghe — và cách duy nhất đảm bảo điều đó là
 * không bao giờ viết nhánh code nào lấy giá trị lỏng hơn.
 *
 * Hệ quả cần nói thẳng: đây là phòng vệ cho client THẬT, không phải biên giới
 * chống client bị sửa. Chế độ duyệt quyền chỉ tồn tại trên máy dev nên chỉ máy
 * dev thực thi được. Biên giới thật vẫn ở gateway: RBAC theo model, hạn mức,
 * chính sách nội dung, audit — không cái nào phụ thuộc client.
 */
import { z } from 'zod';

/** Lỏng → chặt. Thứ tự này LÀ định nghĩa của "chặt hơn". */
export const PERMISSION_MODES = ['acceptEdits', 'ask', 'plan'] as const;
export type PolicyPermissionMode = (typeof PERMISSION_MODES)[number];

/** Lỏng → chặt. */
export const SANDBOX_NETWORKS = ['full', 'restricted', 'none'] as const;
export type PolicyNetwork = (typeof SANDBOX_NETWORKS)[number];

export const IdePolicySchema = z.object({
  min_permission_mode: z.enum(PERMISSION_MODES).default('ask'),
  max_sandbox_network: z.enum(SANDBOX_NETWORKS).default('none'),
  allow_hooks: z.boolean().default(false),
  allow_mcp: z.boolean().default(false),
  extra_denylist: z.array(z.string()).default([]),
});

export type IdePolicy = z.infer<typeof IdePolicySchema>;

/**
 * Mặc định khi CHƯA BAO GIỜ lấy được policy — trùng với mặc định của client.
 *
 * Cố ý không chặt hơn: người dùng lần đầu cài extension, chưa kịp đăng nhập,
 * mà đã bị khoá vào `plan` thì họ sẽ tưởng sản phẩm hỏng. Trạng thái "chưa biết
 * policy" khác với "policy nói lỏng" — cái sau mới là thứ phải nghi ngờ.
 */
export const DEFAULT_IDE_POLICY: IdePolicy = {
  min_permission_mode: 'ask',
  max_sandbox_network: 'none',
  allow_hooks: false,
  allow_mcp: false,
  extra_denylist: [],
};

/** Giá trị chặt hơn trong hai giá trị, theo thứ tự của `scale`. */
function stricter<T extends string>(scale: readonly T[], a: T, b: T): T {
  return scale.indexOf(a) >= scale.indexOf(b) ? a : b;
}

export interface UserPreferences {
  permissionMode: PolicyPermissionMode;
  sandboxNetwork: PolicyNetwork;
  hooksEnabled: boolean;
  mcpEnabled: boolean;
}

export interface EffectiveSettings extends UserPreferences {
  extraDenylist: string[];
  /**
   * Ô nào đang bị policy khoá, kèm lý do đọc được.
   *
   * UI PHẢI hiện cái này. Im lặng vô hiệu hoá một ô cài đặt là cách nhanh nhất
   * khiến người dùng nghĩ sản phẩm hỏng: họ bật `acceptEdits`, lưu, rồi thấy nó
   * vẫn hỏi duyệt, và không có gì giải thích vì sao.
   */
  locked: LockedField[];
}

export interface LockedField {
  field: 'permissionMode' | 'sandboxNetwork' | 'hooks' | 'mcp';
  /** Giá trị người dùng muốn — thứ bị bỏ qua. */
  requested: string;
  /** Giá trị thực sự áp dụng. */
  applied: string;
  reason: string;
}

/**
 * Gộp policy với cài đặt của người dùng.
 *
 * Không có nhánh nào ở đây trả về giá trị lỏng hơn cả hai đầu vào — đó là bất
 * biến mà bộ test giữ.
 */
export function applyIdePolicy(policy: IdePolicy, prefs: UserPreferences): EffectiveSettings {
  const locked: LockedField[] = [];

  const permissionMode = stricter(
    PERMISSION_MODES,
    policy.min_permission_mode,
    prefs.permissionMode,
  );
  if (permissionMode !== prefs.permissionMode) {
    locked.push({
      field: 'permissionMode',
      requested: prefs.permissionMode,
      applied: permissionMode,
      reason: `Your organization requires at least "${policy.min_permission_mode}".`,
    });
  }

  const sandboxNetwork = stricter(
    SANDBOX_NETWORKS,
    policy.max_sandbox_network,
    prefs.sandboxNetwork,
  );
  if (sandboxNetwork !== prefs.sandboxNetwork) {
    locked.push({
      field: 'sandboxNetwork',
      requested: prefs.sandboxNetwork,
      applied: sandboxNetwork,
      reason: `Your organization caps sandbox networking at "${policy.max_sandbox_network}".`,
    });
  }

  // Boolean: policy `false` là cấm, và cấm luôn thắng. Không có chiều ngược lại
  // — policy `true` KHÔNG bật hộ thứ người dùng đang tắt.
  const hooksEnabled = prefs.hooksEnabled && policy.allow_hooks;
  if (hooksEnabled !== prefs.hooksEnabled) {
    locked.push({
      field: 'hooks',
      requested: 'on',
      applied: 'off',
      reason: 'Your organization does not allow running hooks from the repo.',
    });
  }

  const mcpEnabled = prefs.mcpEnabled && policy.allow_mcp;
  if (mcpEnabled !== prefs.mcpEnabled) {
    locked.push({
      field: 'mcp',
      requested: 'on',
      applied: 'off',
      reason: 'Your organization does not allow enabling MCP servers.',
    });
  }

  return {
    permissionMode,
    sandboxNetwork,
    hooksEnabled,
    mcpEnabled,
    extraDenylist: policy.extra_denylist,
    locked,
  };
}

// ─── Lấy policy về ──────────────────────────────────────────────────────────

/** Nơi giữ bản policy lấy được lần cuối. Extension dùng globalState, CLI dùng file. */
export interface PolicyCache {
  read(): IdePolicy | undefined;
  write(policy: IdePolicy): void;
}

export interface IdePolicyClientOptions {
  /** Gốc gateway, KHÔNG kèm /v1. */
  baseURL: string;
  getToken: () => Promise<string>;
  cache?: PolicyCache;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export class IdePolicyClient {
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;

  constructor(private readonly opts: IdePolicyClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  }

  /**
   * Policy đang áp dụng.
   *
   * Gateway không gọi được → dùng bản cache cuối. **Không** rơi về
   * `DEFAULT_IDE_POLICY` khi đã từng có cache: "mất mạng" không phải là lý do
   * để nới quyền, và một kẻ chặn được mạng sẽ dùng đúng đường đó nếu ta để mở.
   *
   * Chưa từng có cache thì mới dùng mặc định — lúc đó ta thật sự chưa biết gì,
   * và khoá cứng người dùng lần đầu cài đặt là sai kiểu khác.
   */
  async load(): Promise<{ policy: IdePolicy; stale: boolean }> {
    try {
      const res = await this.fetchImpl(`${this.opts.baseURL.replace(/\/+$/, '')}/ide/policy`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${await this.opts.getToken()}`,
        },
      });
      if (!res.ok) throw new Error(`GET /ide/policy returned ${res.status}`);
      const policy = IdePolicySchema.parse(await res.json());
      this.opts.cache?.write(policy);
      return { policy, stale: false };
    } catch {
      const cached = this.opts.cache?.read();
      return { policy: cached ?? DEFAULT_IDE_POLICY, stale: true };
    }
  }
}
