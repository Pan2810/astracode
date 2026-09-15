/**
 * Điểm vào của extension.
 *
 * Phạm vi hiện tại: chat (kèm bảng cài đặt bên trong nó), sửa file có duyệt
 * quyền và chạy lệnh trong sandbox.
 */
import * as vscode from 'vscode';
import {
  applyIdePolicy,
  AstraError,
  ChangeLedger,
  CheckpointStore,
  FileHistoryStore,
  HistoryLog,
  HomeCleanup,
  Logger,
  NodeFileSystem,
  PermissionManager,
  SessionStore,
  StateStore,
  TodoStore,
  defaultRedactor,
  describeMode,
  migrateHome,
  summarizeChanges,
  type PermissionMode,
} from '@astra/core';
import { OutputChannelSink, activeWorkspaceRoot, describeError } from './adapters.js';
import { inspectVerifyCommand, readConfig } from './config.js';
import { AstraSession } from './session.js';
import { ChatViewProvider } from './chatView.js';
import {
  ChangeDecorationProvider,
  InlineDiffDecorator,
  OriginalContentProvider,
  openDiff,
} from './changes/ChangeUi.js';
import { ChangeItem, ChangesTreeProvider, RevertApplier } from './changes/ChangesTree.js';
import { SandboxManager } from './sandbox/SandboxManager.js';
import { VsCodeApprovalStore } from './chat/Extras.js';
import { readOrCreateMemoryFile } from './chat/memoryFile.js';
import { McpService } from './mcp/McpService.js';
import { manageMcpServers } from './mcp/McpUi.js';
import { CodeGraphService } from './graph/CodeGraphService.js';
import {
  homeLayout,
  migrateGlobalStorageSessions,
  resolveSessionStorage,
} from './session/storage.js';
import { SignInFlow } from './auth/SignInFlow.js';
import { addSelectionToChat } from './pinCommand.js';
import { UsageSync } from './telemetry/UsageSync.js';
import { AccountUsageStore } from './telemetry/AccountUsage.js';
import { extractCredential, type Credential } from './auth/credential.js';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('AstraCode');
  context.subscriptions.push(channel);

  const logger = new Logger({
    sink: new OutputChannelSink(channel),
    level: readConfig().logLevel,
    redactor: defaultRedactor,
  });

  const session = new AstraSession(context, logger);
  context.subscriptions.push(session);

  // ── M4: sổ thay đổi + quyền ──────────────────────────────────────────────
  // Cả hai sống theo CỬA SỔ, không theo lượt chat: người dùng đóng chat rồi mở
  // lại vẫn phải thấy những gì agent đã sửa và vẫn còn hiệu lực quyền đã cấp.
  // ── M6: checkpoint theo lượt ─────────────────────────────────────────────
  // Gắn vào sổ thay đổi qua `onRecord` để KHÔNG có đường nào ghi file mà quên
  // chụp. Sổ giữ bản gốc của cả phiên; checkpoint giữ bản trước từng lượt —
  // hai vai trò khác nhau, xem core/session/Checkpoint.ts.
  const checkpoints = new CheckpointStore();
  const ledger = new ChangeLedger({ onRecord: (input) => checkpoints.capture(input) });
  const permissions = new PermissionManager({
    logger,
    mode: readConfig().permissionMode,
  });
  const todos = new TodoStore();
  const sandboxes = new SandboxManager(logger);
  context.subscriptions.push(sandboxes);

  // ── M7: MCP ──────────────────────────────────────────────────────────────
  // Cổng workspace trust nằm bên trong McpService: nó đọc `workspace.isTrusted`
  // mỗi lần apply(), nên bấm "Trust" xong là MCP tự nạp mà không cần tải lại.
  const mcp = new McpService(logger, context.secrets, context.globalStorageUri);
  context.subscriptions.push(mcp);

  // ── M12: CodeGraph — symbol table + dependency graph ─────────────────────
  const codeGraph = new CodeGraphService(logger, context.extensionUri);
  context.subscriptions.push(codeGraph);

  // ── `~/.astra`: một thư mục nhà dùng chung với CLI ───────────────────────
  // Phiên, bản chụp để undo và lịch sử gõ đều nằm ở đây chứ không trong
  // globalStorage của extension. Xem session/storage.ts để biết vì sao.
  const homeFs = new NodeFileSystem();
  const home = homeLayout();
  const state = new StateStore({ fs: homeFs, layout: home, logger });
  const fileHistory = new FileHistoryStore({ fs: homeFs, layout: home, logger });
  const promptLog = new HistoryLog({ fs: homeFs, layout: home });

  const sessionStorage = resolveSessionStorage({
    workspaceRoot: activeWorkspaceRoot()?.uri.fsPath,
    globalStorage: context.globalStorageUri,
    logger,
  });
  const sessions = new SessionStore({ storage: sessionStorage.storage, logger });

  const decorations = new ChangeDecorationProvider(ledger);
  const originals = new OriginalContentProvider(ledger);
  const inlineDiff = new InlineDiffDecorator(ledger);
  const changesTree = new ChangesTreeProvider(ledger);
  const revert = new RevertApplier();
  context.subscriptions.push(decorations, originals, inlineDiff, changesTree);

  const changesView = vscode.window.createTreeView('astra.changesView', {
    treeDataProvider: changesTree,
    showCollapseAll: false,
  });
  changesTree.attach(changesView);
  context.subscriptions.push(changesView);

  // ── M8: hooks ────────────────────────────────────────────────────────────
  // Duyệt hook lưu ở globalState, KHÔNG trong repo: quyết định tin một lệnh là
  // của người dùng, không phải của thư mục họ đang mở.
  const hookApprovals = new VsCodeApprovalStore(context.globalState);

  // Model nào đã tự chứng minh là không gọi được tool native. Nhớ ở
  // globalState chứ không theo phiên: nó là tính chất của MODEL, không của thư
  // mục đang mở, và quên nó nghĩa là mỗi lần mở VS Code lại tốn một request
  // hỏng để học lại đúng điều vừa học.
  //
  // Từ 0.0.19 nó còn được ghi sang `~/.astra/state.json` để CLI dùng chung: đo
  // ở bên nào thì bên kia khỏi trả giá lại bằng một request hỏng. globalState
  // vẫn là nguồn đọc đồng bộ — `activate()` không await được, và một cổng
  // `has()` bất đồng bộ sẽ lan async vào giữa vòng lặp agent.
  const NATIVE_UNSUPPORTED_KEY = 'astra.nativeToolsUnsupported';
  const nativeUnsupported = {
    has: (id: string): boolean =>
      (context.globalState.get<string[]>(NATIVE_UNSUPPORTED_KEY) ?? []).includes(id),
    add: (id: string): void => {
      void state.markNativeUnsupported(id);
      const seen = context.globalState.get<string[]>(NATIVE_UNSUPPORTED_KEY) ?? [];
      if (seen.includes(id)) return;
      void context.globalState.update(NATIVE_UNSUPPORTED_KEY, [...seen, id]);
      logger.info('remembering that this model cannot call native tools', { model: id });
    },
  };

  // ── Đăng nhập: nhận credential khi người dùng quay lại từ trình duyệt ─────
  // Sống ở đây chứ không trong hàm signIn: nó phải còn nghe được sau khi hàm
  // đó trả về, vì việc đăng nhập diễn ra ở một tiến trình khác.
  const signInFlow = new SignInFlow({
    logger,
    accept: (credential) => acceptCredential(session, logger, credential, { quiet: true }),
  });
  context.subscriptions.push(signInFlow);

  // ── M10: sổ mức dùng + đẩy lên AstraWork ─────────────────────────────────
  // Sống theo CỬA SỔ chứ không theo phiên chat: nó tồn tại chính là để con số
  // không biến mất mỗi lần người dùng bấm "Hội thoại mới".
  // Không còn công tắc: số đo đi lên cùng với việc dùng công cụ, không phải một
  // lựa chọn. Vẫn đúng những gì §9.2 của documents/SECURITY.md liệt kê — bộ đếm,
  // model, LOC ± — và prompt/nội dung file thì vẫn không bao giờ rời máy.
  const usageSync = new UsageSync({ context, session, logger });
  context.subscriptions.push(usageSync);

  // Chiều ngược lại: số của TÀI KHOẢN, đọc từ chính lời gọi mà trang cá nhân
  // AstraWork dùng. Mục "Usage" hiện cái này chứ không hiện sổ đếm phía trên —
  // xem đầu file telemetry/AccountUsage.ts.
  const accountUsage = new AccountUsageStore({ session, logger });
  context.subscriptions.push(accountUsage);

  const chat = new ChatViewProvider(context.extensionUri, session, logger, {
    ledger,
    permissions,
    todos,
    getSandbox: () => sandboxes.current(),
    getMcpTools: () => mcp.tools(),
    getCodeGraph: (root) => codeGraph.forWorkspace(root),
    sessions,
    checkpoints,
    fileHistory,
    promptLog,
    state,
    applyRevert: (ops) => revert.apply(ops),
    autoCompact: () => readConfig().autoCompact,
    verifyCommand: () => inspectVerifyCommand(),
    hookApprovals,
    nativeUnsupported,
    usage: usageSync,
    account: accountUsage,
  });
  context.subscriptions.push(chat);

  const webviewOptions = { retainContextWhenHidden: true };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
      webviewOptions,
    }),
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'astra.selectModel';
  context.subscriptions.push(status);

  const refreshStatus = async (): Promise<void> => {
    const s = await session.status();
    const model = s.activeModel;
    const perm = permissions.getState();

    if (!s.authenticated) {
      status.text = '$(account) AstraCode: not signed in';
      status.tooltip = 'Click to open AstraCode settings';
      status.command = 'astra.openSettings';
    } else if (!model) {
      status.text = '$(warning) AstraCode: no model';
      status.tooltip = s.lastError ?? 'Could not fetch the model list';
      status.command = 'astra.openSettings';
    } else {
      // Chế độ quyền nằm ngay trên status bar, không giấu trong tooltip: nó
      // quyết định agent có tự sửa file được không, và "tôi tưởng nó đang ở
      // chế độ hỏi" là loại bất ngờ tệ nhất trong một công cụ sửa code.
      const modeIcon =
        perm.effectiveMode === 'plan'
          ? '$(book)'
          : perm.effectiveMode === 'acceptEdits'
            ? '$(pencil)'
            : '$(question)';

      status.text = `$(sparkle) ${model} ${modeIcon}`;
      status.tooltip = [
        `Source: ${s.sourceLabel}`,
        s.username ? `Account: ${s.username}${s.role ? ` (${s.role})` : ''}` : undefined,
        `Permissions: ${describeMode(perm.effectiveMode)}`,
        perm.downgraded ? `Downgraded: ${perm.downgradeReason}` : undefined,
        ledger.size > 0 ? `Changes: ${summarizeChanges(ledger.list())}` : undefined,
        'Click to switch model.',
      ]
        .filter(Boolean)
        .join('\n');
      status.command = 'astra.selectModel';
    }
    status.show();
  };

  session.onDidChange(() => void refreshStatus());
  context.subscriptions.push(
    new vscode.Disposable(permissions.onChange(() => void refreshStatus())),
    new vscode.Disposable(ledger.onChange(() => void refreshStatus())),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('astra')) return;
      const before = session.getConfig().gatewayBaseUrl;
      await session.reload();
      const locked = applyOrgPolicy(session, permissions);
      if (locked.length > 0) void vscode.window.showWarningMessage(locked.join('  '));
      // Đổi endpoint thì danh sách model cũ không còn đúng. `gatewayBaseUrl`
      // hiện cố định trong code nên điều kiện này gần như không chạy — và đặc
      // biệt là không chạy khi chỉ đổi model/planModel, tránh một lời gọi mạng
      // sau mỗi lần chọn model.
      if (session.getConfig().gatewayBaseUrl !== before) {
        await session.refreshModels();
      }
      await sandboxes.apply(readConfig());
      await mcp.apply(readConfig());
    }),
    // Bấm "Trust" trong VS Code không phát onDidChangeConfiguration, nhưng nó
    // là đúng thời điểm MCP được phép chạy — nên phải nghe riêng.
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void mcp.apply(readConfig());
      void sandboxes.apply(readConfig());
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('astra.openChat', () => chat.reveal()),
    vscode.commands.registerCommand('astra.newChat', () => chat.clear()),
    vscode.commands.registerCommand('astra.stopChat', () => chat.stop()),
    vscode.commands.registerCommand('astra.openSettings', () => chat.openSettings()),
    vscode.commands.registerCommand('astra.togglePrimarySidebar', () =>
      vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility'),
    ),
    vscode.commands.registerCommand('astra.toggleSecondarySidebar', () =>
      vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar'),
    ),
    vscode.commands.registerCommand('astra.showLogs', () => channel.show()),
    vscode.commands.registerCommand('astra.selectModel', () => selectModel(session)),
    vscode.commands.registerCommand('astra.signIn', () => signIn(session, logger, signInFlow)),
    vscode.commands.registerCommand('astra.signOut', () => signOut(session, signInFlow)),
    vscode.commands.registerCommand('astra.testConnection', () => testConnection(session)),
    vscode.commands.registerCommand('astra.copyToken', () => copyToken(session)),

        // ── M4: thao tác trên sổ thay đổi ─────────────────────────────────────
    vscode.commands.registerCommand('astra.changes.openDiff', (item?: ChangeItem) => {
      if (item) return openDiff(item.change);
      return undefined;
    }),
    vscode.commands.registerCommand('astra.changes.accept', (item?: ChangeItem) => {
      if (item) ledger.accept(item.change.uri);
    }),
    vscode.commands.registerCommand('astra.changes.reject', async (item?: ChangeItem) => {
      if (!item) return;
      const op = ledger.reject(item.change.uri);
      if (!op) return;
      const { failed } = await revert.apply([op]);
      if (failed.length > 0) {
        void vscode.window.showErrorMessage(`Could not undo: ${failed[0]}`);
      }
    }),
    vscode.commands.registerCommand('astra.changes.acceptAll', () => {
      ledger.acceptAll();
    }),
    vscode.commands.registerCommand('astra.changes.revertAll', () =>
      revertAll(ledger, revert),
    ),
    vscode.commands.registerCommand('astra.setPermissionMode', () =>
      pickPermissionMode(permissions),
    ),

    // ── M6: bộ nhớ và phiên ───────────────────────────────────────────────
    vscode.commands.registerCommand('astra.undo', () => chat.undo()),
    vscode.commands.registerCommand('astra.resumeSession', () => chat.pickSession()),
    vscode.commands.registerCommand('astra.chatHistory', () => chat.showHistory()),
    vscode.commands.registerCommand('astra.editMemory', () => openMemoryFile()),
    vscode.commands.registerCommand('astra.pinToChat', () => addSelectionToChat(chat)),
    vscode.commands.registerCommand('astra.manageMcp', () => manageMcpServers(mcp, logger)),
    vscode.commands.registerCommand('astra.showProjectAgents', () =>
      showProjectAgents(session),
    ),
    vscode.commands.registerCommand('astra.revokeHooks', async () => {
      await hookApprovals.revokeAll();
      logger.info('revoked every approved hook');
      void vscode.window.showInformationMessage(
        'AstraCode: forgot every approved hook. The next run will ask again.',
      );
    }),
  );

  // Đường quay về từ trình duyệt: vscode://astracode.astracode/auth?token=…
  // (hoặc ?code=…). Web AstraWork deep-link về đây thật: trang `/ide-auth` nhận
  // mã một lần rồi nhảy sang scheme này, còn trang đăng nhập CHUYỂN TIẾP mã chứ
  // không tiêu nó — nên trình duyệt không giữ phiên cho một lần đăng nhập mà
  // người dùng thực hiện thay cho editor. Đường dán tay giữ lại làm dự phòng
  // cho máy chưa đăng ký scheme.
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) => void handleAuthUri(uri, session, logger, signInFlow),
    }),
  );

  void (async () => {
    // Thư mục nhà trước tiên: layout phải đúng trước khi có ai đọc nó, và phiên
    // cũ trong globalStorage phải về `~/.astra` trước khi người dùng mở danh
    // sách hội thoại và thấy nó trống.
    await migrateHome({ fs: homeFs, layout: home, logger });
    if (sessionStorage.kind === 'home') {
      await migrateGlobalStorageSessions({ globalStorage: context.globalStorageUri, logger });
    }
    await state.recordStartup(String(context.extension.packageJSON.version ?? ''));
    const root = activeWorkspaceRoot()?.uri.fsPath;
    if (root) {
      await state.touchProject(root, {
        ...(vscode.workspace.isTrusted ? { trustAcceptedAt: Date.now() } : {}),
      });
    }
    // Dọn rác có mốc riêng, một ngày một lần — xem HomeCleanup.
    await new HomeCleanup({ fs: homeFs, layout: home, logger }).runIfDue();

    await session.reload();
    // Trần của tổ chức áp ngay lúc khởi động, TRƯỚC khi sandbox và MCP dựng
    // theo cài đặt — nếu không, một phiên chạy với cấu hình lỏng hơn trong
    // khoảng thời gian giữa hai bước, và "chỉ vài giây thôi" không phải là một
    // lập luận dùng được cho quyền ghi file.
    const locked = applyOrgPolicy(session, permissions);
    await sandboxes.apply(readConfig());
    await mcp.apply(readConfig());
    // Token còn hạn từ lần trước = đã đăng nhập, nên danh sách model phải tự có.
    // Không có bước này thì mỗi lần mở VS Code lại phải bấm "Refresh list"
    // mới chọn được model — một nghi thức không nói ra ở đâu.
    await session.ensureModels();
    await refreshStatus();
    if (locked.length > 0) {
      logger.info('the organisation tightened the configuration', { locked });
      void vscode.window.showWarningMessage(locked.join('  '));
    }
  })().catch((err: unknown) => {
    // Không có `catch` ở đây thì mọi lỗi trong khối trên thành unhandled
    // rejection: VS Code chỉ hiện một dòng đỏ ở Runtime Status, còn người dùng
    // thấy một extension im lặng không hoạt động. Tệ hơn là các bước
    // applyOrgPolicy/sandbox/MCP phía trên đã bị bỏ qua mà không ai được báo.
    const reason = err instanceof Error ? err.message : String(err);
    logger.error('startup did not finish', { reason });
    void vscode.window.showErrorMessage(
      `AstraCode did not finish starting: ${reason}. Open Output → AstraCode for details.`,
    );
  });

  logger.info('AstraCode activated');
}

