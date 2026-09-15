/**
 * ModelRegistry — ghép HAI nguồn thông tin về model.
 *
 *   1. GET /models của gateway AstraWork — model nào TỒN TẠI và user này có
 *      QUYỀN dùng. Shape lấy từ schemas.py: AvailableModel.
 *   2. models.json (capability profile) — model đó LÀM ĐƯỢC GÌ (tool-calling,
 *      context window, kháng injection). Gateway không biết những thứ này.
 *
 * Ghép theo id. Model có ở gateway nhưng thiếu profile thì **coi như làm được**
 * (native tool-calling, đọc được ảnh) — xem `INFERRED_DEFAULTS` bên dưới để
 * biết vì sao mặc định lạc quan chứ không phải bi quan.
 */
import { z } from 'zod';
import type { ModelRole } from '../provider/types.js';
import type { Logger } from '../telemetry/logger.js';
import type { ModelSource } from './ModelSource.js';
import { ConfigError } from '../errors.js';
import { usdFromVnd } from '../config/pricing.js';

/**
 * Giá một model, USD. Ưu tiên trường USD; chỉ quy đổi khi gateway còn ở bản
 * VND — xem `config/pricing.ts` để biết vì sao có đường quy đổi ấy.
 */
function priceUsd(usd: number | undefined, vnd: number | undefined): number {
  if (typeof usd === 'number' && usd > 0) return usd;
  return usdFromVnd(vnd ?? 0);
}

// ─── Nguồn 1: GET /models của gateway ───────────────────────────────────────
// Khớp với AvailableModel trong backend/gateway/app/schemas.py.
// Cố ý dùng passthrough: gateway thêm trường mới không được làm vỡ client.
export const AvailableModelSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().default(''),
    context_limit: z.number().nonnegative().default(0),
    online: z.boolean(),
    allowed: z.boolean(),
    // Giá TRÊN 1 TRIỆU TOKEN. Hai tên cho cùng một thứ vì gateway đang chuyển
    // sang USD: `*_usd` là bản mới, `*_vnd` là bản đang chạy. Cả hai optional —
    // gateway cũ không có trường USD, gateway mới sẽ bỏ trường VND.
    input_price_usd: z.number().optional(),
    output_price_usd: z.number().optional(),
    input_price_vnd: z.number().optional(),
    output_price_vnd: z.number().optional(),
  })
  .passthrough();

export type AvailableModel = z.infer<typeof AvailableModelSchema>;

// ─── Nguồn 2: models.json (capability profile) ────────────────────────────
const ModelProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().default(''),
  contextWindow: z.number().positive(),
  maxOutput: z.number().positive().default(4096),
  toolCalling: z.enum(['native', 'xml-fallback', 'none']),
  streamingToolCalls: z.boolean().default(false),
  vision: z.boolean().default(false),
  /**
   * `unknown` = CHƯA AI ĐO, khác hẳn với `low` = đã đo và model dễ bị dắt mũi.
   *
   * Trước đây hai thứ này dùng chung giá trị `low`, nên mọi model chưa đo đều
   * bị xếp cùng chỗ với model đã bị kết luận là kém. Gộp như vậy làm hỏng cả
   * hai đầu: bản cài mới nào cũng thấy một hàng cảnh báo đỏ vô nghĩa, và đến
   * lúc có một model thật sự kém thì không còn ai đọc cảnh báo nữa.
   */
  injectionResistance: z.enum(['high', 'medium', 'low', 'unknown']).default('unknown'),
  roles: z.array(z.enum(['planner', 'editor', 'fast', 'vision'])).default([]),
  editStrategy: z.enum(['search-replace', 'diff-fenced', 'whole-file']).default('diff-fenced'),
  /**
   * Ngưỡng tự nén, theo tỉ lệ cửa sổ THẬT, ghi đè mặc định 0.8 của
   * `ContextBudget`. Khai cho model cửa sổ lớn (200k) mà không muốn nén sớm;
   * không khai thì giữ mặc định. Phải nằm trong (0, 1) và đứng sau `warnAt`.
   */
  compactAt: z.number().positive().max(1).optional(),
  /**
   * Ngưỡng cảnh báo, theo tỉ lệ cửa sổ THẬT, ghi đè mặc định 0.7. Luôn đứng
   * trước `compactAt` theo tỉ lệ không đổi, kể cả khi `compactAt` bị trần
   * `reserveForOutput` kéo xuống. Không khai thì giữ mặc định.
   */
  warnAt: z.number().positive().max(1).optional(),
}).superRefine((profile, ctx) => {
  if (
    profile.warnAt !== undefined &&
    profile.compactAt !== undefined &&
    profile.warnAt >= profile.compactAt
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['warnAt'],
      message: 'must be lower than compactAt',
    });
  }
});

