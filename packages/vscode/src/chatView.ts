/**
 * Webview chat — mốc M3.
 *
 * Bảo mật (documents/SECURITY.md §6): CSP nonce, không
 * unsafe-inline, không CDN, validate mọi message từ webview. Thêm một thứ nữa
 * riêng cho chat: output của model được sanitize bằng DOMPurify TRƯỚC khi
 * render — nó là nội dung không tin cậy hạng nhất.
 */
import * as vscode from 'vscode';
import type {
  ChangeLedger,
  CheckpointStore,
  CodeGraphProvider,
  FileHistoryStore,
  HistoryLog,
  HookApprovalStore,
  Logger,
  PermissionManager,
  PinnedRef,
  Sandbox,
  SessionStore,
  StateStore,
  TodoStore,
  Tool,
} from '@astra/core';
import { describeError, makeNonce } from './adapters.js';
import { updateConfig } from './config.js';
import type { AstraSession } from './session.js';
import type { UsageSync } from './telemetry/UsageSync.js';
import type { AccountUsageStore } from './telemetry/AccountUsage.js';
import { ChatController, baseName } from './chat/ChatController.js';
import { MentionIndex } from './chat/mentionIndex.js';
import { fuzzyRank } from '@astra/core';
import { refForSelection } from './pinCommand.js';
import {
  CHAT_PROTOCOL_VERSION,
  MAX_IMAGE_BASE64,
  parseChatMessage,
  type ChatHostPayload,
  type ChatWebviewMessage,
  type ImageMediaType,
  type MentionItem,
  type SelectionHintWire,
  type SettingsModelRow,
  type SettingsWire,
  type WorkWire,
} from './chat/protocol.js';

const MENTION_LIMIT = 20;

/**
 * Workspace root ĐANG ACTIVE — folder chứa editor đang focus, không phải folder
 * đầu tiên. Trong multi-root workspace mở nhiều folder, `@` phải load file từ
 * folder người dùng đang làm việc, không phải folder khai báo đầu tiên.
 * Không có editor active thì fallback về folder đầu tiên.
 */
function activeWorkspaceRoot(): vscode.WorkspaceFolder | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) return folder;
  }
  return vscode.workspace.workspaceFolders?.[0];
}

/** Kiểu ảnh suy từ đuôi file. Đuôi lạ = không đính kèm, không đoán bừa. */
function mediaTypeOf(path: string): ImageMediaType | undefined {
  const ext = path.toLowerCase().split('.').pop();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return undefined;
  }
}

/**
 * Bao lâu thì coi như webview đã chết lúc nạp.
 *
 * `chat.js` gửi `ready` ngay khi script chạy xong, nên trên máy khoẻ con số này
 * là vài chục ms. Để rộng vì lần mở đầu tiên còn phải nạp bundle từ đĩa, và một
 * lần nạp lại thừa còn đỡ hơn một panel trắng.
 */
const READY_TIMEOUT_MS = 4000;

