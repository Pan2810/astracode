/**
 * `astracode` — vòng chat trong terminal.
 *
 * Cùng `AgentLoop`, cùng bộ tool, cùng `PermissionManager` mà extension dùng.
 * Đây không phải bản rút gọn: nếu CLI có đường đi riêng thì hai đầu sẽ trôi xa
 * nhau, và lớp quyền — thứ đứng giữa model và đĩa cứng của bạn — là chỗ cuối
 * cùng đáng có hai cách hành xử.
 *
 * Cùng lý do đó, `/` và `@` ở đây đi qua đúng những hàm mà webview đi qua:
 * `loadCommands`/`loadSkills` để tìm nguồn, `resolveSlash` để quyết định `/x`
 * chạy cái gì, `renderSkillInvocation` để dựng tin nhắn. Chỉ phần VẼ là riêng.
 */
import {
  AgentLoop,
  ChangeLedger,
  Compactor,
  ContextBudget,
  GraphBuilder,
  GraphCache,
  HistoryLog,
  NodeFileSystem,
  PermissionManager,
  SkillIndex,
  TreeSitterParser,
  buildSlashEntries,
  buildSystemPrompt,
  createLoadSkillTool,
  createRegistry,
  applyIdePolicy,
  createToolContext,
  describeInjectionScan,
  estimateConversationTokens,
  fuzzyRank,
  graphDir,
  isAbortError,
  loadCommands,
  loadSkills,
  newSessionId,
  parseSlashInput,
  renderCommand,
  renderSkillInvocation,
  resolveSlash,
  TodoStore,
  type AgentEvent,
  type BuiltinCommand,
  type ChatMessage,
  type CodeGraph,
  type CodeGraphProvider,
  type Logger,
  type PermissionMode,
  type PolicyPermissionMode,
  type Provider,
  type Skill,
  type ToolProtocol,
  type SlashCommand,
  type TodoItem,
} from '@astra/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import type { Interface } from 'node:readline/promises';
import { askPermission, createReadline, nonInteractiveAsker } from './ask.js';
import { buildSession } from './session.js';
import { LineEditor, type SuggestItem, type SuggestSource } from './editor.js';
import { FileIndex, expandMentions } from './mentions.js';
import { MarkdownStream } from './markdown.js';
import { layout } from './home.js';
import { ensureProjectTrust, ensureWorkspaceTrust, isTrusted } from './trust.js';
import { c, out, write } from './ui.js';

/**
 * Lệnh dựng sẵn. Đứng trên cùng trong ô gợi ý và thắng mọi trùng tên — xem
 * `resolveSlash`: một repo lạ không được cướp `/exit`.
 */
const BUILTINS: BuiltinCommand[] = [
  { name: 'help', description: 'Lệnh, command và skill đang có' },
  { name: 'model', description: 'Model đang dùng' },
  { name: 'mode', description: 'Đổi chế độ quyền', argumentHint: 'plan | ask | acceptEdits' },
  { name: 'changes', description: 'File agent đã sửa trong phiên' },
  { name: 'clear', description: 'Xoá lịch sử hội thoại, giữ nguyên phiên' },
  { name: 'compact', description: 'Nén hội thoại ngay; thêm chỉ dẫn để nói phần nào cần giữ kỹ' },
  { name: 'exit', description: 'Thoát' },
];

/**
 * Có tô markdown hay không.
 *
 * Tắt khi output bị pipe — cùng nguyên tắc với màu ở `ui.ts`. `astracode -p
 * "…" > ghi-chu.md` phải ra markdown sạch để còn dùng tiếp, không phải một mớ
 * khung kẻ đã dàn cột cho terminal rộng 80.
 */
