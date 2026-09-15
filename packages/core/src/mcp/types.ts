/**
 * Kiểu và schema cho MCP (mốc M7).
 *
 * MCP không phải "thêm vài tool nữa". Nó là đường đưa CODE CỦA NGƯỜI KHÁC vào
 * quy trình của agent — supply chain risk, không phải tính năng thường
 * (documents/SECURITY.md §6). Nên toàn bộ phần khai báo được siết
 * bằng schema ở đây, và mọi thứ không khớp schema thì bị TỪ CHỐI kèm lý do đọc
 * được, chứ không im lặng bỏ qua.
 *
 * Ba ràng buộc nằm ngay trong kiểu dữ liệu:
 *
 *   1. `digest` phải là sha256 thật. Tag bị đẩy đè được, digest thì không —
 *      nên `image: mcp/git:latest` hôm nay và ngày mai có thể là hai thứ khác
 *      hẳn nhau mà không ai biết.
 *   2. Cấu hình từ REPO chỉ được BẬT server có sẵn trong catalog. Khai báo
 *      image/lệnh tuỳ ý chỉ có ở `~/.astra/mcp.json` — nguồn do người dùng viết.
 *   3. `trustLevel` đi kèm từng server và theo output của nó tới tận
 *      PermissionManager. Server vùng C làm phiên tự hạ cấp quyền.
 */
import { z } from 'zod';

/** Digest hợp lệ: `sha256:` + 64 ký tự hex. Không nhận tag, không nhận rỗng. */
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Tên server — dùng làm tiền tố tên tool nên phải hẹp. */
export const SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

export type McpRisk = 'low' | 'medium' | 'high';
export type McpTrustLevel = 'A' | 'B' | 'C';
export type McpNetwork = 'none' | 'restricted' | 'full';

const RiskSchema = z.enum(['low', 'medium', 'high']);
const TrustLevelSchema = z.enum(['A', 'B', 'C']);
const NetworkSchema = z.enum(['none', 'restricted', 'full']);

export const CatalogServerSchema = z.object({
  name: z.string().regex(SERVER_NAME_RE, 'tên server chỉ nhận [a-z0-9_-]'),
  image: z.string().min(1),
  /**
   * Không validate bằng regex ở đây: catalog trong repo còn chỗ giữ chỗ
   * (`sha256:<ĐIỀN KHI TRIỂN KHAI>`) và ta muốn UI hiện được server đó kèm lý do
   * "chưa pin digest", chứ không phải cả file catalog vỡ vì một dòng.
   * Việc chặn nằm ở `loadCatalog` → `pinned: false`.
   */
  digest: z.string().min(1),
  description: z.string().default(''),
  risk: RiskSchema.default('medium'),
  defaultEnabled: z.boolean().default(false),
  network: NetworkSchema.default('none'),
  mounts: z.array(z.string()).default([]),
  trustLevel: TrustLevelSchema.default('C'),
  notes: z.string().optional(),
});

export type CatalogServer = z.infer<typeof CatalogServerSchema>;

export const CatalogPolicySchema = z.object({
  requireWorkspaceTrust: z.boolean().default(true),
  requireExplicitEnablePerServer: z.boolean().default(true),
  defaultPermissionMode: z.enum(['plan', 'ask', 'acceptEdits']).default('ask'),
  pinByDigest: z.boolean().default(true),
  allowCustomServersFromRepo: z.boolean().default(false),
  allowCustomServersFromUserConfig: z.boolean().default(true),
  showToolDescriptionsBeforeEnable: z.boolean().default(true),
  scanToolDescriptionsForInjection: z.boolean().default(true),
});

export type McpPolicy = z.infer<typeof CatalogPolicySchema>;

export const DEFAULT_POLICY: McpPolicy = CatalogPolicySchema.parse({});

export const McpCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  servers: z.array(CatalogServerSchema).default([]),
  policy: CatalogPolicySchema.default(DEFAULT_POLICY),
});