/** Số lần nạp lại tối đa cho mỗi webview. Xem `load()` để biết vì sao có trần. */
const MAX_RELOADS = 2;

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'astracode.chat';

  private readonly targets = new Set<vscode.Webview>();
  /**
   * Webview đã nạp xong chưa, và đã nạp lại mấy lần. Xem `load()`.
   *
   * Khoá theo webview chứ không phải một cờ chung: VS Code có thể dựng lại
   * webview (khôi phục cửa sổ) trong khi cái cũ chưa kịp dispose, nên hai
   * webview cùng sống một lúc và một cái hỏng không nói gì về cái kia.
   */
  private readonly loads = new Map<
    vscode.Webview,
    { ready: boolean; reloads: number; timer?: ReturnType<typeof setTimeout> }
  >();
  private readonly controller: ChatController;
  private readonly disposables: vscode.Disposable[] = [];
  /** Chỉ mục file toàn workspace cho ô gợi ý `@mention`. Xem `MentionIndex`. */
  private readonly mentionIndex = new MentionIndex();
  private readonly sessions: SessionStore | undefined;
  private readonly usage: UsageSync | undefined;
  private readonly account: AccountUsageStore | undefined;
  /**
   * Người dùng bấm "Hội thoại cũ" khi panel chat chưa từng mở.
   *
   * `reveal()` chỉ ra lệnh focus; webview nạp xong sau đó vài chục ms. Gửi danh
   * sách ngay lúc này thì nó rơi vào hư không — nên nhớ ý định và phát lại khi
   * webview báo `ready`.
   */
  private historyPending = false;
  /** Cùng lý do với `historyPending`, cho lệnh "Mở cài đặt". */
  private settingsPending = false;
  /**
   * Gợi ý pin đang hiện trong panel chat (nếu có) — bôi đen trong editor xuất
   * hiện ở đây thay vì chỉ qua menu chuột phải. Giữ lại bản đầy đủ (không chỉ
   * gửi cho webview) vì lúc người dùng bấm "Pin", focus đã chuyển sang webview
   * — `vscode.window.activeTextEditor` lúc đó không còn đáng tin, nên phải nhớ
   * sẵn từ lúc `onDidChangeTextEditorSelection` nổ.
   */
  private selectionHint: SelectionHintWire | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly session: AstraSession,
    private readonly logger: Logger,
    deps: {
      ledger: ChangeLedger;
      permissions: PermissionManager;
      todos: TodoStore;
      getSandbox: () => Sandbox | undefined;
      getMcpTools?: () => Tool[];
      /** CodeGraph theo workspace (M12) — không truyền = không có find_references/impact_of. */
      getCodeGraph?: (root: string) => CodeGraphProvider;
      sessions?: SessionStore;
      checkpoints?: CheckpointStore;
      fileHistory?: FileHistoryStore;
      promptLog?: HistoryLog;
      state?: StateStore;
      applyRevert?: (
        ops: Array<{ uri: string; content: string | null }>,
      ) => Promise<{ reverted: number; failed: string[] }>;
      autoCompact?: () => boolean;
      verifyCommand?: () => { command: string; ignoredFromWorkspace: boolean };
      hookApprovals?: HookApprovalStore;
      nativeUnsupported?: { has: (id: string) => boolean; add: (id: string) => void };
      /** Sổ mức dùng tích luỹ + đường đẩy lên AstraWork (M10). */
      usage?: UsageSync;
      /** Số của tài khoản đọc ngược từ AstraWork — nội dung mục "Usage". */
      account?: AccountUsageStore;
    },
  ) {
    this.usage = deps.usage;
    this.account = deps.account;
    this.controller = new ChatController({
      session,
      logger,
      emit: (payload) => this.post(payload),
      ledger: deps.ledger,
      permissions: deps.permissions,
      todos: deps.todos,
      getSandbox: deps.getSandbox,
      ...(deps.getMcpTools ? { getMcpTools: deps.getMcpTools } : {}),
      ...(deps.getCodeGraph ? { getCodeGraph: deps.getCodeGraph } : {}),
      ...(deps.sessions ? { sessions: deps.sessions } : {}),
      ...(deps.checkpoints ? { checkpoints: deps.checkpoints } : {}),
      ...(deps.fileHistory ? { fileHistory: deps.fileHistory } : {}),
      ...(deps.promptLog ? { promptLog: deps.promptLog } : {}),
      ...(deps.state ? { state: deps.state } : {}),
      ...(deps.applyRevert ? { applyRevert: deps.applyRevert } : {}),
      ...(deps.autoCompact ? { autoCompact: deps.autoCompact } : {}),
      ...(deps.verifyCommand ? { verifyCommand: deps.verifyCommand } : {}),
      ...(deps.hookApprovals ? { hookApprovals: deps.hookApprovals } : {}),
      ...(deps.nativeUnsupported ? { nativeUnsupported: deps.nativeUnsupported } : {}),
      ...(deps.usage || deps.account
        ? {
            recordUsage: (s) => {
              deps.usage?.record(s);
              // Lượt vừa xong ĐÃ được gateway ghi vào sổ audit của nó — đọc lại
              // để bảng hiện đúng con số mà trang AstraWork đang hiện, thay vì
              // đợi tới lần người dùng mở lại bảng.
              deps.account?.scheduleAfterTurn();
            },
          }
        : {}),
    });
    this.sessions = deps.sessions;

    // Đổi model hay đăng nhập lại thì trạng thái "gửi được chưa" đổi theo, và
    // bảng cài đặt (nếu đang mở) phải thấy ngay — nó là nơi người dùng vừa bấm.
    this.disposables.push(
      session.onDidChange(() => {
        void this.pushReadiness();
        void this.pushSettings();
        this.pushWork();
        // Chuẩn dự án về SAU khi webview báo `ready` (đăng nhập xong, đổi dự
        // án, hoặc lần tự làm mới sau 10 phút), nên ô gợi ý `/` phải dựng lại.
        // Tự bỏ qua khi bản chuẩn không đổi — xem `refreshCommandsIfStale`.
        void this.controller.refreshCommandsIfStale();
        // Đăng nhập xong (hay chuỗi vừa dựng lại lúc khởi động) là lúc duy nhất
        // hai ô chọn có thể điền được mà chưa ai đi đọc. `ensureWork` chỉ đọc
        // một lần cho mỗi chuỗi, nên đường này không thành vòng lặp: nó tự đẩy
        // một `onDidChange` nữa, và lần ấy rơi vào nhánh "đã thử rồi".
        void this.session.ensureWork();
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        void this.pushReadiness();
        this.updateSelectionHint(e.textEditor);
      }),
      // Đổi tab không tự nổ sự kiện selection ở trên (selection của editor cũ
      // không đổi) — phải nghe riêng để gợi ý theo đúng editor đang xem.
      vscode.window.onDidChangeActiveTextEditor((editor) => this.updateSelectionHint(editor)),
    );

    // Sổ mức dùng đổi sau MỖI lượt, kể cả khi bảng cài đặt đang đóng. Đẩy sang
    // webview ngay để lần mở tiếp theo không hiện một con số đã cũ.
    if (deps.usage) this.disposables.push(deps.usage.onDidChange(() => void this.pushSettings()));
    if (deps.account) {
      this.disposables.push(deps.account.onDidChange(() => void this.pushSettings()));
    }
  }

  dispose(): void {
    this.controller.dispose();
    this.mentionIndex.dispose();
    // Đồng hồ canh nạp phải tắt trước: một cái còn sống sau khi extension tắt
    // sẽ gán HTML vào một webview đã đi rồi.
    for (const webview of this.loads.keys()) this.clearWatchdog(webview);
    this.loads.clear();
    for (const d of this.disposables) d.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.attach(view.webview, view);
    view.onDidDispose(() => {
      this.clearWatchdog(view.webview);
      this.loads.delete(view.webview);
      this.targets.delete(view.webview);
    });

    // View bị giấu đi rồi hiện lại là cơ hội thử lại rẻ nhất: nếu lần nạp trước
    // chết giữa chừng, người dùng vừa nhìn thẳng vào panel trắng ấy.
    view.onDidChangeVisibility(() => {
      if (view.visible && this.loads.get(view.webview)?.ready === false) {
        this.load(view.webview, view);
      }
    });
  }

  reveal(): void {
    void vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
  }

  clear(): void {
    this.controller.clear();
  }

  stop(): void {
    this.controller.stop();
  }

  undo(): Promise<boolean> {
    return this.controller.undoLastTurn();
  }

  /**
   * Ghim một file/đoạn dòng — gọi từ lệnh "AstraCode: Add to Chat" (editor
   * context menu), xem `pinCommand.ts`.
   *
   * Mở panel ra: mục đích của pin là người dùng THẤY chip vừa xuất hiện, một
   * pin âm thầm không hiện gì thì không khác gì không làm.
   */
  async addPin(ref: PinnedRef): Promise<void> {
    this.reveal();
    await this.controller.addPin(ref);
  }

  /**
   * Mở bảng cài đặt — nó sống trong panel chat, không còn view riêng.
   *
   * Một bề mặt cài đặt duy nhất là có chủ ý: hai bảng cài đặt song song sẽ lệch
   * nhau ngay lần đầu ai đó thêm một tuỳ chọn vào đúng một bên.
   */
  async openSettings(): Promise<void> {
    this.reveal();
    if (this.targets.size === 0) {
      this.settingsPending = true;
      return;
    }
    await this.pushSettings(true);
  }

  /**
   * Mở bảng hội thoại cũ ngay trong panel chat.
   *
   * Khác `pickSession()` ở chỗ nó không rời khỏi panel: xem lại một hội thoại
   * cũ là việc vừa nhìn vừa chọn, mà QuickPick thì che mất chỗ đang nhìn.
   */
  async showHistory(): Promise<void> {
    this.reveal();
    if (this.targets.size === 0) {
      this.historyPending = true;
      return;
    }
    await this.controller.listSessions(true);
  }

  /** Chọn một phiên cũ và mở lại. Dùng từ Command Palette (M6). */
  async pickSession(): Promise<void> {
    const sessions = this.sessions;
    if (!sessions) return;

    const root = activeWorkspaceRoot()?.uri.fsPath ?? '';
    const items = await sessions.list(root);
    if (items.length === 0) {
      void vscode.window.showInformationMessage('No session has been saved for this workspace yet.');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      items.map((s) => ({
        label: s.title,
        description: `${s.turns} turns · ${s.totalTokens} tokens`,
        detail: new Date(s.updatedAt).toLocaleString(),
        id: s.id,
      })),
      { title: 'Reopen an AstraCode session', placeHolder: 'Pick a session' },
    );
    if (!picked) return;

    this.reveal();
    await this.controller.resumeSession(picked.id);
  }

  private roots(): vscode.Uri[] {
    return [
      vscode.Uri.joinPath(this.extensionUri, 'media'),
      vscode.Uri.joinPath(this.extensionUri, 'dist'),
    ];
  }

  private attach(webview: vscode.Webview, view?: vscode.WebviewView): void {
    webview.options = { enableScripts: true, localResourceRoots: this.roots() };

    webview.onDidReceiveMessage((raw: unknown) => {
      const msg = parseChatMessage(raw);
      if (!msg) {
        this.logger.warn('ignoring an invalid chat message from the webview');
        return;
      }
      // Tin đầu tiên bất kỳ chứng minh script trong webview đang chạy — không
      // chỉ riêng `ready`, vì `ready` có thể tới sau một thao tác của người dùng
      // nếu thứ tự thay đổi. Tắt đồng hồ canh ngay để không nạp lại một webview
      // đang sống, việc sẽ xoá đúng thứ người dùng vừa gõ vào ô nhập.
      this.markLoaded(webview);
      void this.handle(msg);
    });

    this.targets.add(webview);
    this.load(webview, view);
  }

  /**
   * Nạp nội dung webview, và canh xem nó có sống dậy không.
   *
   * VS Code phục vụ tài nguyên webview qua một service worker. Khi nhiều webview
   * cùng dựng — ví dụ cửa sổ vừa khôi phục — bước đăng ký ấy có thể hỏng với
   * `Could not register service worker:
   * InvalidStateError: The document is in an invalid state`. Đó là lỗi phía
   * VS Code, extension không tác động được vào lúc đăng ký.
   *
   * Cái tệ hơn là hệ quả: iframe ở lại trang lỗi VĨNH VIỄN. Không script nào
   * chạy nên không có gì tự sửa được từ bên trong, và người dùng nhìn một panel
   * trắng cho tới khi họ tự đoán ra là phải reload cả cửa sổ.
   *
   * Không có API nào hỏi được "webview nạp xong chưa", nên dấu hiệu duy nhất là
   * tin nhắn đầu tiên từ `chat.js`. Im lặng quá `READY_TIMEOUT_MS` thì gán lại
   * HTML: tài liệu mới đăng ký lại service worker, và lần thứ hai hầu như luôn
   * qua. Nonce đổi mỗi lần gọi `html()` nên chuỗi luôn khác chuỗi cũ — điều kiện
   * để VS Code thật sự nạp lại chứ không bỏ qua phép gán.
   *
   * Trần `MAX_RELOADS` là bắt buộc: nếu webview im vì một lý do khác (bundle
   * hỏng, CSP chặn script), nạp lại vô hạn biến một lỗi hiển thị thành một vòng
   * lặp ngốn CPU không ai dừng được.
   */
  private load(webview: vscode.Webview, view?: vscode.WebviewView): void {
    const state = this.loads.get(webview) ?? { ready: false, reloads: 0 };
    this.clearWatchdog(webview);

    webview.html = this.html(webview);

    state.ready = false;
    state.timer = setTimeout(() => {
      const current = this.loads.get(webview);
      if (!current || current.ready) return;
      if (current.reloads >= MAX_RELOADS) {
        this.logger.warn('the chat webview never came up; reload the window to try again');
        return;
      }
      // View đang bị giấu thì để `onDidChangeVisibility` lo — nạp lại một thứ
      // không ai nhìn chỉ tốn một vòng dựng DOM.
      if (view && !view.visible) return;

      current.reloads += 1;
      this.logger.warn('the chat webview did not report ready; loading it again', {
        attempt: current.reloads,
      });
      this.load(webview, view);
    }, READY_TIMEOUT_MS);

    this.loads.set(webview, state);
  }

  private markLoaded(webview: vscode.Webview): void {
    const state = this.loads.get(webview);
    if (!state || state.ready) return;
    state.ready = true;
    this.clearWatchdog(webview);
  }

  private clearWatchdog(webview: vscode.Webview): void {
    const state = this.loads.get(webview);
    if (!state?.timer) return;
    clearTimeout(state.timer);
    delete state.timer;
  }

  private post(payload: ChatHostPayload): void {
    for (const webview of this.targets) {
      void webview.postMessage({ ...payload, protocolVersion: CHAT_PROTOCOL_VERSION });
    }
  }

  private async pushReadiness(): Promise<void> {
    if (this.targets.size === 0) return;
    this.post(await this.controller.describeReadiness());
  }

  /**
   * Gợi ý pin trong panel chat khi selection đổi — xem `refForSelection`.
   *
   * Chỉ hiện khi selection KHÔNG RỖNG: selection rỗng (pin cả file) vẫn chỉ
   * qua menu chuột phải, vì không có gì "vừa bôi đen" để gợi ý.
   *
   * Luôn cập nhật `this.selectionHint` kể cả khi panel đang đóng (`post()` tự
   * no-op khi `targets` rỗng) — không thì mở lại panel sau khi đã đổi selection
   * lúc đóng sẽ đẩy một gợi ý CŨ, sai với editor đang thấy.
   */
  private updateSelectionHint(editor: vscode.TextEditor | undefined): void {
    const ref = editor && !editor.selection.isEmpty ? refForSelection(editor) : undefined;
    this.selectionHint =
      ref && ref.startLine !== undefined && ref.endLine !== undefined
        ? { path: ref.path, name: baseName(ref.path), startLine: ref.startLine, endLine: ref.endLine }
        : undefined;
    this.post({ type: 'selectionHint', ref: this.selectionHint ?? null });
  }

  /**
   * Nội dung bảng cài đặt.
   *
   * Gửi vô điều kiện khi trạng thái đổi, kể cả lúc bảng đang đóng: webview giữ
   * bản mới nhất và vẽ lại tại chỗ. Rẻ hơn nhiều so với việc host phải theo dõi
   * xem lớp phủ bên kia đang mở hay đóng — một trạng thái nữa để lệch nhau.
   */
  private async pushSettings(open = false): Promise<void> {
    if (this.targets.size === 0) return;
    this.post({ type: 'settings', state: await this.buildSettings(), ...(open ? { open } : {}) });
  }

  private async buildSettings(): Promise<SettingsWire> {
    // Đăng nhập rồi mà bảng model trống là trạng thái không đáng tồn tại: nó
    // nói "chưa có model" trong khi thứ duy nhất còn thiếu là một lời gọi mạng
    // mà chính bảng này biết cách gọi. `ensureModels` chỉ thử một lần cho mỗi
    // chuỗi nên nó không biến việc vẽ lại bảng thành một vòng bắn request.
    await this.session.ensureModels();
    const s = await this.session.status();
    const registry = this.session.getRegistry();

    const models: SettingsModelRow[] = s.models.map((m) => ({
      id: m.id,
      label: m.label || m.id,
      available: m.available,
      allowed: m.allowed,
      online: m.online,
      toolCalling: m.toolCalling,
      contextWindow: m.contextWindow,
      injectionResistance: m.injectionResistance,
      profileSource: m.profileSource,
      safeForWrite: registry?.safeForWrite(m.id) ?? false,
    }));

    return {
      sourceLabel: s.sourceLabel,
      authenticated: s.authenticated,
      ...(s.username ? { username: s.username } : {}),
      ...(s.role ? { role: s.role } : {}),
      ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}),
      models,
      selected: s.config.model,
      ...(s.activeModel ? { active: s.activeModel } : {}),
      selectedPlan: s.config.planModel,
      ...(s.activePlanModel ? { activePlan: s.activePlanModel } : {}),
            missingProfiles: s.missingProfiles,
      ...(s.lastError ? { lastError: s.lastError } : {}),
      usage: this.controller.usage(),
      // Đọc lại nếu số đang giữ đã cũ. Không `force`: bảng này được vẽ lại sau
      // mỗi thay đổi nhỏ, và mỗi lần vẽ một request là một tràng request.
      account: this.accountState(),
      projectAgents: this.projectAgentsState(),
      // Không có sổ = đường đẩy chưa dựng (test). Vẫn trả hình dạng hợp lệ:
      // webview không nên có nhánh "thiếu trường" cho thứ luôn có trong bản thật.
      metricsSync: this.usage?.state() ?? { syncing: false, pendingTurns: 0 },
    };
  }

  /**
   * Trạng thái mục "Usage": số của tài khoản ở AstraWork.
   *
   * Việc đọc lại chạy NGẦM chứ không chặn việc vẽ bảng — chờ một lời gọi mạng
   * xong rồi mới hiện bảng cài đặt là biến một thao tác tức thời thành một
   * khoảng trắng vài trăm mili giây. Đọc xong thì `onDidChange` đẩy bản mới.
   */
  /**
   * Bộ agent chung của dự án, cho bảng cài đặt.
   *
   * Chỉ ĐỌC trạng thái đang giữ, không gọi mạng: việc lấy về đã tự chạy ở
   * `AstraSession` (lúc mở, lúc đăng nhập, lúc đổi dự án, và mỗi 10 phút khi
   * đang chat). Gọi thêm ở đây sẽ biến mỗi lần vẽ bảng thành một request.
   */
  private projectAgentsState(): SettingsWire['projectAgents'] {
    const s = this.session.getProjectAgents();
    return {
      names: s.agents.map((a) => a.name),
      skillNames: s.skills.map((a) => a.name),
      version: s.standard.version,
      ...(s.standard.updated_by ? { updatedBy: s.standard.updated_by } : {}),
      ...(s.standard.updated_at ? { updatedAt: s.standard.updated_at } : {}),
      source: s.source,
      stale: s.stale,
    };
  }

  private accountState(): SettingsWire['account'] {
    if (!this.account) return { available: false, loading: false };
    void this.account.refresh();
    return this.account.state();
  }

  /**
   * Đẩy trạng thái dự án/task xuống webview.
   *
   * Task rút gọn còn `{id, label}` ngay tại đây: phần còn lại của một task WBS
   * là dữ liệu dự án, và webview không cần — cũng không nên — giữ nó.
   */
  private pushWork(): void {
    const work = this.session.work();
    const state: WorkWire = {
      projects: work.projects.map((p) => ({ id: p.id, name: p.name })),
      tasks: work.tasks.map((t) => ({
        id: t.id,
        label: t.code ? `${t.code} · ${t.title}` : t.title,
        planStart: t.planStart,
        planEnd: t.planEnd,
      })),
      ...(work.projectId !== undefined ? { projectId: work.projectId } : {}),
      ...(work.taskId !== undefined ? { taskId: work.taskId } : {}),
      ...(work.taskLabel ? { taskLabel: work.taskLabel } : {}),
      ...(work.otherStages ? { otherStages: work.otherStages } : {}),
      ...(work.loading ? { loading: true } : {}),
      ...(work.error ? { error: work.error } : {}),
    };
    this.post({ type: 'work', state });
  }

  private async withBusy(label: string, fn: () => Promise<void>): Promise<void> {
    this.post({ type: 'settingsBusy', busy: true, label });
    try {
      await fn();
    } catch (err) {
      this.post({ type: 'notice', level: 'error', text: describeError(err) });
    } finally {
      this.post({ type: 'settingsBusy', busy: false });
      await this.pushSettings();
    }
  }

  private async handle(msg: ChatWebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.pushReadiness();
        // Vẽ ngay bằng lựa chọn đã lưu, rồi mới đi hỏi gateway: thanh chọn
        // hiện đúng task đang khai từ lần trước mà không phải chờ mạng.
        this.pushWork();
        void this.session.refreshWork().then(() => this.pushWork());
        // Danh sách lệnh và đồng hồ ngữ cảnh chỉ có nghĩa khi webview đã sống.
        await this.controller.refreshCommands();
        this.controller.emitContext();
        await this.controller.emitPins();
        this.post({ type: 'selectionHint', ref: this.selectionHint ?? null });
        await this.controller.pushPromptHistory();
        // Bảng cài đặt có dữ liệu sẵn từ trước khi ai bấm vào nó — mở ra thấy
        // một khung trống rồi mới đầy là cảm giác của một trang web chậm.
        await this.pushSettings(this.settingsPending);
        this.settingsPending = false;
        if (this.historyPending) {
          this.historyPending = false;
          await this.controller.listSessions(true);
        }
        return;

      case 'listSessions':
        await this.controller.listSessions(true);
        return;

      case 'resumeSession':
        await this.controller.resumeSession(msg.id);
        return;

      case 'pinRemove':
        await this.controller.removePin(msg.id);
        return;

      case 'pinSelectionHint': {
        const hint = this.selectionHint;
        if (!hint) return;
        // Đã ghim thì gợi ý hết ý nghĩa (nội dung giờ nằm trong chip pin rồi)
        // — xoá trước khi `addPin` để tránh hiện cả hai cùng lúc.
        this.selectionHint = undefined;
        this.post({ type: 'selectionHint', ref: null });
        await this.addPin({ path: hint.path, startLine: hint.startLine, endLine: hint.endLine });
        return;
      }

      case 'send':
        await this.controller.send(msg.text, msg.images ?? []);
        return;

      case 'stop':
        this.controller.stop();
        return;

      case 'clear':
        this.controller.clear();
        return;

      case 'mentionQuery':
        this.post({ type: 'mentions', query: msg.query, items: await this.findFiles(msg.query) });
        return;

      case 'openFile':
        await this.openFile(msg.path);
        return;

      case 'pickAttachment':
        await this.pickAttachment();
        return;

      // ── Cài đặt ─────────────────────────────────────────────────────────
      case 'openSettings':
        await this.pushSettings();
        return;

      case 'setModel':
        await updateConfig('model', msg.value);
                return;

      case 'setPlanModel':
        await updateConfig('planModel', msg.value);
        return;

      // Đổi model cho phiên đang mở. KHÔNG đi qua `updateConfig` — đó là điểm
      // khác biệt với hai case trên: lựa chọn này không ghi vào settings.json.
      case 'setSessionModel':
        await this.controller.setSessionModel(msg.id ?? undefined);
        return;

      // ── Dự án / task đang làm ───────────────────────────────────────────
      case 'setProject':
        // Đổi dự án là xin token mới, tức là một lời gọi mạng có thể hỏng —
        // báo bằng notice thay vì để hai ô chọn im lặng quay về giá trị cũ.
        try {
          await this.session.switchProject(msg.id);
        } catch (err) {
          this.post({ type: 'notice', level: 'error', text: describeError(err) });
        }
        this.pushWork();
        return;

      case 'setTask':
        await this.session.setTask(msg.id ?? undefined);
        this.pushWork();
        return;

      /**
       * Mở hộp "Report Done". Lỗi đi bằng chính message trả về chứ không phải
       * một notice: webview đã bật trạng thái "đang đọc" khi bấm nút, và nếu
       * không có gì quay lại thì nó đứng đó mãi.
       */
      case 'openTaskReport':
        try {
          this.post({ type: 'taskReport', state: await this.session.taskReport(msg.taskId) });
        } catch (err) {
          this.post({ type: 'taskReport', error: describeError(err) });
        }
        return;

      case 'reportTaskDone':
        try {
          const done = await this.session.reportTaskDone(msg);
          this.post({ type: 'taskReported', taskId: msg.taskId, ...done });
          this.pushWork();
        } catch (err) {
          // Hộp ở lại mở với đúng những gì người dùng đã gõ: bắt gõ lại bốn ô
          // vì gateway chớp một cái là cách nhanh nhất để người ta bỏ luôn nút.
          this.post({ type: 'taskReportFailed', error: describeError(err) });
        }
        return;

      case 'refreshWork':
        await this.session.refreshWork();
        this.pushWork();
        return;

              case 'signIn':
        await vscode.commands.executeCommand('astra.signIn');
        return;

      case 'signOut':
        await vscode.commands.executeCommand('astra.signOut');
        return;

      case 'refreshModels':
        await this.withBusy('fetching the model list', () => this.session.refreshModels());
        return;

      case 'syncUsage':
        // Hai đường khác nhau, cùng một nút: đẩy nốt phần số đo tồn đọng của
        // board, rồi đọc lại con số của tài khoản. Người bấm "Refresh" đang hỏi
        // "số bây giờ là bao nhiêu", nên bản cache còn hạn không phải câu trả lời.
        await this.usage?.flush();
        await this.account?.refresh(true);
        await this.pushSettings();
        return;

      case 'showProjectAgents':
        // Cùng một lệnh với Command Palette, không phải bản sao: lệnh đó tự gọi
        // lại gateway rồi mở trang, nên hai lối vào không thể hiện hai thứ khác
        // nhau. Bảng cài đặt vẽ lại sau đó để số phiên bản khớp trang vừa mở.
        await vscode.commands.executeCommand('astra.showProjectAgents');
        await this.pushSettings();
        return;

      case 'testConnection':
              await vscode.commands.executeCommand('astra.testConnection');
              return;

            case 'showLogs':
              await vscode.commands.executeCommand('astra.showLogs');
              return;

      case 'permissionAnswer':
        this.controller.answerPermission(msg.id, msg.decision);
        return;

      case 'questionAnswer':
        this.controller.answerQuestion(msg.id, msg.selections);
        return;

      case 'setMode':
        this.controller.setMode(msg.mode);
        return;

      case 'showChanges':
        await vscode.commands.executeCommand('astra.changesView.focus');
        return;
    }
  }

  /**
   * Gợi ý file cho `@mention`.
   *
   * Hai nửa tách bạch:
   *   - Lấy ứng viên: `MentionIndex` quét toàn workspace một lần rồi giữ trong
   *     bộ nhớ (xem docstring của nó về vì sao cắt kết quả TRƯỚC khi lọc gần
   *     đúng là sai).
   *   - Lọc gần đúng: `fuzzyRank` (dùng chung với ô gợi ý `/` và `@` của CLI),
   *     vốn `toLowerCase` cả hai phía nên KHÔNG phân biệt hoa thường, và chịu
   *     cả gõ tắt rời rạc ("chatts" → `chat.ts`).
   */
  private async findFiles(query: string): Promise<MentionItem[]> {
    const root = activeWorkspaceRoot();
    if (!root) return [];

    const all = await this.mentionIndex.all(root);
    const ranked = fuzzyRank(all, query, (i) => i.path).slice(0, MENTION_LIMIT).map((r) => r.item);

    // Gợi ý không hiện thì có hai khả năng rất khác nhau: không tìm ra file, hay
    // tìm ra mà không vẽ được. Log số kết quả để phân biệt ngay từ Output channel.
    this.logger.info('@mention suggestions', { query, results: ranked.length });
    return ranked;
  }

  /**
   * Chọn file đính kèm từ đĩa. Việc đọc file do host làm, không phải webview:
   * webview không có quyền vào đĩa, và cho nó quyền đó chỉ để đính kèm một tấm
   * ảnh là đổi một ranh giới bảo mật lấy một tiện ích.
   *
   * Hộp chọn nhận MỌI loại file, và cái gì xảy ra sau đó phụ thuộc loại:
   *
   *   - Ảnh  → đọc thành base64, đi thẳng vào prompt (model nhìn thấy nó).
   *   - Khác → chỉ trả ĐƯỜNG DẪN về, webview chèn `@đường/dẫn` vào ô nhập.
   *
   * Vì sao không nhồi nội dung file text vào prompt luôn: một file 20 MB đủ
   * đốt sạch cửa sổ ngữ cảnh cho thứ mà agent có thể tự đọc đúng đoạn nó cần
   * bằng `read_file`. Đường `@mention` vốn đã làm đúng việc này rồi.
   */
  private async pickAttachment(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      // Khoá đầu tiên là bộ lọc mặc định của hộp thoại — để "Mọi file" đứng
      // trước, nếu không thì cái hộp vẫn chỉ hiện ảnh y như trước.
      filters: {
        'All files': ['*'],
        Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
        'Code & text': [
          'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'cs', 'go', 'rs', 'rb', 'php',
          'c', 'cpp', 'h', 'hpp', 'json', 'yaml', 'yml', 'toml', 'xml', 'html',
          'css', 'scss', 'md', 'txt', 'csv', 'sql', 'sh', 'ps1',
        ],
        Documents: ['pdf', 'docx', 'xlsx', 'pptx'],
      },
    });
    if (!picked || picked.length === 0) return;

    for (const uri of picked) {
      const name = uri.path.split('/').pop() ?? 'file';
      const mediaType = mediaTypeOf(uri.path);

      if (!mediaType) {
        // Trong workspace thì dùng đường dẫn tương đối: `@mention` và mọi tool
        // của agent đều nói bằng đường dẫn đó. Ngoài workspace mới lấy đường
        // tuyệt đối — agent có thể không mở được, nhưng nói ra vẫn hơn im lặng
        // bỏ file người dùng vừa chọn.
        const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
        const path = relative === uri.fsPath ? uri.fsPath.replace(/\\/g, '/') : relative;
        this.post({ type: 'filePicked', path, name });
        continue;
      }

      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const data = Buffer.from(bytes).toString('base64');
        if (data.length > MAX_IMAGE_BASE64) {
          void vscode.window.showWarningMessage(`Image ${name} is too large (limit ~4 MB).`);
          continue;
        }
        this.post({ type: 'imagePicked', image: { name, mediaType, data } });
      } catch (err) {
        this.logger.warn('could not read the attached image', { error: String(err) });
        void vscode.window.showWarningMessage(`Could not read ${name}.`);
      }
    }
  }

  private async openFile(relative: string): Promise<void> {
      const root = activeWorkspaceRoot();
      if (!root) return;

    // Đường dẫn đến từ webview — không tin cậy. Chỉ mở khi nó thực sự nằm
    // trong workspace sau khi giải.
    const target = vscode.Uri.joinPath(root.uri, ...relative.split('/'));
    if (!target.fsPath.toLowerCase().startsWith(root.uri.fsPath.toLowerCase())) {
      this.logger.warn('webview asked to open a file outside the workspace', { path: relative });
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch {
      void vscode.window.showWarningMessage(`Could not open ${relative}`);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'chat.js'),
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'),
    );

    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      // `data:` để hiện thumbnail ảnh người dùng vừa dán. Vẫn không có host nào
      // được phép: ảnh từ mạng không vào được, và output của model không dựng
      // được thẻ <img> vì DOMPurify không cho `img` qua.
      'img-src data:',
      "font-src 'none'",
      "connect-src 'none'",
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${style.toString()}" rel="stylesheet">
  <title>AstraCode Chat</title>
</head>
<body>
  <div id="banner" class="banner" hidden></div>
  <div id="downgrade" class="downgrade" hidden></div>
  <div id="todos" class="todos" hidden></div>
  <div id="context" class="context" hidden></div>
  <!-- Khung chat và lớp giữa trang nằm chung một khối định vị: lớp kia phủ đúng
       vùng tin nhắn, không phủ banner phía trên hay ô nhập phía dưới. -->
  <div class="chat-area">
    <div id="messages" class="messages"></div>
    <!-- Giữa trang, CHỈ khi hội thoại còn trống: dòng "đang nạp" và mức dùng
         của tài khoản ngay sau đó. Phủ lên khung tin nhắn chứ không đẩy nó:
         có tin nhắn rồi thì cả lớp này biến mất, nên không có lúc nào nó che
         mất chữ. Trong CSS nó còn có pointer-events: none, để không bao giờ
         nuốt một cú bấm. -->
    <div id="idle" class="idle" hidden>
      <div id="idleStatus" class="idle-status" hidden></div>
    </div>
  </div>
  <!-- Bảng hội thoại cũ. Cùng một vỏ popup với bảng cài đặt (.modal): hộp nổi,
       lớp mờ, bấm ra ngoài để đóng. Không chèn vào dòng chat vì đây là một chế
       độ riêng ("đang chọn hội thoại") — trộn vào lịch sử tin nhắn sẽ để lại
       một danh sách chết trong hội thoại sau khi đã chọn xong. -->
  <div id="history" class="modal" hidden>
    <button type="button" id="historyScrim" class="modal-scrim" tabindex="-1" aria-label="Close chat history"></button>
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="historyTitle">
      <div class="modal-head">
        <span id="historyTitle" class="modal-title">Chat history</span>
        <button type="button" id="historyClose" class="icon-btn" title="Close (Esc)" aria-label="Close chat history">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div id="historyList" class="history-list"></div>
      <div class="history-foot">
        <button type="button" id="historyNew">New chat</button>
      </div>
    </div>
  </div>
  <!-- Bảng cài đặt: cùng vỏ popup ở trên.
       Lớp mờ là một <button> để bấm-ra-ngoài-để-đóng đến được cả bằng bàn phím. -->
  <div id="settings" class="modal" hidden>
    <button type="button" id="settingsScrim" class="modal-scrim" tabindex="-1" aria-label="Close settings"></button>
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
      <div class="modal-head">
        <span id="settingsTitle" class="modal-title">Settings</span>
        <button type="button" id="settingsClose" class="icon-btn" title="Close (Esc)" aria-label="Close settings">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div id="settingsBody" class="modal-body"></div>
    </div>
  </div>
  <!-- Hộp báo done. Cùng vỏ popup với bảng cài đặt.
       Là một <form> chứ không phải mấy ô rời: Enter phải gửi được, và trình
       duyệt tự lo phần focus/tab giữa các ô ngày. Sáu ô đều sửa được — số
       telemetry chỉ đo được phần đi qua AstraCode, còn một task thật thường
       có cả những giờ không ngồi trong IDE (xem AstraSession.taskReport). -->
  <div id="report" class="modal" hidden>
    <button type="button" id="reportScrim" class="modal-scrim" tabindex="-1" aria-label="Close report"></button>
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="reportTitle">
      <div class="modal-head">
        <span id="reportTitle" class="modal-title">Report task done</span>
        <button type="button" id="reportClose" class="icon-btn" title="Close (Esc)" aria-label="Close report">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </button>
      </div>
      <form id="reportForm" class="modal-body report-body">
        <div id="reportTask" class="report-task"></div>
        <div id="reportLoading" class="report-hint">Reading the task from AstraWork…</div>
        <div id="reportFields" class="report-fields" hidden>
          <label class="report-label" for="reportPlanStart">Plan start</label>
          <input type="date" id="reportPlanStart" class="report-input">
          <label class="report-label" for="reportPlanEnd">Plan end</label>
          <input type="date" id="reportPlanEnd" class="report-input">
          <label class="report-label" for="reportActualStart">Actual start</label>
          <input type="date" id="reportActualStart" class="report-input">
          <label class="report-label" for="reportActualEnd">Actual end</label>
          <input type="date" id="reportActualEnd" class="report-input">
          <label class="report-label" for="reportTokens">Tokens</label>
          <input type="number" id="reportTokens" class="report-input" min="0" step="1" inputmode="numeric">
          <label class="report-label" for="reportCost">Cost (USD)</label>
          <input type="number" id="reportCost" class="report-input" min="0" step="0.0001" inputmode="decimal">
        </div>
        <div id="reportNote" class="report-hint" hidden></div>
        <div id="reportError" class="report-error" hidden></div>
        <div class="report-foot">
          <button type="button" id="reportCancel" class="ghost">Cancel</button>
          <button type="submit" id="reportSubmit" disabled>Report</button>
        </div>
      </form>
    </div>
  </div>
  <!-- Cửa đăng nhập. Chắn NGANG panel khi chưa có phiên: chat không chạy được
       nếu thiếu nó, nên để ô nhập mờ mờ ở đó chỉ mời người dùng gõ vào hư không. -->
  <div id="gate" class="gate" hidden>
    <div class="gate-box">
      <div id="gateTitle" class="gate-title">Sign in to AstraWork to start</div>
      <div id="gateText" class="gate-text"></div>
      <button type="button" id="gateSignIn">Sign in to AstraWork</button>
      <button type="button" id="gateSettings" class="ghost">Open settings</button>
    </div>
  </div>
  <form id="composer" class="composer">
    <!-- Hộp gợi ý phải nằm TRONG .composer: nó định vị bằng position:absolute +
         bottom:100%, mà .composer là ancestor duy nhất có position:relative.
         Để ngoài thì containing block thành viewport và hộp bị đẩy lên trên
         mép màn hình — có dữ liệu nhưng không ai nhìn thấy. -->
    <div id="mentions" class="mentions" hidden></div>
    <!-- Dự án + task đang làm. Nằm TRÊN ô nhập, trong cùng khối với nó: đây là
         ngữ cảnh của câu sắp gõ, không phải một mục cài đặt — số đo của mọi lượt
         gõ ở dưới sẽ được quy về đúng task đang hiện ở đây. Ẩn khi chưa đăng
         nhập (không có gì để chọn) — xem renderWork trong chat.ts. -->
    <div id="workbar" class="workbar">
      <!-- Chỉ PHẦN CHỌN bị ẩn khi chưa đăng nhập hoặc tài khoản không có dự án
           nào, không phải cả hàng: nút mẹo ở cuối hàng vẫn phải với tới được,
           và người cần nó nhất chính là người chưa dựng xong tài khoản. -->
      <span id="workPickers" class="work-pickers" hidden>
        <label class="work-label" for="workProject">Project:</label>
        <select id="workProject" class="work-select"></select>
        <label class="work-label" for="workTask">Task:</label>
        <select id="workTask" class="work-select"></select>
        <!-- Lịch của task đang chọn. Một dòng chữ, không phải một popup: người
             dùng cần biết hạn của việc mình đang gõ mà không phải bấm gì, và
             một thông báo bật lên mỗi lần đổi task sẽ bị tắt từ ngày thứ hai. -->
        <span id="workPlan" class="work-plan" hidden></span>
        <!-- Chỉ hiện khi đã khai một task: không có task thì không có gì để báo. -->
        <button type="button" id="reportDone" class="work-report" title="Mark this WBS task done on AstraWork" hidden>Report Done</button>
        <span id="workNote" class="work-note"></span>
      </span>
      <button type="button" id="tipsToggle" class="tips-toggle" aria-expanded="false" aria-controls="tips" title="A few things AstraCode can do">Tips</button>
    </div>
    <!-- Nội dung dựng ở webview/chat.ts để chữ nằm cùng chỗ với logic đóng/mở. -->
    <div id="tips" class="tips" hidden></div>
    <div class="input-box">
      <!-- Gợi ý ghim khi bôi đen trong editor — dựng ở webview/chat.ts. Nằm
           TRÊN #pins: đây là một LỰA CHỌN (chưa ghim), khác các chip bên dưới
           đã là pin thật. -->
      <div id="selectionHint" class="selection-hint" hidden></div>
      <div id="pins" class="pins" hidden></div>
      <div id="attachments" class="attachments" hidden></div>
      <textarea id="input" rows="1" placeholder="Ask about the codebase…  @ to add a file · / for commands · Ctrl+V to paste an image"></textarea>
      <div class="composer-row">
        <div class="composer-left">
          <button type="button" id="attach" class="icon-btn" title="Attach a file — image, code, document (or Ctrl+V)" aria-label="Attach a file">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </button>
          <!-- Bánh răng thật (răng + trục), không phải vòng tròn có tia: hình tia
               đọc ra thành "độ sáng" hoặc "hiệu ứng" chứ không phải cài đặt. -->
          <button type="button" id="openSettings" class="icon-btn" title="Settings — models, account, connection" aria-label="Settings">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
        </div>
        <div class="composer-right">
          <button type="button" id="changes" class="ghost" hidden>Changes</button>
          <button type="button" id="clear" class="ghost" title="Clear the conversation">Clear</button>
          <!-- Chọn chế độ: nút + bảng bật lên, KHÔNG phải <select>. Mỗi chế độ
               đổi việc agent được tự làm gì với đĩa cứng, nên nó cần một dòng mô
               tả bên cạnh tên — một danh sách ba nhãn trần không nói được điều
               đó, và người dùng chọn nhầm mới biết mình chọn gì. Bảng dựng ở
               webview/chat.ts để tên và mô tả nằm cùng một chỗ với logic. -->
          <div class="mode-picker">
            <button type="button" id="mode" class="mode-btn" aria-haspopup="true" aria-expanded="false" title="Agent permission mode (Shift+Tab to switch)">
              <span id="modeIcon" class="mode-btn-icon" aria-hidden="true"></span>
              <span id="modeLabel" class="mode-btn-label">Ask first</span>
            </button>
            <div id="modeMenu" class="mode-menu" role="menu" hidden></div>
          </div>
          <!-- Chọn model: cùng khuôn nút + bảng bật lên với ô chế độ bên trên,
               và cố ý dùng chung lớp CSS .mode-* — hai ô cạnh nhau trong cùng
               một hàng công cụ mà lệch nhau vài pixel thì trông như lỗi. Lựa
               chọn ở đây chỉ áp cho PHIÊN đang mở, không ghi vào settings; bảng
               nói ra điều đó ngay dưới danh sách. -->
          <div class="mode-picker model-picker">
            <button type="button" id="model" class="mode-btn" aria-haspopup="true" aria-expanded="false" title="Model for this conversation">
              <span id="modelIcon" class="mode-btn-icon" aria-hidden="true"></span>
              <span id="modelLabel" class="mode-btn-label">Model</span>
            </button>
            <div id="modelMenu" class="mode-menu model-menu" role="menu" hidden></div>
          </div>
          <!-- MỘT nút cho cả gửi lẫn dừng: cùng một chỗ, cùng một phím. Hai nút
               thay nhau ẩn/hiện làm hàng công cụ nhảy ngang mỗi lượt, và tay đã
               quen vị trí thì bấm trượt đúng lúc muốn dừng. -->
          <button type="submit" id="send" class="round" title="Send (Enter)" aria-label="Send">
            <svg class="icon-send" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 13V3.5M8 3.5 4 7.5M8 3.5l4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <svg class="icon-stop" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>
          </button>
        </div>
      </div>
    </div>
  </form>
  <script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}
