/**
 * Điều phối một lượt chat: dựng AgentLoop, bơm sự kiện ra webview, hủy được.
 *
 * Giữ history trong bộ nhớ ở M3. Lưu và khôi phục phiên là việc của M6 —
 * làm sớm hơn sẽ tạo ra một định dạng file phải migrate trước khi biết cần
 * lưu những gì.
 */
import * as vscode from 'vscode';
import * as os from 'node:os';
import {
  AgentLoop,
  AstraError,
  BackgroundJobs,
  ChangeLedger,
  CheckpointStore,
  Compactor,
  ContextBudget,
  FileHistoryStore,
  HistoryLog,
  PermissionManager,
  SessionStore,
  StateStore,
  TodoStore,
  appendTurn,
  buildSystemPrompt,
  createRegistry,
  createToolContext,
  describeInjectionScan,
  describeJob,
  describeUsage,
  diffLines,
  diffStat,
  turnCostUsd,
  estimateConversationTokens,
  estimateTokens,
  isAbortError,
  loadCommands,
  loadMemory,
  MEMORY_MAX_CHARS,
  loadSkills,
  parseSlashInput,
  renderCommand,
  renderSkillInvocation,
  resolvePins,
  renderPinnedContext,
  StaticContextCache,
  summarizeChanges,
  summarizeToolResult,
  titleFrom,
  type AgentEvent,
  type AskUserFn,
  type AskUserQuestion,
  type AskUserResult,
  type ChatMessage,
  type CodeGraphProvider,
  type Logger,
  type MemoryBundle,
  type ModelRole,
  type PermissionDecision,
  type PersistedToolSummary,
  type PermissionRequest,
  type PersistedSession,
  type PinnedRef,
  type ResolvedPin,
  type Sandbox,
  type SlashCommand,
  describeHook,
  type HookApprovalStore,
  type JobEvent,
  type LoadedHook,
  type Provider,
  type Skill,
  type Tool,
  type ToolProtocol,
  type ToolRegistry,
} from '@astra/core';
import { buildExtras, type Extras } from './Extras.js';
import { reconcileAnswers } from './questionReconcile.js';
import { appendConvention, readOrCreateMemoryFile } from './memoryFile.js';
import { renderRestored } from './restore.js';
import { turnEndReasonForError } from './turnOutcome.js';
import { chooseTurnModel, type ChatModelOption } from './modelChoice.js';
import type { AstraSession } from '../session.js';
import { VsCodeFileSystem } from '../fs/VsCodeFileSystem.js';
import { activeWorkspaceRoot } from '../adapters.js';
import type {
  ChatHostPayload,
  ChatModelInfo,
  CommandWire,
  CompactTrigger,
  ImageWire,
  PermissionModeWire,
  PinnedItemWire,
  QuestionAnswerWire,
  SandboxState,
  SessionPermissionState,
  UsageWire,
} from './protocol.js';

/** Số ký tự tối đa của kết quả tool hiện trên UI. Bản đầy đủ vẫn vào history. */
const PREVIEW_CHARS = 600;
/**
 * Trần ký tự mỗi mẩu output trực tiếp gửi sang webview.
 *
 * Có trần vì một lệnh in ra vài MB (build log, `cat` file nhị phân) sẽ dội
 * hàng nghìn postMessage vào webview và làm treo UI. Model vẫn nhận đủ output
 * qua ToolResult ở cuối — cắt ở đây chỉ cắt phần nhìn.
 */
const OUTPUT_CHUNK_CHARS = 4000;
/** Diff trong hộp duyệt quyền — dài hơn thì người ta không đọc, chỉ bấm bừa. */
const PERMISSION_PREVIEW_CHARS = 4000;

export interface ChatControllerOptions {
  session: AstraSession;
  logger: Logger;
  emit: (payload: ChatHostPayload) => void;
  ledger: ChangeLedger;
  permissions: PermissionManager;
  todos: TodoStore;
  /** Sandbox của phiên, nếu người dùng đã bật. */
  getSandbox: () => Sandbox | undefined;
  /**
   * Tool từ server MCP đang chạy (M7). Đọc lại mỗi lượt chứ không cache: người
   * dùng bật/tắt server giữa chừng là chuyện bình thường, và một tool đã biến
   * mất mà model vẫn thấy trong danh sách sẽ dẫn tới kế hoạch không thực hiện được.
   */
  getMcpTools?: () => Tool[];
  /** CodeGraph theo workspace (M12). Không truyền = không có find_references/impact_of. */
  getCodeGraph?: (root: string) => CodeGraphProvider;
  // ── M6 ────────────────────────────────────────────────────────────────────
  /** Kho phiên. Không truyền = không lưu gì (test). */
  sessions?: SessionStore;
  /** Ảnh chụp trước mỗi lượt, cho `/undo`. */
  checkpoints?: CheckpointStore;
  /**
   * Ảnh chụp đó xuống đĩa (`~/.astra/file-history/`).
   *
   * Không truyền = `/undo` chỉ sống trong cửa sổ này, đúng như trước 0.0.19.
   */
  fileHistory?: FileHistoryStore;
  /** Lịch sử prompt dùng chung với CLI. Không truyền = không ghi gì. */
  promptLog?: HistoryLog;
  /** Sổ trạng thái ở `~/.astra/state.json`. Không truyền = không ghi gì. */
  state?: StateStore;
  /** Ghi các thao tác hoàn tác ra đĩa. Không có thì `/undo` báo không làm được. */
  applyRevert?: (ops: Array<{ uri: string; content: string | null }>) => Promise<{
    reverted: number;
    failed: string[];
  }>;
  /** Tự nén khi ngữ cảnh gần đầy. Mặc định bật. */
  autoCompact?: () => boolean;
  /** Nạp command từ `.astra/commands` của repo. Mặc định theo workspace trust. */
  allowProjectCommands?: () => boolean;
  /**
   * Lệnh chạy sau mỗi lượt có sửa file, và có nên cảnh báo rằng bản trong repo
   * đã bị bỏ qua không. Xem `inspectVerifyCommand` trong config.ts.
   */
  verifyCommand?: () => { command: string; ignoredFromWorkspace: boolean };
  // ── M8 ────────────────────────────────────────────────────────────────────
  /** Nơi nhớ hook nào đã được duyệt. Không truyền = không hook nào chạy. */
  hookApprovals?: HookApprovalStore;
  /**
   * Nhớ model nào đã bị phát hiện không gọi được tool native.
   *
   * Phải BỀN qua lần khởi động sau, không chỉ trong phiên: nếu quên, mỗi lần
   * mở VS Code lại tốn một request hỏng để học lại đúng điều vừa học. Không
   * truyền = chỉ nhớ trong bộ nhớ tiến trình (test).
   */
  nativeUnsupported?: {
    has: (modelId: string) => boolean;
    add: (modelId: string) => void;
  };
  // ── M10 ───────────────────────────────────────────────────────────────────
  /**
   * Sổ mức dùng sống qua nhiều phiên (`UsageSync`).
   *
   * Chỉ nhận BỘ ĐẾM: số token và tên model. Không prompt, không nội dung file,
   * không đường dẫn — xem documents/SECURITY.md §9.2. Không truyền = không đếm gì cả,
   * và đó là trạng thái hợp lệ (test, hoặc bản không bật telemetry).
   */
  recordUsage?: (sample: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    model?: string;
    /** Chi phí lượt, USD. Tính từ giá gateway công bố — xem `turnCostUsd`. */
    costUsd?: number;
    /** Dòng agent thêm/xoá trong lượt — xem `linesChangedIn`. */
    linesAdded?: number;
    linesRemoved?: number;
  }) => void;
}

/**
 * Lệnh dựng sẵn. Nằm ở đây chứ không trong `.astra/commands` vì chúng thao tác
 * lên chính phiên chat — không có prompt nào diễn tả được "hoàn tác lượt vừa
 * rồi".
 */
const BUILTIN_COMMANDS: CommandWire[] = [
  { name: 'undo', description: 'Revert the files the agent changed in the last turn', source: 'builtin' },
  {
    name: 'compact',
    description: 'Compact the conversation now — add a note to say what to keep in detail',
    source: 'builtin',
  },
  { name: 'clear', description: 'Clear the conversation and start a new session', source: 'builtin' },
  { name: 'sessions', description: 'List past sessions to reopen', source: 'builtin' },
  {
    name: 'memory',
    description: 'Save a project rule to ASTRA.md, or open the file to edit it',
    source: 'builtin',
  },
  { name: 'help', description: 'List the available commands', source: 'builtin' },
  {
    name: 'create-skill',
    description: 'Scaffold a new skill in .astra/skills/',
    source: 'builtin',
  },
  {
    name: 'create-agent',
    description: 'Scaffold a new sub-agent in .astra/agents/',
    source: 'builtin',
  },
];

/**
 * Nơi lưu duyệt hook mặc định khi extension không truyền cái nào: KHÔNG duyệt
 * gì cả. Một hook chưa duyệt thì không chạy, nên đây là trạng thái "không có
 * hook nào hoạt động" chứ không phải "mọi hook đều chạy".
 */
const DENY_ALL_APPROVALS: HookApprovalStore = {
  isApproved: () => false,
  approve: async () => {
    /* không lưu được thì lần sau vẫn hỏi lại */
  },
};

/**
 * Một hộp duyệt quyền đang chờ người dùng bấm.
 *
 * `resolve` là câu trả lời thật của người dùng; `cancel` là đường thoát khi
 * KHÔNG còn ai trả lời được (webview đóng, người dùng bấm Dừng) và luôn chốt
 * 'deny'. Hai thứ này loại trừ nhau — gọi `cancel` trên một hộp người dùng vừa
 * bấm Cho phép sẽ nuốt mất câu trả lời đó.
 */
interface PendingPermission {
  resolve: (decision: PermissionDecision) => void;
  cancel: vscode.Disposable;
}

/**
 * Một hộp ask_user_question đang chờ người dùng bấm.
 *
 * Giữ nguyên `questions` gốc (không chỉ id) vì `answerQuestion` phải đối
 * chiếu nhãn webview gửi lên với đúng lựa chọn đã đưa ra — không tin thẳng
 * những gì webview echo lại, xem `answerQuestion`.
 */
interface PendingQuestion {
  questions: AskUserQuestion[];
  resolve: (result: AskUserResult) => void;
  cancel: vscode.Disposable;
}

/**
 * Token của phần KHÔNG PHẢI `this.history` nhưng vẫn gửi kèm mỗi request —
 * xem `computeContextBreakdown`. `messages` (history) không nằm ở đây: nó đổi
 * mỗi lượt và luôn đo lại tươi từ `this.history`, trong khi năm mục dưới đây
 * chỉ đổi khi model/skill/memory/tool đổi.
 */
interface ContextBreakdown {
  contextWindow: number;
  systemPromptTokens: number;
  systemToolTokens: number;
  mcpToolTokens: number;
  memoryTokens: number;
  skillTokens: number;
}

export class ChatController implements vscode.Disposable {
  private history: ChatMessage[] = [];
  /**
   * Model người dùng chọn ở thanh soạn, cho PHIÊN chat đang mở.
   *
   * Sống ở host chứ không ở webview: webview bị nạp lại (đổi tab, watchdog ở
   * `chatView.ts`) mà lựa chọn thì không được mất theo. KHÔNG ghi vào settings —
   * đó là điểm khác biệt với ô model trong bảng cài đặt, và là điều đã chọn:
   * đổi model để thử một câu hỏi không nên đổi cấu hình của cả máy.
   *
   * Xoá khi mở hội thoại mới (xem `clear`).
   */
  private modelOverride: string | undefined;
  private abort: AbortController | undefined;
  private turnCounter = 0;
  /** Bản chuẩn dự án mà ô gợi ý `/` đang dựng theo. Xem `refreshCommandsIfStale`. */
  private slashStandardVersion = -1;
  private permissionSeq = 0;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private questionSeq = 0;
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly disposables: vscode.Disposable[] = [];
  // ── M6 ────────────────────────────────────────────────────────────────────
  private persisted: PersistedSession | undefined;
  private commands: SlashCommand[] = [];
  private memory: MemoryBundle | undefined;
  /**
   * Tóm tắt tool dạng người dùng đọc, khoá theo `ToolCall.id`.
   *
   * Sống ở đây chứ không trong `this.persisted` vì tool chạy xong trước khi lượt
   * được ghi: `recordTurn` chạy ở cuối lượt, còn `tool_end` nổ ở giữa. Đổ vào
   * phiên lúc ghi, và dọn theo `messages` để nén ngữ cảnh không để lại rác.
   */
  private toolSummaries = new Map<string, PersistedToolSummary>();
  /** Số lần đã nén trong phiên — hiện ở cuối lượt để người dùng biết đã mất chi tiết. */
  private compactions = 0;
  /**
   * File/đoạn dòng đang chờ ghim vào LƯỢT KẾ TIẾP (tính năng pin).
   *
   * Một-lần-mỗi-lượt, giống hệt ảnh đính kèm: `send()` chụp lại danh sách này
   * cho câu hỏi đang gửi rồi xoá trắng ngay (xem `pinsForTurn` trong `send()`)
   * — không còn dính sang các câu hỏi sau như bản trước đây. `/clear` và mở
   * lại một phiên cũ vẫn xoá luôn phòng khi người dùng ghim rồi không gửi,
   * cùng lý do quyền đã cấp bị xoá theo ở `clear()`.
   *
   * `id` chỉ có ý nghĩa trong phiên VS Code đang chạy — không lưu xuống
   * `PersistedSession`.
   */
  private pins: Array<PinnedRef & { id: string }> = [];
  private pinSeq = 0;
  /**
   * Lịch sử undo của phiên này đến từ đĩa chứ không từ cửa sổ đang mở.
   *
   * Bật khi mở lại một phiên cũ, tắt sau lần `/undo` đầu tiên đã được xác nhận.
   * Xem `confirmUndoAfterResume`.
   */
  private undoNeedsConfirm = false;
  // ── M8 ────────────────────────────────────────────────────────────────────
  /** Skill/agent/hook của lượt gần nhất — dựng lại mỗi lượt, xem Extras.ts. */
  private extras: Extras | undefined;
  /**
   * Token của mọi thứ gửi kèm history mỗi request — dựng lại mỗi lượt cùng
   * lúc với `systemPrompt`/registry trong `send()` (xem `computeContextBreakdown`).
   * Dùng cho mục "Context" ở bảng cài đặt VÀ đồng hồ ngữ cảnh của khung chat —
   * cả hai đọc từ đây để không có hai con số khác nhau cho cùng một hội thoại.
   */
  private lastContextBreakdown: ContextBreakdown | undefined;
  /** `cachedTokens` của lượt chat gần nhất — xem `usage()`. */
  private lastCachedTokens: number | undefined;
  /**
   * Cache ngữ cảnh tĩnh riêng của AstraCode — không phụ thuộc gateway, xem
   * `StaticContextCache` (`@astra/core`). Sống theo phiên chat, reset khi mở
   * phiên mới cùng với `history`.
   */
  private readonly staticContextCache = new StaticContextCache();
  /** Token trùng khớp lượt trước do `staticContextCache` nhận ra — xem `usage()`. */
  private lastAstraCachedTokens: number | undefined;
  /**
   * Skill đã nạp, giữ riêng khỏi `extras` vì ô gợi ý `/` cần chúng TRƯỚC lượt
   * đầu tiên — `extras` chỉ tồn tại sau khi đã có model và provider.
   */
  private skills: Skill[] = [];
  /**
   * Tác vụ nền của phiên.
   *
   * Sống ở controller chứ không ở lượt: một lệnh bật ở lượt này phải hỏi được
   * kết quả ở lượt sau — đó là toàn bộ lý do có nó. Chết theo `clear()` và
   * `dispose()`, nên không có tiến trình nào sống lâu hơn hội thoại đã sinh ra
   * nó.
   */
  private readonly jobs: BackgroundJobs;