export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const ModelsFileSchema = z.object({
  schemaVersion: z.literal(1),
  baseURL: z.string().default(''),
  models: z.array(ModelProfileSchema),
  routing: z.object({
    planner: z.string().default(''),
    editor: z.string().default(''),
    fast: z.string().default(''),
    /**
     * Model cho lượt có ảnh đính kèm. Có `default('')` nên `models.json` do bản
     * cũ của `astracode measure` sinh ra vẫn đọc được — thiếu khoá này thì vai
     * `vision` rơi về `planner`, xem `resolve`.
     */
    vision: z.string().default(''),
    fallback: z.array(z.string()).default([]),
  }),
});

export type ModelsFile = z.infer<typeof ModelsFileSchema>;

/** Kết quả ghép — thứ mà phần còn lại của AstraCode nhìn thấy. */
export interface ResolvedModel extends ModelProfile {
  available: boolean;
  allowed: boolean;
  online: boolean;
  description: string;
  /** Giá trên 1 triệu token, USD. 0 = gateway không nói giá. */
  inputPriceUsd: number;
  outputPriceUsd: number;
  /** Profile là thật hay được suy ra vì thiếu dữ liệu đo. */
  profileSource: 'measured' | 'inferred';
}

/**
 * Năng lực giả định cho model gateway có cấp nhưng chưa ai đo.
 *
 * **Lạc quan, không phải bi quan** — đây là một thay đổi có chủ đích so với
 * bản đầu. Lý lẽ cũ ("đoán native là hỏng âm thầm") đúng khi AstraCode có thể
 * cắm vào endpoint OpenAI-compatible bất kỳ. Nó không còn đúng nữa: model đến
 * từ `GET /models` của một gateway do chính tổ chức vận hành, danh sách nhỏ và
 * biết trước.
 *
 * Ba lý do đổi:
 *
 *   1. **Bi quan không hề an toàn hơn.** Quyền ghi file đã có `PermissionManager`
 *      đứng chắn, và nó không hỏi model xem nó giỏi cỡ nào. Ép `toolCalling:
 *      'none'` chỉ làm chậm, không làm chặt.
 *   2. **Đoán sai là phát hiện được.** Model không gọi được tool thì gateway
 *      trả lỗi ngay ở lượt đầu, và `AgentLoop` tự tụt về XML rồi nhớ lại. Một
 *      lần vấp thay cho một bước cài đặt bắt buộc.
 *   3. **Bắt mỗi người tự đo là đo sai đơn vị.** Kết quả đo là thuộc tính của
 *      MODEL, không phải của máy. Đo lại ở từng máy là tìm lại cùng một đáp án
 *      bằng token của từng người.
 *
 * Riêng `injectionResistance` KHÔNG lạc quan: nó là thứ duy nhất ở đây không
 * dò được lúc chạy, nên nó ở lại `unknown`. Ghi `high` vào chỗ này là tự khai
 * một điều chưa ai kiểm chứng.
 */
export const INFERRED_DEFAULTS = {
  toolCalling: 'native',
  vision: true,
  injectionResistance: 'unknown',
      maxOutput: 4096,
      /**
       * Chỉ dùng khi gateway cũng không nói `context_limit`.
       *
       * 32k thay cho 8k cũ: 8k là con số của model đời đầu và của đoán bi quan
       * ("đoán thấp an toàn hơn"). Đoán thấp ở đây KHÔNG an toàn — nó khiến nén
       * chạy ở ~50% cửa sổ thật (xem `ContextBudget.compactThreshold`), dìm đầu
       * mọi hội thoại dài mà thực ra chưa cần nén. 32k khớp với nhóm model phổ
       * thông (Qwen2.5-7B, Llama-3-8B, GLM-4-9B); ai thêm model lớn hơn sẽ khai
       * trong models.json, và gateway nào nói `context_limit` thì giá trị đó
       * thắng từ trước (xem `merge`).
       */
      contextWindow: 32_768,
    } as const;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ModelRegistryOptions {
  /**
   * Nguồn danh sách model. Truyền GatewayModelSource (chuẩn) hoặc
   * FptModelSource (chế độ tạm, xem ModelSource.ts).
   */
  source: ModelSource;
  profiles: ModelsFile;
  logger: Logger;
}

