/**
 * AstraSession — dựng lại toàn bộ chuỗi core mỗi khi cấu hình đổi.
 *
 * Vì sao dựng lại thay vì mutate: đổi địa chỉ gateway làm thay đổi nguồn model,
 * nguồn token và base URL cùng lúc. Mutate từng phần sẽ để lại trạng thái lai —
 * ví dụ registry còn model của endpoint cũ trong khi provider đã trỏ chỗ mới.
 */
import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AstraWorkAuth,
  BUNDLED_MODELS_FILE,
  GatewayModelSource,
  GatewayProvider,
  Logger,
  ModelRegistry,
  IdePolicyClient,
  IdePolicySchema,
  DEFAULT_IDE_POLICY,
  ProjectAgentsClient,
  ProjectStandardSchema,
  EMPTY_PROJECT_STANDARD,
  toAgentDefinitions,
  toSkillDefinitions,
  defaultRedactor,
  mergeModelsFiles,
  parseModelsFile,
  WorkItemsClient,
  type AgentDefinition,
  type AstraProject,
  type AstraTask,
  type IdePolicy,
  type ModelSource,
  type ModelsFile,
  type ProjectStandard,
  type Skill,
  type ResolvedModel,
  type TaskDoneReport,
  type TaskDoneResult,
} from '@astra/core';
import {
  SECRET_KEY_ASTRAWORK_TOKEN,
  readConfig,
  type AstraConfig,
} from './config.js';
import { SecretStorageTokenStore } from './adapters.js';

/** Khoá `workspaceState` giữ task đang khai. Đổi tên khoá = mất lựa chọn. */
const WORK_STATE_KEY = 'astra.work';

interface SavedWork {
  taskId?: number;
  taskLabel?: string;
}

/**
 * Dự án + task đang khai, và hai danh sách để chọn.
 *
 * `projectId` KHÔNG được lưu xuống đĩa: nó nằm trong JWT (xem
 * `core/work/WorkItems.ts`), nên chỗ giữ nó là token chứ không phải state của
 * extension. Hai bản sao của cùng một sự thật sẽ lệch nhau ngay lần người dùng
 * đổi dự án trên web.
 */
export interface WorkState {
  projects: AstraProject[];
  tasks: AstraTask[];
  /** Dự án đang mở trong token, đọc từ chính token. */
  projectId?: number;
  taskId?: number;
  /** Nhãn task đã chọn, giữ lại để hiện đúng trước khi danh sách kịp về. */
  taskLabel?: string;
  /** Task đang mở của người này nhưng ở công đoạn khác `coding`. Xem AstraTaskList. */
  otherStages?: number;
  /** Vì sao lần đọc gần nhất hỏng. Rỗng = lần gần nhất trót lọt. */
  error?: string;
  loading?: boolean;
}

/**
 * Bản nháp của một lần báo done, dựng từ gateway để người dùng sửa lại.
 *
 * Mọi số ở đây đều là ĐỀ XUẤT, không phải sự thật cuối cùng: telemetry chỉ đo
 * được phần đi qua AstraCode, còn một task thường có cả những giờ không ngồi
 * trong IDE. Vì thế hộp thoại cho sửa từng ô — xem `webview/chat.ts`.
 */
export interface TaskReport {
  taskId: number;
  label: string;
  /** `YYYY-MM-DD` hoặc rỗng. Lịch kế hoạch, y như đang lưu trên WBS. */
  planStart: string;
  planEnd: string;
  /** Đã điền sẵn hôm nay khi WBS còn để trống — xem `AstraSession.taskReport`. */
  actualStart: string;
  actualEnd: string;
  tokens: number;
  costUsd: number;
  /** Vì sao không đọc được số đo. Có nó thì hai số trên là 0, không phải "đo được 0". */
  usageError?: string;
}

/**
 * Hôm nay theo múi giờ CỦA MÁY, `YYYY-MM-DD`.
 *
 * Không dùng `toISOString()`: nó cho ngày UTC, và ở UTC+7 thì mọi lần báo done
 * trước 7 giờ sáng sẽ ghi ngày hôm qua lên WBS. Cột này là ngày làm việc của
 * con người, nên nó phải theo lịch mà người ấy đang nhìn.
 */