function markdownEnabled(args: string[]): boolean {
  if (args.includes('--raw')) return false;
  if (process.env.ASTRA_MARKDOWN === '0') return false;
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

function readAstraignore(root: string): string | undefined {
  try {
    return readFileSync(join(root, '.astraignore'), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Một `readline.Interface` sống đúng bằng câu hỏi cần nó.
 *
 * Bắt buộc phải vậy: `LineEditor` đặt stdin sang raw mode và tự đọc phím. Một
 * Interface mở thường trực cũng đọc stdin, nên hai bên sẽ giành nhau từng ký
 * tự — người dùng gõ một chữ, ô nhập nhận hai. Mở/đóng theo từng lời hỏi tốn
 * không đáng kể và loại hẳn cả lớp bug đó.
 */
async function withReadline<T>(fn: (rl: Interface) => Promise<T>): Promise<T> {
  const rl = createReadline();
  try {
    return await fn(rl);
  } finally {
    rl.close();
  }
}

export async function runChat(args: string[]): Promise<void> {
  const session = buildSession();
  const root = process.cwd();
  const interactive = Boolean(process.stdin.isTTY);

  await session.registry.load();

  let mode: PermissionMode = session.config.permissionMode;
  const modeFlag = args.find((a) => a.startsWith('--mode='));
  if (modeFlag) mode = modeFlag.slice('--mode='.length) as PermissionMode;

  // Trần của tổ chức (M9). Áp SAU cờ dòng lệnh một cách có chủ ý: `--mode` là
  // lựa chọn của người dùng, và policy siết được lựa chọn đó — không có chiều
  // ngược lại. Xem applyIdePolicy.
  const { policy, stale } = await session.loadPolicy();
  const effective = applyIdePolicy(policy, {
    permissionMode: mode as PolicyPermissionMode,
    // CLI chưa nối sandbox/hooks/MCP; khai đúng hiện trạng để phần khoá của
    // policy không báo nhầm là đã chặn thứ vốn không tồn tại.
    sandboxNetwork: 'none',
    hooksEnabled: false,
    mcpEnabled: false,
  });
  mode = effective.permissionMode as PermissionMode;

  const markdown = markdownEnabled(args);
  const permissions = new PermissionManager({
    mode,
    logger: session.logger,
    ask: interactive
      ? (req) => withReadline((rl) => askPermission(rl, req))
      : nonInteractiveAsker(),
  });

  const ledger = new ChangeLedger();

  // Cổng workspace-trust cho quyền GHI (sổ nợ #2). Chỉ hỏi khi chế độ thật sự
  // cho ghi — hỏi ở `plan` là một lời hỏi bảo mật không dẫn tới rủi ro nào, và
  // đó là cách nhanh nhất dạy người dùng bấm "có" mà không đọc.
  //
  // Câu trả lời dùng chung với `ensureProjectTrust` ở dưới, nên người dùng chỉ
  // bị hỏi MỘT lần cho một thư mục.
  const writeAllowedByMode = mode !== 'plan';
  const workspaceTrusted = writeAllowedByMode
    ? interactive
      ? await withReadline((rl) => ensureWorkspaceTrust(root, rl))
      : isTrusted(root)
    : false;
  const canWrite = writeAllowedByMode && workspaceTrusted;

  if (writeAllowedByMode && !canWrite) {
    out(
      c.dim(
        '  Thư mục chưa tin cậy — phiên này chỉ đọc. Công cụ sửa file không được đăng ký.',
      ),
    );
  }

  // Plan task (giai đoạn 2 của quy trình). Không có store thì `todo_write`
  // không tồn tại, và prompt sẽ bảo model lập plan bằng một công cụ nó không
  // có — nên hai thứ này phải bật/tắt cùng nhau, không bao giờ lệch.
  const todoStore = new TodoStore();
  todoStore.onChange(renderPlan);

  const astraignore = readAstraignore(root);

  // ── M12: CodeGraph — không có watcher ở CLI, nên mỗi lượt tự so hash lại
  // (rẻ: file không đổi thì GraphBuilder bỏ qua parse). Xem GraphBuilder.build.
  const codeGraphParser = new TreeSitterParser({ logger: session.logger });
  const codeGraphCache = new GraphCache({
    fs: new NodeFileSystem(),
    dir: graphDir(layout(), root),
    logger: session.logger,
  });
  let codeGraphState: CodeGraph | undefined;
  let codeGraphLoadedFromCache = false;
  const codeGraphProvider: CodeGraphProvider = {
    async ensureFresh(signal): Promise<CodeGraph> {
      if (!codeGraphLoadedFromCache) {
        codeGraphState = await codeGraphCache.load();
        codeGraphLoadedFromCache = true;
      }
      const ctx = createToolContext({
        workspaceRoot: root,
        logger: session.logger,
        fs: new NodeFileSystem(),
        ...(astraignore ? { astraignore } : {}),
        ...(signal ? { signal } : {}),
      });
      const builder = new GraphBuilder({
        workspaceRoot: ctx.workspaceRoot,
        fs: ctx.fs,
        pathGuard: ctx.pathGuard,
        denylist: ctx.denylist,
        logger: ctx.logger,
        parser: codeGraphParser,
        ...(signal ? { signal } : {}),
      });
      codeGraphState = await builder.build(codeGraphState);
      void codeGraphCache.save(codeGraphState);
      return codeGraphState;
    },
  };

  const toolContext = createToolContext({
    workspaceRoot: root,
    logger: session.logger,
    fs: new NodeFileSystem(),
    ledger,
    codeGraph: codeGraphProvider,
    ...(astraignore ? { astraignore } : {}),
  });

  const model = session.registry.resolve('editor');
  const profile = model ? session.registry.get(model) : undefined;
  // `let` chứ không `const`: một lượt phát hiện endpoint không nhận `tools`
  // thì các lượt sau của cùng phiên đi thẳng đường XML, không trả giá lại bằng
  // một request hỏng nữa. Phiên CLI ngắn nên nhớ trong tiến trình là đủ —
  // extension nhớ bền hơn vì nó sống qua nhiều ngày.
  let protocol: ToolProtocol = profile?.toolCalling === 'native' ? 'native' : 'xml';
  // Tóm tắt là việc dễ — dùng model `fast` nếu người dùng đã giao vai đó, để
  // một lần nén không tốn bằng một lượt làm việc thật.
  const fastModel = session.registry.resolve('fast');
  // Chưa đo được profile thì đoán thấp — đoán cao rồi tràn là hỏng cả lượt,
  // còn đoán thấp thì chỉ nén sớm hơn cần thiết. Nhưng 8k cũ khiến nén chạy
  // ở ~50% cửa sổ thật với rất nhiều model phổ thông; 32k khớp nhóm đó hơn.
  // Bằng nếu gateway công bố `context_limit` thì `merge` đã lấy giá trị thật,
  // nên con số này chỉ là đường cùng đổ của notional khi cả profile lẫn
  // gateway đều im.
  const contextWindow = profile?.contextWindow ?? 32_768;
  // Ngưỡng nén theo model (thay thế mặc định 0.8/0.7 cố định): model cửa sổ
  // lớn khai cao hơn để giữ ngữ cảnh, model cửa sổ nhỏ để trống cho `reserve`
  // kéo xuống sớm. profile có thì truyền, không có thì ContextBudget tự dùng
  // mặc định.
  const compactAt = profile?.compactAt;
  const warnAt = profile?.warnAt;

  out('');
  out(c.bold(c.cyan('  AstraCode')) + c.dim(`  ${root}`));
  out(
    c.dim(
      // KHÔNG còn nhắc "chưa đo" ở đây. Đo là việc của người thêm model vào
      // gateway, không phải điều kiện để thành viên bắt đầu làm việc — và một
      // dòng vàng hiện ra ở mọi lần khởi động chỉ dạy người ta bỏ qua màu vàng.
      `  model: ${model ?? '(chưa chọn)'}` +
        `   quyền: ${mode}` +
        `   tool-calling: ${profile?.toolCalling ?? 'native'}`,
    ),
  );
  // Nói rõ ô nào bị tổ chức khoá và vì sao. Im lặng vô hiệu hoá `--mode` là
  // cách nhanh nhất khiến người dùng nghĩ cờ đó hỏng.
  for (const l of effective.locked) {
    out(c.yellow(`  ⚑ ${l.reason} (bạn chọn "${l.requested}", đang chạy "${l.applied}")`));
  }
  if (stale && effective.locked.length > 0) {
    out(c.dim('    (dùng bản policy cache — chưa gọi được gateway)'));
  }

  // ── Nguồn của `/`: command và skill ────────────────────────────────────
  //
  // Skill của REPO chỉ được nạp khi người dùng đã đồng ý cho thư mục này —
  // thân skill là prompt chạy với quyền của phiên. Skill ở HOME thì luôn nạp:
  // đó là thứ chính người dùng đặt vào máy mình.
  const trusted = interactive
    ? await withReadline((rl) => ensureProjectTrust(root, rl))
    : false;

  let commands: SlashCommand[] = [];
  let skills: Skill[] = [];

  const refreshSources = async (): Promise<void> => {
    const fs = new NodeFileSystem();
    const home = homedir();
    try {
      [commands, skills] = await Promise.all([
        loadCommands({
          fs,
          workspaceRoot: root,
          homeDir: home,
          allowProjectCommands: trusted,
        }),
        loadSkills({
          fs,
          workspaceRoot: root,
          homeDir: home,
          allowProjectSkills: trusted,
        }),
      ]);
    } catch (e) {
      // Nguồn hỏng không được làm chết phiên chat — chat vẫn là việc chính.
      session.logger.warn('không nạp được command/skill', { reason: (e as Error).message });
    }
  };

  await refreshSources();

  if (commands.length > 0 || skills.length > 0) {
    out(
      c.dim(
        `  ${commands.length} command, ${skills.length} skill` +
          (trusted ? '' : c.yellow('  (chưa nạp nguồn của thư mục này)')),
      ),
    );
  }
  out(c.dim('  / để xem lệnh, @ để chèn file, /exit để thoát.'));
  out('');

  /**
   * Dựng lại AgentLoop cho MỖI lượt.
   *
   * Không phải để tiết kiệm gì — mà vì danh mục skill phụ thuộc câu người dùng
   * vừa gõ (lọc theo `triggers`), và vì sửa SKILL.md rồi hỏi tiếp là cách dùng
   * bình thường. Một loop dựng một lần lúc khởi động sẽ đóng băng cả hai.
   */
  const makeLoop = (conversation: string): AgentLoop => {
    const index = new SkillIndex({ skills });
    const extraTools = skills.length > 0 ? [createLoadSkillTool(index)] : [];
    const tools = createRegistry({ canWrite, todoStore, extraTools, codeGraph: codeGraphProvider });
    const catalog = index.promptSection(conversation);

    // Chốt SẴN model từ role hiện tại của lượt này, một lần duy nhất. Nếu chỉ
    // truyền `role`, GatewayProvider tự resolve lại theo role ở MỖI vòng lặp
    // bên trong lượt (mỗi vòng là một request `stream()` riêng) — không gì
    // đảm bảo nó luôn ra cùng một model nếu registry đổi trạng thái giữa
    // chừng. Model đổi giữa vòng phá điều kiện để cache prompt phía nhà cung
    // cấp còn cái mà hit (documents/Context-window-management-flow.md §7 Pha 2). Pin ở đây giống
    // cách `ChatController.ts` bên VS Code đã làm (`readiness.model.id`).
    const role = mode === 'plan' ? 'planner' : 'editor';
    const resolvedModel = session.registry.resolve(role);

    return new AgentLoop({
      provider: session.provider,
      tools,
      toolContext,
      logger: session.logger,
      permissions,
      systemPrompt: buildSystemPrompt({
        workspaceRoot: root,
        platform: platform(),
        canWrite,
        permissionMode: mode,
        hasTodos: true,
        hasCodeGraph: true,
        // Nói đúng sự thật: bản CLI này chưa nối sandbox, nên không có tool bash.
        // Khai khống ở đây sẽ khiến model lập plan quanh một công cụ không tồn
        // tại rồi bế tắc ở giai đoạn 4.
        sandbox: 'none',
        ...(catalog ? { skillCatalog: catalog } : {}),
      }),
      protocol,
      // Chế độ plan đi tới model lập kế hoạch, còn lại đi tới model sửa code
      // (core/config/model.ts). Đọc `mode` ở đây chứ không ở lúc khởi động vì
      // `/mode` đổi được nó giữa phiên — loop được dựng lại mỗi lượt nên nó
      // luôn thấy giá trị hiện tại.
      role,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      onProtocolFallback: () => {
        protocol = 'xml';
      },
      // Tự nén NGAY TRONG lượt: một lượt chạy hàng chục vòng (đọc file, grep
      // liên tiếp, không message user mới nào chen vào) có thể tự phình qua
      // ngưỡng ngữ cảnh trước khi `turn()` ở dưới kịp kiểm tra lại — đường đó
      // chỉ nén được TRƯỚC lượt, không nén được GIỮA lượt. Thiếu bước này,
      // người dùng phải gõ thêm một câu thì lượt sau mới nén.
        compactor: new Compactor({
          provider: session.provider,
          logger: session.logger,
          ...(fastModel ? { model: fastModel } : {}),
        }),
        contextWindow,
        ...(compactAt !== undefined ? { compactAt } : {}),
        ...(warnAt !== undefined ? { warnAt } : {}),
      });
  };

  /** Câu hỏi → tin nhắn thật: mở rộng `@file` rồi báo cái gì không mở được. */
  const prepare = async (text: string): Promise<string> => {
    const expanded = await expandMentions(text, toolContext);
    for (const p of expanded.problems) {
      out(c.yellow(`  ⚠ @${p.path}: ${p.reason}`));
    }
    for (const a of expanded.attachments) {
      const note = a.truncated ? c.dim(' (đã cắt)') : '';
      out(c.dim(`  + ${a.path}`) + note);
      if (a.scan.suspicious) {
        out(c.red(`  ⚠ ${a.path} có dấu hiệu prompt injection: ${describeInjectionScan(a.scan)}`));
      }
    }
    return expanded.text;
  };

  // Một lượt rồi thoát: `astracode -p "câu hỏi"`, hoặc câu hỏi đẩy qua pipe.
  // Dùng cho script và CI. Quyền ở đây do `nonInteractiveAsker` xử lý — nó TỪ
  // CHỐI mọi thứ cần hỏi, vì tự duyệt khi không ai ngồi xem là bỏ hẳn cổng
  // quyền đúng vào lúc nó cần nhất.
  const oneShot = readOneShotPrompt(args);
  if (oneShot !== undefined) {
    if (!oneShot.trim()) {
      out(c.red('  Không có câu hỏi nào.'));
      process.exitCode = 2;
      return;
    }
    const resolved = await resolveInput(oneShot, { commands, skills });
    if (resolved === undefined) {
      out(c.red('  Lệnh chỉ dùng được trong phiên tương tác.'));
      process.exitCode = 2;
      return;
    }
    await runTurn(makeLoop(resolved), await prepare(resolved), [], markdown);
    return;
  }

  if (!interactive) {
    out(c.red('  Không có terminal tương tác.'));
    out(c.dim('  Dùng một lượt rồi thoát:  astracode -p "câu hỏi"'));
    process.exitCode = 2;
    return;
  }

  // ── Ô nhập ─────────────────────────────────────────────────────────────

  const fileIndex = new FileIndex(toolContext);
  let slashItems = slashSuggestions(commands, skills);

  const source: SuggestSource = {
    items(kind) {
      return kind === 'command' ? slashItems : fileIndex.suggestions();
    },
    open(kind, refresh) {
      if (kind === 'file') {
        fileIndex.ensure(refresh);
        return;
      }
      // Nạp lại mỗi lần mở menu (không phải mỗi ký tự): người dùng vừa tạo một
      // skill ở cửa sổ khác thì nó phải có mặt mà không cần khởi động lại.
      void refreshSources().then(() => {
        slashItems = slashSuggestions(commands, skills);
        refresh();
      });
    },
  };

  // Lịch sử gõ sống qua các lần chạy và dùng chung với extension: câu gõ trong
  // VS Code sáng nay tìm lại được ở đây bằng mũi tên lên.
  //
  // Lọc theo THƯ MỤC ĐANG MỞ. File `history.jsonl` là chung cho mọi repo, nhưng
  // mũi tên lên mà trả về câu hỏi của một dự án khác thì người dùng phải bấm
  // qua một đống thứ không liên quan mới tới cái mình cần.
  //
  // `recent()` trả mới nhất trước, còn ô nhập cần cũ nhất trước — cuối mảng là
  // câu gần đây nhất.
  const promptLog = new HistoryLog({ fs: new NodeFileSystem(), layout: layout() });
  const promptSessionId = newSessionId();
  const lineHistory: string[] = (await promptLog.recent(200, root)).map((e) => e.display).reverse();
  const editor = new LineEditor({
    prompt: c.green('› '),
    promptWidth: 2,
    source,
    history: lineHistory,
  });

  let history: ChatMessage[] = [];

  const compactDeps: CompactDeps = {
    provider: session.provider,
    logger: session.logger,
    ...(fastModel ? { model: fastModel } : {}),
    contextWindow,
  };
  const budget = new ContextBudget({
    contextWindow,
    ...(compactAt !== undefined ? { compactAt } : {}),
    ...(warnAt !== undefined ? { warnAt } : {}),
  });

  /**
   * Một lượt hoàn chỉnh: nén nếu cần rồi mới gọi model.
   *
   * Nén TRƯỚC khi gửi, không phải sau khi tràn — sau khi tràn thì lượt đã hỏng
   * rồi, và người dùng nhận một lỗi từ gateway thay vì một câu trả lời.
   */
  const turn = async (input: string): Promise<void> => {
    if (budget.shouldCompact(history)) {
      history = await compactNow(history, compactDeps, 'auto');
    }
    history = await runTurn(makeLoop(input), await prepare(input), history, markdown);
    // Lượt vừa rồi có thể vừa tạo file mới — chỉ mục `@` phải biết.
    fileIndex.invalidate();
    out('');
  };

  for (;;) {
    const line = await editor.read();
    if (line === undefined) break;

    const trimmed = line.trim();
    if (!trimmed) continue;

    // Ghi cả `/lệnh`: tìm lại một lệnh đã gõ cũng là việc mũi tên lên phải làm.
    // Không `await`: lịch sử gõ không được phép làm chậm lượt chat.
    void promptLog.append({
      display: trimmed,
      project: root,
      sessionId: promptSessionId,
      timestamp: Date.now(),
    });

    if (trimmed.startsWith('/')) {
      const parsed = parseSlashInput(trimmed);
      const builtin = parsed && BUILTINS.some((b) => b.name === parsed.name) ? parsed : undefined;

      if (builtin) {
        if (builtin.name === 'exit' || builtin.name === 'quit') break;
        if (builtin.name === 'help') {
          printHelp(commands, skills, trusted);
          continue;
        }
        if (builtin.name === 'clear') {
          history = [];
          out(c.dim('  Đã xoá lịch sử hội thoại.'));
          continue;
        }
        if (builtin.name === 'compact') {
          if (history.length === 0) out(c.dim('  Chưa có gì để nén.'));
          else history = await compactNow(history, compactDeps, 'manual', builtin.args);
          continue;
        }
        if (builtin.name === 'model') {
          out(c.dim(`  ${model ?? '(chưa chọn)'} — tool-calling: ${profile?.toolCalling ?? 'none'}`));
          // Nói cả model lập kế hoạch: ở chế độ plan thì lượt chạy bằng nó, và
          // một dòng chỉ nói model sửa code sẽ giải thích sai chi phí vừa hiện.
          const planner = session.registry.resolve('planner');
          if (planner && planner !== model) {
            out(c.dim(`  ${planner} — dùng cho chế độ plan`));
          }
          continue;
        }
        if (builtin.name === 'changes') {
          const changes = ledger.list();
          if (changes.length === 0) out(c.dim('  Chưa sửa file nào.'));
          else for (const ch of changes) out(`  ${ch.status.padEnd(9)} ${ch.uri}`);
          continue;
        }
        if (builtin.name === 'mode') {
          const next = builtin.args.trim().split(/\s+/)[0] as PermissionMode | undefined;
          if (!next) {
            out(c.dim(`  Chế độ hiện tại: ${permissions.getState().mode}`));
          } else if (next === 'plan' || next === 'ask' || next === 'acceptEdits') {
            // Đi lại qua policy. Nếu không, `/mode acceptEdits` là một đường vòng
            // qua đúng cái trần vừa áp lúc khởi động — và một trần chỉ áp lúc
            // khởi động thì không phải trần.
            const applied = applyIdePolicy(policy, {
              permissionMode: next as PolicyPermissionMode,
              sandboxNetwork: 'none',
              hooksEnabled: false,
              mcpEnabled: false,
            });
            permissions.setMode(applied.permissionMode as PermissionMode);
            const lock = applied.locked.find((l) => l.field === 'permissionMode');
            if (lock) out(c.yellow(`  ⚑ ${lock.reason} → giữ "${lock.applied}".`));
            else out(c.dim(`  Chế độ: ${next}`));
          } else {
            out(c.red('  Chế độ phải là plan, ask hoặc acceptEdits.'));
          }
          continue;
        }
      }

      // Không phải builtin: nạp lại nguồn rồi tra command/skill. Nạp lại ở đây
      // chứ không dựa vào lần nạp lúc mở menu, vì người dùng có thể gõ thẳng
      // `/speckit-plan` mà không bao giờ mở ô gợi ý.
      await refreshSources();
      const resolved = await resolveInput(trimmed, { commands, skills });
      if (resolved === undefined) continue;
      await turn(resolved);
      continue;
    }

    await turn(trimmed);
  }
}

/**
 * Biến dòng người dùng gõ thành tin nhắn gửi model.
 *
 * `undefined` nghĩa là đã xử lý xong tại chỗ (hoặc lỗi đã in ra) và không có gì
 * để gửi. Dòng không bắt đầu bằng `/` thì trả lại nguyên văn.
 */
async function resolveInput(
  line: string,
  sources: { commands: SlashCommand[]; skills: Skill[] },
): Promise<string | undefined> {
  const parsed = parseSlashInput(line);
  if (!parsed) return line;

  const inputs = { builtins: BUILTINS, ...sources };
  const target = resolveSlash(parsed.name, inputs);

  if (!target) {
    out(c.red(`  Không có lệnh /${parsed.name}.`));
    // Gợi ý tên gần đúng. Đây là chỗ hay vấp nhất: tên thật của một skill do
    // công cụ khác sinh ra thường lệch một dấu so với thứ ghi trong tài liệu
    // của nó — spec-kit đổi `/speckit.plan` thành `/speckit-plan` là đúng ca
    // đó. "Không có lệnh" trống trơn để người dùng tự đoán chỗ lệch.
    //
    // Bỏ dấu ngăn cách ở CẢ HAI phía trước khi khớp: đó chính là thứ đang
    // lệch, nên để nguyên thì `speckit.plan` không khớp `speckit-plan` và gợi
    // ý im lặng đúng lúc cần nhất.
    const bare = (s: string): string => s.replace(/[.:_-]/g, '');
    const near = fuzzyRank(buildSlashEntries(inputs), bare(parsed.name), (e) => bare(e.name), 3);
    if (near.length > 0) {
      out(c.dim(`  Ý bạn là: ${near.map((n) => '/' + n.item.name).join('  ')}`));
    } else {
      out(c.dim('  Gõ /help để xem danh sách.'));
    }
    return undefined;
  }
  if (target.kind === 'not-user-invocable') {
    out(c.yellow(`  Skill "${target.name}" khai user-invocable: false — chỉ model được gọi.`));
    return undefined;
  }
  if (target.kind === 'builtin') return undefined;

  // Nguồn từ repo là prompt do người khác viết. Người dùng chủ động gõ nó nên
  // vẫn chạy, nhưng phải biết mình vừa chạy cái gì và từ đâu.
  const scan = target.kind === 'command' ? target.command.scan : target.skill.scan;
  const source = target.kind === 'command' ? target.command.source : target.skill.source;
  const path = target.kind === 'command' ? target.command.path : target.skill.path;
  if (source === 'project' && scan.suspicious) {
    out(c.red(`  ⚠ ${path} có dấu hiệu prompt injection: ${describeInjectionScan(scan)}`));
  }

  out(c.dim(`  ${target.kind === 'command' ? 'command' : 'skill'}: ${path}`));

  return target.kind === 'command'
    ? renderCommand(target.command, parsed.args)
    : renderSkillInvocation(target.skill, parsed.args);
}

function slashSuggestions(commands: SlashCommand[], skills: Skill[]): SuggestItem[] {
  return buildSlashEntries({ builtins: BUILTINS, commands, skills }).map((e) => ({
    value: e.name,
    label: e.name,
    ...(e.argumentHint ? { hint: e.argumentHint } : {}),
    description: e.description,
    badge: e.kind === 'builtin' ? '' : e.kind === 'skill' ? 'skill' : 'cmd',
    ...(e.suspicious ? { suspicious: true } : {}),
  }));
}

function printHelp(commands: SlashCommand[], skills: Skill[], trusted: boolean): void {
  out('');
  for (const b of BUILTINS) {
    out(`  ${('/' + b.name).padEnd(12)} ${c.dim(b.description)}`);
  }

  if (commands.length > 0) {
    out('');
    out(c.bold('  Command'));
    for (const cmd of commands) {
      out(`  ${('/' + cmd.name).padEnd(24)} ${c.dim(cmd.description)}`);
    }
  }

  const invocable = skills.filter((s) => s.userInvocable);
  if (invocable.length > 0) {
    out('');
    out(c.bold('  Skill'));
    for (const s of invocable) {
      out(`  ${('/' + s.name).padEnd(24)} ${c.dim(s.description)}`);
    }
  }

  if (!trusted) {
    out('');
    out(c.dim('  Nguồn của thư mục này chưa được nạp (.claude/ và .astra/ của repo).'));
  }
  out('');
}

export interface CompactDeps {
  provider: Provider;
  logger: Logger;
  /** Model tóm tắt. Việc này không cần model giỏi — dùng `fast` nếu có. */
  model?: string;
  /** Cửa sổ ngữ cảnh của model đang chat, để biết khi nào chạm ngưỡng. */
  contextWindow: number;
}

/**
 * Nén hội thoại và NÓI RA ở mọi nhánh.
 *
 * Nén là một lượt gọi model đầy đủ chen vào trước lượt của người dùng. Trong
 * terminal, im lặng ở đó còn khó chịu hơn trong panel: không có spinner, không
 * có gì nhúc nhích, và người dùng vừa gõ Enter xong thì màn hình đứng vài giây.
 * Cách duy nhất họ phân biệt được "đang nén" với "treo" là ta nói ra.
 *
 * Trả về lịch sử mới, hoặc chính lịch sử cũ nếu không nén được — nén hỏng
 * không được giết lượt.
 */
export async function compactNow(
  history: ChatMessage[],
  deps: CompactDeps,
  trigger: 'auto' | 'manual',
  focus = '',
): Promise<ChatMessage[]> {
  const before = estimateConversationTokens(history);
  out(
    c.dim(
      focus.trim()
        ? `  ⋯ đang nén hội thoại, giữ kỹ: ${focus.trim()}`
        : trigger === 'manual'
          ? '  ⋯ đang nén hội thoại…'
          : `  ⋯ ngữ cảnh đầy (${shortTokens(before)}/${shortTokens(deps.contextWindow)}) — đang nén hội thoại…`,
    ),
  );

  // Ctrl-C dừng việc nén chứ không giết tiến trình, cùng khuôn với `runTurn`.
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on('SIGINT', onSigint);

  try {
    const compactor = new Compactor({
      provider: deps.provider,
      logger: deps.logger,
      ...(deps.model ? { model: deps.model } : {}),
    });
    const result = await compactor.compact(history, controller.signal, focus);

    if (!result.compacted) {
      // Đường `auto` chỉ chạy khi ĐÃ chạm ngưỡng, nên "không nén được" ở đây
      // nghĩa là riêng vài lượt gần nhất đã chiếm gần hết cửa sổ. Lượt sau
      // nhiều khả năng vỡ, và người dùng là người duy nhất xử lý được.
      out(
        trigger === 'manual'
          ? c.dim('  Hội thoại còn ngắn, chưa cần nén.')
          : c.yellow(
              '  ⚠ không nén được: riêng vài lượt gần nhất đã chiếm gần hết cửa sổ.' +
                ' Cân nhắc /clear hoặc tách nhỏ yêu cầu.',
            ),
      );
      return history;
    }

    out(
      c.dim(
        `  ✓ đã nén: bỏ ${result.droppedMessages} tin nhắn cũ, ` +
          `${shortTokens(result.tokensBefore)} → ${shortTokens(result.tokensAfter)} token`,
      ),
    );
    // Hai lý do xuống cấp KHÔNG dùng chung một câu: `model_failed` là trục trặc
    // kỹ thuật, còn `injection` nghĩa là có nội dung trong repo đang cố lái
    // agent — nghe giống nhau thì người dùng bỏ qua đúng cái đáng để ý.
    if (result.degradedReason === 'model_failed') {
      out(c.yellow('  ⚠ model tóm tắt không chạy được — chỉ giữ được bản rút gọn cơ học.'));
    } else if (result.degradedReason === 'injection') {
      out(
        c.red(
          '  ⚠ bản tóm tắt bị loại vì có dấu hiệu chỉ thị lạ trong nội dung đã đọc' +
            ' — đã thay bằng bản rút gọn cơ học. Xem lại file agent vừa mở.',
        ),
      );
    }
    return result.messages;
  } catch (e) {
    if (isAbortError(e)) {
      out(c.dim('  Đã dừng khi đang nén — hội thoại giữ nguyên.'));
      return history;
    }
    const reason = (e as Error).message;
    deps.logger.warn('nén ngữ cảnh thất bại', { reason });
    out(
      c.yellow(
        `  ⚠ không nén được hội thoại (${reason}).` +
          ' Ngữ cảnh vẫn sát trần nên lượt sau có thể lỗi — thử /compact lại, hoặc /clear.',
      ),
    );
    return history;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

function shortTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * Một lượt: chạy agent loop, in ra, trả về lịch sử mới.
 *
 * Ctrl-C huỷ lượt đang chạy chứ không giết tiến trình — người dùng thường muốn
 * dừng một câu trả lời đi lạc rồi hỏi lại, không phải mất cả phiên.
 */
async function runTurn(
  loop: AgentLoop,
  message: string,
  history: ChatMessage[],
  markdown: boolean,
): Promise<ChatMessage[]> {
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on('SIGINT', onSigint);

  // Bộ tô gom theo dòng, nên nó luôn giữ lại phần dòng dở. Mọi thứ in ra
  // KHÔNG qua nó (dòng tool, hộp duyệt quyền) phải xả nó trước, nếu không thứ
  // tự trên màn hình sẽ khác thứ tự thật.
  const md = markdown
    ? new MarkdownStream(out, { width: process.stdout.columns ?? 80 })
    : undefined;

  try {
    const gen = loop.run(message, history, controller.signal);
    let printedText = false;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        md?.end();
        if (next.value.stoppedBy === 'iteration_limit') {
          out(c.yellow('\n  Chạm trần số vòng lặp — hỏi tiếp để agent làm nốt.'));
        }
        // Lượt dừng vì lỗi không còn đi qua khối catch ở dưới: AgentLoop trả về
        // thay vì ném, để giữ phần đã làm (sổ nợ #10). History vẫn được trả về
        // bình thường ở dòng dưới — đó chính là điểm của thay đổi đó.
        if (next.value.error) {
          out('');
          out(c.red(`  ${next.value.error.message}`));
          process.exitCode = 1;
        }
        if (printedText) out('');
        return next.value.messages.filter((m) => m.role !== 'system');
      }
      renderEvent(next.value, () => {
        printedText = true;
      }, md);
    }
  } catch (e) {
    out('');
    out(c.red(`  ${(e as Error).message}`));
    process.exitCode = 1;
    return history;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

/**
 * Câu hỏi cho chế độ một lượt: `-p "..."` / `--print "..."`, hoặc stdin bị pipe.
 * Trả `undefined` nghĩa là chạy chế độ tương tác.
 */
export function readOneShotPrompt(args: string[]): string | undefined {
  const withEq = args.find((a) => a.startsWith('-p=') || a.startsWith('--print='));
  if (withEq) return withEq.slice(withEq.indexOf('=') + 1);

  const i = args.findIndex((a) => a === '-p' || a === '--print');
  if (i >= 0) {
    const rest = args.slice(i + 1).filter((a) => !a.startsWith('-'));
    if (rest.length > 0) return rest.join(' ');
  }

  // stdin bị pipe (`echo "…" | astracode`) — đọc hết rồi coi là một câu hỏi.
  if (!process.stdin.isTTY && i < 0 && !withEq) {
    try {
      return readFileSync(0, 'utf8');
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function renderEvent(ev: AgentEvent, markText: () => void, md?: MarkdownStream): void {
  if (ev.type === 'text') {
    markText();
    if (md) md.push(String(ev.delta ?? ''));
    else write(String(ev.delta ?? ''));
    return;
  }
  // Sắp in thứ không phải chữ của model — xả bộ đệm để nó không hiện ra SAU.
  md?.end();

  switch (ev.type) {
    case 'tool_start':
      out(c.dim(`\n  · ${String(ev.toolName)} ${summarizeArgs(ev.toolArgs)}`));
      break;
    case 'tool_end': {
      const ms = typeof ev.durationMs === 'number' ? ` ${ev.durationMs}ms` : '';
      out(c.dim(`  ✓ ${String(ev.toolName)}${ms}`));
      break;
    }
    case 'injection_warning':
      // Không im lặng: nội dung agent vừa đọc trông như đang cố điều khiển nó.
      out(c.red(`  ⚠ nội dung đáng ngờ trong kết quả tool — quyền đã bị hạ cấp`));
      break;
    case 'permission_denied':
      out(c.yellow(`  ✗ từ chối: ${String(ev.reason ?? '')}`));
      break;
    case 'permission_downgraded':
      out(c.yellow(`  ⚠ hạ cấp quyền: ${String(ev.reason ?? '')}`));
      break;
    case 'hook_blocked':
      out(c.yellow(`  ✗ hook chặn: ${String(ev.reason ?? '')}`));
      break;
    // Câu trả lời bị cắt giữa chừng. Im lặng ở đây là để người dùng tưởng nửa
    // câu là cả câu.
    case 'truncated':
      out(c.yellow(`\n  ⚠ ${String(ev.reason ?? 'câu trả lời bị cắt giữa chừng')}`));
      break;
    // Không im lặng: giải thích vì sao lượt này khởi động chậm hơn, và vì sao
    // model vừa đổi cách gọi công cụ giữa chừng.
    case 'protocol_fallback':
      out(
        c.yellow(
          '  ⚠ model không nhận native tool-calling — chuyển sang đường XML cho cả phiên này.',
        ),
      );
      break;
    case 'context_recovery':
      out(c.yellow(`  ⚠ ${String(ev.reason ?? 'đang dựng lại request an toàn')}`));
      break;
    // Nén xảy ra NGAY TRONG lượt này (khác `compactNow()` chạy trước `turn()`)
    // — không im lặng, cùng lý do `compactNow` đã nói ra ở mọi nhánh: người
    // dùng cần biết vì sao mạch hội thoại vừa "quên" phần đầu.
    case 'compacted':
      out(
        c.dim(
          `  ✓ tự nén giữa lượt: bỏ ${ev.droppedMessages ?? 0} tin nhắn cũ, ` +
            `${shortTokens(ev.tokensBefore ?? 0)} → ${shortTokens(ev.tokensAfter ?? 0)} token`,
        ),
      );
      if (ev.degradedReason === 'model_failed') {
        out(c.yellow('  ⚠ model tóm tắt không chạy được — chỉ giữ được bản rút gọn cơ học.'));
      } else if (ev.degradedReason === 'injection') {
        out(
          c.red(
            '  ⚠ bản tóm tắt bị loại vì có dấu hiệu chỉ thị lạ trong nội dung đã đọc' +
              ' — đã thay bằng bản rút gọn cơ học.',
          ),
        );
      }
      break;
    default:
      break;
  }
}

/**
 * In plan mỗi lần model gọi `todo_write`.
 *
 * Đây là điểm người dùng chặn được một hiểu lầm sớm — trước khi mười file bị
 * đụng — nên nó phải nổi bật hơn một dòng `· todo_write` mờ như mọi tool khác.
 */
function renderPlan(todos: TodoItem[]): void {
  if (todos.length === 0) return;
  out('');
  out(c.bold('  Plan:'));
  for (const t of todos) {
    const mark =
      t.status === 'completed'
        ? c.green('✓')
        : t.status === 'in_progress'
          ? c.yellow('▸')
          : c.dim('○');
    const text = t.status === 'completed' ? c.dim(t.content) : t.content;
    out(`   ${mark} ${text}`);
  }
  out('');
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const o = args as Record<string, unknown>;
  const key = ['path', 'pattern', 'command', 'file_path'].find((k) => typeof o[k] === 'string');
  return key ? c.dim(String(o[key])) : '';
}