export function deactivate(): void {
  // Không có tài nguyên nào ngoài context.subscriptions.
}

// ─── Commands ───────────────────────────────────────────────────────────────

/**
 * Hoàn tác TẤT CẢ. Hỏi lại trước khi làm — nó xoá cả những thay đổi người dùng
 * đã bấm duyệt, và không có nút hoàn tác cho chính nó ngoài Ctrl+Z từng file.
 */
async function revertAll(ledger: ChangeLedger, revert: RevertApplier): Promise<void> {
  const changes = ledger.list();
  if (changes.length === 0) {
    void vscode.window.showInformationMessage('No changes to revert.');
    return;
  }

  const confirm = 'Revert everything';
  const picked = await vscode.window.showWarningMessage(
    `Revert ${summarizeChanges(changes)}? Approved changes go back to their originals too.`,
    { modal: true },
    confirm,
  );
  if (picked !== confirm) return;

  const { reverted, failed } = await revert.apply(ledger.revertAll());
  if (failed.length > 0) {
    void vscode.window.showErrorMessage(
      `Reverted ${reverted} file(s), ${failed.length} failed: ${failed[0]}`,
    );
  } else {
    void vscode.window.showInformationMessage(`Reverted ${reverted} file(s).`);
  }
}

/**
 * Mở ASTRA.md để sửa, tạo sẵn nếu chưa có (M6).
 *
 * Bản mẫu nằm ở `chat/memoryText.ts`, dùng chung với builtin `/memory`.
 */