export class ModelRegistry {
  private resolved = new Map<string, ResolvedModel>();
  private loaded = false;

  constructor(private readonly opts: ModelRegistryOptions) {}

  /** Nguồn đang dùng — UI hiển thị nhãn và cảnh báo khi nguồn không governed. */
  get source(): ModelSource {
    return this.opts.source;
  }

  /** Lấy danh sách model rồi ghép với profile. Gọi lại sau khi đổi user/nguồn. */
  async load(): Promise<void> {
    this.merge(await this.opts.source.list());
    this.loaded = true;
  }

  /**
   * Ghép mà không gọi mạng — dùng cho test và cho chế độ offline một phần.
   * Tách khỏi load() vì logic ghép là thứ đáng test kỹ nhất ở đây.
   */
  merge(available: AvailableModel[]): void {
    const profileById = new Map(this.opts.profiles.models.map((m) => [m.id, m]));
    this.resolved = new Map();

    for (const a of available) {
      const profile = profileById.get(a.name);

      if (!profile) {
        // Không còn là chuyện đáng cảnh báo: chạy với năng lực giả định là
        // đường đi BÌNH THƯỜNG bây giờ, không phải trạng thái hỏng. Vẫn ghi
        // lại để chẩn đoán khi một model cư xử lạ.
        this.opts.logger.debug('model chưa có capability profile, dùng mặc định', {
          model: a.name,
        });
      }

      this.resolved.set(a.name, {
        id: a.name,
        label: profile?.label || a.name,
        contextWindow:
          profile?.contextWindow ??
          // Gateway biết `context_limit` thật; chỉ khi nó cũng không nói thì
          // mới rơi về con số đoán.
          (a.context_limit > 0 ? a.context_limit : INFERRED_DEFAULTS.contextWindow),
        maxOutput: profile?.maxOutput ?? INFERRED_DEFAULTS.maxOutput,
        toolCalling: profile?.toolCalling ?? INFERRED_DEFAULTS.toolCalling,
        streamingToolCalls: profile?.streamingToolCalls ?? false,
        vision: profile?.vision ?? INFERRED_DEFAULTS.vision,
        injectionResistance: profile?.injectionResistance ?? INFERRED_DEFAULTS.injectionResistance,
        roles: profile?.roles ?? [],
        editStrategy: profile?.editStrategy ?? 'diff-fenced',
        ...(profile?.compactAt !== undefined ? { compactAt: profile.compactAt } : {}),
        ...(profile?.warnAt !== undefined ? { warnAt: profile.warnAt } : {}),
        available: a.online && a.allowed,
        allowed: a.allowed,
        online: a.online,
        description: a.description,
        inputPriceUsd: priceUsd(a.input_price_usd, a.input_price_vnd),
        outputPriceUsd: priceUsd(a.output_price_usd, a.output_price_vnd),
        profileSource: profile ? 'measured' : 'inferred',
      });
    }

    // Profile có nhưng gateway không trả về: user không có quyền, hoặc model
    // đã bị gỡ. Không đưa vào danh sách — nhưng nói ra để dễ chẩn đoán.
    for (const p of this.opts.profiles.models) {
      if (!this.resolved.has(p.id)) {
        this.opts.logger.debug('model có profile nhưng gateway không cấp', { model: p.id });
      }
    }
  }

  /** Model dùng được: online + user có quyền. */
  usable(): ResolvedModel[] {
    return [...this.resolved.values()].filter((m) => m.available);
  }

  /** Toàn bộ model gateway trả về, kể cả không dùng được — cho UI picker. */
  all(): ResolvedModel[] {
    return [...this.resolved.values()];
  }

  get(id: string): ResolvedModel | undefined {
    return this.resolved.get(id);
  }

  /**
   * Model cho một vai trò. Thứ tự ưu tiên:
   *   1. routing.<role> trong models.json, nếu model đó đang dùng được
   *      (vai `vision` không khai thì mượn `planner` — đọc ảnh và lập kế hoạch
   *      là cùng một loại việc, xem config/model.ts)
   *   2. model dùng được đầu tiên có khai báo vai trò đó
   *   3. model dùng được đầu tiên có tool-calling native (cho editor/planner)
   *   4. model dùng được bất kỳ
   */
  resolve(role: ModelRole): string | undefined {
    const routing = this.opts.profiles.routing;
    const configured = role === 'vision' ? routing.vision || routing.planner : routing[role];
    if (configured && this.resolved.get(configured)?.available) return configured;

    const usable = this.usable();
    const byRole = usable.find((m) => m.roles.includes(role));
    if (byRole) return byRole.id;

    if (role === 'editor' || role === 'planner') {
      const native = usable.find((m) => m.toolCalling === 'native');
      if (native) return native.id;
    }
    return usable[0]?.id;
  }