  constructor(private readonly opts: ChatControllerOptions) {
    // Manager ra đời trước controller (status bar cần nó ngay lúc bật
    // extension), nên kênh hỏi được gắn vào đây chứ không truyền qua hàm dựng.
    opts.permissions.setAsker(this.askPermission);
    this.jobs = new BackgroundJobs(opts.logger);

    this.disposables.push(
      new vscode.Disposable(this.jobs.onEvent((event) => this.announceJob(event))),
      new vscode.Disposable(
        opts.permissions.onChange(() => {
          this.opts.emit({ type: 'permission_state', state: this.permissionState() });
        }),
      ),
      new vscode.Disposable(
        opts.todos.onChange((items) => this.opts.emit({ type: 'todos', items })),
      ),
      new vscode.Disposable(
        opts.ledger.onChange((changes) =>
          this.opts.emit({
            type: 'changes',
            pending: changes.filter((c) => !c.approved).length,
            summary: summarizeChanges(changes),
          }),
        ),
      ),
    );
  }

  dispose(): void {
    this.abort?.abort();
    this.rejectAllPending();
    // Không `await`: `dispose()` của VS Code là đồng bộ. Việc giết đã được phát
    // đi ngay trong lời gọi, phần chờ chỉ để tiến trình kịp chết hẳn.
    void this.jobs.dispose();
    for (const d of this.disposables) d.dispose();
  }

  get busy(): boolean {
    return this.abort !== undefined;
  }

  clear(): void {
    this.abort?.abort();
    this.history = [];
    // Lựa chọn model thuộc về hội thoại vừa xoá, cùng lý do với quyền đã cấp và
    // pin ở dưới: nó được chọn cho một câu hỏi cụ thể mà người dùng không còn
    // nhìn thấy nữa.
    this.modelOverride = undefined;
    this.opts.todos.clear();
    // Tác vụ nền thuộc về hội thoại vừa xoá: id của chúng chỉ tồn tại trong
    // những lượt không còn ai nhìn thấy. Để chúng chạy tiếp là để lại tiến
    // trình mà không ai — kể cả agent — còn cách nào hỏi tới hay dừng lại.
    void this.jobs.killAll();
    // Quyền đã cấp thuộc về ngữ cảnh của hội thoại vừa xoá. Giữ lại chúng cho
    // hội thoại mới là cho phép dựa trên thứ người dùng không còn thấy nữa.
    this.opts.permissions.reset();
    // Phiên mới = lịch sử undo mới. Checkpoint của hội thoại đã xoá trỏ tới
    // những lượt người dùng không còn nhìn thấy, nên không hoàn tác được nữa.
    this.opts.checkpoints?.clear();
    this.persisted = undefined;
    this.compactions = 0;
    this.turnCounter = 0;
    this.toolSummaries.clear();
    // Pin trỏ tới ngữ cảnh của hội thoại vừa xoá — giữ lại cho hội thoại mới
    // cũng sai theo cách giống hệt lý do bỏ quyền đã cấp ở trên.
    this.pins = [];
    this.opts.emit({ type: 'cleared' });
    this.emitContext();
    void this.emitPins();
  }

  // ── Phiên (M6) ───────────────────────────────────────────────────────────