function todayISO(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface SessionStatus {
  config: AstraConfig;
  /** Nhãn nguồn model đang dùng, ví dụ "Gateway AstraWork". */
  sourceLabel: string;
  authenticated: boolean;
  username?: string;
  role?: string;
  /**
   * Hạn của token hiện tại, epoch ms. Là hạn thật nếu từ giờ tới đó không ai
   * chat — mỗi lượt chat đẩy nó ra xa (xem `rebuild`).
   */
  expiresAt?: number;
  models: ResolvedModel[];
  /**
   * Model thật sự đang dùng sau khi giải quyết routing — khác với
   * `config.model` khi model được chọn không có trong danh sách gateway cấp,
   * lúc đó registry rơi về một model dùng được.
   */
  activeModel?: string;
  /**
   * Model thật sự dùng cho lượt có ảnh và lượt trong chế độ plan — cũng đã qua
   * routing, nên nó khác `config.planModel` khi model ấy không được cấp.
   */
  activePlanModel?: string;
  /** Số model gateway trả về nhưng thiếu capability profile. */
  missingProfiles: number;
    lastError?: string;
}

/**
 * Capability profile do `astracode measure` sinh ra, ở `~/.astra/models.json`.
 *
 * Dùng chung với CLI có chủ ý: đo một lần, cả hai công cụ cùng thấy. Đặt ở HOME
 * chứ không trong repo vì nó mô tả MODEL, không mô tả dự án — cùng một model thì
 * đo ở repo nào cũng ra kết quả ấy.
 *
 * Thiếu file KHÔNG phải lỗi và cũng không làm suy giảm gì: model không có mục
 * riêng chạy bằng `INFERRED_DEFAULTS` (native + vision), và đó là đường mặc
 * định chứ không phải đường dự phòng. File này chỉ cần tồn tại khi có model mà
 * giả định đó SAI.
 */
function modelsFilePath(): string {
  return path.join(process.env.ASTRA_HOME || path.join(os.homedir(), '.astra'), 'models.json');
}

/**
 * File giả lập chuẩn dự án, để thử đường ống khi gateway chưa có `/ide/agents`.
 *
 * Nội dung y hệt payload thật. Chỉ đọc khi gateway KHÔNG trả về chuẩn nào —
 * một file trên máy không được phép che chuẩn thật, nếu không thì "chuẩn dự án"
 * thành thứ mỗi người tự tắt được.
 *
 * Đặt ở HOME chứ không trong repo, và đó là ranh giới quan trọng: `~/.astra/`
 * là của chính người đang ngồi máy, còn thư mục repo đến từ bất kỳ ai gửi PR.
 * File này cũng không cho thêm quyền gì mới — ai viết được vào đây thì đã viết
 * được `~/.astra/agents/*.md` từ M8.
 */
function projectAgentsStubPath(): string {
  return path.join(
    process.env.ASTRA_HOME || path.join(os.homedir(), '.astra'),
    'project-agents.json',
  );
}

/**
 * Bộ agent cũ hơn mức này thì lượt chat sau tự đi lấy lại. Xem
 * `ensureProjectAgentsFresh`.
 *
 * Mười phút là đánh đổi giữa hai kiểu sai: hỏi lại mỗi lượt là bắn request vào
 * gateway suốt ngày cho một thứ hiếm khi đổi, còn không hỏi lại lần nào thì PM
 * sửa xong cả đội vẫn chạy bản cũ tới hôm sau — đúng cái tình huống mà header
 * `Cache-Control: no-store` bên gateway dựng ra để tránh.
 */
const PROJECT_AGENTS_TTL_MS = 10 * 60_000;

/** Chuẩn agent của dự án đang mở, và nó đến từ đâu. */
export interface ProjectAgentsState {
  standard: ProjectStandard;
  /** Mục `kind: "agent"` — đã chuẩn hoá, cắt và quét. Đưa cho `loadAgents`. */
  agents: AgentDefinition[];
  /** Mục `kind: "skill"` — cùng payload, khác hình dạng. Đưa cho `loadSkills`. */
  skills: Skill[];
  /** Đang dùng bản cache vì gateway không gọi được. */
  stale: boolean;
  source: 'gateway' | 'stub' | 'none';
}

export class AstraSession implements vscode.Disposable {
  private config: AstraConfig;
  private profiles: ModelsFile = BUNDLED_MODELS_FILE;
  /** Trần cấu hình của tổ chức (M9). Xem `loadPolicy`. */
  private policy: IdePolicy = DEFAULT_IDE_POLICY;
  /** Policy đang dùng là bản cache vì gateway không gọi được. */
  private policyStale = false;
  /** Lần lấy chuẩn agent gần nhất THÀNH CÔNG, epoch ms. 0 = chưa lần nào. */
  private projectAgentsFetchedAt = 0;
  /** Lần nạp đang chạy — để nhiều lượt song song không thành nhiều request. */
  private projectAgentsLoading: Promise<void> | undefined;
  /** Chuẩn agent của dự án (M10b). Xem `loadProjectAgents`. */
  private projectAgents: ProjectAgentsState = {
    standard: EMPTY_PROJECT_STANDARD,
    agents: [],
    skills: [],
    stale: false,
    source: 'none',
  };
    private auth: AstraWorkAuth | undefined;
  private registry: ModelRegistry | undefined;
  private provider: GatewayProvider | undefined;
  private lastError: string | undefined;
  /**
   * Đã tự nạp danh sách model cho chuỗi hiện tại chưa. Xem `ensureModels`.
   *
   * Đặt lại ở `rebuild()` chứ không ở `refreshModels()`: nó đánh dấu ĐÃ THỬ,
   * không phải đã thành công — gateway hỏng mà cứ thử lại mỗi lần UI vẽ thì
   * thành một vòng lặp bắn request, và cái vòng đó chỉ lộ ra ở log của server.
   */
  private autoLoadTried = false;
  /** Lần nạp đang chạy — để hai lời gọi song song không thành hai request. */
  private loading: Promise<void> | undefined;

  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onChangeEmitter.event;

  /** Dự án + task đang khai, và danh sách để chọn. Xem `work()`. */
  private workState: WorkState = { projects: [], tasks: [] };
  private workLoading: Promise<void> | undefined;
  /**
   * Đã thử đọc dự án/task cho chuỗi hiện tại chưa. Xem `ensureWork`.
   *
   * Cùng vai với `autoLoadTried` của danh sách model, và đặt lại ở đúng chỗ ấy:
   * `rebuild()`. Nó đánh dấu ĐÃ THỬ chứ không phải đã thành công — gateway hỏng
   * mà cứ thử lại mỗi lần UI vẽ thì thành một vòng bắn request.
   */
  private workTried = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {
    this.config = readConfig();
    // Task đã chọn sống theo WORKSPACE, không theo máy: mỗi repo là một mạch
    // việc khác nhau, và mang task của repo này sang repo khác là cách chắc
    // chắn nhất để số liệu bị quy sai chỗ.
    const saved = this.context.workspaceState.get<SavedWork>(WORK_STATE_KEY);
    if (saved?.taskId) this.workState.taskId = saved.taskId;
    if (saved?.taskLabel) this.workState.taskLabel = saved.taskLabel;
  }

  dispose(): void {
    this.onChangeEmitter.dispose();
  }

  /** Đọc lại cấu hình và dựng lại chuỗi. Gọi khi settings đổi. */
    async reload(): Promise<void> {
      this.config = readConfig();
      this.lastError = undefined;
      await this.loadProfiles();
      this.rebuild();
      // SAU rebuild: cần `auth` đã dựng xong để lấy token.
      await this.loadPolicy();
      await this.loadProjectAgents();
      this.onChangeEmitter.fire();
    }

  /**
   * Nạp profile: bản ship sẵn theo extension, chồng thêm `~/.astra/models.json`
   * của người dùng nếu có.
   *
   * Đọc lại ở MỖI lần reload chứ không chỉ lúc khởi động: người dùng chạy
   * `astracode measure` ở terminal bên cạnh, rồi bấm "Test connection" hay đổi
   * cài đặt là thấy kết quả ngay — không phải khởi động lại VS Code.
   *
   * Không có file của người dùng là trạng thái BÌNH THƯỜNG, không phải suy
   * giảm: model thiếu profile chạy bằng `INFERRED_DEFAULTS`. File hỏng thì nói
   * ra — im lặng bỏ qua sẽ khiến người vừa đo xong tưởng việc đo vô tác dụng.
   */
  private async loadProfiles(): Promise<void> {
    const uri = vscode.Uri.file(modelsFilePath());
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.profiles = mergeModelsFiles(
        BUNDLED_MODELS_FILE,
        parseModelsFile(JSON.parse(Buffer.from(bytes).toString('utf8'))),
      );
    } catch (e) {
      this.profiles = BUNDLED_MODELS_FILE;
      // Không tồn tại là trạng thái bình thường (chưa ai đo) — chỉ kêu khi file
      // CÓ mà đọc/parse không được.
      const code = (e as { code?: string }).code;
      if (code !== 'FileNotFound' && code !== 'ENOENT') {
        this.logger.warn('could not read the capability profile', {
          path: modelsFilePath(),
          error: (e as Error).message,
        });
      }
    }
  }

  /**
   * Nạp trần cấu hình của tổ chức (M9).
   *
   * Cache trong `globalState` chứ không phải workspace state: policy là của
   * TÀI KHOẢN, không của thư mục đang mở — mở repo khác không phải lý do để
   * bắt đầu lại từ "chưa biết gì".
   *
   * Mất mạng → dùng bản cache cuối, KHÔNG rơi về mặc định lỏng hơn. Ai chặn
   * được mạng sẽ dùng đúng đường đó nếu ta để mở (xem IdePolicyClient).
   */
  private async loadPolicy(): Promise<void> {
    const KEY = 'astra.idePolicy';
    const readCache = (): IdePolicy | undefined => {
      const raw = this.context.globalState.get<unknown>(KEY);
      const parsed = IdePolicySchema.safeParse(raw);
      return parsed.success ? parsed.data : undefined;
    };

    // Chưa cấu hình gateway thì không có đường nào gọi `/ide/policy`. Vẫn giữ
    // bản cache cuối nếu có, vì lý do y hệt trường hợp mất mạng ở trên: "chưa
    // điền địa chỉ" không phải cái cớ để chạy với trần lỏng hơn trần mà tổ chức
    // đã cấp. Đánh dấu stale để UI nói rõ đây là bản cũ.
    if (!this.auth) {
      this.policy = readCache() ?? DEFAULT_IDE_POLICY;
      this.policyStale = true;
      return;
    }

    const client = new IdePolicyClient({
      baseURL: this.config.gatewayBaseUrl,
      getToken: () => this.auth!.requireToken(),
      cache: {
        read: readCache,
        write: (p) => void this.context.globalState.update(KEY, p),
      },
    });
    const { policy, stale } = await client.load();
    this.policy = policy;
    this.policyStale = stale;
  }

  /** Trần cấu hình đang áp dụng, và nó có phải bản cache hay không. */
  getPolicy(): { policy: IdePolicy; stale: boolean } {
    return { policy: this.policy, stale: this.policyStale };
  }

  /**
   * Nạp chuẩn agent của dự án đang mở (M10b).
   *
   * Cache theo DỰ ÁN, khác `loadPolicy` (cache theo tài khoản): policy là trần
   * của tổ chức cấp cho một con người, còn cái này là quy ước của một dự án.
   * Dùng chung một khoá thì đổi dự án xong sẽ thấy bộ agent của dự án trước
   * trong lúc chờ mạng — sai một cách khó nhận ra vì nó vẫn "có agent".
   *
   * Khoá lấy `projectId` từ chính TOKEN, không phải từ `workState`: workState
   * có thể chưa kịp đọc lúc khởi động, còn token thì luôn có mặt khi đã đăng nhập.
   */
  private async loadProjectAgents(): Promise<void> {
    const KEY = 'astra.projectAgents';
    const auth = this.auth;

    const bucket = (): Record<string, unknown> =>
      this.context.globalState.get<Record<string, unknown>>(KEY) ?? {};

    const apply = (standard: ProjectStandard, stale: boolean, source: 'gateway' | 'stub'): void => {
      this.projectAgents = {
        standard,
        agents: toAgentDefinitions(standard),
        skills: toSkillDefinitions(standard),
        stale,
        source: standard.agents.length === 0 && source === 'gateway' && !stale ? 'none' : source,
      };
    };

    if (!auth) {
      this.projectAgents = {
        standard: EMPTY_PROJECT_STANDARD,
        agents: [],
        skills: [],
        stale: false,
        source: 'none',
      };
      return;
    }

    let scope = 'default';
    try {
      const state = await auth.state();
      if (!state.authenticated) {
        this.projectAgents = {
          standard: EMPTY_PROJECT_STANDARD,
          agents: [],
          skills: [],
          stale: false,
          source: 'none',
        };
        return;
      }
      if (state.projectId !== undefined) scope = String(state.projectId);
    } catch {
      // Không đọc được token = coi như chưa đăng nhập ở trên. Đi tiếp với
      // scope mặc định thay vì ném: đây nằm trên đường khởi động.
    }

    const client = new ProjectAgentsClient({
      baseURL: this.config.gatewayBaseUrl,
      getToken: () => auth.requireToken(),
      cache: {
        read: () => {
          const parsed = ProjectStandardSchema.safeParse(bucket()[scope]);
          return parsed.success ? parsed.data : undefined;
        },
        write: (s) => void this.context.globalState.update(KEY, { ...bucket(), [scope]: s }),
      },
    });

    const { standard, stale } = await client.load();
    apply(standard, stale, 'gateway');
    // Chỉ tính là "vừa lấy" khi gateway thật sự trả lời. Một lần hỏng mà đặt
    // mốc thời gian sẽ khoá bản cache lại thêm mười phút nữa, đúng lúc đáng
    // thử lại nhất.
    if (!stale) this.projectAgentsFetchedAt = Date.now();

    // Gateway chưa có gì (endpoint chưa lên, hoặc dự án chưa khai agent nào):
    // mới đến lượt file giả lập. Xem `projectAgentsStubPath`.
    if (this.projectAgents.agents.length === 0 && this.projectAgents.skills.length === 0) {
      const stub = await this.readProjectAgentsStub();
      if (stub) apply(stub, false, 'stub');
    }

    if (this.projectAgents.agents.length + this.projectAgents.skills.length > 0) {
      this.logger.info('project agent standard loaded', {
        source: this.projectAgents.source,
        version: this.projectAgents.standard.version,
        agents: this.projectAgents.agents.map((a) => a.name),
        skills: this.projectAgents.skills.map((a) => a.name),
        stale: this.projectAgents.stale,
      });
    }
  }

  /** Đọc file giả lập. Không có là trạng thái bình thường, không kêu gì. */
  private async readProjectAgentsStub(): Promise<ProjectStandard | undefined> {
    const file = projectAgentsStubPath();
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
      const parsed = ProjectStandardSchema.safeParse(
        JSON.parse(Buffer.from(bytes).toString('utf8')),
      );
      if (parsed.success) return parsed.data;
      // File CÓ mà sai shape thì phải kêu: người vừa viết nó đang chờ thấy kết quả.
      this.logger.warn('project agent stub has the wrong shape', { path: file });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'FileNotFound' && code !== 'ENOENT') {
        this.logger.warn('could not read the project agent stub', {
          path: file,
          error: (e as Error).message,
        });
      }
    }
    return undefined;
  }

  /** Chuẩn agent của dự án đang mở. Xem `loadProjectAgents`. */
  getProjectAgents(): ProjectAgentsState {
    return this.projectAgents;
  }

  /** Đọc lại chuẩn dự án theo yêu cầu — cho lệnh trong Command Palette. */
  async refreshProjectAgents(): Promise<ProjectAgentsState> {
    await this.loadProjectAgents();
    this.onChangeEmitter.fire();
    return this.projectAgents;
  }

  /**
   * Bộ agent quá cũ thì đi lấy lại — KHÔNG chặn người gọi.
   *
   * Gọi ở đầu mỗi lượt chat. Cố ý không `await`: lượt này vẫn chạy bằng bộ
   * đang có, lượt sau mới thấy bản mới. Chờ một request mạng trước khi trả lời
   * là bắt người dùng trả giá cho một thứ hiếm khi đổi — và nếu gateway treo
   * thì cái giá đó là cả lượt chat đứng im.
   */
  ensureProjectAgentsFresh(): void {
    if (Date.now() - this.projectAgentsFetchedAt < PROJECT_AGENTS_TTL_MS) return;
    if (this.projectAgentsLoading) return;

    this.projectAgentsLoading = (async () => {
      const before = this.projectAgents.standard.version;
      // `loadProjectAgents` đã nuốt mọi lỗi và giữ bản cache — không có gì để
      // bắt ở đây, và một lần lấy nền hỏng không được nổi lên thành thông báo.
      await this.loadProjectAgents();
      // Chỉ báo UI khi có thay đổi thật: bắn onChange mỗi mười phút cho một
      // payload y hệt là vẽ lại panel không vì lý do gì.
      if (this.projectAgents.standard.version !== before) this.onChangeEmitter.fire();
    })().finally(() => {
      this.projectAgentsLoading = undefined;
    });
  }

  /**
   * Một nguồn duy nhất: gateway AstraWork. Danh sách model, quyền dùng từng
   * model và hạn mức đều đi ra từ tài khoản đã đăng nhập — không có đường nào
   * khác để có model, và đó là điều cố ý.
   */
  private rebuild(): void {
    const baseURL = this.config.gatewayBaseUrl;
    // Chuỗi mới = danh sách model cũ không còn đúng, và lần thử tự nạp trước đó
    // nói về một endpoint khác. Dự án/task cũng đi ra từ chuỗi này, nên lần thử
    // đọc chúng cũng hết hiệu lực.
    this.autoLoadTried = false;
    this.workTried = false;

    // Địa chỉ giờ là hằng số trong code nên nhánh này KHÔNG chạy nữa. Giữ lại
    // vì nó rẻ và vì thứ nó bảo vệ vẫn đắt: `AstraWorkAuth` ném ConfigError khi
    // baseURL rỗng, và một exception ở đây giết cả activation, kéo theo
    // applyOrgPolicy/sandbox/MCP không bao giờ chạy. Xoá hằng số đi một ngày
    // nào đó thì extension im lặng chứ không sập.
    if (!baseURL) {
      this.auth = undefined;
      this.registry = undefined;
      this.provider = undefined;
      return;
    }

    const auth = new AstraWorkAuth({
      baseURL,
      tokenStore: new SecretStorageTokenStore(this.context.secrets, SECRET_KEY_ASTRAWORK_TOKEN),
      redactor: defaultRedactor,
    });
    this.auth = auth;
    // `logout()`/`handleUnauthorized()` chỉ bắn tới listener NỘI BỘ của
    // `AstraWorkAuth` (xem `emit` ở đó) — không nối lại đây thì một lần bị
    // văng ra GIỮA lượt chat (401 mid-turn) không tự đẩy `onDidChange`, và
    // gate/bảng cài đặt/Account usage chỉ thấy trạng thái mới ở lần đọc kế
    // tiếp mà một sự kiện KHÁC tình cờ kích hoạt (đổi vùng chọn trong editor,
    // mở bảng cài đặt) — người dùng thấy panel như không phản hồi gì.
    auth.onStateChange(() => this.onChangeEmitter.fire());

    // Hai đường lấy token khác nhau, và khác nhau có chủ ý.
    //
    // Nguồn model (và policy, và đồng bộ usage ở chỗ khác) dùng `requireToken`:
    // chúng chạy nền, không được tính là "người dùng đang làm việc". Provider —
    // đường duy nhất gọi tới model — dùng `ensureFresh`, nên mỗi lượt chat tự
    // đẩy hạn phiên ra xa. Hạn cố định 60 phút của gateway nhờ thế thành idle
    // timeout, mà không cần một cái timer nào trong extension: bỏ VS Code đấy
    // thì không có lượt nào chạy, không có gì gia hạn, phiên hết như thường.
    this.buildFrom(
      new GatewayModelSource({ baseURL, getToken: () => auth.requireToken() }),
      `${baseURL}/v1`,
      () => auth.ensureFresh(),
      () => auth.handleUnauthorized(),
    );
  }

  private buildFrom(
    source: ModelSource,
    providerBaseUrl: string,
    getToken: () => Promise<string>,
    onUnauthorized: () => Promise<void> | void,
  ): void {
    // Cấu hình model của user trong settings.json thắng routing sinh bởi đo.
    // Hai ô cho bốn vai: `astra.model` cầm việc sửa code (và những lượt phụ
    // chạy kèm nó), `astra.planModel` cầm việc đọc ảnh và lập kế hoạch — xem
    // core/config/model.ts để biết vì sao đường chia nằm đúng ở đó.
    const model = this.config.model;
    const planModel = this.config.planModel;
    const profiles: ModelsFile = {
      ...this.profiles,
      routing: {
        ...this.profiles.routing,
        editor: model || this.profiles.routing.editor,
        fast: model || this.profiles.routing.fast,
        planner: planModel || this.profiles.routing.planner,
        vision: planModel || this.profiles.routing.vision,
      },
    };

    this.registry = new ModelRegistry({ source, profiles, logger: this.logger });
    this.provider = new GatewayProvider({
      baseURL: providerBaseUrl,
      getToken,
      onUnauthorized,
      registry: this.registry,
      logger: this.logger,
    });
  }

  /**
   * Nạp danh sách model nếu đã đăng nhập mà chưa nạp lần nào.
   *
   * Vì sao cần: `refreshModels()` chỉ chạy khi có ai đó gọi nó — lúc đăng nhập
   * xong, hoặc lúc đổi cấu hình. Mở lại VS Code với token còn hạn thì không
   * đường nào chạy qua đó, nên bảng cài đặt mở ra trống trơn và người dùng phải
   * tự bấm "Refresh list" — một bước bắt buộc không nói ra ở đâu cả.
   *
   * Chỉ thử MỘT lần cho mỗi chuỗi (xem `autoLoadTried`) và im lặng khi chưa
   * đăng nhập: gọi `GET /models` không token chỉ đổi lấy một dòng 401 trong log.
   */
  async ensureModels(): Promise<void> {
    if (!this.registry) this.rebuild();
    const registry = this.registry;
    const auth = this.auth;
    if (!registry || !auth || this.autoLoadTried || registry.isLoaded()) return;

    if (this.loading) {
      await this.loading;
      return;
    }

    const state = await auth.state();
    if (!state.authenticated) return;

    this.autoLoadTried = true;
    this.loading = this.refreshModels().finally(() => {
      this.loading = undefined;
    });
    await this.loading;
  }

  /** Gọi endpoint để lấy danh sách model. Lỗi được giữ lại để UI hiển thị. */
  async refreshModels(): Promise<void> {
    if (!this.registry) this.rebuild();
    // Vẫn chưa có registry sau rebuild = chưa điền địa chỉ gateway. Không có gì
    // để gọi, và đó không phải lỗi cần ghi log.
    if (!this.registry) {
      this.onChangeEmitter.fire();
      return;
    }
    try {
      await this.registry!.load();
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger.warn('could not fetch the model list', { reason: this.lastError });
    }
    this.onChangeEmitter.fire();
  }

  async status(): Promise<SessionStatus> {
    if (!this.registry) this.rebuild();
    // Chưa cấu hình gateway: trả về trạng thái rỗng thay vì `this.registry!`.
    // ChatController đọc `config.gatewayBaseUrl` từ đây để dựng thông báo đúng
    // việc còn thiếu, nên đường này phải đi tới nơi chứ không được ném.
    if (!this.registry) {
      return {
        config: this.config,
        sourceLabel: 'not configured',
        authenticated: false,
        models: [],
        missingProfiles: 0,
      };
    }
    const registry = this.registry;
    const authState = this.auth ? await this.auth.state() : undefined;
    const authenticated = authState?.authenticated ?? false;

    const models = registry.all();

    // Hai vai, hai câu hỏi. `editor` là model của phần lớn lượt nên nó là thứ
    // status bar và bảng cài đặt hiển thị; `planner` chỉ lộ ra ở lượt có ảnh
    // hoặc lượt chạy trong chế độ plan.
    const activeModel = registry.resolve('editor');
    const activePlanModel = registry.resolve('planner');

    return {
      config: this.config,
      sourceLabel: registry.source.label,
      authenticated,
      ...(authState?.username ? { username: authState.username } : {}),
      ...(authState?.role ? { role: authState.role } : {}),
      ...(authState?.expiresAt ? { expiresAt: authState.expiresAt.getTime() } : {}),
      models,
      ...(activeModel ? { activeModel } : {}),
      ...(activePlanModel ? { activePlanModel } : {}),
      missingProfiles: models.filter((m) => m.profileSource === 'inferred').length,
            ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  // ── Dự án và task đang làm ────────────────────────────────────────────────

  /** Trạng thái để vẽ hai ô chọn. Không gọi mạng. */
  work(): WorkState {
    return this.workState;
  }

  /** Task đang khai, dạng chuỗi cho thuộc tính OTLP `astrawork.task`. */
  taskAttribute(): string | undefined {
    return this.workState.taskId ? String(this.workState.taskId) : undefined;
  }

  /**
   * Đọc dự án/task MỘT lần cho mỗi chuỗi, nếu đã đăng nhập mà chưa đọc lần nào.
   *
   * Vì sao cần: `refreshWork()` chỉ chạy khi có ai gọi nó, và người gọi duy
   * nhất là lúc webview báo `ready`. Lúc ấy khối khởi động vẫn đang dọn thư mục
   * nhà và chưa tới `session.reload()`, nên `this.auth` còn rỗng — lời gọi rơi
   * vào hư không và KHÔNG có gì thử lại. Kết quả là ô "Project" đứng ở
   * "Project…" suốt phiên, còn ô "Task" hiện nhãn lưu từ lần trước nên trông
   * như chỉ mỗi dự án hỏng.
   *
   * Chưa đăng nhập thì KHÔNG đánh dấu đã thử: đăng nhập xong `reload()` dựng
   * lại chuỗi, cờ về `false`, và lần `onDidChange` ngay sau đó đọc được.
   */
  async ensureWork(): Promise<void> {
    if (!this.auth) this.rebuild();
    const auth = this.auth;
    if (!auth || this.workTried) return;

    const state = await auth.state();
    if (!state.authenticated) return;

    await this.refreshWork();
  }

  /**
   * Đọc lại danh sách dự án và task.
   *
   * Im lặng khi chưa đăng nhập: hai ô chọn lúc đó chỉ là hai ô rỗng, và một
   * dòng 401 trong log không nói cho ai điều gì. Lỗi thật thì giữ lại để UI
   * hiện — nuốt nó đi sẽ để người dùng nhìn một danh sách trống mà không hiểu
   * vì sao.
   */
  async refreshWork(): Promise<void> {
    if (this.workLoading) return this.workLoading;

    // Chuỗi chưa dựng (webview `ready` tới trước `reload()`): dựng ngay thay vì
    // bỏ cuộc im lặng. `rebuild()` chỉ đọc cấu hình và secret store, không gọi
    // mạng, nên gọi sớm không tốn gì.
    if (!this.auth) this.rebuild();
    const auth = this.auth;
    if (!auth) return;

    this.workTried = true;

    const state = await auth.state();
    if (!state.authenticated) {
      // Chưa đăng nhập không phải một lần thử đã tiêu: token về là đọc lại được.
      this.workTried = false;
      // Xoá hai DANH SÁCH, giữ lại task đang khai. Task nằm trong workspaceState
      // và sống lâu hơn phiên đăng nhập; quên nó ở đây thì lần đọc sau thấy
      // `taskId === undefined` rồi ghi đè bản lưu — người dùng đăng nhập lại và
      // mất lựa chọn mà không hiểu vì sao.
      const next: WorkState = { projects: [], tasks: [] };
      if (this.workState.taskId !== undefined) next.taskId = this.workState.taskId;
      if (this.workState.taskLabel) next.taskLabel = this.workState.taskLabel;
      this.setWork(next);
      return;
    }

    const client = new WorkItemsClient({
      baseURL: this.config.gatewayBaseUrl,
      getToken: () => auth.requireToken(),
    });

    this.setWork({ ...this.workState, loading: true });
    this.workLoading = (async () => {
      try {
        // Hai lời gọi song song: chúng độc lập, và bảng chọn chỉ dùng được khi
        // đã có cả hai.
        //
        // `username` đi vào `tasks()` để lọc còn việc được giao cho chính người
        // này: gateway trả cả bảng WBS của dự án (cố ý — xem core/work/WorkItems.ts),
        // mà ô chọn ở đây trả lời "tôi đang làm gì", không phải "dự án có gì".
        const [projects, taskList] = await Promise.all([
          client.projects(),
          client.tasks(state.username ?? ''),
        ]);
        const tasks = taskList.items;
        const next: WorkState = { projects, tasks, loading: false };
        if (taskList.otherStages > 0) next.otherStages = taskList.otherStages;
        if (state.projectId !== undefined) next.projectId = state.projectId;

        // Task đã chọn không còn trong danh sách (đã xong, đã đổi công đoạn,
        // hoặc thuộc dự án khác): bỏ khai báo thay vì giữ một id mà gateway sẽ
        // lặng lẽ vứt đi. Người dùng cần biết mình đang không đo gì cả.
        const keep = this.workState.taskId && tasks.some((t) => t.id === this.workState.taskId);
        if (keep) {
          next.taskId = this.workState.taskId!;
          if (this.workState.taskLabel) next.taskLabel = this.workState.taskLabel;
        }
        this.setWork(next);
        if (!keep && this.workState.taskId === undefined) await this.saveWork();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.debug('could not read projects/tasks', { reason });
        this.setWork({ ...this.workState, loading: false, error: reason });
      } finally {
        this.workLoading = undefined;
      }
    })();

    return this.workLoading;
  }

  /**
   * Đổi dự án — tức là đổi TOKEN.
   *
   * Kéo theo ba thứ, và cả ba đều phải xảy ra ở đây chứ không phải rải rác:
   * danh sách task đổi (task thuộc dự án), model có thể đổi (quyền theo vai trò
   * trong dự án), và ingest token của telemetry phải xin lại vì nó gắn với dự
   * án cũ. Task đang khai bị bỏ: một id của dự án A khai ở dự án B sẽ bị
   * gateway vứt đi mà không báo gì.
   */
  async switchProject(projectId: number): Promise<void> {
    const auth = this.auth;
    if (!auth) throw new Error('Not signed in to AstraWork.');

    const client = new WorkItemsClient({
      baseURL: this.config.gatewayBaseUrl,
      getToken: () => auth.requireToken(),
    });
    const token = await client.switchProject(projectId);
    await auth.acceptAccessToken(token);

    this.workState = { ...this.workState, projectId, tasks: [] };
    delete this.workState.taskId;
    delete this.workState.taskLabel;
    await this.saveWork();

    // Model đến từ tài khoản + dự án, nên danh sách cũ có thể đã sai.
    this.autoLoadTried = false;
    await this.refreshWork();
    await this.refreshModels();
    // Chuẩn agent cũng thuộc về dự án: giữ lại bộ của dự án cũ là sai kiểu khó
    // thấy nhất, vì trông vẫn như đang có chuẩn.
    await this.loadProjectAgents();
    this.onChangeEmitter.fire();
  }

  /** Khai task đang làm. `undefined` = thôi khai, số sẽ về rổ chưa gán. */
  async setTask(taskId: number | undefined): Promise<void> {
    if (taskId === undefined) {
      delete this.workState.taskId;
      delete this.workState.taskLabel;
    } else {
      const task = this.workState.tasks.find((t) => t.id === taskId);
      if (!task) return;
      this.workState.taskId = taskId;
      this.workState.taskLabel = task.code ? `${task.code} · ${task.title}` : task.title;
    }
    await this.saveWork();
    this.onChangeEmitter.fire();
  }

  /**
   * Số liệu để mở hộp "Report Done": lịch của task, và số đo đã quy về nó.
   *
   * Hai lời gọi song song, và số đo được phép HỎNG RIÊNG. Lịch đến từ WBS —
   * thiếu nó thì hộp thoại không có gì để hiện. Token/chi phí đến từ board
   * Năng suất, một đường khác, có thể chưa bật hoặc chưa có điểm nào; hỏng ở
   * đó mà chặn cả hộp thoại là để một tính năng phụ khoá mất việc báo done.
   * Người dùng vẫn gõ tay được hai con số.
   *
   * Ngày thực tế trống thì điền HÔM NAY: đó đúng là thứ gateway sẽ tự đóng
   * dấu khi task sang `done`, nên hộp thoại hiện trước điều sắp xảy ra thay vì
   * hai ô trống mà người dùng phải đoán.
   */
  async taskReport(taskId: number): Promise<TaskReport> {
    const client = this.requireWorkItems();
    const today = todayISO();
    const [task, usage] = await Promise.all([
      client.taskDetail(taskId),
      client.taskUsage(taskId).catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.debug('could not read task usage', { taskId, reason });
        return { error: reason };
      }),
    ]);

    const measured = 'error' in usage ? undefined : usage;
    return {
      taskId,
      label: task.code ? `${task.code} · ${task.title}` : task.title,
      planStart: task.planStart,
      planEnd: task.planEnd,
      actualStart: task.actualStart || today,
      actualEnd: task.actualEnd || today,
      tokens: measured?.tokens ?? 0,
      costUsd: measured?.costUsd ?? 0,
      ...('error' in usage ? { usageError: usage.error } : {}),
    };
  }

  /** Gửi báo cáo done lên WBS, rồi đọc lại danh sách vì task vừa đóng sổ. */
  async reportTaskDone(report: TaskDoneReport): Promise<TaskDoneResult> {
    const result = await this.requireWorkItems().reportDone(report);
    // Task đã `done` nên nó rời danh sách "việc còn mở" — `refreshWork` cũng là
    // chỗ bỏ khai báo task đang chọn, nếu không thì lượt chat tiếp theo vẫn quy
    // số đo về một dòng WBS đã đóng.
    await this.refreshWork();
    return result;
  }

  private requireWorkItems(): WorkItemsClient {
    if (!this.auth) this.rebuild();
    const auth = this.auth;
    if (!auth) throw new Error('Not signed in to AstraWork.');
    return new WorkItemsClient({
      baseURL: this.config.gatewayBaseUrl,
      getToken: () => auth.requireToken(),
    });
  }

  private setWork(next: WorkState): void {
    this.workState = next;
    this.onChangeEmitter.fire();
  }

  private async saveWork(): Promise<void> {
    const saved: SavedWork = {};
    if (this.workState.taskId) saved.taskId = this.workState.taskId;
    if (this.workState.taskLabel) saved.taskLabel = this.workState.taskLabel;
    await this.context.workspaceState.update(WORK_STATE_KEY, saved);
  }

  getAuth(): AstraWorkAuth | undefined {
    return this.auth;
  }

  getRegistry(): ModelRegistry | undefined {
    return this.registry;
  }

  getProvider(): GatewayProvider | undefined {
    return this.provider;
  }

  getConfig(): AstraConfig {
    return this.config;
  }
}