  /** Model dự phòng, đã lọc theo quyền. */
  fallbackChain(): string[] {
    const declared = this.opts.profiles.routing.fallback.filter(
      (id) => this.resolved.get(id)?.available,
    );
    if (declared.length > 0) return declared;
    return this.usable().map((m) => m.id);
  }

  /**
   * Model có được phép nhận việc có quyền ghi không.
   *
   * documents/SECURITY.md §1.7: model **đo được** kháng injection mức `low` thì
   * không. `unknown` KHÔNG bị chặn — chặn thứ chưa ai đo nghĩa là chặn tất cả
   * cho tới khi có người chạy phép đo, tức là biến một lớp phòng thủ thành một
   * bước cài đặt. Lớp thật sự đứng giữa model và đĩa cứng vẫn là
   * `PermissionManager`, và nó không phụ thuộc phép đo nào.
   */
  safeForWrite(id: string): boolean {
    const m = this.resolved.get(id);
    return Boolean(m?.available && m.toolCalling !== 'none' && m.injectionResistance !== 'low');
  }

  isLoaded(): boolean {
    return this.loaded;
  }
}

/** Đọc và validate models.json (capability profile). Ném ConfigError kèm lý do đọc được. */
export function parseModelsFile(raw: unknown): ModelsFile {
  const parsed = ModelsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `models.json is not valid: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/** Registry rỗng — dùng khi chưa có capability profile, để UI vẫn khởi động được. */
export const EMPTY_MODELS_FILE: ModelsFile = {
  schemaVersion: 1,
  baseURL: '',
  models: [],
  routing: { planner: '', editor: '', fast: '', vision: '', fallback: [] },
};

/**
 * Profile ship SẴN theo AstraCode — để không ai phải đo mới bắt đầu dùng được.
 *
 * Đây là chỗ ghi kết quả đo của các model trên gateway của tổ chức. Kết quả đo
 * là thuộc tính của model chứ không phải của máy, nên nó được đo MỘT LẦN bởi
 * người thêm model vào gateway, rồi đi kèm bản cài — thay vì mỗi thành viên tự
 * chạy `astracode measure` để tìm lại cùng một đáp án bằng token của mình.
 *
 * **Chỉ điền vào đây thứ đã đo thật.** Danh sách rỗng không phải thiếu sót:
 * model không có mặt ở đây vẫn chạy bình thường bằng `INFERRED_DEFAULTS`, và
 * đường đó là đường mặc định chứ không phải đường suy giảm. Mục duy nhất đáng
 * thêm vào là model mà giả định lạc quan SAI — ví dụ model không gọi được tool
 * native, hoặc đo ra kháng injection mức `low`. Chép một dòng chưa đo vào đây
 * là biến một phỏng đoán thành một sự thật có vẻ đáng tin.
 *
 * Quy trình thêm: `astracode measure`, rồi chép mục tương ứng từ
 * `~/.astra/models.json` vào đây kèm ngày đo.
 */
export const BUNDLED_MODELS_FILE: ModelsFile = {
  schemaVersion: 1,
  baseURL: '',
  models: [],
  routing: { planner: '', editor: '', fast: '', vision: '', fallback: [] },
};

/**
 * Chồng profile của người dùng lên bản ship sẵn.
 *
 * Người dùng thắng theo TỪNG MODEL, không phải thay cả file: một người đo lại
 * đúng một model không nên xoá sạch hiểu biết về những model còn lại. Cùng lẽ
 * đó, mỗi vai trong `routing` được xét riêng — khai `editor` ở máy mình không
 * làm mất `fast` của bản ship sẵn.
 */
export function mergeModelsFiles(base: ModelsFile, user: ModelsFile): ModelsFile {
  const byId = new Map(base.models.map((m) => [m.id, m]));
  for (const m of user.models) byId.set(m.id, m);

  return {
    schemaVersion: 1,
    baseURL: user.baseURL || base.baseURL,
    models: [...byId.values()],
    routing: {
      planner: user.routing.planner || base.routing.planner,
      editor: user.routing.editor || base.routing.editor,
      fast: user.routing.fast || base.routing.fast,
      vision: user.routing.vision || base.routing.vision,
      fallback: user.routing.fallback.length > 0 ? user.routing.fallback : base.routing.fallback,
    },
  };
}