  /**
   * Danh sách phiên cũ của workspace hiện tại.
   *
   * `open` = người dùng vừa yêu cầu XEM danh sách. Gọi để làm mới dữ liệu thì
   * để nguyên mặc định — xem chú thích của payload `sessions`.
   */
  async listSessions(open = false): Promise<void> {
    const store = this.opts.sessions;
    if (!store) return;

    const root = activeWorkspaceRoot()?.uri.fsPath ?? '';
    const items = await store.list(root);
    this.opts.emit({
      type: 'sessions',
      ...(open ? { open } : {}),
      items: items.map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        turns: s.turns,
        totalTokens: s.totalTokens,
        active: s.id === this.persisted?.id,
      })),
    });
  }

  /**
   * Mở lại một phiên cũ.
   *
   * Từ 0.0.19 lịch sử undo ĐƯỢC nạp lại từ `~/.astra/file-history/`. Nhưng lo
   * ngại cũ vẫn đúng nguyên vẹn: file trên đĩa đã đi tiếp từ lúc đó (người dùng
   * sửa tay, đổi nhánh, chạy build), nên hoàn tác về một bản chụp của tuần
   * trước có thể xoá mất việc làm sau đó.
   *
   * Lời giải không phải là vứt bản chụp đi, mà là HỎI: lần `/undo` đầu tiên
   * trong một phiên vừa mở lại phải được người dùng xác nhận. Xem `undoLastTurn`.
   */
  async resumeSession(id: string): Promise<boolean> {
    const store = this.opts.sessions;
    if (!store) return false;

    // Bảng đã đóng lúc người dùng bấm, nên im lặng ở đây nghĩa là họ nhìn vào
    // một hội thoại KHÔNG phải cái vừa chọn mà không có lời giải thích nào.
    if (this.busy) {
      this.opts.emit({
        type: 'error',
        message: 'A turn is running — press Stop before opening another conversation.',
      });
      return false;
    }

    const loaded = await store.load(id);
    if (!loaded) {
      this.opts.emit({
        type: 'error',
        message: 'Could not reopen this session — its file is damaged or from an older build.',
      });
      return false;
    }

    this.history = loaded.messages;
    this.persisted = loaded;
    this.compactions = loaded.compactions;
    // Nạp lại tóm tắt đã lưu vào map đang chạy: lượt tiếp theo ghi đè cả phiên,
    // nên không nạp lại thì hỏi thêm một câu là xoá sạch tóm tắt của phần trước.
    this.toolSummaries = new Map(Object.entries(loaded.toolSummaries ?? {}));
    this.turnCounter = loaded.turns.length;
    this.opts.todos.clear();
    this.opts.permissions.reset();
    this.opts.checkpoints?.clear();
    // Pin thuộc về hội thoại vừa rời đi, không được lưu trong PersistedSession
    // — mở một phiên khác thì bắt đầu với danh sách pin trống, như `/clear`.
    this.pins = [];
    void this.emitPins();

    const checkpoints = this.opts.checkpoints;
    if (checkpoints && this.opts.fileHistory) {
      const saved = await this.opts.fileHistory.load(loaded.id);
      if (saved.length > 0) {
        checkpoints.hydrate(saved);
        this.undoNeedsConfirm = true;
      }
    }

    this.opts.emit({
      type: 'restored',
      title: loaded.title,
      messages: renderRestored(
        loaded.messages,
        this.knownToolNames(),
        loaded.toolSummaries ?? {},
      ),
    });
    this.emitContext();
    await this.listSessions();
    return true;
  }

  /**
   * Đẩy lịch sử prompt sang webview.
   *
   * Gửi một lần lúc webview sẵn sàng chứ không hỏi lại mỗi lần bấm mũi tên: đó
   * là một mảng chuỗi ngắn, và một vòng đi-về qua postMessage cho mỗi lần bấm
   * phím sẽ thấy được bằng mắt.
   */
  async pushPromptHistory(): Promise<void> {
    const log = this.opts.promptLog;
    if (!log) return;
    const root = activeWorkspaceRoot()?.uri.fsPath ?? '';
    const items = await log.recent(200, root);
    if (items.length === 0) return;
    this.opts.emit({ type: 'promptHistory', items: items.map((e) => e.display).reverse() });
  }

  /** Hoàn tác lượt gần nhất. Trả về false nếu không có gì để hoàn tác. */
  async undoLastTurn(): Promise<boolean> {
    const checkpoints = this.opts.checkpoints;
    const applyRevert = this.opts.applyRevert;

    if (!checkpoints || !applyRevert) {
      this.opts.emit({ type: 'error', message: 'This session cannot track file changes.' });
      return false;
    }
    if (this.busy) {
      this.opts.emit({ type: 'error', message: 'A turn is running — press Stop before undoing.' });
      return false;
    }

    const turnId = checkpoints.lastTurnId();
    if (!turnId) {
      this.opts.emit({
        type: 'error',
        message: 'No turn in this session changed a file, so there is nothing to undo.',
      });
      return false;
    }

    if (!(await this.confirmUndoAfterResume())) return false;

    const skippedBefore = checkpoints.skippedFiles();
    const { ops, removedTurnIds } = checkpoints.restoreWithTurns(turnId);
    const { reverted, failed } = await applyRevert(ops);

    // Xoá luôn trên đĩa. Không xoá thì lần mở lại phiên sau sẽ hồi sinh đúng
    // lượt mà người dùng vừa hoàn tác.
    const sessionId = this.persisted?.id;
    if (sessionId) await this.opts.fileHistory?.removeTurns(sessionId, removedTurnIds);

    // Sổ thay đổi phải khớp với đĩa NGAY SAU khi ghi, không phải sau đó: badge
    // trong Explorer nói về trạng thái file, và nói sai còn tệ hơn không nói.
    this.opts.ledger.applyUndo(ops);
    this.dropTurnFromHistory(turnId);

    if (failed.length > 0) {
      this.opts.emit({
        type: 'error',
        message: `Reverted ${reverted}/${ops.length} file(s). ${failed[0]} failed.`,
      });
    }

    this.opts.emit({ type: 'undone', turnId, files: reverted, skipped: skippedBefore });
    this.emitContext();
    await this.persist();
    return true;
  }

  /**
   * Gỡ một lượt khỏi lịch sử hội thoại.
   *
   * Cắt từ message `user` thứ N tính từ cuối cho tới hết. Cắt lẻ tẻ sẽ để lại
   * message `tool` mồ côi và API sẽ từ chối cả request sau đó.
   */
  private dropTurnFromHistory(turnId: string): void {
    const index = this.persisted?.turns.findIndex((t) => t.id === turnId) ?? -1;
    const userIndices = this.history
      .map((m, i) => (m.role === 'user' ? i : -1))
      .filter((i) => i >= 0);

    // Không tra được thứ tự lượt thì bỏ lượt cuối — đó cũng là thứ `/undo` hứa.
    const cutAt = index >= 0 ? userIndices[index] : userIndices.at(-1);
    if (cutAt !== undefined) this.history = this.history.slice(0, cutAt);

    if (this.persisted) {
      this.persisted.turns = index >= 0 ? this.persisted.turns.slice(0, index) : this.persisted.turns.slice(0, -1);
      this.persisted.messages = this.history;
    }
  }

  // ── Pin file/dòng vào chat ───────────────────────────────────────────────

  /**
   * Ghim một file hoặc một đoạn dòng vào hội thoại đang mở.
   *
   * Nguồn DUY NHẤT là lệnh "AstraCode: Add to Chat" (editor context menu) —
   * KHÔNG có message webview nào tạo pin: webview không tự đọc được đĩa, và
   * việc đọc phải đi qua đúng pathGuard/denylist mà `resolvePins` dùng lại từ
   * `read_file`, không có đường tắt riêng bỏ qua hai lớp chắn đó.
   */
  async addPin(ref: PinnedRef): Promise<void> {
    this.pins.push({ ...ref, id: `pin${++this.pinSeq}` });
    await this.emitPins();
  }

  /** Bỏ một pin — webview gửi lại đúng id đã nhận trong payload `pins` gần nhất. */
  async removePin(id: string): Promise<void> {
    this.pins = this.pins.filter((p) => p.id !== id);
    await this.emitPins();
  }

  /**
   * Đọc lại TỪ ĐĨA toàn bộ pin đang chờ (chưa gửi) rồi phát danh sách cho
   * webview vẽ chip trong composer.
   *
   * Đọc lại mỗi lần thay vì cache: file có thể đã đổi hoặc bị xoá từ lúc ghim,
   * và chip phải phản ánh đúng lần đọc gần nhất — không phải lúc người dùng
   * bấm ghim. `send()` KHÔNG gọi lại hàm này nữa: pin một-lần-mỗi-lượt nên
   * composer đã được xoá (và phát rỗng) ngay khi lượt bắt đầu; phần đọc file
   * để build prompt cho model là một lượt `resolvePins` riêng, không qua đây.
   */
  async emitPins(): Promise<void> {
    if (this.pins.length === 0) {
      this.opts.emit({ type: 'pins', items: [] });
      return;
    }

    const root = activeWorkspaceRoot()?.uri.fsPath;
    if (!root) {
      this.opts.emit({
        type: 'pins',
        items: this.pins.map((p) => ({
          id: p.id,
          path: p.path,
          name: baseName(p.path),
          ...(p.startLine !== undefined ? { startLine: p.startLine } : {}),
          ...(p.endLine !== undefined ? { endLine: p.endLine } : {}),
          error: 'No workspace is open.',
        })),
      });
      return;
    }

    const toolContext = createToolContext({
      workspaceRoot: root,
      logger: this.opts.logger,
      fs: new VsCodeFileSystem(),
      ...(await this.readAstraignore(root)),
    });
    const resolved = await resolvePins(this.pins, toolContext);
    this.opts.emit({
      type: 'pins',
      items: resolved.map((r, i) => this.toPinnedItemWire(this.pins[i]!.id, r)),
    });
  }

  private toPinnedItemWire(id: string, r: ResolvedPin): PinnedItemWire {
    return {
      id,
      path: r.path,
      name: baseName(r.path),
      ...(r.startLine !== undefined ? { startLine: r.startLine } : {}),
      ...(r.endLine !== undefined ? { endLine: r.endLine } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(r.truncated ? { truncated: true } : {}),
    };
  }

  stop(): void {
    this.abort?.abort();
    this.rejectAllPending();
  }

  setMode(mode: PermissionModeWire): void {
    this.opts.permissions.setMode(mode);
  }

  /** Webview trả lời hộp duyệt quyền. */
  answerPermission(id: string, decision: PermissionDecision): void {
    const pending = this.pendingPermissions.get(id);
    if (!pending) return;
    this.pendingPermissions.delete(id);
    // Chốt quyết định của người dùng TRƯỚC. `pending.cancel` là đường thoát
    // "hết cách hỏi → deny"; chạy nó ở đây sẽ khoá promise ở 'deny' và câu trả
    // lời thật phía dưới thành no-op — bấm Cho phép vẫn ra bị từ chối.
    this.opts.emit({ type: 'permission_resolved', id, decision });
    pending.resolve(decision);
  }

  /**
   * Hỏi người dùng qua webview và CHỜ. Hai đường thoát bắt buộc, vì không có
   * chúng thì một lượt chat có thể treo vĩnh viễn:
   *   - người dùng bấm Dừng  → abort signal
   *   - webview đóng/reload  → dispose
   * Cả hai đều trả 'deny', không phải 'allow': hết đường hỏi thì mặc định là
   * không được phép.
   */
  private askPermission = async (req: PermissionRequest): Promise<PermissionDecision> => {
    const id = `p${++this.permissionSeq}`;
    const turnId = `t${this.turnCounter}`;

    return new Promise<PermissionDecision>((resolve) => {
      const signal = this.abort?.signal;
      let settled = false;

      const finish = (decision: PermissionDecision): void => {
        if (settled) return;
        settled = true;
        this.pendingPermissions.delete(id);
        signal?.removeEventListener('abort', onAbort);
        resolve(decision);
      };

      const onAbort = (): void => finish('deny');
      signal?.addEventListener('abort', onAbort, { once: true });

      this.pendingPermissions.set(id, {
        resolve: finish,
        cancel: new vscode.Disposable(() => finish('deny')),
      });

      this.opts.emit({
        type: 'permission_request',
        turnId,
        prompt: {
          id,
          tool: req.tool,
          summary: req.summary,
          mode: req.mode,
          // Cảnh báo cũng khoá nút "luôn cho phép": core từ chối nhớ quyết định
          // cho thao tác có cảnh báo, nên hiện nút ở đây là hứa suông.
          alwaysAsk: req.tool === 'bash' || (req.warnings?.length ?? 0) > 0,
          ...(req.warnings?.length ? { warnings: req.warnings } : {}),
          ...(req.path ? { path: req.path } : {}),
          ...(req.preview
            ? { preview: req.preview.slice(0, PERMISSION_PREVIEW_CHARS) }
            : {}),
          ...(req.previewKind ? { previewKind: req.previewKind } : {}),
          ...(req.downgradeReason ? { downgradeReason: req.downgradeReason } : {}),
        },
      });
    });
  };

  /**
   * Webview trả lời hộp ask_user_question.
   *
   * Việc đối chiếu (lọc nhãn lạ, kiểm số câu hỏi khớp) nằm ở `reconcileAnswers`
   * — tách riêng khỏi file này vì file này import `vscode`, không mock được
   * trong test của repo; xem `questionReconcile.test.ts`.
   */
  answerQuestion(id: string, selections: string[][]): void {
    const pending = this.pendingQuestions.get(id);
    if (!pending) return;

    const answers = reconcileAnswers(pending.questions, selections);
    // Lệch số câu hỏi: `cancel.dispose()` đi qua đúng `finish` bên dưới nên
    // webview vẫn được báo `question_resolved`, không bị bỏ mặc với hộp còn
    // nút bấm sống.
    if (!answers) {
      pending.cancel.dispose();
      return;
    }

    pending.resolve({ cancelled: false, answers });
  }

  /**
   * Hỏi người dùng qua webview và CHỜ — cùng khuôn với `askPermission`. Hai
   * đường thoát bắt buộc, vì không có chúng thì một lượt chat có thể treo
   * vĩnh viễn: người dùng bấm Dừng → abort signal; webview đóng/reload →
   * dispose. Cả hai đều trả `cancelled: true` — khác `askPermission`, ở đây
   * không có "mặc định an toàn" nào để chốt thay (không phải 'deny', không
   * phải một lựa chọn), nên tool phải tự nói rõ KHÔNG có câu trả lời.
   */
  private askUser: AskUserFn = async (questions) => {
    const id = `q${++this.questionSeq}`;
    const turnId = `t${this.turnCounter}`;

    return new Promise<AskUserResult>((resolve) => {
      const signal = this.abort?.signal;
      let settled = false;

      // MỌI đường chốt (trả lời thật, Dừng, đóng panel, lệch số câu hỏi) đi
      // qua đây — kể cả webview phải luôn nhận được `question_resolved` để gỡ
      // hộp đang chờ và mở khoá lại ô nhập. Từng có lỗi: chỉ đường trả lời thật
      // mới emit, nên bấm Dừng để lại hộp còn nút bấm sống và ô nhập khoá vĩnh
      // viễn tới khi `/clear`.
      const finish = (result: AskUserResult): void => {
        if (settled) return;
        settled = true;
        this.pendingQuestions.delete(id);
        signal?.removeEventListener('abort', onAbort);
        this.opts.emit({
          type: 'question_resolved',
          id,
          cancelled: result.cancelled,
          ...(result.cancelled
            ? {}
            : {
                answers: result.answers.map(
                  (a): QuestionAnswerWire => ({ header: a.header, selected: a.selected }),
                ),
              }),
        });
        resolve(result);
      };

      const onAbort = (): void => finish({ cancelled: true });
      signal?.addEventListener('abort', onAbort, { once: true });

      this.pendingQuestions.set(id, {
        questions,
        resolve: finish,
        cancel: new vscode.Disposable(() => finish({ cancelled: true })),
      });

      this.opts.emit({
        type: 'question_request',
        turnId,
        prompt: {
          id,
          questions: questions.map((q) => ({
            header: q.header,
            question: q.question,
            options: q.options,
            ...(q.multiSelect ? { multiSelect: true } : {}),
          })),
        },
      });
    });
  };

  private rejectAllPending(): void {
    for (const [, pending] of [...this.pendingPermissions]) pending.cancel.dispose();
    this.pendingPermissions.clear();
    for (const [, pending] of [...this.pendingQuestions]) pending.cancel.dispose();
    this.pendingQuestions.clear();
  }

  private permissionState(): SessionPermissionState {
    const s = this.opts.permissions.getState();
    return {
      mode: s.mode,
      effectiveMode: s.effectiveMode,
      downgraded: s.downgraded,
      ...(s.downgradeReason ? { downgradeReason: s.downgradeReason } : {}),
    };
  }

  private sandboxState(): SandboxState {
    const sandbox = this.opts.getSandbox();
    if (!sandbox) return { kind: 'none', label: 'Cannot run commands', isolated: false };
    const info = sandbox.info();
    return { kind: info.kind, label: info.label, isolated: info.isolated };
  }

  /**
   * Vai model cho lượt này — tức là lượt này thuộc loại việc nào.
   *
   * Hai tín hiệu, và cả hai đều là thứ người dùng CỐ Ý làm chứ không phải thứ
   * đoán từ câu chữ: đính ảnh vào lượt, và bật chế độ plan. Đoán "câu này nghe
   * như lập kế hoạch" sẽ khiến cùng một câu hỏi chạy bằng hai model khác nhau
   * tuỳ cách gõ, và không ai giải thích được vì sao.
   */
  private roleForTurn(imageCount: number): ModelRole {
    if (imageCount > 0) return 'vision';
    if (this.opts.permissions.effectiveMode() === 'plan') return 'planner';
    return 'editor';
  }

  /**
   * Trạng thái để webview biết có gửi được không, và vì sao nếu không.
   *
   * `role` quyết định model nào được soi ở đây — cửa sổ ngữ cảnh, đường
   * tool-calling và quyền ghi đều là thuộc tính của MODEL, nên hỏi trạng thái
   * cho một model rồi chạy lượt bằng model khác là cách nén nhầm ngưỡng và
   * chọn nhầm giao thức. Không truyền vai = hỏi cho lượt sửa code, là thứ
   * webview vẽ khi chưa có lượt nào đang chạy.
   */
  async describeReadiness(
    role: ModelRole = 'editor',
  ): Promise<ChatHostPayload & { type: 'ready' }> {
    const status = await this.opts.session.status();
    const registry = this.opts.session.getRegistry();
    // Vai plan/vision chưa giải được (model ấy không được cấp) thì rơi về model
    // sửa code — chậm và đắt hơn vẫn hơn là chặn cả lượt.
    const roleModel =
      role === 'editor' ? status.activeModel : (status.activePlanModel ?? status.activeModel);

    // Lựa chọn ở thanh soạn thắng cấu hình theo vai, cho MỌI vai — xem
    // `chat/modelChoice.ts`. Danh sách model đi kèm payload để bảng chọn và
    // dòng trạng thái không bao giờ nói hai chuyện khác nhau.
    const options = this.modelOptions();
    const choice = chooseTurnModel({
      override: this.modelOverride,
      roleModel,
      models: options,
    });
    const modelId = choice.id;

    // Model đã chọn không còn dùng được: nói ra một lần rồi gỡ lựa chọn, thay vì
    // âm thầm chạy bằng model khác ở mọi lượt sau.
    if (choice.reason === 'override-unavailable') {
      this.modelOverride = undefined;
      if (choice.notice) {
        this.opts.emit({ type: 'notice', level: 'warn', text: choice.notice });
      }
    }

    const env = {
      permissions: this.permissionState(),
      sandbox: this.sandboxState(),
      models: options,
      ...(roleModel ? { modelDefault: roleModel } : {}),
      ...(this.modelOverride ? { modelOverride: this.modelOverride } : {}),
    };

    if (!vscode.workspace.workspaceFolders?.length) {
      return {
        type: 'ready',
        ...env,
        canChat: false,
        blockKind: 'workspace',
        blockReason: 'No folder is open. AstraCode needs a workspace to read code from.',
      };
    }
    // Cổng "chưa có địa chỉ gateway" đã bị gỡ cùng với ô cấu hình sinh ra nó.
    // Địa chỉ giờ là hằng số trong bundle, nên trạng thái ấy không tồn tại
    // được nữa — và một cổng chặn không bao giờ đóng chỉ khiến người đọc tin
    // rằng có một ô cấu hình nào đó cần điền.
    if (!status.authenticated) {
      return {
        type: 'ready',
        ...env,
        canChat: false,
        blockKind: 'auth',
        blockReason: 'Not signed in to AstraWork.',
      };
    }
    if (!modelId) {
      return {
        type: 'ready',
        ...env,
        canChat: false,
        blockKind: 'model',
        blockReason: status.lastError ?? `No model could be picked for the ${role} role.`,
      };
    }

    const profile = registry?.all().find((m) => m.id === modelId);
    const model: ChatModelInfo = {
      id: modelId,
      toolCalling: profile?.toolCalling ?? 'none',
      profileSource: profile?.profileSource ?? 'inferred',
      contextWindow: profile?.contextWindow ?? 0,
      ...(profile?.compactAt !== undefined ? { compactAt: profile.compactAt } : {}),
      ...(profile?.warnAt !== undefined ? { warnAt: profile.warnAt } : {}),
      vision: profile?.vision ?? false,
    };

    // Chỉ chặn khi đã đo và kết luận model không gọi được công cụ.
        // Chưa đo thì vẫn chat được qua đường XML — nó chỉ cần model làm theo
        // hướng dẫn trong prompt, không cần năng lực function calling nào.
        if (model.toolCalling === 'none' && model.profileSource === 'measured') {
          return {
            type: 'ready',
            ...env,
            model,
            canChat: false,
            blockKind: 'capability',
            blockReason:
              `${modelId} was measured and cannot call tools at all, not even over XML. ` +
              `Pick another model in settings.`,
          };
        }

    return { type: 'ready', ...env, model, canChat: true };
  }

  /** Danh sách cho bảng chọn model ở thanh soạn. */
  private modelOptions(): ChatModelOption[] {
    const registry = this.opts.session.getRegistry();
    if (!registry) return [];
    return registry.all().map((m) => ({
      id: m.id,
      label: m.label,
      available: m.available,
      contextWindow: m.contextWindow,
      toolCalling: m.toolCalling === 'native' ? 'native' : 'xml-fallback',
      vision: m.vision,
      profileSource: m.profileSource,
    }));
  }

  /**
   * Đổi model cho phiên đang mở, từ bảng chọn ở thanh soạn.
   *
   * `undefined` = thôi chọn, quay về cấu hình của máy. Không ghi settings.
   *
   * Không đổi được giữa lúc một lượt đang chạy: `AgentLoop` đã dựng xong với
   * cửa sổ ngữ cảnh, ngưỡng nén và đường tool-calling của model cũ, nên đổi
   * giữa chừng sẽ nén theo ngưỡng của model này rồi gửi lên model khác.
   */
  async setSessionModel(id: string | undefined): Promise<void> {
    if (this.busy) {
      this.opts.emit({
        type: 'notice',
        level: 'warn',
        text: 'Wait for this turn to finish before switching model.',
      });
      // Vẫn phát lại trạng thái: webview đã tự vẽ model mới lúc bấm, nên không
      // trả nó về giá trị thật thì nút nói một đằng, lượt chạy một nẻo.
      this.opts.emit(await this.describeReadiness());
      return;
    }

    if (id !== undefined && !this.modelOptions().some((m) => m.id === id && m.available)) {
      this.opts.emit({
        type: 'notice',
        level: 'warn',
        text: `${id} is not available on this account.`,
      });
      this.opts.emit(await this.describeReadiness());
      return;
    }

    this.modelOverride = id;
    this.opts.emit(await this.describeReadiness());
  }

  /**
   * Model có được giao quyền ghi trong lượt này không.
   *
   * Hai điều kiện, và điều kiện thứ hai mới là điều đáng nói: model kháng
   * injection mức `low` KHÔNG được cầm tool ghi, dù người dùng bật acceptEdits
   * (documents/SECURITY.md §1.7). Một model dễ bị dắt mũi cộng với quyền ghi file là
   * cách biến mọi file trong repo thành kênh thực thi.
   */
  private canWrite(modelId: string): { allowed: boolean; reason?: string } {
    if (this.opts.permissions.effectiveMode() === 'plan') {
      return { allowed: false, reason: 'plan mode is on' };
    }

    // Workspace chưa tin cậy → extension chỉ đọc.
    //
    // Chặn ở đây chứ không chỉ ở tool MCP: mở một repo lạ lên để xem code là
    // việc bình thường, và trong tình huống đó mọi file trong repo — ASTRA.md,
    // comment, README — đều là chỉ thị do người khác viết. Cho agent quyền ghi
    // ngay lúc ấy là giao bút cho người viết repo.
    if (!vscode.workspace.isTrusted) {
      return { allowed: false, reason: 'this workspace is not trusted' };
    }

    const registry = this.opts.session.getRegistry();
    const profile = registry?.get(modelId);
    // Chưa đo thì cho ghi: permission layer vẫn đứng chắn phía trước, và chặn
        // mọi model chưa đo sẽ khiến bản cài mới không sửa được gì.
        if (profile?.profileSource === 'measured' && profile.injectionResistance === 'low') {
          return {
            allowed: false,
            reason: `${modelId} measured low resistance to prompt injection`,
          };
        }
    return { allowed: true };
  }

  async send(rawText: string, images: ImageWire[] = []): Promise<void> {
    if (this.busy) return;

    // Slash command đi TRƯỚC mọi thứ khác: `/undo` phải chạy được kể cả khi
    // chưa đăng nhập hay chưa chọn model — nó không cần model nào.
    const resolved = await this.resolveSlash(rawText);
    if (resolved.handled) return;
    const text = resolved.text;

    const role = this.roleForTurn(images.length);
    const readiness = await this.describeReadiness(role);
    if (!readiness.canChat || !readiness.model) {
      // Chưa đăng nhập thì nút phải mở luôn trình duyệt đăng nhập, không phải
      // mở bảng cài đặt rồi bắt bấm thêm một nút "Sign in" thật ở trong đó.
      this.opts.emit(
        readiness.blockKind === 'auth'
          ? {
              type: 'error',
              message: readiness.blockReason ?? 'Not ready.',
              hint: 'Sign in to AstraWork',
              hintAction: 'signIn',
            }
          : {
              type: 'error',
              message: readiness.blockReason ?? 'Not ready.',
              hint: 'Open AstraCode settings',
            },
      );
      return;
    }

    const provider = this.opts.session.getProvider();
    const root = activeWorkspaceRoot()?.uri.fsPath;
    if (!provider || !root) return;
    const turnId = `t${++this.turnCounter}`;

    // Pin (tính năng ghim) giờ là MỘT LẦN MỖI LƯỢT, giống hệt ảnh đính kèm: đi
    // kèm đúng câu hỏi này (hiện lại trong bong bóng vừa gửi, xem `turn_start`
    // bên dưới), rồi biến mất khỏi composer — không còn dính sang câu hỏi sau
    // như bản cũ. Chụp lại danh sách TRƯỚC khi xoá: đoạn đọc file/build prompt
    // bên dưới vẫn cần đúng những pin này.
    const pinsForTurn = this.pins;
    this.pins = [];
    void this.emitPins();
    const pinItemsForTurn: PinnedItemWire[] = pinsForTurn.map((p) => ({
      id: p.id,
      path: p.path,
      name: baseName(p.path),
      ...(p.startLine !== undefined ? { startLine: p.startLine } : {}),
      ...(p.endLine !== undefined ? { endLine: p.endLine } : {}),
    }));

    // Tin tức tác vụ nền đi kèm câu hỏi, không phải một lượt riêng: model
    // chỉ đọc được thứ nằm trong hội thoại, và một tác vụ xong trong lúc
    // nó không chạy thì không có chỗ nào khác để nói ra.
    //
    // `let`: nội dung pin được gắn thêm vào ĐẦU ngay sau khi `resolvedPins`
    // đọc xong bên dưới — chỉ biết được sau khi có toolContext.
    let prompt = `${this.backgroundNews()}${text}`;

    this.opts.emit({
      type: 'turn_start',
      turnId,
      prompt: text,
      images: images.length,
      pins: pinItemsForTurn,
    });

    // Lịch sử gõ dùng chung với CLI. Nguyên văn người dùng gõ, KHÔNG kèm phần
    // đính kèm đã ghép vào (`prompt`) — đó là thứ mũi tên lên cần trả lại, và
    // cũng là thứ ít lộ nhất: không có trích đoạn file trong đó.
    // Không `await`: một lượt chat không được chờ đĩa.
    void this.opts.promptLog?.append({
      display: text,
      project: root,
      sessionId: this.persisted?.id ?? '',
      timestamp: Date.now(),
    });

    // Lượt này chạy bằng model khác model đang hiện trên thanh trạng thái. Nói
    // ra một dòng: người dùng thấy chi phí và giọng văn đổi giữa hai lượt liền
    // nhau, và không có dòng này thì chỗ duy nhất giải thích được là source code.
    if (role !== 'editor') {
      this.opts.emit({
        type: 'note',
        turnId,
        text:
          images.length > 0
            ? `Reading images with ${readiness.model.id}.`
            : `Planning with ${readiness.model.id} — plan mode is on.`,
      });
    }

    // Profile nói model không đọc được ảnh: vẫn gửi (profile mặc định là
    // `vision: false` khi chưa đo, chặn ở đây sẽ khoá cả những model đọc được),
    // nhưng nói trước để người dùng không ngồi đoán vì sao model tả sai ảnh.
    if (images.length > 0 && !readiness.model.vision) {
      this.opts.emit({
        type: 'note',
        turnId,
        text:
          readiness.model.profileSource === 'measured'
                      ? `${readiness.model.id} was measured as unable to read images — they are still sent, but it will most likely ignore them.`
            : `Whether ${readiness.model.id} can read images has not been measured. If it answers as though it saw nothing, switch to a vision model.`,
      });
    }

    this.abort = new AbortController();
    const started = Date.now();

    // Nén TRƯỚC khi gửi, không phải sau khi tràn. Sau khi tràn thì lượt đã hỏng
    // rồi, và người dùng nhận một lỗi từ gateway thay vì một câu trả lời.
    const budget = new ContextBudget({
      contextWindow: readiness.model.contextWindow,
      ...(readiness.model.compactAt !== undefined ? { compactAt: readiness.model.compactAt } : {}),
      ...(readiness.model.warnAt !== undefined ? { warnAt: readiness.model.warnAt } : {}),
    });
    if ((this.opts.autoCompact?.() ?? true) && budget.shouldCompact(this.history)) {
      await this.compactNow(turnId);
    }

    // Mặc định là native, kể cả khi chưa ai đo model này — xem
    // `INFERRED_DEFAULTS`. Hai thứ kéo nó xuống XML: profile nói rõ model
    // không làm được, hoặc chính ta đã thử và thất bại ở một lượt trước.
    //
    // Lần thất bại đó là phép đo thật sự: nó xảy ra trong lúc dùng bình
    // thường, không phải trong một bước cài đặt mà ai cũng bỏ qua.
    const learnedXml = this.opts.nativeUnsupported?.has(readiness.model.id) ?? false;
    const protocol: ToolProtocol =
      readiness.model.toolCalling === 'native' && !learnedXml ? 'native' : 'xml';

    const write = this.canWrite(readiness.model.id);
    if (!write.allowed && write.reason && !write.reason.includes('plan mode')) {
      this.opts.logger.warn('withholding write access from the model', { reason: write.reason });
      this.opts.emit({
        type: 'error',
        turnId,
        message: `This session is read-only because ${write.reason}. Pick another model if you need edits.`,
      });
    }

    const sandbox = this.opts.getSandbox();

    // Hoist khỏi object literal của AgentLoop bên dưới: `resolvePins` cần
    // CHÍNH toolContext này (cùng pathGuard/denylist với mọi lần agent tự đọc
    // file) để đọc lại nội dung pin ngay trước khi build system prompt.
    const toolContext = createToolContext({
      workspaceRoot: root,
      logger: this.opts.logger,
      fs: new VsCodeFileSystem(),
      ledger: this.opts.ledger,
      turnId,
      ...(sandbox ? { sandbox, jobs: this.jobs } : {}),
      askUser: this.askUser,
      ...(await this.readAstraignore(root)),
    });

    // Đọc lại TỪ ĐĨA ngay trước khi build prompt, không cache nội dung lúc
    // ghim: file có thể đã đổi giữa lúc bấm ghim và lúc bấm gửi, và model phải
    // thấy bản MỚI NHẤT. Không còn broadcast `pins` ở đây — composer đã xoá
    // chip ngay từ đầu hàm (pin một-lần-mỗi-lượt), nên không cần đồng bộ lại
    // UI giữa chừng như thời pin còn dính qua nhiều lượt.
    const resolvedPins = pinsForTurn.length > 0 ? await resolvePins(pinsForTurn, toolContext) : [];
    // Gắn vào ĐẦU CÂU HỎI của lượt này, không phải system prompt: người dùng
    // ghim để dùng NGAY cho câu hỏi hiện tại, nên nó phải đọc như một phần của
    // lượt `user`, không phải một chỉ thị nền chung mà model có thể lướt qua.
    const pinnedContext = renderPinnedContext(resolvedPins);
    if (pinnedContext) prompt = `${this.pinnedPreamble(pinnedContext)}${prompt}`;

    // ── M8: skill, subagent, hooks ────────────────────────────────────────
    // Dựng lại mỗi lượt: sửa SKILL.md rồi hỏi tiếp là cách dùng bình thường.
    const extras = await this.buildExtrasForTurn(root, provider, readiness.model.id, protocol, text);
    this.extras = extras;

    const codeGraph = this.opts.getCodeGraph?.(root);
    const registry = createRegistry({
      canWrite: write.allowed,
      hasSandbox: sandbox !== undefined,
      hasBackgroundJobs: sandbox !== undefined,
      todoStore: this.opts.todos,
      // Không điều kiện — khác sandbox, kênh hỏi qua webview luôn có sẵn
      // trong VS Code, người dùng không cần bật gì để dùng được.
      hasAskUser: true,
      ...(codeGraph ? { codeGraph } : {}),
      // Chế độ plan chặn tool có tác dụng phụ ở tầng core; tool MCP đều được
      // coi là có tác dụng phụ, nên đưa vào cũng chỉ để model gọi rồi bị từ
      // chối. Không đưa thì nó lập kế hoạch bằng thứ nó thật sự có.
      extraTools: [
        ...extras.tools,
        ...(write.allowed ? (this.opts.getMcpTools?.() ?? []) : []),
      ],
    });
    const memoryOpts = await this.readMemory(root);
    const systemPrompt = buildSystemPrompt({
      workspaceRoot: root,
      platform: process.platform,
      // Model context nhỏ thì rút gọn prompt, nhưng mục "Ranh giới tin cậy"
      // vẫn được giữ nguyên bên trong buildSystemPrompt.
      compact: readiness.model.contextWindow > 0 && readiness.model.contextWindow < 32_000,
              canWrite: write.allowed,
              sandbox: sandbox?.info().kind ?? 'none',
              // Shell thật, không suy từ platform: sandbox docker chạy bash
              // kể cả trên Windows, còn host trên Windows là PowerShell.
              ...(sandbox ? { shell: sandbox.info().shell } : {}),
              hasTodos: this.opts.todos !== undefined,
              hasBackgroundJobs: sandbox !== undefined,
              hasAskUser: true,
              hasCodeGraph: codeGraph !== undefined,
              permissionMode: this.opts.permissions.effectiveMode(),
      // Danh mục skill: CHỈ tên + mô tả (M8). Thân về qua load_skill.
      ...(extras.skillCatalog ? { skillCatalog: extras.skillCatalog } : {}),
      // ASTRA.md — nội dung không tin cậy, buildSystemPrompt tự bọc delimiter.
      ...memoryOpts,
    });

    this.lastContextBreakdown = this.computeContextBreakdown({
      registry,
      systemPrompt,
      contextWindow: readiness.model.contextWindow,
      ...(extras.skillCatalog ? { skillCatalog: extras.skillCatalog } : {}),
      ...(memoryOpts.astraMd ? { astraMd: memoryOpts.astraMd } : {}),
    });

    const loop = new AgentLoop({
      provider,
      tools: registry,
      toolContext,
      logger: this.opts.logger,
      permissions: this.opts.permissions,
      systemPrompt,
      model: readiness.model.id,
      role,
      protocol,
      onProtocolFallback: ({ model }) => {
        if (model) this.opts.nativeUnsupported?.add(model);
      },
      // Tự nén NGAY TRONG lượt (không chỉ trước lượt, xem check ở trên): một
      // lượt chạy hàng chục vòng (đọc file, grep liên tiếp) có thể tự phình
      // qua ngưỡng ngữ cảnh mà không có message user mới nào để kích hoạt
      // nhánh nén-trước-khi-gửi. Thiếu bước này, người dùng phải gõ thêm một
      // câu ("tiếp tục") thì lượt SAU mới nén — đúng lỗi đã gặp.
      ...((this.opts.autoCompact?.() ?? true)
        ? {
            compactor: new Compactor({
              provider,
              logger: this.opts.logger,
              model: readiness.model.id,
            }),
            contextWindow: readiness.model.contextWindow,
            ...(readiness.model.compactAt !== undefined
              ? { compactAt: readiness.model.compactAt }
              : {}),
            ...(readiness.model.warnAt !== undefined ? { warnAt: readiness.model.warnAt } : {}),
          }
        : {}),
      ...(extras.hooks ? { hooks: extras.hooks } : {}),
      onToolOutput: (chunk) =>
        this.opts.emit({
          type: 'tool_output',
          turnId,
          callId: chunk.callId,
          delta: chunk.text.slice(0, OUTPUT_CHUNK_CHARS),
        }),
    });

    try {
      const gen = loop.run(
        prompt,
        this.history,
        this.abort.signal,
        images.map((img) => ({ mediaType: img.mediaType, data: img.data })),
      );
      let next = await gen.next();

      while (!next.done) {
        this.forward(turnId, next.value);
        next = await gen.next();
      }

      const result = next.value;
      this.history = result.messages.filter((m) => m.role !== 'system');
      this.lastCachedTokens = result.usage.cachedTokens;

      // Lượt dừng vì lỗi KHÔNG còn đi qua khối catch phía dưới: `AgentLoop` trả
      // về thay vì ném, để giữ `messages` của phần đã làm (sổ nợ #10). Nên câu
      // thông báo phải phát ở đây, nếu không người dùng chỉ thấy trạng thái
      // "error" trên bong bóng lượt mà không biết vì sao.
      if (result.error) {
        this.opts.emit({
          type: 'error',
          turnId,
          ...describeErrorCode(result.error.code, result.error.message),
        });
      }

      this.opts.emit({
        type: 'turn_end',
        turnId,
        stoppedBy: result.stoppedBy,
        toolCalls: result.toolCalls,
        iterations: result.iterations,
        totalTokens: result.usage.totalTokens,
        ...(result.usage.cachedTokens !== undefined
          ? { cachedTokens: result.usage.cachedTokens }
          : {}),
        durationMs: Date.now() - started,
      });

      this.recordTurn(root, readiness.model.id, {
        id: turnId,
        prompt: text,
        startedAt: started,
        durationMs: Date.now() - started,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        // Gateway không phải lúc nào cũng trả usage. Rơi về ước lượng còn hơn
        // hiện 0 token cho một lượt vừa đọc năm file.
        totalTokens:
          result.usage.totalTokens > 0
            ? result.usage.totalTokens
            : estimateTokens(prompt) + estimateTokens(result.text),
        stoppedBy: result.stoppedBy,
        filesTouched: this.opts.checkpoints?.get(turnId)?.entries.length ?? 0,
      });
      await this.persist();
      await this.persistCheckpoint(turnId);
      void this.opts.state?.touchProject(root, { turns: 1 });
      // Vào sổ mức dùng của máy — nơi duy nhất con số này sống sót qua lần
      // "Hội thoại mới" tiếp theo. Chỉ số, không nội dung.
      // Giá lấy từ registry (gateway nói), không phải từ một bảng giá chép tay
      // trong extension: bảng chép tay sẽ đúng cho tới lần đầu tiên bên kia đổi
      // giá, và sau đó sai mãi mà không ai biết.
      const priced = this.opts.session.getRegistry()?.get(readiness.model.id);
      this.opts.recordUsage?.({
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        model: readiness.model.id,
        ...(priced
          ? {
              costUsd: turnCostUsd({
                promptTokens: result.usage.promptTokens,
                completionTokens: result.usage.completionTokens,
                inputPriceUsd: priced.inputPriceUsd,
                outputPriceUsd: priced.outputPriceUsd,
              }),
            }
          : {}),
        ...linesChangedIn(this.opts.ledger, turnId),
      });
      this.emitContext(readiness.model.contextWindow);
      await this.runVerify(turnId, root);
    } catch (err) {
      this.opts.logger.error('chat turn failed', {
        turnId,
        reason: err instanceof Error ? err.message : String(err),
      });
      this.opts.emit({ type: 'error', turnId, ...describeChatError(err) });
      this.opts.emit({
        type: 'turn_end',
        turnId,
        stoppedBy: turnEndReasonForError(err),
        toolCalls: 0,
        iterations: 0,
        totalTokens: 0,
        durationMs: Date.now() - started,
      });
    } finally {
      this.abort = undefined;
    }
  }

  private forward(turnId: string, event: AgentEvent): void {
    switch (event.type) {
      case 'thinking':
        this.opts.emit({ type: 'thinking', turnId, iteration: event.iterations ?? 1 });
        return;

      case 'text':
        if (event.delta) this.opts.emit({ type: 'text', turnId, delta: event.delta });
        return;

      case 'tool_start':
        this.opts.emit({
          type: 'tool_start',
          turnId,
          callId: event.callId ?? '?',
          name: event.toolName ?? '?',
          args: event.toolArgs,
        });
        return;

      case 'tool_end': {
        const name = event.toolName ?? '?';
        const content = event.toolResult?.content ?? '';
        const isError = event.toolResult?.isError === true;
        const summary = summarizeToolResult({
          name,
          isError,
          contentLength: content.length,
          ...(event.toolResult?.meta ? { meta: event.toolResult.meta } : {}),
        });

        // Chụp lại bản người dùng đọc NGAY ở đây. Nó chỉ tồn tại trong sự kiện
        // này: `messages` giữ bản gửi model, bằng tiếng Việt của prompt layer,
        // và hai chuỗi không phải bản dịch của nhau nên không dựng lại được.
        if (event.callId) this.toolSummaries.set(event.callId, { summary, isError });

        this.opts.emit({
          type: 'tool_end',
          turnId,
          callId: event.callId ?? '?',
          name,
          isError,
          summary,
          durationMs: event.durationMs ?? 0,
          // Ưu tiên preview do tool.describe() soạn (diff đã format): UI hiển thị
          // split diff trực quan hơn content thô ("đã ghi đè X dòng"). Nếu tool
          // không khai preview (read_file, grep…), rơi về content như cũ.
          ...(event.preview
            ? { preview: event.preview }
            : {
                preview:
                  content.length > PREVIEW_CHARS
                    ? `${content.slice(0, PREVIEW_CHARS)}\n… (${content.length - PREVIEW_CHARS} more characters)`
                    : content,
              }),
          ...(event.previewKind ? { previewKind: event.previewKind } : {}),
        });
        return;
      }

      case 'injection_warning': {
        const scan = event.scan;
        if (!scan) return;
        this.opts.emit({
          type: 'injection_warning',
          turnId,
          toolName: event.toolName ?? '?',
          score: scan.score,
          signals: [...new Set(scan.findings.map((f) => f.signal))],
          excerpt: scan.findings[0]?.excerpt ?? describeInjectionScan(scan),
        });
        return;
      }

      case 'repair':
        this.opts.emit({ type: 'repair', turnId, reason: event.reason ?? '' });
        return;

      // Nói ra chứ không âm thầm: người dùng cần biết vì sao lượt này khởi
      // động chậm hơn bình thường, và vì sao model vừa đổi cách gọi công cụ.
      case 'protocol_fallback':
        this.opts.emit({
          type: 'note',
          turnId,
          text:
            'This model does not accept native tool calling — switched to the XML path and ' +
            'remembered it, so later turns go straight there.',
        });
        return;

      case 'context_recovery':
        this.opts.emit({
          type: 'note',
          turnId,
          text: event.reason ?? 'Gateway rejected the request; retrying with a safer context.',
        });
        return;

      // Câu trả lời bị cắt (hết token đầu ra, hoặc bộ lọc nội dung). Không nói
      // ra thì một câu dở trông y hệt một câu hoàn chỉnh, và người dùng đi hành
      // động trên nửa câu.
      case 'truncated':
        this.opts.emit({
          type: 'note',
          turnId,
          text: event.reason ?? 'The answer was cut off before it finished.',
        });
        return;

      case 'tool_call_dropped':
        this.opts.emit({ type: 'tool_call_dropped', turnId, reason: event.reason ?? '' });
        return;

      case 'permission_denied':
        this.opts.emit({
          type: 'permission_denied',
          turnId,
          toolName: event.toolName ?? '?',
          reason: event.reason ?? '',
        });
        return;

      case 'permission_downgraded':
        this.opts.emit({
          type: 'permission_downgraded',
          turnId,
          toolName: event.toolName ?? '?',
          reason: event.reason ?? '',
        });
        return;

      // Đồng hồ ngữ cảnh realtime (M6 mở rộng). AgentLoop đã đo trên `messages`
      // THẬT đang chạy — đây là duy nhất nhìn thấy context phình lên giữa các
      // vòng, vì `this.history` ở ngoài chỉ gán lại khi lượt XONG. Trước đây meter
      // chỉ cập nhật ở `turn_end`, nên một lượt dài gọi 5 tool mà UI vẫn đứng im.
      //
      // Truyền thẳng snapshot qua webview thay vì gọi `emitContext()`: hàm đó
      // đo `this.history` CŨ (chưa có các message của lượt đang chạy), nên
      // forward về nó là forward về số đã nháp rồi.
      case 'context': {
        const ctx = event.contextUsage;
        if (!ctx) return;
        this.opts.emit({
          type: 'context',
          usage: {
            used: ctx.used,
            usable: ctx.usable,
            ratio: ctx.ratio,
            level: ctx.level,
            label: describeUsage(ctx),
          },
        });
        return;
      }

      // Nén tự động xảy ra NGAY TRONG lượt (AgentLoop, không phải compactNow()
      // của lớp này) — vẫn phải cập nhật đúng sổ sách: bộ đếm và bản ghi phiên
      // đọc `this.compactions`, và `/compact` thủ công lẫn nén giữa lượt phải
      // cùng cộng vào một con số, không thì thống kê hiện sai.
      case 'compacted':
        this.compactions++;
        if (this.persisted) this.persisted.compactions = this.compactions;
        this.opts.emit({
          type: 'compacted',
          turnId,
          trigger: 'auto',
          droppedMessages: event.droppedMessages ?? 0,
          tokensBefore: event.tokensBefore ?? 0,
          tokensAfter: event.tokensAfter ?? 0,
          degraded: event.degraded ?? false,
          degradedReason: event.degradedReason ?? null,
        });
        return;

      default:
        return;
    }
  }

  // ── Slash command, bộ nhớ, ngữ cảnh (M6) ─────────────────────────────────

  /**
   * Xử lý `/lệnh` trong ô nhập.
   *
   * Trả `handled: true` khi lệnh tự làm xong việc (không gửi gì cho model), và
   * `text` đã thay thế khi đó là command sinh prompt.
   */
  private async resolveSlash(raw: string): Promise<{ handled: boolean; text: string }> {
    const parsed = parseSlashInput(raw);
    if (!parsed) return { handled: false, text: raw };

    switch (parsed.name) {
      case 'undo':
        await this.undoLastTurn();
        return { handled: true, text: raw };

      case 'clear':
        this.clear();
        return { handled: true, text: raw };

      case 'sessions':
        await this.listSessions(true);
        return { handled: true, text: raw };

      case 'compact':
        if (this.history.length === 0) {
          this.opts.emit({ type: 'error', message: 'Nothing to compact yet.' });
        } else {
          // Phần sau `/compact` là chỉ dẫn cho lần nén này, không phải tham số
          // bị bỏ qua: người dùng biết chỗ nào trong hội thoại còn cần đến,
          // còn bộ tóm tắt thì không.
          await this.compactNow(undefined, 'manual', parsed.args);
        }
        return { handled: true, text: raw };

      case 'memory':
        await this.rememberRule(parsed.args);
        return { handled: true, text: raw };

      case 'help':
        await this.refreshCommands();
        return { handled: true, text: raw };

      case 'create-skill':
        await this.scaffold('skill', parsed.args);
        return { handled: true, text: raw };

      case 'create-agent':
        await this.scaffold('agent', parsed.args);
        return { handled: true, text: raw };

      default:
        break;
    }

    await this.refreshCommands();

    // Gọi tay skill (M8): `/tên-skill` nạp thẳng hướng dẫn, không qua phán đoán
    // của model. Đây là đường thoát khi model yếu không tự nhận ra cần nó.
    const skill = this.skills.find((sk) => sk.name === parsed.name && sk.userInvocable);
    if (skill && !this.commands.some((c) => c.name === parsed.name)) {
      if (skill.source === 'project' && skill.scan.suspicious) {
        this.opts.emit({
          type: 'injection_warning',
          turnId: `t${this.turnCounter}`,
          toolName: `skill:${skill.name}`,
          score: skill.scan.score,
          signals: [...new Set(skill.scan.findings.map((f) => f.signal))],
          excerpt: skill.scan.findings[0]?.excerpt ?? describeInjectionScan(skill.scan),
        });
      }
      return { handled: false, text: renderSkillInvocation(skill, parsed.args) };
    }

    const command = this.commands.find((c) => c.name === parsed.name);
    if (!command) {
      this.opts.emit({
        type: 'error',
        message: `There is no /${parsed.name} command. Type /help for the list.`,
      });
      return { handled: true, text: raw };
    }

    // Command của repo là prompt do người khác viết. Người dùng chủ động gõ nó
    // nên vẫn chạy, nhưng phải biết mình vừa chạy cái gì và từ đâu.
    if (command.source === 'project' && command.scan.suspicious) {
      this.opts.emit({
        type: 'injection_warning',
        turnId: `t${this.turnCounter}`,
        toolName: `/${command.name}`,
        score: command.scan.score,
        signals: [...new Set(command.scan.findings.map((f) => f.signal))],
        excerpt: command.scan.findings[0]?.excerpt ?? describeInjectionScan(command.scan),
      });
    }

    return { handled: false, text: renderCommand(command, parsed.args) };
  }

  // ── M8: skill, subagent, hooks ──────────────────────────────────────────

  /**
   * Dựng skill/agent/hook cho lượt này.
   *
   * Không có nơi lưu quyết định duyệt hook (`hookApprovals`) thì hook vẫn được
   * NẠP nhưng không cái nào CHẠY — HookRunner từ chối mọi hook chưa duyệt và
   * không có kênh hỏi. Cố ý: mất nơi lưu không được biến thành mất cả rào.
   */
  private async buildExtrasForTurn(
    root: string,
    provider: Provider,
    model: string,
    protocol: ToolProtocol,
    conversation: string,
  ): Promise<Extras> {
    // Không chặn lượt này: nếu chuẩn đã cũ, nó đi lấy nền và lượt SAU dùng bản
    // mới. Xem `ensureProjectAgentsFresh`.
    this.opts.session.ensureProjectAgentsFresh();

    const extras = await buildExtras({
      workspaceRoot: root,
      logger: this.opts.logger,
      provider,
      model,
      protocol,
      toolContext: createToolContext({
        workspaceRoot: root,
        logger: this.opts.logger,
        fs: new VsCodeFileSystem(),
      }),
      approvals: this.opts.hookApprovals ?? DENY_ALL_APPROVALS,
      askHook: (hook) => this.askHookApproval(hook),
      conversation,
      orgAgents: this.opts.session.getProjectAgents().agents,
      orgSkills: this.opts.session.getProjectAgents().skills,
    });

    for (const reason of extras.rejections) {
      this.opts.logger.warn('hook source ignored', { reason });
    }

    // Skill KHÔNG do chính người dùng viết mà có dấu hiệu injection: nói ngay,
    // đừng đợi model nạp nó. Gồm cả skill của dự án — xem vòng lặp agent bên dưới.
    for (const skill of extras.skills) {
      if (skill.source !== 'user' && skill.scan.suspicious) {
        this.opts.emit({
          type: 'injection_warning',
          turnId: `t${this.turnCounter}`,
          toolName: `skill:${skill.name}`,
          score: skill.scan.score,
          signals: [...new Set(skill.scan.findings.map((f) => f.signal))],
          excerpt: skill.scan.findings[0]?.excerpt ?? describeInjectionScan(skill.scan),
        });
      }
    }

    // Cùng lý do, cho agent không do chính người dùng viết. Chuẩn dự án đến từ
    // một tài khoản có RBAC nên đáng tin hơn repo — nhưng "đáng tin hơn" không
    // phải "khỏi xem", và người bị ảnh hưởng là cả đội chứ không riêng ai.
    for (const agent of extras.agents) {
      if (agent.source === 'user' || !agent.scan.suspicious) continue;
      this.opts.emit({
        type: 'injection_warning',
        turnId: `t${this.turnCounter}`,
        toolName: `agent:${agent.name}`,
        score: agent.scan.score,
        signals: [...new Set(agent.scan.findings.map((f) => f.signal))],
        excerpt: agent.scan.findings[0]?.excerpt ?? describeInjectionScan(agent.scan),
      });
    }

    return extras;
  }

  /**
   * `/create-skill` và `/create-agent` — sinh khung file rồi mở ra để sửa.
   *
   * Sinh vào `.astra/` của REPO chứ không vào `~/.astra/`: skill mô tả quy ước
   * của một dự án cụ thể, và nó nên đi cùng repo để cả đội dùng chung. Ai muốn
   * skill cá nhân thì chép sang `~/.astra/skills/` — bản đó sẽ thắng khi trùng tên.
   */
  /**
   * `/memory` — chỗ để một quy ước sống sót qua hết phiên chat.
   *
   * Không có lệnh này thì rule người dùng gõ trong chat chỉ nằm trong history:
   * `/clear`, mở chat mới, hoặc một lần `/compact` nuốt phải đoạn đó là mất, và
   * lần sau agent làm sai đúng thứ vừa được dặn.
   *
   * Cố ý KHÔNG cho model tự gọi. Ghi vào ASTRA.md là ghi vào system prompt của
   * mọi lượt sau; giữ nó ở dạng lệnh người dùng gõ tay nghĩa là mỗi dòng trong
   * file đều truy được về một câu họ đã tự viết ra.
   */
  private async rememberRule(rule: string): Promise<void> {
    const root = activeWorkspaceRoot();
    if (!root) {
      this.opts.emit({ type: 'error', message: 'No folder is open, so there is nowhere to save.' });
      return;
    }

    try {
      // Không có nội dung thì đây là "mở file ra tôi tự sửa": mục Careful around
      // here và mọi thứ không phải một gạch đầu dòng chỉ sửa tay được.
      if (!rule.trim()) {
        const { uri, created } = await readOrCreateMemoryFile(root.uri);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
        this.opts.emit({
          type: 'notice',
          level: 'info',
          text: created
            ? `Created ${uri.fsPath}. Anything you write here is loaded into the system prompt on every turn.`
            : `Opened ${uri.fsPath}. Changes take effect on your next message.`,
        });
        return;
      }

      const { uri, chars } = await appendConvention(root.uri, rule);
      this.opts.emit({
        type: 'notice',
        level: 'info',
        text: `Saved to ${uri.fsPath}. It applies from your next message on.`,
      });

      // Vượt trần của loadMemory thì phần đuôi bị cắt trước khi tới model —
      // rule vừa lưu có thể không bao giờ có hiệu lực. Im lặng ở đây là im lặng
      // đúng vào việc lệnh này sinh ra để làm.
      if (chars > MEMORY_MAX_CHARS) {
        this.opts.emit({
          type: 'notice',
          level: 'warn',
          text:
            `ASTRA.md is now ${chars} characters, over the ${MEMORY_MAX_CHARS} limit. ` +
            `Everything past the limit is cut before the model sees it — trim the file.`,
        });
      }

      this.opts.logger.info('saved a project rule to ASTRA.md', { path: uri.fsPath, chars });
    } catch (err) {
      this.opts.emit({
        type: 'error',
        message: `Could not write ASTRA.md: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async scaffold(kind: 'skill' | 'agent', rawName: string): Promise<void> {
    const root = activeWorkspaceRoot();
    if (!root) {
      this.opts.emit({ type: 'error', message: 'No folder is open, so nothing can be created.' });
      return;
    }

    const name = (rawName.trim() || (await this.promptName(kind)) || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);

    if (!name) return;

    const uri =
      kind === 'skill'
        ? vscode.Uri.joinPath(root.uri, '.astra', 'skills', name, 'SKILL.md')
        : vscode.Uri.joinPath(root.uri, '.astra', 'agents', `${name}.md`);

    try {
      await vscode.workspace.fs.stat(uri);
      this.opts.emit({ type: 'error', message: `${uri.fsPath} already exists.` });
      await vscode.window.showTextDocument(uri);
      return;
    } catch {
      /* chưa có — tạo mới */
    }

    const template =
      kind === 'skill'
        ? `---
name: ${name}
description: Use when <describe the SITUATION this skill is for, not what it is>
triggers: [${name}]
---

# ${name}

Write the step-by-step instructions here. The model only reads this part AFTER it
calls \`load_skill\` — so the \`description\` above is what decides whether it gets
loaded at all.

## Steps

1.
2.
`
        : `---
name: ${name}
description: <what kind of work goes to this agent>
---

You are <role>. Task: <description>.

Sub-agents are READ-ONLY — no file edits, no commands. Answer briefly and cite
concrete file paths.
`;

    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(template));
    await vscode.window.showTextDocument(uri);
    await this.refreshCommands();
    this.opts.logger.info('scaffolded a new file', { kind, path: uri.fsPath });
  }

  private async promptName(kind: 'skill' | 'agent'): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: kind === 'skill' ? 'New skill name' : 'New sub-agent name',
      placeHolder: 'chi-dung-chu-thuong-va-gach-ngang',
      validateInput: (v) => (v.trim() ? undefined : 'A name is required'),
    });
  }

  /**
   * Hộp duyệt hook. Hiện NGUYÊN VĂN lệnh sẽ chạy, dạng modal, không có nút
   * "luôn cho phép mọi hook" — duyệt được ghi theo vân tay của chính lệnh đó,
   * nên sửa lệnh là phải duyệt lại (xem core/hooks/hooks.ts).
   */
  private async askHookApproval(hook: LoadedHook): Promise<boolean> {
    const pick = await vscode.window.showWarningMessage(
      `This project wants to run a hook when the agent calls a tool. Allow it?`,
      {
        modal: true,
        detail:
          `${describeHook(hook)}

` +
          'A hook is a command that runs AUTOMATICALLY with your privileges. Only approve it ' +
          'if you read the command above and trust its source. Editing it means approving again.',
      },
      'Allow this hook',
    );
    const ok = pick === 'Allow this hook';
    this.opts.logger.info('hook approval decision', {
      hook: hook.command,
      event: hook.event,
      approved: ok,
    });
    return ok;
  }

  /**
   * Nạp lại ô gợi ý `/` nếu chuẩn dự án đã đổi kể từ lần dựng gần nhất.
   *
   * Cần một đường riêng vì `refreshCommands()` chạy lúc webview báo `ready`,
   * còn chuẩn dự án về sau đó — đăng nhập xong, hoặc đổi dự án, hoặc lần tự
   * làm mới sau 10 phút. Không có đường này thì quy trình mới khai chỉ xuất
   * hiện sau khi mở lại cửa sổ.
   *
   * So theo `version` chứ không gọi thẳng: `onDidChange` của phiên còn bắn khi
   * đổi task hay nạp lại model, và mỗi lần gọi là hai lần quét thư mục.
   */
  async refreshCommandsIfStale(): Promise<void> {
    if (this.opts.session.getProjectAgents().standard.version === this.slashStandardVersion) {
      return;
    }
    await this.refreshCommands();
  }

  /** Nạp lại danh sách command và đẩy sang webview cho ô gợi ý. */
  async refreshCommands(): Promise<void> {
    const root = activeWorkspaceRoot()?.uri.fsPath;
    this.slashStandardVersion = this.opts.session.getProjectAgents().standard.version;
    const allowProject = this.opts.allowProjectCommands?.() ?? vscode.workspace.isTrusted;

    try {
      this.commands = await loadCommands({
        fs: new VsCodeFileSystem(),
        ...(root ? { workspaceRoot: root } : {}),
        homeDir: os.homedir(),
        allowProjectCommands: allowProject,
      });
    } catch (err) {
      this.opts.logger.warn('could not load a slash command', {
        reason: err instanceof Error ? err.message : String(err),
      });
      this.commands = [];
    }

    // Skill hiện trong cùng ô gợi ý `/` (M8): người dùng không cần nhớ thứ nào
    // là command, thứ nào là skill — với họ cả hai đều là "gõ gạch chéo".
    try {
      this.skills = await loadSkills({
        fs: new VsCodeFileSystem(),
        ...(root ? { workspaceRoot: root } : {}),
        homeDir: os.homedir(),
        allowProjectSkills: allowProject,
        // PHẢI có, và đây là đường thứ hai — `buildExtras` là đường của model,
        // còn đây là đường của NGƯỜI DÙNG (ô gợi ý `/` và lệnh `/tên` gõ tay).
        // Thiếu ở đây thì model gọi được quy trình của dự án mà người dùng gõ
        // `/` lại không thấy nó, và không có lỗi nào báo.
        orgSkills: this.opts.session.getProjectAgents().skills,
      });
    } catch (err) {
      this.opts.logger.warn('could not load a skill', {
        reason: err instanceof Error ? err.message : String(err),
      });
      this.skills = [];
    }

    const commandNames = new Set(this.commands.map((c) => c.name));

    const items: CommandWire[] = [
      ...BUILTIN_COMMANDS,
      ...this.commands.map((c) => ({
        name: c.name,
        description: c.description,
        source: c.source,
      })),
      ...this.skills
        .filter((sk) => sk.userInvocable && !commandNames.has(sk.name))
        .map((sk) => ({
          name: sk.name,
          description: `[skill] ${sk.description}`,
          source: sk.source,
        })),
    ];
    this.opts.emit({ type: 'commands', items });
  }

  /**
   * ASTRA.md của người dùng và của project.
   *
   * Nạp lại MỖI LƯỢT chứ không cache cả phiên: người dùng sửa ASTRA.md rồi hỏi
   * tiếp là cách dùng bình thường, và bắt họ mở lại VS Code để thấy hiệu lực là
   * hành vi khó đoán.
   */
  private async readMemory(root: string): Promise<{ astraMd?: string }> {
    try {
      const bundle = await loadMemory({
        fs: new VsCodeFileSystem(),
        workspaceRoot: root,
        homeDir: os.homedir(),
      });

      const changed =
        bundle.files.length !== this.memory?.files.length ||
        bundle.files.some((f, i) => f.hash !== this.memory?.files[i]?.hash);

      if (changed) {
        this.opts.emit({
          type: 'memory',
          files: bundle.files.map((f) => ({
            path: f.path,
            source: f.source,
            flagged: f.scan.suspicious,
          })),
        });
        for (const file of bundle.flagged) {
          this.opts.logger.warn('ASTRA.md shows signs of prompt injection', { path: file.path });
        }
      }

      this.memory = bundle;
      return bundle.combined ? { astraMd: bundle.combined } : {};
    } catch (err) {
      this.opts.logger.debug('could not read ASTRA.md', {
        reason: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  /** Nén ngay. Dùng cho cả `/compact` lẫn auto-compact trước khi gửi. */
  /**
   * Nén hội thoại và NÓI CHO NGƯỜI DÙNG BIẾT ở cả ba nhánh: bắt đầu, xong,
   * hỏng.
   *
   * Nén là một lượt gọi model đầy đủ chen vào trước lượt của người dùng. Im
   * lặng trong lúc đó để lại đúng cái ấn tượng tệ nhất một agent có thể tạo ra:
   * bấm gửi xong không có gì xảy ra trong nhiều giây. Và im lặng khi nén xong
   * thì tệ theo kiểu khác — người dùng thấy agent bỗng "quên" phần đầu hội
   * thoại mà không có gì giải thích.
   */
  private async compactNow(
    turnId?: string,
    trigger: CompactTrigger = 'auto',
    focus = '',
  ): Promise<void> {
    const provider = this.opts.session.getProvider();
    if (!provider) {
      if (trigger === 'manual') {
        this.opts.emit({ type: 'compact_skipped', reason: 'No model is active.' });
      }
      return;
    }

    // Báo TRƯỚC MỌI THỨ, kể cả trước `session.status()`.
    //
    // Trước đây dòng này nằm sau một `await` — đọc thì thấy vô hại vì
    // `status()` chỉ đọc token trong bộ nhớ, nhưng nó vẫn nhường một lượt cho
    // event loop, và trên đường có `ensureModels()` thì lượt ấy thành một lời
    // gọi mạng. Người dùng vừa gõ Enter mà thứ đầu tiên chạy là một cái await
    // im lặng thì đúng lúc họ nhìn màn hình nhất lại là lúc không có gì để
    // nhìn. Báo trước rồi mới đi chuẩn bị: thông báo không phụ thuộc vào bất
    // cứ thứ gì có thể chậm.
    this.opts.emit({
      type: 'compacting',
      ...(turnId ? { turnId } : {}),
      trigger,
      tokensBefore: estimateConversationTokens(this.history),
      ...(focus.trim() ? { focus: focus.trim() } : {}),
    });

    const status = await this.opts.session.status();
    const compactor = new Compactor({
      provider,
      logger: this.opts.logger,
      // Cùng model với lượt chat: chỉ còn một ô chọn model, nên việc nén cũng
      // đi tới đúng chỗ mọi việc khác đi.
      ...(status.activeModel ? { model: status.activeModel } : {}),
    });

    try {
      const result = await compactor.compact(this.history, this.abort?.signal, focus);
      if (!result.compacted) {
        // Hai tình huống rất khác nhau, không dùng chung một câu.
        //
        // Gõ tay: người dùng vừa ra lệnh và đang chờ — "chưa cần nén" là câu
        // trả lời đủ.
        //
        // Tự động: đường này chỉ chạy khi ĐÃ chạm ngưỡng, nên "không nén được"
        // nghĩa là mấy lượt gần nhất một mình đã chiếm gần hết cửa sổ. Lượt sau
        // nhiều khả năng vỡ, và người dùng là người duy nhất xử lý được.
        this.opts.emit({
          type: 'compact_skipped',
          reason:
            trigger === 'manual'
              ? 'The conversation is still short; no need to compact.'
              : 'The context hit the threshold but cannot be compacted: the last few turns alone fill most of the window. Consider /clear, or splitting the request.',
        });
        return;
      }

      this.history = result.messages;
      this.compactions++;
      if (this.persisted) {
        this.persisted.messages = this.history;
        this.persisted.compactions = this.compactions;
      }

      this.opts.emit({
        type: 'compacted',
        ...(turnId ? { turnId } : {}),
        trigger,
        droppedMessages: result.droppedMessages,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        degraded: result.degraded,
        degradedReason: result.degradedReason,
      });
      this.emitContext();
    } catch (err) {
      // Nén hỏng không được giết lượt: hội thoại chưa nén vẫn gửi được, chỉ là
      // sát trần hơn. Nhưng "không giết lượt" không có nghĩa là "không nói gì" —
      // người dùng cần biết ngữ cảnh vẫn đang sát trần để tự quyết định có nên
      // `/clear` hay chia nhỏ việc ra.
      // Người dùng bấm Stop giữa lúc nén. KHÔNG ném lại: `compactNow` được gọi
      // trước khối try của lượt, nên một exception ở đây thoát ra ngoài mọi
      // finally và panel kẹt lại ở trạng thái đang chạy.
      if (isAbortError(err)) {
        this.opts.emit({
          type: 'compact_skipped',
          reason: 'Stopped mid-compaction — the conversation is unchanged.',
        });
        return;
      }

      const reason = err instanceof Error ? err.message : String(err);
      this.opts.logger.warn('compaction failed', { reason });
      this.opts.emit({
        type: 'compact_failed',
        ...(turnId ? { turnId } : {}),
        trigger,
        reason,
      });
    }
  }

  /**
   * Chạy lệnh kiểm tra sau một lượt có sửa file (nợ từ M5).
   *
   * Đây là NGOẠI LỆ duy nhất của quy tắc "bash luôn phải duyệt", và nó chỉ hợp
   * lệ nhờ một điều: chuỗi lệnh đến từ cài đặt NGƯỜI DÙNG, không từ model và
   * không từ repo (config.ts `inspectVerifyCommand`). Model không có đường nào
   * tác động lên nội dung lệnh này, nên nó không phải bề mặt tấn công mà
   * PermissionManager đang chắn.
   *
   * Kết quả được nhét vào lịch sử để lượt sau agent tự sửa tiếp — nhưng là
   * `user` message có delimiter, không phải `system`: output lệnh vẫn là dữ
   * liệu không tin cậy.
   */
  private async runVerify(turnId: string, root: string): Promise<void> {
    const config = this.opts.verifyCommand?.();
    if (!config?.command) return;

    const touched = this.opts.checkpoints?.get(turnId)?.entries.length ?? 0;
    if (touched === 0) return;

    if (config.ignoredFromWorkspace) {
      this.opts.emit({
        type: 'error',
        turnId,
        message:
          'Ignoring the astra.verifyCommand set in the repo .vscode/settings.json — ' +
          'auto-run commands are only accepted from user settings.',
      });
    }

    const sandbox = this.opts.getSandbox();
    if (!sandbox) {
      this.opts.emit({
        type: 'error',
        turnId,
        message: `Cannot run "${config.command}": astra.sandbox is off.`,
      });
      return;
    }

    const callId = `${turnId}-verify`;
    this.opts.emit({ type: 'tool_start', turnId, callId, name: 'verify', args: config.command });

    const started = Date.now();
    let output = '';
    try {
      const proc = sandbox.exec(config.command, { cwd: root, timeoutMs: 300_000 });
      for await (const chunk of proc) {
        output += chunk.text;
        this.opts.emit({
          type: 'tool_output',
          turnId,
          callId,
          delta: chunk.text.slice(0, OUTPUT_CHUNK_CHARS),
        });
      }
      const result = await proc.result;

      this.opts.emit({
        type: 'tool_end',
        turnId,
        callId,
        name: 'verify',
        isError: result.exitCode !== 0,
        summary:
          result.exitCode === 0
            ? `${config.command} — xanh`
            : `${config.command} — exit code ${result.exitCode}`,
        durationMs: Date.now() - started,
        preview: output.slice(-PREVIEW_CHARS),
      });

      // Chỉ nhét vào lịch sử khi ĐỎ. Lệnh xanh không dạy model được gì, mà vẫn
      // tốn ngữ cảnh của mọi lượt sau.
      if (result.exitCode !== 0) {
        this.history.push({
          role: 'user',
          content:
            `The automatic verify command \`${config.command}\` ran after your edits and failed ` +
            `(exit ${result.exitCode}). Output:\n\n` +
            `<tool_result untrusted="true">\n${output.slice(-4000)}\n</tool_result>\n\n` +
            `Fix it if the failure came from the change you just made.`,
        });
      }
    } catch (err) {
      this.opts.emit({
        type: 'tool_end',
        turnId,
        callId,
        name: 'verify',
        isError: true,
        summary: 'could not run',
        durationMs: Date.now() - started,
        preview: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Model soi cửa sổ ngữ cảnh khi CHƯA có lượt nào đang chạy — tức model sẽ
   * xử lý lượt KẾ TIẾP nếu người dùng gõ Enter ngay bây giờ, không phải model
   * đã xử lý lượt cuối. `this.persisted?.model` chỉ cập nhật sau khi một lượt
   * thật sự chạy xong (`recordTurn`), nên đổi model trong bảng cài đặt mà vẫn
   * đọc field đó thì đồng hồ ngữ cảnh đứng im tới lượt chat kế tiếp.
   */
  private activeModelId(): string | undefined {
    const registry = this.opts.session.getRegistry();
    return registry?.resolve(this.roleForTurn(0)) ?? this.persisted?.model;
  }

  /** Đồng hồ ngữ cảnh cho UI. */
  emitContext(contextWindow?: number): void {
    const registry = this.opts.session.getRegistry();
    const modelId = this.activeModelId();
    const model = modelId ? registry?.get(modelId) : undefined;
    const window = contextWindow ?? model?.contextWindow ?? 0;

    const usage = new ContextBudget({
      contextWindow: window,
      ...(model?.compactAt !== undefined ? { compactAt: model.compactAt } : {}),
      ...(model?.warnAt !== undefined ? { warnAt: model.warnAt } : {}),
    }).measure(this.history, this.extraContextTokens());
    this.opts.emit({
      type: 'context',
      usage: {
        used: usage.used,
        usable: usage.usable,
        ratio: usage.ratio,
        level: usage.level,
        label: describeUsage(usage),
      },
    });
  }

  /**
   * Tên mọi tool có thể đã xuất hiện trong một phiên cũ.
   *
   * Cố ý dựng với `canWrite`/`hasSandbox` bật hết: phiên cũ có thể đã chạy ở
   * chế độ quyền khác chế độ bây giờ, và danh sách này chỉ dùng để NHẬN RA lời
   * gọi trong văn bản cũ — không cấp quyền cho gì cả. Thiếu một tên ở đây thì
   * hậu quả là khối XML đó hiện nguyên văn, tức là lùi về hành vi cũ chứ không
   * mất dữ liệu.
   */
  private knownToolNames(): string[] {
    return createRegistry({
      canWrite: true,
      hasSandbox: true,
      hasBackgroundJobs: true,
      todoStore: this.opts.todos,
      hasAskUser: true,
      // Chỉ cần MẶT của tool để nhận tên trong văn bản cũ — không bao giờ gọi
      // execute() ở đây, nên một provider giả (ném lỗi nếu lỡ bị gọi) là đủ.
      codeGraph: { ensureFresh: () => Promise.reject(new Error('unused: knownToolNames')) },
      extraTools: [...(this.extras?.tools ?? []), ...(this.opts.getMcpTools?.() ?? [])],
    })
      .all()
      .map((t) => t.name);
  }

  /**
   * Ước lượng token của mọi thứ KHÔNG NẰM trong `this.history` nhưng vẫn đi
   * kèm mỗi request — gọi lại mỗi lượt cùng lúc dựng registry/systemPrompt ở
   * `send()`, lưu vào `this.lastContextBreakdown` để cả `usage()` (bảng cài
   * đặt) và `emitContext()` (đồng hồ khung chat) đọc CHUNG một nguồn.
   *
   * Tool "MCP" nhận ra bằng `tool.jsonSchema` — chỉ tool MCP gán trường này
   * (schema thật lấy từ server ngoài, xem `McpManager.ts`); tool lõi/skill/
   * hook đều sinh schema từ zod nên trường đó luôn vắng (`Tool.ts`).
   *
   * `systemPrompt` truyền vào ĐÃ gồm skillCatalog và astraMd nối ở cuối (xem
   * `buildSystemPrompt`) — trừ hai phần đó ra để không tính hai lần.
   */
  private computeContextBreakdown(input: {
    registry: ToolRegistry;
    systemPrompt: string;
    contextWindow: number;
    skillCatalog?: string;
    astraMd?: string;
  }): ContextBreakdown {
    const skillTokens = input.skillCatalog?.trim() ? estimateTokens(input.skillCatalog.trim()) : 0;
    const memoryTokens = input.astraMd?.trim() ? estimateTokens(input.astraMd.trim()) : 0;
    const systemPromptTokens = Math.max(
      0,
      estimateTokens(input.systemPrompt) - skillTokens - memoryTokens,
    );

    let systemToolTokens = 0;
    let mcpToolTokens = 0;
    let systemToolsJson = '';
    let mcpToolsJson = '';
    for (const def of input.registry.definitions()) {
      const json = JSON.stringify(def);
      const tokens = estimateTokens(json);
      if (input.registry.get(def.name)?.jsonSchema) {
        mcpToolTokens += tokens;
        mcpToolsJson += json;
      } else {
        systemToolTokens += tokens;
        systemToolsJson += json;
      }
    }

    // Cache ngữ cảnh tĩnh riêng của AstraCode: đoạn nào giống hệt lượt trước
    // được tính là cache hit, không phụ thuộc gateway có báo cache hay không.
    const { hitTokens } = this.staticContextCache.update([
      { key: 'systemPrompt', content: input.systemPrompt, tokens: systemPromptTokens },
      { key: 'systemTools', content: systemToolsJson, tokens: systemToolTokens },
      { key: 'mcpTools', content: mcpToolsJson, tokens: mcpToolTokens },
      { key: 'memory', content: input.astraMd ?? '', tokens: memoryTokens },
      { key: 'skills', content: input.skillCatalog ?? '', tokens: skillTokens },
    ]);
    this.lastAstraCachedTokens = hitTokens;

    return {
      contextWindow: input.contextWindow,
      systemPromptTokens,
      systemToolTokens,
      mcpToolTokens,
      memoryTokens,
      skillTokens,
    };
  }

  /** Tổng token của `lastContextBreakdown`, KHÔNG kể `messages` (đo riêng từ `this.history`). */
  private extraContextTokens(): number {
    const b = this.lastContextBreakdown;
    if (!b) return 0;
    return b.systemPromptTokens + b.systemToolTokens + b.mcpToolTokens + b.memoryTokens + b.skillTokens;
  }

  /**
   * Số liệu dùng của phiên đang mở, cho mục "Tài khoản & mức dùng".
   *
   * Đây là số của PHIÊN NÀY, không phải tổng chi tiêu của tài khoản: hạn mức
   * nằm ở gateway và chưa có endpoint để đọc. Nhãn trên UI phải nói đúng thế.
   */
  usage(): UsageWire {
    const registry = this.opts.session.getRegistry();
    const modelId = this.activeModelId();
    const model = modelId ? registry?.get(modelId) : undefined;
    const ctx = new ContextBudget({
      contextWindow: model?.contextWindow ?? 0,
      ...(model?.compactAt !== undefined ? { compactAt: model.compactAt } : {}),
      ...(model?.warnAt !== undefined ? { warnAt: model.warnAt } : {}),
    }).measure(this.history, this.extraContextTokens());

    const b = this.lastContextBreakdown;
    return {
      turns: this.persisted?.turns.length ?? this.turnCounter,
      totalTokens: this.persisted?.totalTokens ?? 0,
      contextUsed: ctx.used,
      contextUsable: ctx.usable,
      contextRatio: ctx.ratio,
      ...(b
        ? {
            contextBreakdown: {
              contextWindow: ctx.contextWindow,
              systemPrompt: b.systemPromptTokens,
              systemTools: b.systemToolTokens,
              mcpTools: b.mcpToolTokens,
              memory: b.memoryTokens,
              skills: b.skillTokens,
              messages: ctx.used - this.extraContextTokens(),
              // Không kẹp 0: khi context đã tràn, `free` phải âm để bảy phần cộng
              // lại đúng bằng `contextWindow` (xem `protocol.ts` ContextBreakdownWire).
              // UI tự kẹp âm về 0% thanh ngang, còn số âm cho người dùng thấy rõ
              // mình đã vượt cửa sổ bao nhiêu.
              free: ctx.contextWindow - ctx.used,
              ...(this.lastCachedTokens !== undefined
                ? { cachedTokens: this.lastCachedTokens }
                : {}),
              ...(this.lastAstraCachedTokens !== undefined
                ? { astraCachedTokens: this.lastAstraCachedTokens }
                : {}),
            },
          }
        : {}),
    };
  }

  private recordTurn(
    root: string,
    model: string,
    turn: Parameters<typeof appendTurn>[1],
  ): void {
    if (!this.opts.sessions) return;

    this.persisted ??= this.opts.sessions.create(root, model);
    this.persisted.model = model;
    appendTurn(this.persisted, turn);
    // Ảnh ở lại trong RAM để hỏi tiếp về nó được, nhưng KHÔNG xuống đĩa: một
    // ảnh chụp màn hình base64 thổi file phiên lên vài MB cho mỗi lượt.
    this.persisted.messages = this.history.map((m) =>
      m.role === 'user' && m.images ? { role: 'user' as const, content: m.content } : m,
    );
    this.persisted.compactions = this.compactions;
    this.persisted.toolSummaries = this.collectToolSummaries();
    if (this.persisted.turns.length === 1) this.persisted.title = titleFrom(turn.prompt);
  }

  /**
   * Tóm tắt tool cho những lời gọi CÒN trong lịch sử.
   *
   * Lọc theo `messages` chứ không đổ cả map: nén ngữ cảnh cắt mất phần đầu, và
   * giữ lại tóm tắt của những lời gọi không còn message nào trỏ tới là để file
   * phiên phình lên vô hạn theo mỗi lượt nén.
   */
  private collectToolSummaries(): Record<string, PersistedToolSummary> {
    const out: Record<string, PersistedToolSummary> = {};
    for (const m of this.history) {
      if (m.role !== 'assistant') continue;
      for (const call of m.toolCalls ?? []) {
        const saved = this.toolSummaries.get(call.id);
        if (saved) out[call.id] = saved;
      }
    }
    return out;
  }

  private async persist(): Promise<void> {
    if (!this.opts.sessions || !this.persisted) return;
    await this.opts.sessions.save(this.persisted);
    void this.opts.sessions.prune();
  }

  /**
   * Ghi bản chụp của lượt vừa xong xuống `~/.astra/file-history/`.
   *
   * Sau `persist()` chứ không trước: file phiên là thứ quyết định phiên có tồn
   * tại hay không, và một bản chụp mồ côi (phiên chưa kịp lưu) chỉ là rác chờ
   * lần dọn dẹp sau.
   */
  private async persistCheckpoint(turnId: string): Promise<void> {
    const store = this.opts.fileHistory;
    const checkpoint = this.opts.checkpoints?.get(turnId);
    const sessionId = this.persisted?.id;
    if (!store || !checkpoint || !sessionId) return;
    await store.saveTurn(sessionId, checkpoint);
  }

  /**
   * Hỏi trước lần `/undo` đầu tiên của một phiên vừa mở lại.
   *
   * Bản chụp có thể đã vài ngày tuổi: file trên đĩa đã đi tiếp, và ghi đè nó
   * bằng nội dung cũ có thể xoá mất việc người dùng làm sau đó. Trong một phiên
   * đang chạy thì không hỏi — ở đó "lượt vừa rồi" nghĩa là vài giây trước.
   */
  private async confirmUndoAfterResume(): Promise<boolean> {
    if (!this.undoNeedsConfirm) return true;

    const answer = await vscode.window.showWarningMessage(
      'This conversation was reopened from an earlier session.',
      {
        modal: true,
        detail:
          'Undo restores the files as they were before that turn. Anything changed since then — by you, by a build, or by switching branches — will be overwritten.',
      },
      'Undo anyway',
    );
    if (answer !== 'Undo anyway') return false;

    this.undoNeedsConfirm = false;
    return true;
  }

  // ── Tác vụ nền ───────────────────────────────────────────────────────────

  /**
   * Nói cho NGƯỜI DÙNG biết một tác vụ nền vừa xong.
   *
   * Cần thiết vì tác vụ hay kết thúc lúc agent đang im: lượt chat đã trả lời
   * xong từ ba phút trước, và không có dòng này thì bản build hỏng nằm im
   * trong bộ nhớ cho tới khi có ai đó tình cờ hỏi lại.
   */
  private announceJob(event: JobEvent): void {
    if (event.type !== 'finished') return;
    const job = event.job;
    const what =
      job.status === 'done'
        ? 'finished'
        : job.status === 'killed'
          ? 'was stopped'
          : job.timedOut
            ? 'timed out'
            : `failed with exit code ${job.exitCode ?? '?'}`;
    this.opts.emit({
      type: 'note',
      text: `Background task ${job.id} ${what}: ${job.description ?? job.command}`,
    });
  }

  /**
   * Tình hình tác vụ nền, gắn vào đầu câu hỏi của lượt kế tiếp.
   *
   * Đánh dấu rõ là do AstraCode chèn: nó nằm trong lượt `user`, tức là vùng
   * tin cậy, nên model không được hiểu nhầm đây là lời người dùng. Nội dung ở
   * đây chỉ có dòng lệnh do CHÍNH model viết ra ở lượt trước cộng trạng thái
   * tiến trình — output của lệnh KHÔNG đi qua đây, nó về qua `task_status` để
   * còn đi đúng đường bọc delimiter và quét injection.
   */
  private backgroundNews(): string {
    const finished = this.jobs.unreported();
    const running = this.jobs.running();
    if (finished.length === 0 && running.length === 0) return '';

    const lines = [...finished, ...running].map((job) => `- ${describeJob(job)}`);
    return (
      `<background_tasks from="AstraCode">\n${lines.join('\n')}\n</background_tasks>\n` +
      `Đọc output bằng task_status trước khi kết luận về những tác vụ này.\n\n`
    );
  }

  /**
   * Nội dung pin (tính năng ghim), gắn vào ĐẦU câu hỏi của lượt này.
   *
   * Trước đây nằm trong system prompt (chỉ thị nền chung); giờ gắn thẳng vào
   * lượt `user` để rõ nó thuộc về CÂU HỎI HIỆN TẠI, không cần người dùng gõ
   * thêm một câu bảo model "đọc đoạn đã ghim" — model đã thấy nó ngay trong
   * chính tin nhắn đang trả lời. Vẫn là DỮ LIỆU không tin cậy, thẻ
   * `<pinned_context>` do `renderPinnedContext()` tạo đã được TRUST_BOUNDARY
   * trong system prompt giải thích từ trước.
   */
  private pinnedPreamble(rendered: string): string {
    return (
      `Người dùng đã chọn các đoạn code/file dưới đây và ghim vào cuộc trò chuyện ` +
      `này để dùng cho câu hỏi bên dưới. Dùng ngay nội dung đã có, không cần gọi ` +
      `lại read_file cho đúng phần đã ghim.\n\n${rendered}\n\n---\n\n`
    );
  }

  private async readAstraignore(root: string): Promise<{ astraignore?: string }> {
    try {
      const uri = vscode.Uri.joinPath(vscode.Uri.file(root), '.astraignore');
      const bytes = await vscode.workspace.fs.readFile(uri);
      return { astraignore: new TextDecoder().decode(bytes) };
    } catch {
      return {};
    }
  }
}

/** Tên file để hiện trên chip pin — `path` luôn dùng `/` (xem `pinCommand.ts`). */
export function baseName(path: string): string {
  return path.split('/').pop() || path;
}

/**
 * Số dòng agent thêm/xoá trong một lượt, đọc từ sổ thay đổi.
 *
 * Đếm bằng diff thật (`diffLines`) chứ không bằng hiệu số dòng: một lượt viết
 * lại 10 dòng tại chỗ có hiệu số bằng 0, và báo "0 dòng" cho việc đó là báo sai
 * đúng thứ mà board Năng suất tồn tại để đo.
 *
 * File mới tính toàn bộ là thêm, file bị xoá tính toàn bộ là bớt — `null` ở hai
 * đầu nội dung nghĩa là "chưa từng có" và "không còn nữa", không phải file rỗng.
 */
function linesChangedIn(
  ledger: ChangeLedger,
  turnId: string,
): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const change of ledger.byTurn(turnId)) {
    const stat = diffStat(diffLines(change.originalContent ?? '', change.currentContent ?? ''));
    linesAdded += stat.added;
    linesRemoved += stat.removed;
  }
  return { linesAdded, linesRemoved };
}

export interface ChatErrorText {
  message: string;
  hint?: string;
  hintAction?: 'signIn';
}

/**
 * Câu hiện trên UI cho một lỗi đã phân loại.
 *
 * Tách khỏi `describeChatError` vì lỗi giờ tới từ HAI đường: một exception ném
 * ra ngoài `run()`, và `AgentRunResult.error` của một lượt dừng vì lỗi nhưng vẫn
 * giữ tiến độ (sổ nợ #10). Cả hai chỉ có `code` + `message`, nên chỗ quyết định
 * câu chữ nhận đúng hai thứ đó chứ không nhận một object lỗi.
 */
export function describeErrorCode(code: string, message: string): ChatErrorText {
  switch (code) {
    case 'auth_required':
      // Nút phải mở luôn trình duyệt đăng nhập — mở bảng cài đặt rồi bắt
      // người dùng tự tìm nút "Sign in" thật bên trong là bấm hai lần cho
      // một việc, và cái tên nút "Sign in to AstraWork" đã hứa làm ngay.
      return { message, hint: 'Sign in to AstraWork', hintAction: 'signIn' };
    case 'budget_exceeded':
      return { message, hint: 'Check your quota in AstraWork' };
    case 'rate_limited':
      return { message: 'Rate limited. Try again in a few minutes.' };
    case 'content_rejected':
      // Tới được đây nghĩa là AgentLoop đã che và gửi lại mà vẫn bị chặn, nên
      // đừng hứa "thử lại đi". Nói ra thứ người dùng làm được: bỏ đoạn đó ra
      // khỏi hội thoại. Nêu rule là để họ biết tìm cái gì.
      return { message, hint: 'Start a new chat or remove that snippet' };
    case 'stream_interrupted':
      // Câu trả lời trên màn hình là bản dở, và phần tool đã chạy vẫn còn trong
      // hội thoại — nên việc đúng là hỏi tiếp để agent làm nốt, không phải gõ
      // lại từ đầu.
      return { message, hint: 'Ask again to continue from here' };
    case 'gateway_unreachable':
      return { message, hint: 'Open AstraCode settings' };
    default:
      return { message };
  }
}

export function describeChatError(err: unknown): ChatErrorText {
  if (err instanceof AstraError) {
    return describeErrorCode(err.code, err.message);
  }
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