export type McpCatalog = z.infer<typeof McpCatalogSchema>;

/**
 * Server tuỳ chỉnh trong `~/.astra/mcp.json`.
 *
 * Chỉ khai báo được bằng LỆNH, không bằng image. Cố ý: chạy image tuỳ ý cần
 * một sinh chuỗi `docker run` với đủ cờ siết (read_only, cap_drop, network) —
 * mà chuỗi đó lại sinh ra trong TypeScript thì không ai review được nó, ngược
 * hẳn với lý do compose tồn tại. Muốn thêm image thì thêm vào catalog.
 *
 * Lệnh chạy THẲNG TRÊN MÁY, không cách ly. `isolated: false` được ghi rõ và UI
 * phải hiện điều đó trước khi người dùng bật.
 */
export const UserServerSchema = z.object({
  name: z.string().regex(SERVER_NAME_RE),
  description: z.string().default(''),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Biến môi trường truyền cho tiến trình. KHÔNG kế thừa env của extension. */
  env: z.record(z.string()).default({}),
  /** Mặc định C: thứ do người dùng cắm thêm không được coi là đáng tin hơn web. */
  trustLevel: TrustLevelSchema.default('C'),
  risk: RiskSchema.default('high'),
});

export type UserServer = z.infer<typeof UserServerSchema>;

/** `~/.astra/mcp.json` — nguồn tin cậy. */
export const UserConfigSchema = z.object({
  enable: z.array(z.string()).default([]),
  servers: z.array(UserServerSchema).default([]),
});

export type McpUserConfig = z.infer<typeof UserConfigSchema>;

/**
 * `.astra/mcp.json` trong repo — KHÔNG tin cậy.
 * Chỉ có `enable`. Trường `servers` bị từ chối tường minh chứ không lờ đi: im
 * lặng bỏ qua sẽ khiến người viết repo tưởng nó có tác dụng, và khiến người
 * dùng không biết repo vừa cố làm gì.
 */
export const RepoConfigSchema = z
  .object({
    enable: z.array(z.string()).default([]),
  })
  .passthrough();

/** Cách khởi chạy một server. */
export type McpLaunchSpec =
  | {
      kind: 'compose';
      /** Tên service trong docker-compose.mcp.yml (= tên server). */
      service: string;
      image: string;
      digest: string;
    }
  | {
      kind: 'process';
      command: string;
      args: string[];
      env: Record<string, string>;
    };

/** Một server sau khi ghép catalog + cấu hình + chính sách. */
export interface ResolvedServer {
  name: string;
  description: string;
  risk: McpRisk;
  network: McpNetwork;
  trustLevel: McpTrustLevel;
  mounts: string[];
  /** Server đến từ catalog đóng gói sẵn hay do người dùng tự khai báo. */
  source: 'catalog' | 'user';
  launch: McpLaunchSpec;
  /** Người dùng đã bật server này chưa. Không bật thì không khởi chạy. */
  enabled: boolean;
  /** Digest hợp lệ (chỉ có nghĩa với server catalog). */
  pinned: boolean;
  /** Chạy trong container hay chạy thẳng trên máy. */
  isolated: boolean;
  /** Có lý do thì server KHÔNG được chạy, dù `enabled` là true. */
  blockedReason?: string;
  notes?: string;
}

/** Một khai báo bị bỏ qua, kèm lý do để UI nói ra được. */
export interface McpRejection {
  source: 'repo' | 'user' | 'catalog';
  message: string;
}

export interface McpResolution {
  servers: ResolvedServer[];
  rejections: McpRejection[];
  policy: McpPolicy;
  workspaceTrusted: boolean;
}

/** Mô tả một tool do server MCP cung cấp (kết quả `tools/list`). */
export interface McpToolInfo {
  name: string;
  description: string;
  /** JSON Schema thô của server. Không đổi sang zod — xem McpManager. */
  inputSchema: Record<string, unknown>;
}