async function openMemoryFile(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) {
    void vscode.window.showWarningMessage('No folder is open.');
    return;
  }

  const { uri } = await readOrCreateMemoryFile(root.uri);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
}

async function pickPermissionMode(permissions: PermissionManager): Promise<void> {
  interface ModePick extends vscode.QuickPickItem {
    mode: PermissionMode;
  }

  const current = permissions.getState();
  const choices: Array<{ mode: PermissionMode; label: string; description: string }> = [
    {
      mode: 'plan',
      label: '$(book) Plan',
      description: 'Read-only — every edit is blocked in the core layer',
    },
    {
      mode: 'ask',
      label: '$(question) Ask before editing',
      description: 'Approve every write',
    },
    {
      mode: 'acceptEdits',
      label: '$(pencil) Auto-approve file edits',
      description: 'Edit files without asking. Shell commands always still need approval.',
    },
  ];

  const items: ModePick[] = choices.map((i) =>
    i.mode === current.mode ? { ...i, detail: 'In use' } : { ...i },
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: 'AstraCode permissions for this session',
    placeHolder: current.downgraded
      ? `Currently downgraded: ${current.downgradeReason}`
      : 'Pick a mode',
  });
  if (picked) permissions.setMode(picked.mode);
}

async function selectModel(session: AstraSession): Promise<void> {
  const registry = session.getRegistry();
  const models = registry?.all() ?? [];

  if (models.length === 0) {
    const open = 'Open settings';
    const pick = await vscode.window.showWarningMessage(
      'No models yet. Check the connection and your sign-in.',
      open,
    );
    if (pick === open) await vscode.commands.executeCommand('astra.openSettings');
    return;
  }

  interface ModelPick extends vscode.QuickPickItem {
    id: string;
    available: boolean;
  }

  const items: ModelPick[] = models.map((m) => {
    // Chỉ nói khi có tin XẤU THẬT. "Chưa đo" không phải tin xấu: model đó chạy
    // bằng năng lực giả định và dùng được bình thường, nên gắn một dòng chú
    // thích vào từng mục chỉ làm danh sách chọn model khó đọc hơn.
    const detail = registry?.safeForWrite(m.id)
      ? undefined
      : 'Measured low injection resistance — not eligible for work with write access';

    return {
      label: m.available ? m.id : `$(circle-slash) ${m.id}`,
      description: m.available
        ? `${m.toolCalling} · ${m.contextWindow > 0 ? `${(m.contextWindow / 1000).toFixed(0)}k` : '?'}`
        : !m.allowed
          ? 'not permitted'
          : 'offline',
      ...(detail ? { detail } : {}),
      id: m.id,
      available: m.available,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Model for editing code',
    placeHolder: 'Pick a model, or press Esc to keep the current one',
  });
  if (!picked) return;

  if (!picked.available) {
    void vscode.window.showWarningMessage(`${picked.id} is not usable right now.`);
    return;
  }

  await vscode.workspace
    .getConfiguration('astra')
    .update('model', picked.id, vscode.ConfigurationTarget.Global);
}

/**
 * Đăng nhập AstraWork bằng chính phiên trên trang web.
 *
 * Mở `https://astrawork…/login` trong trình duyệt — nếu người dùng đã đăng nhập
 * Microsoft ở đó thì họ không phải nhập lại gì. Việc còn lại là mang credential
 * của phiên đó sang IDE.
 *
 * Vì sao vẫn phải dán tay: `_safe_next()` của gateway chỉ cho `next` là path nội
 * bộ trên frontend, nên không redirect thẳng về `vscode://` được, và extension
 * thì không đọc được bộ nhớ của trình duyệt. Khi
 * web có trang deep-link về `vscode://astracode.astracode/auth` thì
 * `handleAuthUri` bên dưới nhận thẳng và bước dán này biến mất.
 */
/** Trang giao mã của AstraWork. Phải khớp `IDE_NEXT` ở frontend/src/app/login. */
const IDE_AUTH_PATH = '/ide-auth';

async function signIn(
  session: AstraSession,
  logger: Logger,
  flow: SignInFlow,
): Promise<void> {
  const auth = session.getAuth();
  if (!auth) return;

  // `next=/ide-auth` là chỗ AstraWork giao mã ngược lại cho IDE: trang đó nhận
  // mã một lần rồi mở `vscode://astracode.astracode/auth?code=…`, nên hệ điều
  // hành tự kéo VS Code lên trước và `handleAuthUri` bên dưới nhận thẳng.
  //
  // Trang /ide-auth cố ý KHÔNG đổi mã lấy token: mã đi qua scheme cục bộ, chỉ
  // tới được đúng máy đang chạy trình duyệt, và trình duyệt không giữ lại phiên
  // nào cho một lần đăng nhập mà người dùng thực hiện thay cho IDE.
  //
  // Deploy chưa có trang đó thì luồng vẫn chạy: người dùng dừng ở trang login
  // với `?sso_code=` trên thanh địa chỉ, và SignInFlow nhặt từ clipboard.
  const loginUrl = auth.ssoLoginUrl(IDE_AUTH_PATH);
  const opened = await vscode.env.openExternal(vscode.Uri.parse(loginUrl));
  if (!opened) {
    void vscode.window.showErrorMessage(`Could not open the browser. Go to ${loginUrl} and try again.`);
    return;
  }

  flow.begin();

  const paste = 'Paste the code manually';
  void vscode.window
    .showInformationMessage(
      'Sign in in the browser — AstraCode picks it up and comes back here on its own. ' +
        'If the browser does not reopen VS Code, copy the address bar and switch back here.',
      paste,
    )
    .then(async (picked) => {
      if (picked !== paste) return;
      flow.stop();
      await promptForCredential(session, logger);
    });
}

/** Đường dán tay, cho khi clipboard không dùng được hoặc người dùng muốn chủ động. */
async function promptForCredential(session: AstraSession, logger: Logger): Promise<void> {
  const entered = await vscode.window.showInputBox({
    title: 'AstraWork session',
    prompt: 'Paste the returned URL, the one-time sign-in code, or the web session access token.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) =>
      extractCredential(v) ? undefined : 'No sign-in credential recognised in this string.',
  });
  if (!entered) return;

  const credential = extractCredential(entered);
  if (credential) await acceptCredential(session, logger, credential);
}

/**
 * Nhận credential từ clipboard, deep-link, hoặc ô dán tay — rồi nạp model.
 *
 * Một chỗ duy nhất cho mọi đường vào: nếu tách ra thì đường ít dùng hơn sẽ là
 * đường quên gọi `refreshModels`, và triệu chứng của nó là "đăng nhập rồi mà
 * vẫn không có model" — rất khó lần.
 *
 * Trả `false` khi credential không dùng được. Người gọi tự quyết định có báo
 * lỗi hay không: đường clipboard thử liên tục nên phải im lặng, còn đường dán
 * tay thì người dùng đang đợi câu trả lời.
 */
async function acceptCredential(
  session: AstraSession,
  logger: Logger,
  credential: Credential,
  options: { quiet?: boolean } = {},
): Promise<boolean> {
  const auth = session.getAuth();
  if (!auth) return false;

  try {
    if (credential.kind === 'token') await auth.acceptAccessToken(credential.value);
    else await auth.exchangeSsoCode(credential.value);
  } catch (err) {
    logger.warn('credential is not usable', { reason: describeError(err) });
    if (!options.quiet) {
      void vscode.window.showErrorMessage(`Sign-in failed: ${describeError(err)}`);
    }
    return false;
  }

  await session.refreshModels();
  // Chuẩn agent cũng đi ra từ token vừa nhận. Không gọi ở đây thì lúc
  // activation nó đã chạy MỘT lần trong trạng thái chưa đăng nhập, trả về rỗng,
  // và không có gì thử lại — người dùng đăng nhập xong vẫn không thấy agent nào
  // cho tới lần mở lại VS Code. Cùng cái bẫy mà `ensureWork` đã dính.
  await session.refreshProjectAgents();
  const status = await session.status();
  const usable = status.models.filter((m) => m.available).length;
  void vscode.window.showInformationMessage(
    `Signed in to AstraWork${status.username ? ` — ${status.username}` : ''}. ` +
      `${usable} model(s) available.`,
  );
  return true;
}

/**
 * `vscode://astracode.astracode/auth?token=…` hoặc `?code=…`.
 *
 * Chỉ nhận đúng path `/auth`: URI handler là một cửa mở cho mọi trang web trên
 * máy này gọi vào, nên nhận bừa path là mời người khác vào thử.
 */
async function handleAuthUri(
  uri: vscode.Uri,
  session: AstraSession,
  logger: Logger,
  flow: SignInFlow,
): Promise<void> {
  if (uri.path !== '/auth') {
    logger.warn('ignoring an unrecognised URI', { path: uri.path });
    return;
  }

  const credential = extractCredential(`${uri.scheme}://x/?${uri.query}`);
  if (!credential) {
    void vscode.window.showErrorMessage('That sign-in link carries no valid code.');
    return;
  }

  flow.stop();
  await acceptCredential(session, logger, credential);
}


/**
 * Áp trần cấu hình của tổ chức (M9) lên phiên đang chạy.
 *
 * Gọi lại sau MỖI lần reload, không chỉ lúc khởi động: một trần chỉ áp lúc khởi
 * động thì không phải trần — người dùng đổi `astra.permissionMode` trong
 * settings là đủ để đi vòng qua nó.
 *
 * Thông báo cho người dùng khi có ô bị khoá. Im lặng vô hiệu hoá một ô cài đặt
 * là cách nhanh nhất khiến họ nghĩ sản phẩm hỏng: họ bật acceptEdits, lưu, rồi
 * thấy nó vẫn hỏi duyệt, và không có gì giải thích vì sao.
 */
function applyOrgPolicy(session: AstraSession, permissions: PermissionManager): string[] {
  const cfg = readConfig();
  const { policy } = session.getPolicy();
  const effective = applyIdePolicy(policy, {
    permissionMode: cfg.permissionMode,
    sandboxNetwork: cfg.sandboxNetwork,
    hooksEnabled: true,
    mcpEnabled: cfg.mcp === 'on',
  });
  permissions.setMode(effective.permissionMode);
  return effective.locked.map(
    (l) => `${l.reason} (you picked "${l.requested}", "${l.applied}" is in force)`,
  );
}

async function signOut(session: AstraSession, flow: SignInFlow): Promise<void> {
  flow.stop();
  const auth = session.getAuth();
  if (!auth) {
    void vscode.window.showInformationMessage('There is no sign-in session.');
    return;
  }
  await auth.logout();
  await session.reload();
  void vscode.window.showInformationMessage('Signed out.');
}

/**
 * Đưa JWT AstraWork sang clipboard, để `astracode login --token` dùng lại.
 *
 * Vì sao cần: trang `/ide-auth` viết cho extension — nó tự bắn `vscode://` và
 * không in mã ra bao giờ. CLI đi vào cùng cửa đó nên thừa hưởng một giả định
 * không đúng với nó. Lệnh này bỏ hẳn vòng SSO: extension đã có token hợp lệ
 * rồi, CLI chỉ cần đúng token ấy.
 *
 * Có chép SECRET vào clipboard, nên nói thẳng ra thay vì báo "đã sao chép" một
 * cách vô thưởng vô phạt — người dùng cần biết để còn xoá clipboard sau đó.
 * Không ghi token vào log hay ra màn hình.
 */
/**
 * Hiện chuẩn agent mà dự án đang áp — đọc lại từ gateway trước khi hiện.
 *
 * Lý do có lệnh này chứ không chỉ một dòng trong panel: khi bộ agent trong
 * Command Palette khác với bộ PM tưởng mình đã khai, câu hỏi đầu tiên luôn là
 * "máy tôi đang lấy được cái gì". Không có chỗ trả lời thì cả hai bên đoán.
 */
async function showProjectAgents(session: AstraSession): Promise<void> {
  const state = await session.refreshProjectAgents();

  const origin =
    state.source === 'gateway'
      ? `AstraWork${state.stale ? ' (cached — could not reach the gateway)' : ''}`
      : state.source === 'stub'
        ? 'Local stub file (~/.astra/project-agents.json) — not a real project standard'
        : 'None — this project has not defined any shared agents';

  const lines = [
    '# Project agent standard',
    '',
    `- Source: ${origin}`,
    `- Version: ${state.standard.version}`,
    ...(state.standard.updated_by ? [`- Updated by: ${state.standard.updated_by}`] : []),
    ...(state.standard.updated_at ? [`- Updated at: ${state.standard.updated_at}`] : []),
    '',
  ];

  if (state.agents.length === 0 && state.skills.length === 0) {
    lines.push('No shared agents. Anything under `.astra/agents/` still works as before.');
  }

  // Hai mục riêng, không trộn: khác nhau ở chỗ cái nào SỬA được file, và đó là
  // điều người đọc trang này cần biết trước khi quyết định nhờ việc gì.
  const sections: [string, string, typeof state.skills | typeof state.agents][] = [
    [
      `## Procedures (${state.skills.length})`,
      'Loaded into the chat you are in. Full tools, so they can edit files — every ' +
        'edit still goes through the usual approval prompt. Run one with `/name`.',
      state.skills,
    ],
    [
      `## Sub-agents (${state.agents.length})`,
      'Run in their own context with READ-ONLY tools and report back a summary. ' +
        'They never edit files or run commands.',
      state.agents,
    ],
  ];

  for (const [heading, blurb, items] of sections) {
    if (items.length === 0) continue;
    lines.push(heading, '', blurb, '');
    for (const a of items) {
      lines.push(`### ${a.name}`, '', a.description, '');
      if (a.scan.suspicious) {
        // Nói ngay ở đây, không chỉ lúc chạy: người đọc trang này thường là
        // người đang quyết định có tin bộ agent đó không.
        lines.push(`> ⚠️ Injection scan flagged this entry (score ${a.scan.score}).`, '');
      }
      lines.push('```', a.body, '```', '');
    }
  }

  const doc = await vscode.workspace.openTextDocument({
    content: lines.join('\n'),
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function copyToken(session: AstraSession): Promise<void> {
  const auth = session.getAuth();
  const st = await auth?.state();
  if (!st?.authenticated) {
    void vscode.window.showWarningMessage(
      'Not signed in to AstraWork — run "AstraCode: Sign in to AstraWork" first.',
    );
    return;
  }

  let token: string;
  try {
    // Gia hạn trước khi trao đi, không chỉ đọc: token này rời khỏi extension để
    // sang CLI, nơi không có gì gia hạn nó. Đưa một token còn ba phút là đưa một
    // thứ chết ngay khi người dùng dán xong.
    token = await auth!.ensureFresh();
  } catch {
    void vscode.window.showWarningMessage('Could not read the token. Sign in again.');
    return;
  }

  const after = await auth!.state();
  await vscode.env.clipboard.writeText(token);
  const expiresAt = after.expiresAt ?? st.expiresAt;
  const expiry = expiresAt ? `, expires ${expiresAt.toLocaleString()}` : '';
  // Không còn kèm địa chỉ gateway: CLI dùng chính hằng số này nên nó không cần
  // ai đưa địa chỉ nữa, và in một URL hạ tầng vào thông báo là mời người ta dán
  // nó ra ngoài cùng với token.
  void vscode.window.showInformationMessage(
    `Token copied to the clipboard (${st.username ?? 'unknown'}${expiry}). ` +
      'Run: astracode login --token <paste>. ' +
      'This is a secret — clear your clipboard afterwards.',
  );
}

async function testConnection(session: AstraSession): Promise<void> {
  const cfg = session.getConfig();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'AstraCode: testing the connection' },
    async () => {
      const registry = session.getRegistry();
      if (!registry) return;
      try {
        await registry.load();
        const usable = registry.usable().length;
        const total = registry.all().length;
        void vscode.window.showInformationMessage(
          `${cfg.gatewayBaseUrl} — ${usable}/${total} model(s) available.`,
        );
      } catch (err) {
        const hint =
          err instanceof AstraError && err.code === 'auth_required'
            ? ' Sign in again.'
            : '';
        void vscode.window.showErrorMessage(`Could not connect: ${describeError(err)}.${hint}`);
      }
    },
  );
}
