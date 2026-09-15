/**
 * Script chạy TRONG webview chat.
 *
 * Quy tắc bất di bất dịch: output của model là nội dung KHÔNG TIN CẬY. Nó đi
 * qua marked (markdown -> HTML) rồi DOMPurify (loại script/handler) trước khi
 * chạm tới DOM. Mọi thứ khác — tên tool, đường dẫn, thông báo lỗi — dựng bằng
 * API DOM với textContent, không bao giờ qua innerHTML.
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  CHAT_PROTOCOL_VERSION,
  IMAGE_MEDIA_TYPES,
  MAX_IMAGES,
  MAX_IMAGE_BASE64,
  turnEndStatusLabel,
  type AccountUsageStateWire,
  type BlockKind,
  type ChatHostMessage,
  type ChatModelInfo,
  type ChatModelOption,
  type ChatWebviewMessage,
  type ChatWebviewPayload,
  type CommandWire,
  type ContextWire,
  type ImageMediaType,
  type ImageWire,
  type MentionItem,
  type PinnedItemWire,
  type QuestionAnswerWire,
  type QuestionPrompt,
  type RestoredMessage,
  type SelectionHintWire,
  type SessionWire,
  type SettingsWire,
  type TaskReportWire,
  type TurnEndReason,
  type WorkWire,
} from '../chat/protocol.js';
import { renderSettings } from './settingsPanel.js';
import { describeModelOption } from '../chat/modelChoice.js';

interface VsCodeApi {
  postMessage(msg: ChatWebviewMessage): void;
  /** Trạng thái webview, sống qua lần ẩn/hiện panel. Xem `setTipsOpen`. */
  getState(): WebviewState | undefined;
  setState(state: WebviewState): void;
}

interface WebviewState {
  tipsOpen?: boolean;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

function post(msg: ChatWebviewPayload): void {
  vscode.postMessage({ ...msg, protocolVersion: CHAT_PROTOCOL_VERSION } as ChatWebviewMessage);
}

marked.setOptions({ gfm: true, breaks: true });

/**
 * Chỉ cho qua thẻ định dạng. Không ảnh (CSP đã chặn nhưng thừa còn hơn thiếu),
 * không iframe, không form, không thuộc tính sự kiện.
 */
function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false });
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
      'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'a', 'span',
    ],
    ALLOWED_ATTR: ['class'],
    // Link do model sinh có thể trỏ javascript: — bỏ href luôn cho gọn.
    FORBID_ATTR: ['href', 'src', 'style', 'target'],
  });
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const messages = document.getElementById('messages')!;
const banner = document.getElementById('banner')!;
const mentions = document.getElementById('mentions')!;
const input = document.getElementById('input') as HTMLTextAreaElement;
const composer = document.getElementById('composer') as HTMLFormElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const clearBtn = document.getElementById('clear') as HTMLButtonElement;
const modeBtn = document.getElementById('mode') as HTMLButtonElement;
const modeIcon = document.getElementById('modeIcon')!;
const modeLabel = document.getElementById('modeLabel')!;
const modeMenu = document.getElementById('modeMenu')!;
const modelBtn = document.getElementById('model') as HTMLButtonElement;
const modelIcon = document.getElementById('modelIcon')!;
const modelLabel = document.getElementById('modelLabel')!;
const modelMenu = document.getElementById('modelMenu')!;
const downgradeBox = document.getElementById('downgrade')!;
const todosBox = document.getElementById('todos')!;
const changesBtn = document.getElementById('changes') as HTMLButtonElement;
const contextBox = document.getElementById('context')!;
const attachBtn = document.getElementById('attach') as HTMLButtonElement;
const attachments = document.getElementById('attachments')!;
const pinsBox = document.getElementById('pins')!;
const selectionHintBox = document.getElementById('selectionHint')!;
const workPickers = document.getElementById('workPickers')!;
const tipsToggle = document.getElementById('tipsToggle') as HTMLButtonElement;
const tipsPanel = document.getElementById('tips')!;
const workProject = document.getElementById('workProject') as HTMLSelectElement;
const workTask = document.getElementById('workTask') as HTMLSelectElement;
const workPlan = document.getElementById('workPlan')!;
const workNote = document.getElementById('workNote')!;
const reportDoneBtn = document.getElementById('reportDone') as HTMLButtonElement;
const reportPanel = document.getElementById('report')!;
const reportForm = document.getElementById('reportForm') as HTMLFormElement;
const reportTaskLine = document.getElementById('reportTask')!;
const reportLoading = document.getElementById('reportLoading')!;
const reportFields = document.getElementById('reportFields')!;
const reportNote = document.getElementById('reportNote')!;
const reportError = document.getElementById('reportError')!;
const reportSubmit = document.getElementById('reportSubmit') as HTMLButtonElement;
const reportCancel = document.getElementById('reportCancel') as HTMLButtonElement;
const reportClose = document.getElementById('reportClose') as HTMLButtonElement;
const reportScrim = document.getElementById('reportScrim') as HTMLButtonElement;
const reportPlanStart = document.getElementById('reportPlanStart') as HTMLInputElement;
const reportPlanEnd = document.getElementById('reportPlanEnd') as HTMLInputElement;
const reportActualStart = document.getElementById('reportActualStart') as HTMLInputElement;
const reportActualEnd = document.getElementById('reportActualEnd') as HTMLInputElement;
const reportTokens = document.getElementById('reportTokens') as HTMLInputElement;
const reportCost = document.getElementById('reportCost') as HTMLInputElement;
const idlePanel = document.getElementById('idle')!;
const idleStatus = document.getElementById('idleStatus')!;
const historyPanel = document.getElementById('history')!;
const historyList = document.getElementById('historyList')!;
const historyTitle = document.getElementById('historyTitle')!;
const historyClose = document.getElementById('historyClose') as HTMLButtonElement;
const historyScrim = document.getElementById('historyScrim') as HTMLButtonElement;
const historyNew = document.getElementById('historyNew') as HTMLButtonElement;
const settingsPanel = document.getElementById('settings')!;
const settingsBody = document.getElementById('settingsBody')!;
const settingsClose = document.getElementById('settingsClose') as HTMLButtonElement;
const settingsScrim = document.getElementById('settingsScrim') as HTMLButtonElement;
const openSettingsBtn = document.getElementById('openSettings') as HTMLButtonElement;
const gate = document.getElementById('gate')!;
const gateText = document.getElementById('gateText')!;
const gateSignIn = document.getElementById('gateSignIn') as HTMLButtonElement;
const gateSettings = document.getElementById('gateSettings') as HTMLButtonElement;

let busy = false;
let canChat = false;
/** Số hộp duyệt quyền đang chờ — khoá ô nhập trong lúc chờ. */
let awaitingPermission = 0;
/** Số hộp ask_user_question đang chờ — cùng vai trò với awaitingPermission. */
let awaitingQuestion = 0;
/** Bong bóng trả lời của lượt hiện tại, cùng nguồn markdown đang tích luỹ. */
let current: { node: HTMLElement; body: HTMLElement; raw: string } | undefined;
const toolNodes = new Map<string, HTMLElement>();
/** Tool nào đã có output chảy ra màn hình — để không đè bản rút gọn lên nó. */
const streamedTools = new Set<string>();

// ── Nhận message từ extension host ─────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent<ChatHostMessage>) => {
  const msg = event.data;
  if (!msg || msg.protocolVersion !== CHAT_PROTOCOL_VERSION) return;

  switch (msg.type) {
    case 'ready':
      canChat = msg.canChat;
      // Thiếu credential chắn cả panel; mọi lý do khác chỉ là một dòng banner.
      {
        const gated = msg.blockKind === 'auth' || msg.blockKind === 'config';
        showGate(gated ? msg.blockReason : undefined, msg.blockKind);
        showBanner(gated ? undefined : msg.blockReason, msg.model);
      }
      if (msg.permissions) applyPermissionState(msg.permissions);
      if (msg.sandbox) applySandboxState(msg.sandbox);
      // Host là nguồn sự thật cho lựa chọn model: webview vẽ ngay khi bấm cho
      // đỡ trễ, rồi host xác nhận lại ở đây. Không có bước xác nhận thì một
      // lượt bị từ chối (đang chạy, hoặc model không được cấp) để lại cái nút
      // nói sai.
      showModels(msg.models ?? [], msg.modelDefault, msg.modelOverride);
      updateControls();
      break;

    case 'settings':
      renderSettingsPanel(msg.state);
      if (msg.open) {
        settingsPanel.hidden = false;
        settingsBody.scrollTop = 0;
      }
      break;

    case 'settingsBusy':
      document.body.classList.toggle('busy', msg.busy);
      break;

    case 'work':
      renderWork(msg.state);
      break;

    case 'taskReport':
      // Hộp đã đóng trong lúc chờ (Esc, bấm ra ngoài): bỏ qua. Bật lại một hộp
      // mà người dùng vừa cố ý đóng là cướp màn hình của họ.
      if (reportPanel.hidden) break;
      if (msg.state) fillReport(msg.state);
      else {
        reportLoading.hidden = true;
        setReportError(msg.error ?? 'Could not read this task from AstraWork.');
      }
      break;

    case 'taskReported':
      closeReport();
      appendNote(
        msg.datesRejected
          ? // Lùi có tiếng: người dùng vừa gõ một ngày và nó KHÔNG lên bảng.
            // Nói cả ngày thật sự đã ghi, để họ biết phải nhờ ai sửa cái gì.
            `Task reported done. AstraWork kept its own dates (${msg.actualStart} → ${msg.actualEnd}) — only a reviewer can change them.`
          : `Task reported done on AstraWork (${msg.actualStart} → ${msg.actualEnd}).`,
      );
      break;

    case 'taskReportFailed':
      setReportBusy(false);
      setReportError(msg.error);
      break;

    case 'notice':
      appendNote(msg.text);
      break;

    case 'permission_request':
      hideActivity();
      appendPermissionPrompt(msg.prompt);
      break;

    case 'permission_resolved':
      resolvePermissionPrompt(msg.id, msg.decision);
      break;

    case 'question_request':
      hideActivity();
      appendQuestionPrompt(msg.prompt);
      break;

    case 'question_resolved':
      resolveQuestionPrompt(msg.id, msg.cancelled, msg.answers);
      break;

    case 'permission_state':
      applyPermissionState(msg.state);
      break;

    case 'permission_denied':
      appendNote(`Blocked ${msg.toolName}: ${msg.reason}`);
      break;

    case 'permission_downgraded':
      appendNote(`Permissions downgraded: ${msg.reason}`);
      break;

    case 'todos':
      renderTodos(msg.items);
      break;

    case 'changes':
      changesBtn.hidden = msg.pending === 0;
      changesBtn.textContent = msg.pending > 0 ? `Changes (${msg.pending})` : 'Changes';
      changesBtn.title = msg.summary;
      break;

    case 'turn_start':
      appendUser(msg.prompt, msg.images, msg.pins);
      busy = true;
      updateControls();
      break;

    case 'note':
      appendNote(msg.text);
      break;

    case 'imagePicked':
      pendingImages.push(msg.image);
      renderAttachments();
      break;

    case 'filePicked':
      insertMention(msg.path);
      break;

    case 'thinking':
      showActivity(msg.iteration > 1 ? `Thinking (step ${msg.iteration})` : 'Thinking');
      break;

    case 'text':
      hideActivity();
      appendDelta(msg.delta);
      break;

    case 'tool_start':
      appendToolStart(msg.callId, msg.name, msg.args);
      showActivity(`Running ${msg.name}`);
      break;

    case 'tool_output':
      appendToolOutput(msg.callId, msg.delta);
      break;

    case 'tool_end':
      appendToolEnd(msg.callId, msg.isError, msg.summary, msg.durationMs, msg.preview, msg.previewKind);
      hideActivity();
      break;

    case 'injection_warning':
      appendInjectionWarning(msg.toolName, msg.signals, msg.excerpt);
      break;

    case 'repair':
      // Lý do đã tự nói rõ hỏng ở đâu (sai schema, hay thẻ sai cú pháp) — thêm
      // tiền tố đoán trước sẽ mâu thuẫn với chính nó.
      appendNote(`Asking the model to call again: ${msg.reason}`);
      break;

    case 'tool_call_dropped':
      appendNote(msg.reason);
      break;

    case 'turn_end':
      hideActivity();
      finishAssistant(msg);
      busy = false;
      updateControls();
      break;

    case 'error':
      hideActivity();
      appendError(msg.message, msg.hint, msg.hintAction);
      busy = false;
      updateControls();
      break;

    case 'mentions':
      showMentions(msg.items);
      break;

    // ── M6 ────────────────────────────────────────────────────────────────

    case 'context':
      renderContext(msg.usage);
      break;

    // Nén chen vào TRƯỚC lượt của người dùng và là một lượt gọi model đầy đủ.
    // Không có dòng này thì khoảng đó panel đứng im sau khi bấm gửi.
    case 'compacting':
      // HAI thứ, không phải một. Dòng activity đếm giây trôi qua nhưng nó là
      // thứ tạm: bất cứ sự kiện nào gọi `hideActivity()` cũng xoá nó, và lúc ấy
      // hội thoại không còn dấu vết nào cho thấy có một lượt gọi model đang
      // chạy — người dùng chỉ thấy panel đứng im rồi bỗng hiện kết quả. Ghi chú
      // thì Ở LẠI, và khi có kết quả nó được viết đè tại chỗ nên không sinh ra
      // hai dòng nói cùng một chuyện.
      startCompactNote(
        msg.focus
          ? `Compacting the conversation, keeping detail on: ${msg.focus}`
          : msg.trigger === 'manual'
            ? 'Compacting the conversation — this replaces the older messages with a summary…'
            : `Context is full (${short(msg.tokensBefore)} tokens) — compacting before this turn…`,
      );
      showActivity(
        msg.trigger === 'manual'
          ? 'Compacting the conversation'
          : `Context is full (${short(msg.tokensBefore)} tokens) — compacting automatically`,
      );
      break;

    case 'compacted':
      hideActivity();
      finishCompactNote(
        `Conversation compacted: dropped ${msg.droppedMessages} old messages, ` +
          `${short(msg.tokensBefore)} → ${short(msg.tokensAfter)} tokens. ` +
          'The older part is now only a summary — repeat any detail the agent asks about again.' +
          degradedSuffix(msg.degradedReason),
      );
      break;

    case 'compact_failed':
      hideActivity();
      finishCompactNote(
        `Could not compact the conversation (${msg.reason}). The context is still near the ceiling, so the ` +
          'next turn may fail — try /compact again, or /clear if the current task is done.',
      );
      break;

    case 'compact_skipped':
      hideActivity();
      finishCompactNote(msg.reason);
      break;

    case 'commands':
      commands = msg.items;
      break;

    case 'sessions':
      renderHistory(msg.items);
      if (msg.open) openHistory();
      break;

    case 'promptHistory':
      promptHistory = msg.items;
      promptIndex = promptHistory.length;
      break;

    case 'restored':
      renderRestored(msg.title, msg.messages);
      break;

    case 'memory':
      renderMemory(msg.files);
      break;

    case 'pins':
      renderPins(msg.items);
      break;

    case 'selectionHint':
      renderSelectionHint(msg.ref);
      break;

    case 'undone':
      appendNote(
        msg.files > 0
          ? `Reverted ${msg.files} file(s) from the last turn.` +
              (msg.skipped > 0 ? ` ${msg.skipped} file(s) were too large to snapshot.` : '')
          : 'The last turn changed no files — nothing to undo.',
      );
      break;

    case 'cleared':
      hideActivity();
      closeHistory();
      messages.replaceChildren();
      // Ghi chú nén đang chờ kết quả cũng vừa bị gỡ khỏi DOM. Không quên nó thì
      // kết quả nén sẽ được viết vào một node không còn nằm trên màn hình.
      compactNote = undefined;
      toolNodes.clear();
      streamedTools.clear();
      permissionNodes.clear();
      awaitingPermission = 0;
      questionNodes.clear();
      awaitingQuestion = 0;
      renderTodos([]);
      current = undefined;
      busy = false;
      updateControls();
      break;
  }
});

// ── Dựng nội dung hội thoại ────────────────────────────────────────────────

/**
 * Bám đáy — nhưng chỉ khi người dùng đang ở đáy.
 *
 * Với UI stream, kéo lên đọc lại một đoạn code rồi bị giật xuống mỗi khi có
 * token mới là lỗi khó chịu nhất. Cờ được cập nhật lúc CUỘN chứ không phải lúc
 * vẽ: sau khi thêm một khối lớn thì khoảng cách tới đáy đã khác rồi, đo lúc đó
 * sẽ tưởng nhầm là người dùng đã rời đáy.
 */
let stickToBottom = true;

messages.addEventListener('scroll', () => {
  const distance = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
  stickToBottom = distance < 80;
});

function scrollToEnd(): void {
  if (!stickToBottom) return;
  messages.scrollTop = messages.scrollHeight;
}

function appendUser(text: string, imageCount = 0, pins: PinnedItemWire[] = []): void {
  const bubble = el('div', 'msg user');
  bubble.append(el('div', 'msg-body', text));

  if (imageCount > 0) {
    // `sentImages` chỉ có ở webview vừa bấm gửi. Webview thứ hai (panel mở
    // cạnh) nhận cùng `turn_start` nhưng không có bản gốc — hiện số lượng.
    if (sentImages.length === imageCount) {
      const row = el('div', 'msg-images');
      for (const image of sentImages) {
        const img = document.createElement('img');
        img.src = dataUrl(image);
        img.alt = image.name;
        img.title = image.name;
        row.append(img);
      }
      bubble.append(row);
    } else {
      bubble.append(el('div', 'attachment', `+ ${imageCount} attached image(s)`));
    }
    sentImages = [];
  }

  // Khác ảnh: metadata pin đến thẳng từ `turn_start` (`msg.pins`), không cần
  // webview tự giữ bản gốc — pin một-lần-mỗi-lượt, nên chip chỉ còn ý nghĩa
  // trong đúng bong bóng này, không phải trong composer nữa (xem `renderPins`).
  if (pins.length > 0) {
    const row = el('div', 'msg-pins');
    for (const pin of pins) {
      const label =
        pin.startLine !== undefined && pin.endLine !== undefined
          ? `${pin.name} (L${pin.startLine}-${pin.endLine})`
          : pin.name;
      const chip = el('span', 'msg-pin-chip', label);
      chip.title = pin.path;
      row.append(chip);
    }
    bubble.append(row);
  }

  messages.append(bubble);
  scrollToEnd();
}

function startAssistant(): void {
  const node = el('div', 'msg assistant');
  const body = el('div', 'msg-body');
  node.append(body);
  messages.append(node);
  current = { node, body, raw: '' };
  scrollToEnd();
}

function appendDelta(delta: string): void {
  if (!current) startAssistant();
  current!.raw += delta;
  // Render lại cả khối mỗi lần: markdown không parse được theo từng mẩu, và
  // với độ dài một câu trả lời thì chi phí này không đáng kể.
  current!.body.innerHTML = renderMarkdown(current!.raw);
  scrollToEnd();
}

/**
 * Một bước trong luồng chạy.
 *
 * Dòng đầu là "định làm gì" (tên tool + tham số), dòng thứ hai là "làm được
 * gì" (tóm tắt hoặc trạng thái đang chạy). Cả hai nằm trong `<summary>` để
 * chúng vẫn hiện khi khối đóng — người dùng đọc được toàn bộ mạch làm việc mà
 * không phải mở từng khối, và mở ra khi muốn xem output thô.
 */
function appendToolStart(callId: string, name: string, args: unknown): void {
  const block = el('details', 'tool running');
  const summary = el('summary');

  const head = el('div', 'tool-head');
  head.append(el('span', 'tool-dot', '●'));
  head.append(el('span', 'tool-name', name));
  head.append(el('span', 'tool-args', summarizeArgs(args)));
  head.append(el('span', 'tool-time', ''));
  summary.append(head);
  summary.append(el('div', 'tool-result', 'running…'));

  block.append(summary);
  block.append(el('pre', 'tool-output', ''));

  messages.append(block);
  toolNodes.set(callId, block);
  scrollToEnd();

  // Câu trả lời tiếp theo là một bong bóng mới, không nối vào bong bóng trước.
  current = undefined;
}

/**
 * Output chảy ra trong lúc tool còn chạy (bash).
 *
 * Mở khối ra ngay: một lệnh test chạy hai phút mà không thấy dòng nào thì
 * không phân biệt được đang chạy với đang treo.
 */
function appendToolOutput(callId: string, delta: string): void {
  const block = toolNodes.get(callId);
  if (!block) return;

  const output = block.querySelector('.tool-output');
  if (!output) return;

  streamedTools.add(callId);
  block.setAttribute('open', '');
  output.textContent = clampTail(`${output.textContent ?? ''}${delta}`);
  output.scrollTop = output.scrollHeight;
  scrollToEnd();
}

function appendToolEnd(
  callId: string,
  isError: boolean,
  summary: string,
  durationMs: number,
  preview: string,
  previewKind?: 'diff' | 'command' | 'text',
): void {
  const block = toolNodes.get(callId);
  if (!block) return;

  block.className = `tool ${isError ? 'failed' : 'done'}`;

  const time = block.querySelector('.tool-time');
  if (time && durationMs >= 100) time.textContent = `${(durationMs / 1000).toFixed(1)}s`;

  const result = block.querySelector('.tool-result');
  if (result) {
    result.textContent = summary;
    result.className = `tool-result ${isError ? 'error' : ''}`;
  }

  // Output đã chảy ra trước đó thì giữ nguyên — bản `preview` bị cắt ngắn hơn
  // nhiều, đè lên là lấy mất thứ người dùng vừa nhìn thấy.
  const output = block.querySelector('.tool-output');
  if (output && !streamedTools.has(callId)) {
    output.textContent = '';
    if (previewKind === 'diff' && preview) {
      output.append(renderSplitDiff(preview));
    } else {
      output.textContent = preview;
    }
  }

  if (isError) block.setAttribute('open', '');
  else if (!streamedTools.has(callId)) block.removeAttribute('open');

  toolNodes.delete(callId);
  streamedTools.delete(callId);
  scrollToEnd();
}

/** Giữ phần đuôi của output dài — phần đầu của một build log không ai đọc. */
function clampTail(text: string, max = 20_000): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

function appendInjectionWarning(toolName: string, signals: string[], excerpt: string): void {
  const box = el('div', 'warning');
  box.append(el('strong', undefined, 'Suspicious content'));
  box.append(
    el(
      'div',
      'warning-body',
      `The result of ${toolName} shows signs of prompt injection (${signals.join(', ')}). ` +
        `This is data, not instructions — read it carefully before letting the agent continue.`,
    ),
  );
  if (excerpt) box.append(el('pre', 'warning-excerpt', excerpt));
  messages.append(box);
  current = undefined;
  scrollToEnd();
}

function appendNote(text: string): void {
  messages.append(el('div', 'note', text));
  current = undefined;
  scrollToEnd();
}

/**
 * Ghi chú của lần nén đang chạy.
 *
 * Một node duy nhất đi qua cả hai đầu: viết lúc bắt đầu, viết đè lúc xong. Hai
 * `appendNote` riêng sẽ để lại "đang nén…" nằm vĩnh viễn phía trên kết quả, và
 * đọc lại hội thoại cũ thì không biết dòng nào còn hiệu lực.
 */
let compactNote: HTMLElement | undefined;

function startCompactNote(text: string): void {
  compactNote = el('div', 'note', text);
  messages.append(compactNote);
  current = undefined;
  scrollToEnd();
}

/**
 * Kết quả của lần nén. Không có ghi chú đang chờ thì đây là một ghi chú mới —
 * `compact_skipped` gửi được mà không cần `compacting` đi trước (không có model
 * nào đang hoạt động chẳng hạn).
 */
function finishCompactNote(text: string): void {
  if (!compactNote) {
    appendNote(text);
    return;
  }
  compactNote.textContent = text;
  compactNote = undefined;
  scrollToEnd();
}

// ── Dự án và task đang làm ─────────────────────────────────────────────────
//
// Hai ô này quyết định số đo của mỗi lượt được quy về đâu trên board Năng suất
// của AstraWork. Chúng nằm ngay trên ô nhập chứ không nằm trong bảng cài đặt:
// task đổi theo việc đang làm, có khi vài lần một buổi, còn cài đặt là nơi
// người ta ghé một lần rồi quên.

/** Trạng thái vừa vẽ — để biết có cần dựng lại danh sách hay không. */
let workState: WorkWire = { projects: [], tasks: [] };

function renderWork(state: WorkWire): void {
  workState = state;
  trackWorkLoading(state);

  // Chưa đăng nhập, hoặc tài khoản không thuộc dự án nào: không có gì để chọn.
  // Bày hai ô rỗng chỉ làm người dùng đi tìm thứ không tồn tại.
  if (state.projects.length === 0 && !state.taskId && !state.error) {
    workPickers.hidden = true;
    return;
  }
  workPickers.hidden = false;

  fillSelect(
    workProject,
    state.projects.map((p) => ({ value: String(p.id), label: p.name })),
    state.projectId !== undefined ? String(state.projectId) : '',
    'Project…',
  );

  // Task đã khai nhưng danh sách chưa về (hoặc vừa hỏng): giữ nó lại thành một
  // mục riêng. Không có mục ấy thì ô nhảy về "No task" và bảng nói sai — người
  // dùng tưởng mình chưa khai, trong khi số vẫn đang được quy về task đó.
  const tasks = state.tasks.map((t) => ({ value: String(t.id), label: t.label }));
  if (state.taskId && !state.tasks.some((t) => t.id === state.taskId)) {
    tasks.unshift({ value: String(state.taskId), label: state.taskLabel ?? `#${state.taskId}` });
  }
  fillSelect(
    workTask,
    tasks,
    state.taskId !== undefined ? String(state.taskId) : '',
    'No task — work is not measured',
  );

  workNote.textContent = state.error
    ? state.error
    : state.loading
      ? 'Reading…'
      : state.tasks.length === 0 && state.projectId !== undefined
        ? // Nói rõ vì sao ô rỗng. Danh sách chỉ gồm việc CÒN MỞ, ĐƯỢC GIAO cho
          // người này, Ở CÔNG ĐOẠN CODING — ba điều kiện, và điều kiện thứ ba
          // là thứ người dùng ít ngờ tới nhất, nên khi nó là nguyên nhân thì
          // nói thẳng ra thay vì để họ đi tìm lỗi ở extension.
          state.otherStages
          ? `${state.otherStages} open task(s) of yours here are outside the coding stage`
          : 'No open coding task assigned to you here'
        : '';
  workNote.className = state.error ? 'work-note problem' : 'work-note';

  renderPlanLine(state);
}

// ── Lịch của task đang khai ────────────────────────────────────────────────
//
// Hai cột `plan_start`/`plan_end` của WBS, hiện ngay cạnh ô chọn. Chúng về
// cùng danh sách task nên không tốn thêm lời gọi nào — thứ tốn kém là NGƯỢC
// LẠI: một người viết code không biết hạn của việc mình đang gõ cho tới lúc PM
// đi hỏi.

/** Hôm nay theo múi giờ máy, `YYYY-MM-DD`. Cùng quy ước với host. */
function todayISO(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Số ngày từ hôm nay tới `iso`. Âm = đã qua.
 *
 * So sánh bằng `Date.UTC` trên cả hai đầu: đọc `new Date('2026-08-15')` cho ra
 * nửa đêm UTC còn `new Date()` là giờ địa phương, và trừ hai thứ đó cho nhau
 * làm lệch một ngày ở gần nửa số múi giờ trên đời — đúng vào con số mà cả dòng
 * chữ này tồn tại để nói.
 */
function daysUntil(iso: string): number {
  const MS_PER_DAY = 86_400_000;
  const utc = (date: string): number => {
    const [y, m, d] = date.split('-');
    return Date.UTC(Number(y), Number(m) - 1, Number(d));
  };
  return Math.round((utc(iso) - utc(todayISO())) / MS_PER_DAY);
}

/** "2 days left" / "due today" / "3 days overdue". */
function duePhrase(days: number): string {
  if (days === 0) return 'due today';
  if (days > 0) return `${days} day${days === 1 ? '' : 's'} left`;
  const late = -days;
  return `${late} day${late === 1 ? '' : 's'} overdue`;
}

/**
 * Dòng lịch dưới ô chọn, và nút Report Done đi kèm nó.
 *
 * Im lặng khi chưa khai task: hàng này đã có ba thứ tranh chỗ trên một panel
 * hẹp, và một dòng "no plan dates" khi chưa chọn gì chỉ là nhiễu.
 */
function renderPlanLine(state: WorkWire): void {
  const task = state.taskId ? state.tasks.find((t) => t.id === state.taskId) : undefined;
  reportDoneBtn.hidden = !task;
  if (!task) {
    workPlan.hidden = true;
    workPlan.textContent = '';
    return;
  }

  let text: string;
  let late = false;
  if (task.planEnd) {
    const days = daysUntil(task.planEnd);
    late = days < 0;
    text = `Plan ${task.planStart || '?'} → ${task.planEnd} · ${duePhrase(days)}`;
  } else if (task.planStart) {
    text = `Plan from ${task.planStart} · no end date`;
  } else {
    // Nói ra chứ không để trống: một dòng trống đọc thành "đúng hạn", còn sự
    // thật là dòng WBS này chưa ai đặt lịch — việc phải làm nằm trên web.
    text = 'No plan dates on this task';
  }

  workPlan.textContent = text;
  workPlan.className = late ? 'work-plan late' : 'work-plan';
  workPlan.hidden = false;
}

// ── Hộp "Report Done" ──────────────────────────────────────────────────────
//
// Đóng một dòng WBS từ trong IDE. Vì sao có nút này: người viết code báo done ở
// nơi họ vừa viết xong, không phải sau khi mở trình duyệt, tìm lại dự án, tìm
// lại dòng — ba bước mà bước nào cũng đủ để việc báo cáo bị dời sang "lát nữa".
//
// Sáu ô đều SỬA ĐƯỢC dù đã điền sẵn. Số của telemetry chỉ là phần đi qua
// AstraCode, và ngày thì AstraWork sẽ tự đóng dấu hôm nay — cả hai là phỏng
// đoán tốt, không phải sự thật, nên người biết rõ hơn phải sửa được.

/** Task đang mở trong hộp. `undefined` = hộp đóng, hoặc chưa đọc xong. */
let reportTaskId: number | undefined;

function openReport(taskId: number): void {
  closeSettings();
  closeHistory();
  reportTaskId = undefined;
  reportPanel.hidden = false;
  reportTaskLine.textContent =
    workState.tasks.find((t) => t.id === taskId)?.label ?? workState.taskLabel ?? `#${taskId}`;
  reportLoading.hidden = false;
  reportFields.hidden = true;
  reportNote.hidden = true;
  setReportError(undefined);
  setReportBusy(false);
  reportSubmit.disabled = true;
  post({ type: 'openTaskReport', taskId });
}

function closeReport(): void {
  reportPanel.hidden = true;
  reportTaskId = undefined;
}

function setReportError(text: string | undefined): void {
  reportError.textContent = text ?? '';
  reportError.hidden = !text;
}

/** Khoá hộp trong lúc request đang bay: bấm Report hai lần là hai lần ghi. */
function setReportBusy(busy: boolean): void {
  reportSubmit.disabled = busy;
  reportSubmit.textContent = busy ? 'Reporting…' : 'Report';
  for (const field of [
    reportPlanStart,
    reportPlanEnd,
    reportActualStart,
    reportActualEnd,
    reportTokens,
    reportCost,
  ]) {
    field.disabled = busy;
  }
}

function fillReport(state: TaskReportWire): void {
  reportTaskId = state.taskId;
  reportTaskLine.textContent = state.label;
  reportLoading.hidden = true;
  reportFields.hidden = false;
  reportPlanStart.value = state.planStart;
  reportPlanEnd.value = state.planEnd;
  reportActualStart.value = state.actualStart;
  reportActualEnd.value = state.actualEnd;
  reportTokens.value = String(state.tokens);
  // Bốn số lẻ vì `cost_usd` được làm tròn tới đó ở gateway; cắt còn hai sẽ biến
  // một task nhỏ thành $0.00 rồi ghi đúng con số ấy lên WBS.
  reportCost.value = state.costUsd.toFixed(4);

  reportNote.textContent = state.usageError
    ? // Nói rõ hai ô đang bằng 0 vì KHÔNG ĐỌC ĐƯỢC, không phải vì đo được 0 —
      // hai thứ này khác nhau hoàn toàn với người sắp bấm nút gửi.
      `Could not read the measured usage (${state.usageError}) — type the figures in.`
    : 'Figures come from AstraWork telemetry. Adjust them if you know better.';
  reportNote.hidden = false;
  setReportError(undefined);
  setReportBusy(false);
}

reportDoneBtn.addEventListener('click', () => {
  if (workState.taskId) openReport(workState.taskId);
});

reportClose.addEventListener('click', closeReport);
reportCancel.addEventListener('click', closeReport);
reportScrim.addEventListener('click', closeReport);

reportForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (reportTaskId === undefined) return;

  // Ô number rỗng cho `''`: đọc thành 0 thì một ô bị xoá trắng sẽ lặng lẽ ghi
  // "0 tokens" lên WBS. Chặn ở đây và nói ra.
  const tokens = Number(reportTokens.value);
  const costUsd = Number(reportCost.value);
  if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(costUsd) || costUsd < 0) {
    setReportError('Tokens and cost must be numbers, zero or more.');
    return;
  }

  setReportError(undefined);
  setReportBusy(true);
  post({
    type: 'reportTaskDone',
    taskId: reportTaskId,
    planStart: reportPlanStart.value,
    planEnd: reportPlanEnd.value,
    actualStart: reportActualStart.value,
    actualEnd: reportActualEnd.value,
    tokens: Math.round(tokens),
    costUsd,
  });
});

// ── Mẹo dùng AstraCode ─────────────────────────────────────────────────────
//
// Nằm cuối hàng dự án/task vì gần như mọi thứ dưới đây là chữ gõ THẲNG vào ô
// nhập ngay bên dưới — mẹo nằm cách xa chỗ dùng nó thì đọc xong quên ngay.
//
// Đóng mặc định và nhớ lựa chọn. Một bảng mẹo tự bung ra mỗi lần mở panel là
// thứ người dùng cũ phải đóng lại mỗi ngày, và đó là cách nhanh nhất để một
// thứ hữu ích trở thành thứ gây khó chịu.

/**
 * Chỉ những thứ KHÔNG tự lộ ra khi dùng.
 *
 * Nút bấm và ô chọn đã tự nói tên mình rồi; danh sách này để dành cho các lệnh
 * gõ tay và phím tắt — thứ người dùng không bao giờ tình cờ tìm ra. Mỗi mục
 * kèm một câu nói HỆ QUẢ, không phải mô tả lại chính cái tên.
 */
const TIPS: Array<{ key: string; what: string }> = [
  {
    key: '/memory <rule>',
    what: 'Save a project rule to ASTRA.md — it outlives this conversation',
  },
  {
    key: '/compact <what to keep>',
    what: 'Summarise the older messages now, keeping detail where you say',
  },
  { key: '@', what: 'Attach a file to your question — type @ then part of its name' },
  { key: '/undo', what: 'Put the files back as they were before the last turn' },
  { key: 'Shift+Tab', what: 'Switch permission mode without leaving the keyboard' },
  { key: 'Ctrl+V', what: 'Paste a screenshot straight into the question' },
  { key: '/help', what: 'List every command, including the ones this repo adds' },
];

function renderTips(): void {
  tipsPanel.replaceChildren();
  for (const tip of TIPS) {
    const row = el('div', 'tip');
    row.append(el('code', 'tip-key', tip.key));
    row.append(el('span', 'tip-what', tip.what));
    tipsPanel.append(row);
  }
}

function setTipsOpen(open: boolean): void {
  tipsPanel.hidden = !open;
  tipsToggle.setAttribute('aria-expanded', String(open));
  tipsToggle.textContent = open ? 'Hide tips' : 'Tips';
  vscode.setState({ ...vscode.getState(), tipsOpen: open });
}

// ── Lớp giữa trang: đang nạp, mức dùng ──────────────────────────────────────
//
// Phủ lên khung tin nhắn, chỉ hiện khi hội thoại còn trống. Hai thứ đi qua đây:
// "đang nạp" rồi mức dùng của tài khoản ngay sau khi nạp xong.
//
// Điều kiện duy nhất: hội thoại còn TRỐNG. Có tin nhắn rồi thì khoảng giữa đã
// có chủ, nên một lớp chữ nổi lên trên nó là che mất câu trả lời người ta đang
// đọc.

/** Chờ số của tài khoản lâu nhất bao lâu rồi thôi. */
const USAGE_WAITS_MS = 30_000;

/**
 * Dòng trạng thái ở giữa trang. Rỗng = không có.
 *
 * Hai câu đi qua đây: "đang nạp", rồi mức dùng của tài khoản ngay sau khi nạp
 * xong. Cùng một chỗ vì chúng nối nhau thành một mạch — nạp xong thì nói kết
 * quả — chứ không phải hai thông báo rời.
 *
 * `kind` để phân biệt hai câu ấy, vì chúng sống khác nhau: `loading` là một
 * nhịp chờ, còn `usage` NẰM LẠI cho tới khi người dùng gõ câu hỏi đầu tiên —
 * lúc đó cả lớp giữa trang nhường chỗ cho hội thoại. Không có đồng hồ đếm
 * ngược nào: một con số biến mất sau mười giây là con số người ta vừa liếc
 * thấy rồi phải đi tìm lại trong bảng cài đặt.
 */
let statusText = '';
let statusKind: 'none' | 'loading' | 'usage' = 'none';

/** Hội thoại chưa có gì — điều kiện để lớp giữa trang được phép hiện. */
function chatIsEmpty(): boolean {
  return messages.childElementCount === 0;
}

/**
 * Ai đang hiện ở giữa trang. Một chỗ duy nhất ghi `hidden`, để thứ tự ưu tiên
 * nằm gọn trong một hàm thay vì rải khắp file.
 */
function applyIdle(): void {
  const empty = chatIsEmpty();
  const status = empty && statusKind !== 'none';
  idleStatus.hidden = !status;
  idlePanel.hidden = !status;
}

// Mọi chỗ append vào khung chat đều đi qua đây mà không phải nhớ gọi gì thêm.
// Bắt từng chỗ append tự báo cáo nghĩa là chỗ nào quên báo thì lớp giữa trang
// nằm lại trên câu trả lời — và đó đúng là loại lỗi chỉ lộ ra khi đã phát hành.
new MutationObserver(() => applyIdle()).observe(messages, { childList: true });

/** Đã thấy một lần nạp đang chạy — để nhận ra lúc nó xong. */
let workLoadingSeen = false;

/**
 * Dòng "đang nạp", và cái chốt mở lời chào mức dùng ngay sau đó.
 *
 * Vì sao dòng này không phải `work-note` như "Reading…" cũ: lúc đang nạp lần
 * đầu thì hai ô chọn còn RỖNG và cả khối bị ẩn, nên chữ ghi trong đó không ai
 * thấy. Đúng lúc cần nói "đang làm việc gì đó" thì chỗ nói lại đang tàng hình.
 */
function trackWorkLoading(state: WorkWire): void {
  if (state.loading) {
    workLoadingSeen = true;
    setStatus('Loading your projects and tasks…', 'loading');
    return;
  }

  if (!workLoadingSeen) return;
  workLoadingSeen = false;
  setStatus('', 'none');
  // Nạp xong là lúc duy nhất lời chào mức dùng đúng nghĩa "vừa xong". Số của
  // tài khoản đi đường khác (bảng cài đặt) nên có thể tới sau — `due` là chỗ
  // đứng chờ, có hạn.
  if (usageNotice === 'idle') {
    usageNotice = 'due';
    usageNoticeUntil = Date.now() + USAGE_WAITS_MS;
    showUsageNoticeIfReady();
  }
}

function setStatus(text: string, kind: 'none' | 'loading' | 'usage'): void {
  if (statusText === text && statusKind === kind) return;
  statusText = text;
  statusKind = text === '' ? 'none' : kind;
  idleStatus.textContent = text;
  applyIdle();
}

/**
 * Mức dùng: nói một lần, ngay sau khi nạp xong, rồi trả hàng lại.
 *
 * `idle` → `due` (vừa nạp xong, đang chờ số) → `done`. Chỉ một lần cho mỗi lần
 * webview sống: đây là một lời chào, và một lời chào lặp lại mỗi vài phút thì
 * thành tiếng ồn ngay trong ngày đầu.
 */
let usageNotice: 'idle' | 'due' | 'done' = 'idle';
/** Hết hạn chờ thì thôi: một dòng số nhảy ra sau đó là một cú giật vô cớ. */
let usageNoticeUntil = 0;
let usageNoticeTimer: ReturnType<typeof setTimeout> | undefined;
let lastAccount: AccountUsageStateWire | undefined;

const USAGE_PREFIX = 'Your usage';

const usd = (n: number): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(n);

/**
 * Số của tài khoản đi kèm MỌI lần đẩy bảng cài đặt, kể cả khi bảng đang đóng —
 * nên hàng trên ô nhập không cần một đường lấy số riêng, chỉ cần nhặt lấy bản
 * vừa đi qua.
 */
function noteAccount(account: AccountUsageStateWire): void {
  lastAccount = account;
  showUsageNoticeIfReady();
}

function usageLine(a: NonNullable<AccountUsageStateWire['usage']>): string {
  const tokens = a.totalTokens.toLocaleString('en-US');
  const turns = a.turns.toLocaleString('en-US');
  // Có hạn mức thì phần trăm là câu trả lời người ta thật sự muốn ("còn nhiều
  // không"), nên nó đứng trước. Không có thì đừng bịa ra một mẫu số.
  const spend =
    a.budgetUsd !== undefined && a.budgetUsd > 0
      ? `${Math.round((Math.min(a.costUsd, a.budgetUsd) / a.budgetUsd) * 100)}% used · ` +
        `${usd(a.costUsd)} of ${usd(a.budgetUsd)} · ${usd(a.remainingUsd ?? 0)} left`
      : `${usd(a.costUsd)} spent`;
  return `${USAGE_PREFIX} · ${spend} · ${tokens} tokens · ${turns} turns`;
}

function showUsageNoticeIfReady(): void {
  if (usageNotice !== 'due') return;
  const account = lastAccount;

  // Chưa đăng nhập thì không có số nào để nói, và một dòng "—" không nói gì.
  // `undefined` KHÁC "không đăng nhập": nó là "bảng cài đặt chưa đẩy xuống lần
  // nào", và kết luận sớm ở đó là bỏ mất lời chào trong đúng những lần khởi
  // động chậm — tức là những lần người dùng chờ lâu nhất.
  if (account && (!account.available || account.error)) {
    dropUsageNotice();
    return;
  }

  if (!account?.usage) {
    if (Date.now() >= usageNoticeUntil) {
      dropUsageNotice();
      return;
    }
    setStatus('Reading your usage…', 'loading');
    // Không có sự kiện nào chắc chắn tới nữa (số hỏng thì bảng cài đặt cũng im),
    // nên hạn chờ phải tự hết bằng một cái hẹn giờ — nếu không dòng "Reading…"
    // nằm lại vĩnh viễn giữa trang.
    if (!usageNoticeTimer) {
      usageNoticeTimer = setTimeout(
        () => {
          usageNoticeTimer = undefined;
          showUsageNoticeIfReady();
        },
        Math.max(0, usageNoticeUntil - Date.now()),
      );
    }
    return;
  }

  usageNotice = 'done';
  const line = usageLine(account.usage);

  // Mở lại một phiên cũ thì giữa trang đã có chủ. Nói ở cuối dòng chat thay vì
  // im lặng bỏ qua: đây là con số người dùng vừa được hứa, và một lời chào bị
  // nuốt mất trông y hệt một tính năng hỏng.
  if (!chatIsEmpty()) {
    appendNote(line);
    return;
  }

  // Không hẹn giờ dọn: dòng này ở lại tới khi câu hỏi đầu tiên đẩy cả lớp giữa
  // trang đi (xem `applyIdle` + MutationObserver trên khung tin nhắn).
  setStatus(line, 'usage');
}

function dropUsageNotice(): void {
  usageNotice = 'done';
  if (usageNoticeTimer) {
    clearTimeout(usageNoticeTimer);
    usageNoticeTimer = undefined;
  }
  setStatus('', 'none');
}

renderTips();
setTipsOpen(vscode.getState()?.tipsOpen === true);
tipsToggle.addEventListener('click', () => setTipsOpen(tipsPanel.hidden === true));
applyIdle();

/**
 * Dựng lại nội dung một ô select.
 *
 * `textContent` cho từng option, không `innerHTML`: tên dự án và tiêu đề task
 * là chữ người khác gõ trên web, đi qua gateway rồi vào đây (documents/SECURITY.md §6).
 */
function fillSelect(
  select: HTMLSelectElement,
  items: { value: string; label: string }[],
  selected: string,
  emptyLabel: string,
): void {
  select.replaceChildren();
  const empty = el('option', undefined, emptyLabel);
  empty.value = '';
  select.append(empty);
  for (const item of items) {
    const opt = el('option', undefined, item.label);
    opt.value = item.value;
    select.append(opt);
  }
  select.value = selected;
}

workProject.addEventListener('change', () => {
  const id = Number(workProject.value);
  if (!Number.isInteger(id) || id <= 0) {
    // Không có "bỏ chọn dự án": gateway luôn mở một dự án nào đó trong token.
    // Trả ô về giá trị cũ thay vì gửi một lệnh mà host không làm gì được.
    workProject.value = workState.projectId !== undefined ? String(workState.projectId) : '';
    return;
  }
  post({ type: 'setProject', id });
});

workTask.addEventListener('change', () => {
  const raw = workTask.value;
  const id = raw ? Number(raw) : null;
  post({ type: 'setTask', id: id && Number.isInteger(id) && id > 0 ? id : null });
});

// ── Bộ nhớ, ngữ cảnh, phiên (M6) ───────────────────────────────────────────

/**
 * Đồng hồ ngữ cảnh.
 *
 * Im lặng dưới 70%: một con số nhấp nháy suốt phiên sẽ bị bỏ qua đúng vào lúc
 * nó bắt đầu quan trọng. Chỉ hiện khi đã đáng để biết.
 */
function renderContext(usage: ContextWire): void {
  if (usage.level === 'ok') {
    contextBox.hidden = true;
    contextBox.replaceChildren();
    return;
  }

  contextBox.replaceChildren();
  contextBox.className = `context ${usage.level}`;

  const bar = el('div', 'context-bar');
  const fill = el('div', 'context-fill');
  fill.style.width = `${Math.min(100, Math.round(usage.ratio * 100))}%`;
  bar.append(fill);

  contextBox.append(bar);
  contextBox.append(
    el(
      'span',
      'context-label',
      usage.level === 'compact'
        ? `Context ${usage.label} — will compact on the next turn`
        : `Context ${usage.label}`,
    ),
  );
  contextBox.hidden = false;
}

/**
 * Bảng hội thoại cũ, dựng bằng textContent.
 *
 * Tiêu đề phiên là câu người dùng từng gõ — nội dung của chính họ, nhưng vẫn
 * không đi qua markdown: một hội thoại cũ không nên vẽ được gì lên UI hiện tại.
 */
function renderHistory(items: SessionWire[]): void {
  historyTitle.textContent = `Chat history (${items.length})`;
  historyList.replaceChildren();

  if (items.length === 0) {
    historyList.append(
      el('div', 'note', 'No conversation has been saved for this folder yet.'),
      el(
        'div',
        'note',
        'A conversation is saved after its first answer, and only reappears in the folder that created it.',
      ),
    );
  }

  for (const s of items) {
    const row = el('button', `session${s.active ? ' active' : ''}`);
    row.append(el('span', 'session-title', s.title));
    row.append(
      el(
        'span',
        'session-meta',
        `${s.turns} turns · ${short(s.totalTokens)} tokens · ${new Date(s.updatedAt).toLocaleString()}`,
      ),
    );
    if (s.active) {
      row.append(el('span', 'session-meta', 'Open now'));
      row.disabled = true;
    } else {
      row.addEventListener('click', () => {
        // Đóng NGAY, không chờ host trả lời: người dùng đã quyết định xong, và
        // một lớp phủ nán lại trong lúc chờ vòng gọi khứ hồi trông như treo.
        // Hỏng thì lỗi hiện trong dòng chat — không có gì kẹt lại phía sau.
        closeHistory();
        post({ type: 'resumeSession', id: s.id });
      });
    }
    historyList.append(row);
  }

  historyList.scrollTop = 0;
}

function openHistory(): void {
  closeSettings();
  historyPanel.hidden = false;
  historyList.scrollTop = 0;
}

function closeHistory(): void {
  historyPanel.hidden = true;
}

historyClose.addEventListener('click', closeHistory);
// Bấm ra ngoài hộp — cách thoát thứ hai của mọi popup, giống bảng cài đặt.
historyScrim.addEventListener('click', closeHistory);

historyNew.addEventListener('click', () => {
  closeHistory();
  post({ type: 'clear' });
});

// ── Bảng cài đặt ───────────────────────────────────────────────────────────

/**
 * Vẽ lại toàn bộ bảng mỗi lần state đổi.
 *
 * Vẽ lại cả bảng thay vì vá từng ô: state đến từ host sau khi settings.json đã
 * ghi xong, nên nó là sự thật; giữ lại DOM cũ chỉ tạo cơ hội cho ô nhập hiện
 * một giá trị mà cấu hình thật không có.
 */
function renderSettingsPanel(state: SettingsWire): void {
  settingsBody.replaceChildren(...renderSettings(state, post));
  // Bảng cài đặt được đẩy xuống sau mỗi thay đổi dù đang đóng hay mở, nên đây
  // cũng là chỗ số của tài khoản đi qua — hàng trên ô nhập nhặt nó ở đây.
  noteAccount(state.account);
}

function closeSettings(): void {
  settingsPanel.hidden = true;
}

/**
 * Mở popup và xin lại state.
 *
 * Cuộn về đầu mỗi lần mở: hộp giữ nguyên DOM giữa hai lần, nên không đặt lại
 * thì lần sau nó mở ra ở đúng chỗ lần trước cuộn tới — người dùng bấm bánh răng
 * và thấy nửa cái bảng model, không thấy tiêu đề nào.
 */
function openSettings(): void {
  closeHistory();
  settingsPanel.hidden = false;
  settingsBody.scrollTop = 0;
  // Xin bản mới nhất: giá trị có thể đã đổi từ settings.json trong lúc bảng đóng.
  post({ type: 'openSettings' });
}

settingsClose.addEventListener('click', closeSettings);
// Bấm ra ngoài hộp là cách thoát thứ hai của mọi popup. Lớp mờ là phần tử
// riêng nên không cần dò event.target — không có click nào trong hộp lọt ra đây.
settingsScrim.addEventListener('click', closeSettings);

openSettingsBtn.addEventListener('click', openSettings);

// ── Cửa đăng nhập ──────────────────────────────────────────────────────────

/**
 * Chắn panel khi chưa đăng nhập. `reason` undefined = mở cửa.
 *
 * Model của AstraCode đến từ tài khoản AstraWork và không có nguồn nào khác,
 * nên "chưa đăng nhập" không phải một trạng thái dùng hạn chế — nó là trạng
 * thái chưa dùng được. Cửa này nói đúng điều đó thay vì để ô nhập mở ra rồi
 * nuốt câu hỏi.
 *
 * Nó KHÔNG phải lớp bảo mật — tầng lõi mới là chỗ chặn thật, không token thì
 * mọi request đều 401. Nó chỉ để người dùng không mất công gõ.
 */
function showGate(reason: string | undefined, kind?: BlockKind): void {
  if (!reason) {
    gate.hidden = true;
    return;
  }
  // Nút "Open settings" CHỈ hiện khi thiếu địa chỉ gateway — ở đó bảng cài đặt
  // là việc phải làm tiếp, và cửa này che mất nút bánh răng ở thanh công cụ.
  // Còn khi chỉ là chưa đăng nhập thì cửa có đúng một việc: bấm đăng nhập. Thêm
  // một nút thứ hai vào đó chỉ mời người dùng đi lạc vào một bảng không giúp gì.
  gateSettings.hidden = kind !== 'config';
  gateText.textContent =
    kind === 'config'
      ? reason
      : `${reason} Models come from your AstraWork account, so chat opens up once you sign in.`;
  gate.hidden = false;
}

gateSignIn.addEventListener('click', () => post({ type: 'signIn' }));

gateSettings.addEventListener('click', openSettings);

// Esc là cách thoát khỏi một lớp phủ mà ai cũng thử trước tiên. Chỉ bắt khi có
// lớp phủ đang mở, để không cướp phím Esc của ô nhập. Cửa đăng nhập KHÔNG đóng
// bằng Esc — nó không phải hộp thoại người dùng bỏ qua được.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!modeMenu.hidden) {
    e.preventDefault();
    closeModeMenu();
  } else if (!reportPanel.hidden) {
    e.preventDefault();
    closeReport();
  } else if (!settingsPanel.hidden) {
    e.preventDefault();
    closeSettings();
  } else if (!historyPanel.hidden) {
    e.preventDefault();
    closeHistory();
  }
});

/**
 * Một lần gọi tool trong phiên cũ: tên · input · → output.
 *
 * Cùng bố cục với khối tool lúc chạy thật (tên đậm, tham số mờ, kết quả sau
 * dấu ⌞) để mắt không phải học lại cách đọc khi mở một hội thoại cũ. Toàn bộ
 * dựng bằng textContent — đây là chữ do model và tool sinh ra.
 */
/**
 * Một lần gọi tool trong phiên cũ.
 *
 * Dùng ĐÚNG các class của khối tool lúc chạy thật (`.tool-head`, `.tool-dot`,
 * `.tool-name`, `.tool-args`, `.tool-result`) chứ không phải một bộ class
 * riêng. Lý do không phải là bớt CSS: cùng một thứ mà vẽ bằng hai bố cục khác
 * nhau thì người đọc phải học lại cách đọc màn hình sau mỗi lần mở phiên cũ —
 * và dòng dồn hết lên một hàng bị cắt giữa chừng là chỗ đầu tiên họ nhận ra.
 *
 * Khác duy nhất so với lúc chạy: không có `<details>` và không có `.tool-output`.
 * Nội dung đầy đủ của tool không được lưu, nên một mũi tên bung ra chỗ trống là
 * hứa hẹn một thứ không có.
 */
function restoredToolRow(tool: {
  name: string;
  input: string;
  output: string;
  isError?: boolean;
}): HTMLElement {
  // `failed` chỉ khi phiên NÓI là hỏng. `isError === undefined` nghĩa là phiên
  // cũ không lưu trạng thái đó — và "không biết" phải trông khác "đã xong", nếu
  // không thì mọi phiên v1 hiện thành một dãy toàn màu xanh.
  const row = el('div', `tool restored${tool.isError ? ' failed' : ''}`);

  const head = el('div', 'tool-head');
  head.append(el('span', 'tool-dot', '●'));
  head.append(el('span', 'tool-name', tool.name));
  if (tool.input) head.append(el('span', 'tool-args', tool.input));
  row.append(head);

  // `.tool-result` tự thêm dấu `⌞` bằng ::before, giống hệt lúc chạy.
  if (tool.output) {
    row.append(el('div', `tool-result${tool.isError ? ' error' : ''}`, tool.output));
  }

  row.title = [tool.name, tool.input, tool.output].filter(Boolean).join('  ');
  return row;
}

function renderRestored(title: string, items: RestoredMessage[]): void {
  hideActivity();
  closeHistory();
  messages.replaceChildren();
  // Cùng lý do với nhánh `cleared`: node cũ vừa rời khỏi màn hình.
  compactNote = undefined;
  toolNodes.clear();
  streamedTools.clear();
  permissionNodes.clear();
  awaitingPermission = 0;
  questionNodes.clear();
  awaitingQuestion = 0;
  current = undefined;

  messages.append(el('div', 'note', `Reopened session: ${title}`));
  for (const m of items) {
    if (m.role === 'user') {
      appendUser(m.content);
    } else if (m.role === 'tool') {
      for (const t of m.tools) messages.append(restoredToolRow(t));
    } else {
      startAssistant();
      current!.raw = m.content;
      current!.body.innerHTML = renderMarkdown(m.content);
      current = undefined;
    }
  }

  // Lịch sử undo không đi theo phiên: file trên đĩa đã đi tiếp từ lúc đó.
  messages.append(
    el(
      'div',
      'note',
      'Tool calls from the old session are shown condensed; approval boxes and full results are not rebuilt. /undo starts over from here.',
    ),
  );
  busy = false;
  updateControls();
  scrollToEnd();
}

function renderMemory(files: Array<{ path: string; source: string; flagged: boolean }>): void {
  const flagged = files.filter((f) => f.flagged);
  if (flagged.length === 0) {
    if (files.length > 0) {
      appendNote(`Using notes from ${files.map((f) => f.path).join(', ')}.`);
    }
    return;
  }

  const box = el('div', 'warning');
  box.append(el('strong', undefined, 'ASTRA.md looks like it contains instructions'));
  box.append(
    el(
      'div',
      'warning-body',
      `${flagged.map((f) => f.path).join(', ')} contains text that reads like commands. ` +
        `This file goes straight into the system prompt, so open it and look before trusting it.`,
    ),
  );
  messages.append(box);
  current = undefined;
  scrollToEnd();
}

function short(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * Vì sao bản tóm tắt phải lùi về bản cơ học.
 *
 * Hai lý do này từng dùng chung một câu ("model tóm tắt không chạy được"), và
 * câu đó nói SAI ở trường hợp thứ hai: khi bản tóm tắt bị chặn vì có dấu hiệu
 * injection thì model chạy hoàn toàn bình thường — thứ bất thường nằm trong
 * nội dung agent vừa đọc. Đó là điều đáng báo động, không phải một trục trặc.
 */
function degradedSuffix(reason: 'model_failed' | 'injection' | null): string {
  switch (reason) {
    case 'model_failed':
      return ' The summarising model failed, so only a mechanical trim was kept.';
    case 'injection':
      return (
        ' ⚠ The summary was thrown away because the material read shows signs of injected instructions' +
        ' — a mechanical trim was used instead. Look again at the files the agent just opened.'
      );
    default:
      return '';
  }
}

// ── Chỉ báo "đang làm gì" ──────────────────────────────────────────────────
//
// Khoảng lặng giữa lúc gửi request và lúc token đầu tiên về là chỗ dài nhất
// của một lượt. Không có gì lấp vào đó thì extension trông như bị treo — và
// đó chính là cảm giác "chưa có streaming" dù stream vẫn chạy.

let activityNode: HTMLElement | undefined;
let activityLabel = '';
let activityStarted = 0;
let activityTimer: number | undefined;

function showActivity(label: string): void {
  if (!activityNode) {
    activityNode = el('div', 'activity');
    activityNode.append(el('span', 'activity-spinner', '✳'));
    activityNode.append(el('span', 'activity-label'));
    activityNode.append(el('span', 'activity-time'));
  }

  activityLabel = label;
  activityStarted = Date.now();
  // Luôn đẩy xuống cuối: mọi khối mới thêm vào sau nó sẽ đứng trên nó.
  messages.append(activityNode);
  paintActivity();

  if (activityTimer === undefined) {
    activityTimer = setInterval(paintActivity, 1000) as unknown as number;
  }
  scrollToEnd();
}

function paintActivity(): void {
  if (!activityNode) return;
  const label = activityNode.querySelector('.activity-label');
  const time = activityNode.querySelector('.activity-time');
  if (label) label.textContent = `${activityLabel}…`;
  const elapsed = Math.floor((Date.now() - activityStarted) / 1000);
  if (time) time.textContent = elapsed > 0 ? `${elapsed}s` : '';
}

function hideActivity(): void {
  if (activityTimer !== undefined) {
    clearInterval(activityTimer);
    activityTimer = undefined;
  }
  activityNode?.remove();
}

// ── Duyệt quyền (M4) ───────────────────────────────────────────────────────

const permissionNodes = new Map<string, HTMLElement>();

/**
 * Hộp duyệt quyền.
 *
 * Toàn bộ nội dung dựng bằng `textContent`, KHÔNG qua markdown. Preview ở đây
 * là diff hoặc lệnh shell do model soạn — nếu render nó thành HTML thì model
 * tự vẽ được giao diện lên chính hộp đang hỏi người dùng có tin nó không.
 */
/**
 * Khung xem trước trong hộp duyệt quyền.
 *
 * Diff được tô màu; mọi thứ khác giữ nguyên một khối chữ trơn. Ranh giới đó do
 * tool khai (`previewKind`), không phải đoán ở đây — xem `ToolIntent`.
 *
 * Toàn bộ chữ vẫn đi qua `textContent`. Màu đến từ tên class do CHÍNH TA đặt
 * sau khi đọc ký tự đầu dòng, nên nội dung của model không bao giờ chọn được
 * class cho mình, càng không chèn được thẻ.
 */
function renderPreview(preview: string, kind?: 'diff' | 'command' | 'text'): HTMLElement {
  const pre = el('pre', 'permission-preview');
  if (kind !== 'diff') {
    pre.classList.add(kind === 'command' ? 'is-command' : 'is-text');
    pre.textContent = preview;
    return pre;
  }

  pre.classList.add('is-diff');
  for (const line of preview.split('\n')) {
    pre.append(diffLineNode(line));
  }
  return pre;
}

/**
 * Một dòng diff → một span khối.
 *
 * Dạng do `formatUnifiedDiff` sinh ra: dấu (1 ký tự) + số dòng (5 ký tự căn
 * phải) + khoảng trắng + nội dung. Dòng nào không đúng khuôn đó (`…`, `… còn N
 * dòng nữa`) là dòng phụ, tô nhạt.
 *
 * Ký tự `\n` được giữ lại ở cuối mỗi span để copy ra vẫn đúng nguyên văn diff —
 * người ta có copy khối này đi dán chỗ khác.
 */
function diffLineNode(line: string): HTMLElement {
  const sign = line.charAt(0);
  const known = (sign === '+' || sign === '-' || sign === ' ') && line.length >= 6;

  const row = el('span', 'diff-line');
  if (!known) {
    row.classList.add('diff-meta');
    row.textContent = line + '\n';
    return row;
  }

  row.classList.add(sign === '+' ? 'diff-add' : sign === '-' ? 'diff-del' : 'diff-ctx');
  // Tách máng số dòng ra để làm nhạt nó: mắt cần bám vào phần code, không phải
  // vào cột số. Cắt theo vị trí cố định vì `formatUnifiedDiff` căn cứng.
  row.append(el('span', 'diff-gutter', line.slice(0, 6)));
  row.append(el('span', 'diff-text', line.slice(6)));
  row.append(document.createTextNode('\n'));
  return row;
}

/**
 * Split diff — bên trái là bản cũ, bên phải là bản mới.
 *
 * Phân tích cùng định dạng unified diff mà `formatUnifiedDiff` sinh ra:
 *   `+·· 1 text`  — dòng thêm (bên phải)
 *   `-·· 5 text`  — dòng xoá (bên trái)
 *   ` ·· 3 text`  — dòng giữ (cả hai)
 *   `…`           — dòng meta (cột nhạt, span cả hai)
 *
 * Mỗi dòng diff tương ứng với đúng một hàng trong split view: dòng thêm thì
 * cột trái trống, dòng xoá thì cột phải trống, dòng giữ thì cả hai có. Cách này
 * giữ hàng thẳng — align theo dòng như git diff, không lệch khi thêm/xoá
 * nhiều dòng liên tiếp.
 *
 * Toàn bộ chữ đi qua textContent; class do chính ta đặt sau khi đọc ký tự đầu
 * dòng, nên nội dung của model không bao giờ chọn được class cho mình.
 */
function renderSplitDiff(diff: string): HTMLElement {
  const wrap = el('div', 'split-diff');

  for (const line of diff.split('\n')) {
    const sign = line.charAt(0);
    const known = (sign === '+' || sign === '-' || sign === ' ') && line.length >= 6;

    if (!known) {
      // Dòng meta (…, "… còn N dòng nữa") — nhạt và trải cả hai cột.
      const meta = el('div', 'split-diff-meta', line);
      wrap.append(meta);
      continue;
    }

    const row = el('div', 'split-diff-row');
    const left = el('div', 'split-diff-cell split-diff-left');
    const right = el('div', 'split-diff-cell split-diff-right');
    const gutter = line.slice(0, 6);
    const text = line.slice(6);

    if (sign === '-') {
      left.classList.add('diff-del');
      left.append(el('span', 'diff-gutter', gutter));
      left.append(el('span', 'diff-text', text));
      // Cột phải trống nhưng giữ chiều cao để hàng không bị lép.
      right.classList.add('split-diff-empty');
    } else if (sign === '+') {
      right.classList.add('diff-add');
      right.append(el('span', 'diff-gutter', gutter));
      right.append(el('span', 'diff-text', text));
      left.classList.add('split-diff-empty');
    } else {
      // Dòng ngữ cảnh — cả hai cột đều có.
      left.classList.add('diff-ctx');
      right.classList.add('diff-ctx');
      left.append(el('span', 'diff-gutter', gutter));
      left.append(el('span', 'diff-text', text));
      right.append(el('span', 'diff-gutter', gutter));
      right.append(el('span', 'diff-text', text));
    }

    row.append(left, right);
    wrap.append(row);
  }

  return wrap;
}

function appendPermissionPrompt(prompt: {
  id: string;
  tool: string;
  summary: string;
  path?: string;
  preview?: string;
  previewKind?: 'diff' | 'command' | 'text';
  mode: string;
  downgradeReason?: string;
  alwaysAsk: boolean;
  warnings?: string[];
}): void {
  const box = el('div', 'permission');

  const head = el('div', 'permission-head');
  head.append(el('span', 'permission-tool', prompt.tool));
  head.append(el('span', 'permission-summary', prompt.summary));
  box.append(head);

  if (prompt.downgradeReason) {
    box.append(el('div', 'permission-downgrade', prompt.downgradeReason));
  }

  // Cảnh báo đứng TRƯỚC bản xem trước, không nằm lẫn trong nó: nó là lý do hộp
  // này xuất hiện (có khi giữa chế độ tự duyệt), nên nó phải đọc được trước cả
  // khi mắt kịp lướt xuống ba chục dòng diff.
  if (prompt.warnings?.length) {
    box.classList.add('permission-risky');
    const warn = el('div', 'permission-warnings');
    warn.append(el('div', 'permission-warning-title', 'Reaches outside this workspace'));
    const list = el('ul', 'permission-warning-list');
    for (const line of prompt.warnings) list.append(el('li', undefined, line));
    warn.append(list);
    box.append(warn);
  }

  if (prompt.preview) {
    box.append(
      prompt.previewKind === 'diff'
        ? renderSplitDiff(prompt.preview)
        : renderPreview(prompt.preview, prompt.previewKind),
    );
  }

  const actions = el('div', 'permission-actions');

  const answer = (decision: 'allow_once' | 'allow_always' | 'deny'): void => {
    post({ type: 'permissionAnswer', id: prompt.id, decision });
  };

  const deny = el('button', 'secondary', 'No');
  deny.addEventListener('click', () => answer('deny'));

  const once = el('button', 'primary', 'Allow');
  once.addEventListener('click', () => answer('allow_once'));

  actions.append(deny, once);

  // bash không bao giờ có nút "luôn cho phép" — core cũng từ chối nhớ nó, nên
  // hiện nút ở đây chỉ là lời hứa suông với người dùng.
  if (!prompt.alwaysAsk) {
    const always = el('button', 'secondary', 'Always allow');
    always.title = prompt.path
      ? `Remember for ${prompt.tool} inside the folder holding ${prompt.path}, until this session ends`
      : `Remember for ${prompt.tool} until this session ends`;
    always.addEventListener('click', () => answer('allow_always'));
    actions.append(always);
  }

  box.append(actions);
  messages.append(box);
  permissionNodes.set(prompt.id, box);

  awaitingPermission++;
  updateControls();
  current = undefined;
  scrollToEnd();
}

function resolvePermissionPrompt(
  id: string,
  decision: 'allow_once' | 'allow_always' | 'deny',
): void {
  const box = permissionNodes.get(id);
  if (!box) return;
  permissionNodes.delete(id);

  box.classList.add(decision === 'deny' ? 'permission-denied' : 'permission-allowed');
  box.querySelector('.permission-actions')?.replaceWith(
    el(
      'div',
      'permission-result',
      decision === 'deny'
        ? 'You said no'
        : decision === 'allow_always'
          ? 'Allowed — remembered until this session ends'
          : 'Allowed once',
    ),
  );

  awaitingPermission = Math.max(0, awaitingPermission - 1);
  updateControls();
}

// ── Hỏi người dùng qua nút bấm (ask_user_question) ─────────────────────────

const questionNodes = new Map<string, HTMLElement>();

/**
 * Hộp ask_user_question.
 *
 * Một câu, single-select (trường hợp phổ biến nhất — "chọn A/B/C/D"): bấm một
 * nút là gửi luôn, không cần nút Submit riêng. Nhiều câu hoặc multiSelect thì
 * các nút trở thành toggle và cần bấm Submit — tránh gửi nhầm khi người dùng
 * còn đang chọn dở câu thứ hai.
 */
function appendQuestionPrompt(prompt: QuestionPrompt): void {
  const box = el('div', 'question');
  const single = prompt.questions.length === 1 && !prompt.questions[0]!.multiSelect;

  const state: Set<string>[] = prompt.questions.map(() => new Set());
  let submitBtn: HTMLButtonElement | undefined;

  const submit = (selections: string[][]): void => {
    post({ type: 'questionAnswer', id: prompt.id, selections });
  };

  prompt.questions.forEach((q, i) => {
    const block = el('div', 'question-block');
    block.append(el('div', 'question-title', q.header));
    block.append(el('div', 'question-text', q.question));

    const opts = el('div', 'question-options');
    for (const opt of q.options) {
      const btn = el('button', 'question-option', opt.label);
      if (opt.description) btn.title = opt.description;
      btn.addEventListener('click', () => {
        if (single) {
          submit([[opt.label]]);
          return;
        }
        if (!q.multiSelect) state[i]!.clear();
        if (state[i]!.has(opt.label)) state[i]!.delete(opt.label);
        else state[i]!.add(opt.label);
        opts.querySelectorAll('.question-option').forEach((node) => {
          node.classList.toggle('selected', state[i]!.has(node.textContent ?? ''));
        });
        if (submitBtn) submitBtn.disabled = state.some((s) => s.size === 0);
      });
      opts.append(btn);
    }
    block.append(opts);
    box.append(block);
  });

  if (!single) {
    const actions = el('div', 'question-actions');
    submitBtn = el('button', 'primary', 'Submit');
    submitBtn.disabled = true;
    submitBtn.addEventListener('click', () => submit(state.map((s) => [...s])));
    actions.append(submitBtn);
    box.append(actions);
  }

  messages.append(box);
  questionNodes.set(prompt.id, box);

  awaitingQuestion++;
  updateControls();
  current = undefined;
  scrollToEnd();
}

function resolveQuestionPrompt(
  id: string,
  cancelled: boolean,
  answers?: QuestionAnswerWire[],
): void {
  const box = questionNodes.get(id);
  if (!box) return;
  questionNodes.delete(id);

  box.classList.add(cancelled ? 'question-cancelled' : 'question-answered');
  const summary = cancelled
    ? 'No answer — stopped'
    : (answers ?? [])
        .map((a) => `${a.header}: ${a.selected.length ? a.selected.join(', ') : '(none)'}`)
        .join(' · ');
  box.querySelectorAll('.question-options, .question-actions').forEach((node) => node.remove());
  box.append(el('div', 'question-result', summary));

  awaitingQuestion = Math.max(0, awaitingQuestion - 1);
  updateControls();
}

function applyPermissionState(state: {
  mode: string;
  effectiveMode: string;
  downgraded: boolean;
  downgradeReason?: string;
}): void {
  showMode(state.mode);

  if (state.downgraded && state.downgradeReason) {
    downgradeBox.replaceChildren();
    downgradeBox.append(el('strong', undefined, 'Permissions were downgraded. '));
    downgradeBox.append(document.createTextNode(state.downgradeReason));
    downgradeBox.hidden = false;
  } else {
    downgradeBox.hidden = true;
  }
}

/**
 * Chế độ sandbox KHÔNG còn là một dòng cảnh báo treo trên khung chat.
 *
 * Dòng cũ ("Shell commands run directly on this machine — NO isolation") nói
 * về cấu hình, không nói về việc sắp xảy ra. Nó bật suốt phiên nên sau ngày thứ
 * hai không ai đọc nữa — kể cả đúng lúc agent chuẩn bị chạm `~/.ssh`. Thay vào
 * đó việc báo động gắn vào TỪNG thao tác: lệnh hay script với tay ra ngoài
 * workspace thì hộp duyệt quyền hiện cảnh báo kèm bằng chứng, và thao tác đó
 * buộc phải hỏi dù người dùng đang ở chế độ nào (core/security/workspaceEscape.ts).
 *
 * Hàm giữ lại để chỗ cũ dọn nốt phần tử của bản trước còn sót trong webview đã
 * được khôi phục từ state.
 */
function applySandboxState(_state: { kind: string; label: string; isolated: boolean }): void {
  document.getElementById('sandbox-warning')?.remove();
}

// ── Checklist tiến độ (M5) ─────────────────────────────────────────────────

function renderTodos(items: Array<{ content: string; status: string }>): void {
  if (items.length === 0) {
    todosBox.hidden = true;
    todosBox.replaceChildren();
    return;
  }

  const list = el('ul', 'todo-list');
  for (const item of items) {
    const li = el('li', `todo todo-${item.status}`);
    li.append(
      el(
        'span',
        'todo-mark',
        item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '▸' : '○',
      ),
    );
    li.append(el('span', 'todo-text', item.content));
    list.append(li);
  }

  const done = items.filter((i) => i.status === 'completed').length;
  todosBox.replaceChildren(
    el('div', 'todo-head', `Progress ${done}/${items.length}`),
    list,
  );
  todosBox.hidden = false;
}

function appendError(message: string, hint?: string, hintAction?: 'signIn'): void {
  const box = el('div', 'error-box');
  box.append(el('div', undefined, message));
  if (hint) {
    const btn = el('button', 'link', hint);
    // 'signIn' phải mở luôn trình duyệt đăng nhập — nút đọc là "Sign in to
    // AstraWork" nên hành vi phải khớp đúng chữ đó. Mọi hint khác (chẳng hạn
    // "Open AstraCode settings") vẫn mở hộp cài đặt tại chỗ: chỉ post
    // 'openSettings' thì host gửi state về mà KHÔNG kèm cờ mở — nút sẽ nhấp
    // nháy rồi không có gì hiện ra.
    btn.addEventListener(
      'click',
      hintAction === 'signIn' ? () => post({ type: 'signIn' }) : openSettings,
    );
    box.append(btn);
  }
  messages.append(box);
  current = undefined;
  scrollToEnd();
}

function finishAssistant(info: {
  stoppedBy: TurnEndReason;
  toolCalls: number;
  iterations: number;
  totalTokens: number;
  cachedTokens?: number;
  durationMs: number;
}): void {
  // Số token cộng dồn qua các vòng (info.totalTokens/cachedTokens) không hiện
  // ra footer — dễ hiểu lầm thành kích thước context hiện tại (xem
  // documents/Context-window-management-flow.md §7). Vẫn nhận trong `info` cho chỗ khác cần dùng.
  const parts = [
    `${info.toolCalls} tools`,
    `${info.iterations} iterations`,
    `${(info.durationMs / 1000).toFixed(1)}s`,
  ].filter(Boolean) as string[];

  const status = turnEndStatusLabel(info.stoppedBy);
  if (status) parts.push(status);

  messages.append(el('div', 'meta', parts.join(' · ')));
  current = undefined;
  scrollToEnd();
}

/**
 * Tham số của tool, gọn thành một dòng.
 *
 * Xuống dòng bị ép thành `⏎`: nội dung của `write_file` có thể dài hàng trăm
 * dòng, và để nó vỡ dòng ở đây sẽ đẩy toàn bộ luồng chạy ra khỏi màn hình.
 */
function summarizeArgs(args: unknown): string {
  if (args === null || typeof args !== 'object') return '';
  const entries = Object.entries(args as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== '' && v !== null)
    .map(([k, v]) => `${k}: ${flatten(String(v), 60)}`);
  return entries.length > 0 ? `(${entries.join(', ')})` : '';
}

function flatten(value: string, max: number): string {
  const oneLine = value.replace(/\s*\r?\n\s*/g, ' ⏎ ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

// ── Banner trạng thái ──────────────────────────────────────────────────────

function showBanner(blockReason: string | undefined, model: ChatModelInfo | undefined): void {
  const lines: string[] = [];
  if (blockReason) lines.push(blockReason);

  // KHÔNG còn banner "chưa đo". Model chưa có profile chạy bằng năng lực giả
  // định và đó là đường bình thường, không phải trạng thái suy giảm — một
  // banner thường trực nói về nó chỉ dạy người dùng bỏ qua vùng banner, đúng
  // chỗ mà cảnh báo hạ cấp quyền và sandbox không cách ly cũng hiện ra.
  //
  // Việc model có gọi được tool native hay không giờ tự lộ ra lúc chạy: lượt
  // đầu tiên thất bại thì `AgentLoop` chuyển đường và nói một dòng ngay trong
  // hội thoại — đúng lúc, đúng chỗ, và chỉ một lần.
  if (model && !blockReason && model.toolCalling === 'xml-fallback') {
    lines.push('This model has no native tool calling; falling back to the XML path.');
  }

  if (lines.length === 0) {
    banner.hidden = true;
    return;
  }

  banner.replaceChildren();
  banner.className = `banner ${blockReason ? 'blocked' : 'info'}`;
  for (const line of lines) banner.append(el('div', undefined, line));

  if (blockReason) {
    const btn = el('button', 'link', 'Open settings');
    btn.addEventListener('click', openSettings);
    banner.append(btn);
  }
  banner.hidden = false;
}

function updateControls(): void {
  const waiting = awaitingPermission > 0 || awaitingQuestion > 0;

  // MỘT nút cho cả gửi lẫn dừng. Lúc đang chạy nó phải bấm được — đó chính là
  // lúc người ta cần nó nhất — nên `disabled` chỉ tính cho nhánh gửi.
  sendBtn.classList.toggle('is-stop', busy);
  sendBtn.disabled = busy ? false : !canChat || waiting;
  sendBtn.title = busy
    ? 'Stop the running turn'
    : waiting
      ? awaitingQuestion > 0
        ? 'Waiting for your answer…'
        : 'Waiting for your approval…'
      : 'Send (Enter)';
  sendBtn.setAttribute('aria-label', busy ? 'Stop' : 'Send');

  clearBtn.disabled = busy;
  attachBtn.disabled = busy || !canChat;
  input.disabled = !canChat;
  // Đổi chế độ giữa lúc agent đang chạy sẽ tạo ra một lượt nửa nọ nửa kia:
  // vài tool đã đi qua luật cũ, vài tool đi qua luật mới.
  modeBtn.disabled = busy;
  // Đổi model giữa lượt là nén theo ngưỡng của model này rồi gửi lên model
  // khác — host cũng chặn, nhưng khoá nút là cách nói ra trước khi bấm.
  modelBtn.disabled = busy;
  if (busy) closeModeMenu();
}

// ── Chọn chế độ quyền ──────────────────────────────────────────────────────
//
// Một bảng bật lên thay cho <select>, vì ba chế độ này không phải ba nhãn
// tương đương nhau: chúng quyết định agent có được tự ghi đĩa hay không. Mỗi
// dòng mang theo một câu mô tả hệ quả, và dòng đang chọn có dấu tick — cùng bố
// cục với bảng chế độ của Claude Code, thứ người dùng đã quen đọc.

type ModeId = 'ask' | 'acceptEdits' | 'plan';

/** Một hình vẽ trong icon. Chỉ dựng bằng createElementNS — không innerHTML. */
type Shape =
  | { tag: 'path'; d: string }
  | { tag: 'circle'; cx: number; cy: number; r: number }
  | { tag: 'rect'; x: number; y: number; w: number; h: number; rx: number };

const SVG_NS = 'http://www.w3.org/2000/svg';

function icon(shapes: Shape[], size = 15): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  for (const s of shapes) {
    if (s.tag === 'path') {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', s.d);
      svg.append(p);
    } else if (s.tag === 'circle') {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', String(s.cx));
      c.setAttribute('cy', String(s.cy));
      c.setAttribute('r', String(s.r));
      svg.append(c);
    } else {
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('x', String(s.x));
      r.setAttribute('y', String(s.y));
      r.setAttribute('width', String(s.w));
      r.setAttribute('height', String(s.h));
      r.setAttribute('rx', String(s.rx));
      svg.append(r);
    }
  }
  return svg;
}

const MODES: Array<{ id: ModeId; label: string; hint: string; shapes: Shape[] }> = [
  {
    id: 'ask',
    label: 'Ask first',
    hint: 'The agent asks for approval before every file edit or command',
    shapes: [
      { tag: 'circle', cx: 12, cy: 12, r: 10 },
      { tag: 'path', d: 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3' },
      { tag: 'path', d: 'M12 17h.01' },
    ],
  },
  {
    id: 'acceptEdits',
    label: 'Auto-edit',
    hint: 'The agent edits files in the workspace on its own; shell commands still ask',
    shapes: [
      { tag: 'path', d: 'M12 20h9' },
      { tag: 'path', d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z' },
    ],
  },
  {
    id: 'plan',
    label: 'Plan',
    hint: 'The agent only reads and lays out a plan — it changes nothing',
    shapes: [
      { tag: 'path', d: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2' },
      { tag: 'rect', x: 8, y: 2, w: 8, h: 4, rx: 1 },
      { tag: 'path', d: 'M8.5 12h7M8.5 16h4' },
    ],
  },
];

let currentMode: ModeId = 'ask';

/** Vẽ lại nút + bảng theo chế độ đang chọn. KHÔNG gửi gì lên host. */
function showMode(mode: string): void {
  const found = MODES.find((m) => m.id === mode);
  if (found) currentMode = found.id;
  const active = MODES.find((m) => m.id === currentMode)!;

  modeIcon.replaceChildren(icon(active.shapes, 13));
  modeLabel.textContent = active.label;
  modeBtn.title = `${active.label} — ${active.hint}. Shift+Tab to switch.`;
  renderModeMenu();
}

function renderModeMenu(): void {
  const head = el('div', 'mode-menu-head');
  head.append(el('span', undefined, 'Modes'));
  const kbd = el('span', 'mode-kbd');
  kbd.append(el('kbd', undefined, '⇧'));
  kbd.append(document.createTextNode(' + '));
  kbd.append(el('kbd', undefined, 'tab'));
  kbd.append(document.createTextNode(' to switch'));
  head.append(kbd);

  const rows: HTMLElement[] = [head];

  for (const m of MODES) {
    const selected = m.id === currentMode;
    const row = el('button', `mode-option${selected ? ' selected' : ''}`);
    row.type = 'button';
    row.setAttribute('role', 'menuitemradio');
    row.setAttribute('aria-checked', String(selected));

    const iconBox = el('span', 'mode-option-icon');
    iconBox.append(icon(m.shapes, 16));

    const text = el('span', 'mode-option-text');
    text.append(el('span', 'mode-option-title', m.label));
    text.append(el('span', 'mode-option-desc', m.hint));

    const check = el('span', 'mode-option-check');
    if (selected) check.append(icon([{ tag: 'path', d: 'M20 6 9 17l-5-5' }], 14));

    row.append(iconBox, text, check);
    row.addEventListener('click', () => {
      closeModeMenu();
      chooseMode(m.id);
    });
    rows.push(row);
  }

  modeMenu.replaceChildren(...rows);
}

/** Đổi chế độ thật: vẽ ngay rồi báo host. Host xác nhận lại qua `permission_state`. */
function chooseMode(mode: ModeId): void {
  if (mode === currentMode) return;
  showMode(mode);
  post({ type: 'setMode', mode });
}

function openModeMenu(): void {
  if (modeBtn.disabled) return;
  modeMenu.hidden = false;
  modeBtn.setAttribute('aria-expanded', 'true');
}

function closeModeMenu(): void {
  modeMenu.hidden = true;
  modeBtn.setAttribute('aria-expanded', 'false');
}

modeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (modeMenu.hidden) openModeMenu();
  else closeModeMenu();
});

// Bấm ra ngoài là cách đóng một menu mà không ai phải học.
document.addEventListener('click', (e) => {
  if (modeMenu.hidden) return;
  if (e.target instanceof Node && modeMenu.contains(e.target)) return;
  closeModeMenu();
});

/**
 * Shift+Tab xoay vòng chế độ — đúng phím của Claude Code, và bảng cũng nói ra
 * phím đó nên nó phải chạy thật.
 *
 * Chỉ cướp phím khi focus đang ở trong ô soạn hoặc trên chính nút chế độ. Ở
 * những chỗ khác Shift+Tab vẫn là phím di chuyển focus, và lấy nó đi sẽ khoá
 * người dùng bàn phím ra khỏi một nửa panel.
 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !e.shiftKey || busy) return;
  const target = e.target;
  const inComposer =
    target === input || target === modeBtn || (target instanceof Node && modeMenu.contains(target));
  if (!inComposer) return;

  e.preventDefault();
  const next = MODES[(MODES.findIndex((m) => m.id === currentMode) + 1) % MODES.length]!;
  chooseMode(next.id);
});

// ── Chọn model trong thanh soạn ────────────────────────────────────────────
//
// Cùng khuôn với ô chế độ ngay trên: nút gọn + bảng bật lên phía trên, dùng
// chung lớp CSS. Khác một điểm về Ý NGHĨA, và bảng phải nói ra: lựa chọn ở đây
// chỉ áp cho phiên chat đang mở, không ghi vào settings.

/** Biểu tượng con chip — cùng bộ nét với các icon chế độ. */
const MODEL_ICON: Shape[] = [
  { tag: 'rect', x: 7, y: 7, w: 10, h: 10, rx: 1.5 },
  { tag: 'path', d: 'M10 3v2M14 3v2M10 19v2M14 19v2M3 10h2M3 14h2M19 10h2M19 14h2' },
];

let modelOptions: ChatModelOption[] = [];
let modelDefaultId: string | undefined;
let modelOverrideId: string | undefined;

/** Tên hiện trên nút. Nhãn của gateway có thể rỗng, lúc đó dùng id. */
function modelTitle(id: string): string {
  return modelOptions.find((m) => m.id === id)?.label || id;
}

/** Vẽ lại nút + bảng theo dữ liệu host vừa gửi. KHÔNG gửi gì lên host. */
function showModels(
  options: ChatModelOption[],
  defaultId: string | undefined,
  overrideId: string | undefined,
): void {
  modelOptions = options;
  modelDefaultId = defaultId;
  modelOverrideId = overrideId;

  const active = overrideId ?? defaultId;

  // Chưa có model nào (chưa đăng nhập, hoặc gateway chưa trả danh sách): ẩn hẳn
  // ô chọn. Một nút mở ra bảng rỗng chỉ làm người dùng bấm hai lần để biết là
  // không có gì.
  modelBtn.parentElement!.hidden = options.length === 0 && active === undefined;

  modelIcon.replaceChildren(icon(MODEL_ICON, 13));
  modelLabel.textContent = active ? modelTitle(active) : 'Model';
  modelBtn.title = active
    ? overrideId
      ? `${modelTitle(active)} — this conversation only. Default: ${
          defaultId ? modelTitle(defaultId) : 'none'
        }`
      : `${modelTitle(active)} — from settings`
    : 'No model available yet';

  renderModelMenu();
}

function renderModelMenu(): void {
  const active = modelOverrideId ?? modelDefaultId;

  const head = el('div', 'mode-menu-head');
  head.append(el('span', undefined, 'Model'));
  head.append(el('span', 'mode-menu-note', 'this conversation only'));

  const rows: HTMLElement[] = [head];

  for (const m of modelOptions) {
    const selected = m.id === active;
    const row = el('button', `mode-option${selected ? ' selected' : ''}`);
    row.type = 'button';
    row.setAttribute('role', 'menuitemradio');
    row.setAttribute('aria-checked', String(selected));
    // Model gateway không cấp vẫn HIỆN, chỉ không bấm được: biến mất khỏi danh
    // sách thì người dùng đi tìm cái tên họ nhớ là có, và không biết vì sao
    // không thấy.
    row.disabled = !m.available;

    const iconBox = el('span', 'mode-option-icon');
    iconBox.append(icon(MODEL_ICON, 16));

    const text = el('span', 'mode-option-text');
    text.append(el('span', 'mode-option-title', m.label || m.id));
    text.append(
      el(
        'span',
        'mode-option-desc',
        m.available ? describeModelOption(m) : 'not available on this account',
      ),
    );

    const check = el('span', 'mode-option-check');
    if (selected) check.append(icon([{ tag: 'path', d: 'M20 6 9 17l-5-5' }], 14));

    row.append(iconBox, text, check);
    row.addEventListener('click', () => {
      closeModelMenu();
      chooseModel(m.id);
    });
    rows.push(row);
  }

  // Hai đường quay về, chỉ hiện khi thật sự có gì để quay về.
  if (modelOverrideId) {
    rows.push(el('div', 'mode-menu-sep'));

    const back = el('button', 'mode-option');
    back.type = 'button';
    back.setAttribute('role', 'menuitem');
    back.append(
      (() => {
        const text = el('span', 'mode-option-text');
        text.append(el('span', 'mode-option-title', 'Use the default'));
        text.append(
          el(
            'span',
            'mode-option-desc',
            modelDefaultId ? modelTitle(modelDefaultId) : 'whatever settings picks',
          ),
        );
        return text;
      })(),
    );
    back.addEventListener('click', () => {
      closeModelMenu();
      chooseModel(undefined);
    });
    rows.push(back);

    const makeDefault = el('button', 'mode-option');
    makeDefault.type = 'button';
    makeDefault.setAttribute('role', 'menuitem');
    makeDefault.append(
      (() => {
        const text = el('span', 'mode-option-text');
        text.append(el('span', 'mode-option-title', 'Make this the default'));
        text.append(el('span', 'mode-option-desc', 'saves it in settings for every conversation'));
        return text;
      })(),
    );
    makeDefault.addEventListener('click', () => {
      closeModelMenu();
      // Đường DUY NHẤT trong bảng này ghi vào settings, và nhãn nói rõ như vậy.
      post({ type: 'setModel', value: modelOverrideId! });
    });
    rows.push(makeDefault);
  }

  modelMenu.replaceChildren(...rows);
}

/** Đổi model thật: vẽ ngay rồi báo host. Host xác nhận lại qua `ready`. */
function chooseModel(id: string | undefined): void {
  if (id === modelOverrideId) return;
  showModels(modelOptions, modelDefaultId, id);
  post({ type: 'setSessionModel', id: id ?? null });
}

function openModelMenu(): void {
  if (modelBtn.disabled) return;
  modelMenu.hidden = false;
  modelBtn.setAttribute('aria-expanded', 'true');
}

function closeModelMenu(): void {
  modelMenu.hidden = true;
  modelBtn.setAttribute('aria-expanded', 'false');
}

modelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (modelMenu.hidden) openModelMenu();
  else closeModelMenu();
});

document.addEventListener('click', (e) => {
  if (modelMenu.hidden) return;
  if (e.target instanceof Node && modelMenu.contains(e.target)) return;
  closeModelMenu();
});

changesBtn.addEventListener('click', () => post({ type: 'showChanges' }));

// ── Soạn tin ───────────────────────────────────────────────────────────────

// Nút gửi và nút dừng là MỘT. Lượt đang chạy thì cú bấm đó có nghĩa "dừng" —
// người dùng không phải tìm nút khác, và không có nút nào nhảy chỗ giữa chừng.
composer.addEventListener('submit', (e) => {
  e.preventDefault();
  if (busy) {
    post({ type: 'stop' });
    return;
  }
  submit();
});

/**
 * Gọi lại prompt đã gõ — `~/.astra/history.jsonl`, dùng chung với CLI.
 *
 * Cũ nhất trước; `promptIndex === promptHistory.length` nghĩa là đang ở dòng
 * người dùng tự gõ (bản nháp), chưa bước vào lịch sử.
 */
let promptHistory: string[] = [];
let promptIndex = 0;
let promptDraft = '';

/**
 * Chỉ nhận mũi tên khi con trỏ đang ở ĐẦU (lên) hoặc CUỐI (xuống) ô nhập.
 *
 * Ô nhập này nhiều dòng được. Nuốt mũi tên vô điều kiện sẽ làm người dùng không
 * di chuyển nổi trong chính đoạn văn họ đang viết.
 */
function recallPrompt(direction: -1 | 1): boolean {
  if (promptHistory.length === 0) return false;

  const atStart = (input.selectionStart ?? 0) === 0 && (input.selectionEnd ?? 0) === 0;
  const atEnd =
    (input.selectionStart ?? 0) === input.value.length &&
    (input.selectionEnd ?? 0) === input.value.length;
  if (direction === -1 && !atStart) return false;
  if (direction === 1 && !atEnd) return false;
  if (direction === 1 && promptIndex >= promptHistory.length) return false;

  if (promptIndex === promptHistory.length) promptDraft = input.value;
  const next = Math.min(Math.max(promptIndex + direction, 0), promptHistory.length);
  if (next === promptIndex) return false;

  promptIndex = next;
  input.value = next === promptHistory.length ? promptDraft : (promptHistory[next] ?? '');
  autoGrow();
  const caret = input.value.length;
  input.setSelectionRange(caret, caret);
  return true;
}

input.addEventListener('keydown', (e) => {
  const open = mentionOpen || commandOpen;
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Escape')) {
    if (commandOpen) handleCommandKey(e);
    else handleMentionKey(e);
    return;
  }
  if (!open && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    if (recallPrompt(e.key === 'ArrowUp' ? -1 : 1)) {
      e.preventDefault();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (commandOpen) {
      acceptCommand();
      return;
    }
    if (mentionOpen) {
      acceptMention();
      return;
    }
    submit();
  }
});

/**
 * Ctrl+V ảnh.
 *
 * Chỉ chặn sự kiện khi clipboard THẬT SỰ có ảnh — dán chữ vẫn phải chạy theo
 * đường mặc định của trình duyệt, nếu không thì con trỏ và undo sẽ sai.
 */
input.addEventListener('paste', (e: ClipboardEvent) => {
  const files = Array.from(e.clipboardData?.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null && isImageType(file.type));

  if (files.length === 0) return;
  e.preventDefault();
  void addImages(files);
});

// Kéo ảnh từ Explorer/desktop thả vào ô nhập — cùng đường xử lý với dán.
input.addEventListener('dragover', (e: DragEvent) => {
  if (Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === 'file')) e.preventDefault();
});

input.addEventListener('drop', (e: DragEvent) => {
  const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => isImageType(f.type));
  if (files.length === 0) return;
  e.preventDefault();
  void addImages(files);
});

attachBtn.addEventListener('click', () => post({ type: 'pickAttachment' }));

/** Ô nhập cao theo nội dung, tới trần `max-height` trong CSS thì tự cuộn. */
function autoGrow(): void {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

input.addEventListener('input', autoGrow);

input.addEventListener('input', () => {
  const cursor = input.selectionStart ?? 0;

  // `/lệnh` được xét trước: nó chỉ hợp lệ ở đầu ô nhập, nên không đụng `@`.
  const command = commandQueryAt(input.value, cursor);
  if (command !== undefined) {
    hideMentions();
    showCommands(command);
    return;
  }
  hideCommands();

  const query = mentionQueryAt(input.value, cursor);
  if (query === undefined) {
    hideMentions();
    return;
  }
  post({ type: 'mentionQuery', query });
});

function submit(): void {
  const text = input.value.trim();
  // Ảnh không kèm chữ vẫn là một câu hỏi hợp lệ ("cái này là gì?").
  if ((!text && pendingImages.length === 0) || busy || !canChat) return;
  hideMentions();
  hideCommands();

  // Bong bóng của người dùng do `turn_start` dựng, mà host không gửi ảnh ngược
  // về. Giữ bản gốc ở đây để vẽ lại thumbnail đúng lượt vừa gửi.
  sentImages = pendingImages;
  post({
    type: 'send',
    text,
    ...(pendingImages.length ? { images: pendingImages } : {}),
  });

  // Vào lịch sử gọi lại ngay, không đợi host ghi xuống đĩa xong: mũi tên lên
  // phải tìm thấy câu vừa gửi ngay ở lượt kế tiếp.
  if (text && promptHistory.at(-1) !== text) promptHistory.push(text);
  promptIndex = promptHistory.length;
  promptDraft = '';

  input.value = '';
  pendingImages = [];
  renderAttachments();
  autoGrow();
}

// ── Ảnh đính kèm ───────────────────────────────────────────────────────────

let pendingImages: ImageWire[] = [];
/** Ảnh của lượt vừa bấm gửi, chờ `turn_start` về để vẽ vào bong bóng. */
let sentImages: ImageWire[] = [];

function isImageType(type: string): type is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(type);
}

/**
 * Đọc một file ảnh thành base64.
 *
 * Đi qua `FileReader` rồi cắt phần `data:...;base64,` thay vì tự dựng chuỗi từ
 * byte: với ảnh vài MB, vòng lặp `String.fromCharCode` trên từng byte đủ chậm
 * để làm khựng cả webview.
 */
function readImage(file: File): Promise<ImageWire | undefined> {
  return new Promise((resolve) => {
    // Gán ra const trước khi vào closure: TS chỉ giữ được thu hẹp kiểu của
    // `file.type` ở đây, không giữ được bên trong callback của FileReader.
    const mediaType = file.type;
    if (!isImageType(mediaType)) {
      resolve(undefined);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => resolve(undefined);
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const data = result.slice(result.indexOf(',') + 1);
      if (!data || data.length > MAX_IMAGE_BASE64) {
        resolve(undefined);
        return;
      }
      resolve({ name: file.name || 'pasted-image.png', mediaType, data });
    };
    reader.readAsDataURL(file);
  });
}

async function addImages(files: readonly File[]): Promise<void> {
  const room = MAX_IMAGES - pendingImages.length;
  if (room <= 0) {
    appendNote(`A turn can carry at most ${MAX_IMAGES} images.`);
    return;
  }

  let rejected = 0;
  for (const file of files.slice(0, room)) {
    const image = await readImage(file);
    if (image) pendingImages.push(image);
    else rejected++;
  }

  if (rejected > 0) {
    appendNote('Some images could not be attached: only PNG, JPEG, GIF, WebP under ~4 MB are accepted.');
  }
  renderAttachments();
}

function renderAttachments(): void {
  attachments.replaceChildren();
  attachments.hidden = pendingImages.length === 0;

  pendingImages.forEach((image, i) => {
    const chip = el('div', 'chip');

    const thumb = document.createElement('img');
    thumb.className = 'chip-thumb';
    thumb.src = dataUrl(image);
    thumb.alt = '';
    chip.append(thumb);
    chip.append(el('span', 'chip-name', image.name));

    const remove = el('button', 'chip-remove', '×');
    remove.type = 'button';
    remove.title = `Remove ${image.name}`;
    remove.addEventListener('click', () => {
      pendingImages.splice(i, 1);
      renderAttachments();
    });
    chip.append(remove);

    attachments.append(chip);
  });
}

function dataUrl(image: ImageWire): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

/**
 * Chip cho pin (tính năng ghim) — riêng khỏi `attachments`/`.chip` vì pin có
 * trạng thái ảnh không có: lỗi đọc (denylist, file đã xoá) và bị cắt bớt do
 * chạm trần dòng. Host là nguồn sự thật duy nhất — không có state cục bộ nào
 * ở đây, danh sách luôn vẽ lại y hệt payload `pins` gần nhất.
 */
function renderPins(items: PinnedItemWire[]): void {
  pinsBox.replaceChildren();
  pinsBox.hidden = items.length === 0;

  for (const item of items) {
    const chip = el('div', item.error ? 'pin-chip pin-chip-error' : 'pin-chip');
    const label =
      item.startLine !== undefined && item.endLine !== undefined
        ? `${item.name} (L${item.startLine}-${item.endLine})`
        : item.name;
    chip.append(el('span', 'chip-name', label));

    if (item.error) {
      chip.title = item.error;
    } else if (item.truncated) {
      chip.title = `${item.path} — file is longer than what was pinned; only the first part is included.`;
    } else {
      chip.title = item.path;
    }

    const remove = el('button', 'chip-remove', '×');
    remove.type = 'button';
    remove.title = `Unpin ${item.name}`;
    remove.addEventListener('click', () => post({ type: 'pinRemove', id: item.id }));
    chip.append(remove);

    pinsBox.append(chip);
  }
}

/**
 * Gợi ý pin khi selection trong editor không rỗng — thay cho việc phải mở menu
 * chuột phải. Bấm "Pin" báo host qua `pinSelectionHint` (host tự biết đang gợi
 * ý selection nào, xem `chatView.ts`); bấm "×" chỉ ẩn tại chỗ, không báo host —
 * lần selection đổi kế tiếp sẽ tự vẽ lại đúng trạng thái.
 */
function renderSelectionHint(ref: SelectionHintWire | null): void {
  selectionHintBox.replaceChildren();
  selectionHintBox.hidden = ref === null;
  if (!ref) return;

  const label = el(
    'span',
    'selection-hint-label',
    `Pin ${ref.name} (L${ref.startLine}-${ref.endLine}) to this chat`,
  );
  selectionHintBox.append(label);

  const pin = el('button', 'selection-hint-pin', 'Pin');
  pin.type = 'button';
  pin.addEventListener('click', () => {
    post({ type: 'pinSelectionHint' });
    selectionHintBox.hidden = true;
  });
  selectionHintBox.append(pin);

  const dismiss = el('button', 'selection-hint-dismiss', '×');
  dismiss.type = 'button';
  dismiss.title = 'Dismiss';
  dismiss.addEventListener('click', () => {
    selectionHintBox.hidden = true;
  });
  selectionHintBox.append(dismiss);
}

clearBtn.addEventListener('click', () => post({ type: 'clear' }));

// ── @mention ───────────────────────────────────────────────────────────────

let mentionOpen = false;
let mentionItems: MentionItem[] = [];
let mentionIndex = 0;

/** Trả về phần đã gõ sau `@` nếu con trỏ đang ở trong một mention. */
function mentionQueryAt(value: string, cursor: number): string | undefined {
  const before = value.slice(0, cursor);
  const at = before.lastIndexOf('@');
  if (at < 0) return undefined;
  // `@` phải đứng đầu dòng hoặc sau khoảng trắng, và phần sau không có khoảng trắng.
  const prev = at === 0 ? ' ' : before[at - 1]!;
  if (!/\s/.test(prev)) return undefined;
  const fragment = before.slice(at + 1);
  if (/\s/.test(fragment)) return undefined;
  return fragment;
}

function showMentions(items: MentionItem[]): void {
  mentionItems = items;
  mentionIndex = 0;
  if (items.length === 0) {
    hideMentions();
    return;
  }
  renderMentions();
  mentions.hidden = false;
  mentionOpen = true;
}

function renderMentions(): void {
  mentions.replaceChildren();
  mentionItems.forEach((item, i) => {
    const row = el('div', `mention${i === mentionIndex ? ' active' : ''}`);
    row.append(el('span', 'mention-name', item.name));
    row.append(el('span', 'mention-path', item.path));
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      mentionIndex = i;
      acceptMention();
    });
    mentions.append(row);
  });
}

function handleMentionKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    hideMentions();
    e.preventDefault();
    return;
  }
  e.preventDefault();
  const delta = e.key === 'ArrowDown' ? 1 : -1;
  mentionIndex = (mentionIndex + delta + mentionItems.length) % mentionItems.length;
  renderMentions();
}

function acceptMention(): void {
  const item = mentionItems[mentionIndex];
  if (!item) return;

  const cursor = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, cursor);
  const at = before.lastIndexOf('@');
  if (at < 0) return;

  const replaced = `${input.value.slice(0, at)}@${item.path} ${input.value.slice(cursor)}`;
  input.value = replaced;
  const next = at + item.path.length + 2;
  input.setSelectionRange(next, next);
  hideMentions();
  input.focus();
}

/**
 * Chèn `@đường/dẫn ` vào ô nhập tại con trỏ.
 *
 * Đường vào của file KHÔNG phải ảnh vừa chọn ở hộp đính kèm: nội dung không đi
 * kèm prompt, agent tự mở bằng `read_file` khi cần — y hệt một `@mention` gõ
 * tay, nên không có luật thứ hai nào phải nhớ.
 */
function insertMention(path: string): void {
  const cursor = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, cursor);
  const after = input.value.slice(cursor);
  // Không dính vào chữ liền trước: "xem@src/a.ts" không đọc ra là một mention.
  const gap = before.length === 0 || /\s$/.test(before) ? '' : ' ';

  input.value = `${before}${gap}@${path} ${after}`;
  const next = before.length + gap.length + path.length + 2;
  input.setSelectionRange(next, next);
  input.focus();
  autoGrow();
}

function hideMentions(): void {
  if (!mentionOpen) return;
  mentions.hidden = true;
  mentionOpen = false;
  mentionItems = [];
}

// ── /slash command (M6) ────────────────────────────────────────────────────

let commands: CommandWire[] = [];
let commandOpen = false;
let commandMatches: CommandWire[] = [];
let commandIndex = 0;

/**
 * Phần đã gõ sau `/`, chỉ khi nó ở ĐẦU ô nhập và chưa có khoảng trắng.
 *
 * Ràng buộc "đầu ô nhập" là cố ý: `src/auth.ts` giữa câu không được biến thành
 * gợi ý lệnh, và một khi người dùng đã gõ đối số thì họ đã chọn xong lệnh rồi.
 */
function commandQueryAt(value: string, cursor: number): string | undefined {
  if (!value.startsWith('/')) return undefined;
  const before = value.slice(0, cursor);
  if (/\s/.test(before)) return undefined;
  return before.slice(1);
}

function showCommands(query: string): void {
  const q = query.toLowerCase();
  commandMatches = commands.filter((c) => c.name.startsWith(q)).slice(0, 12);
  commandIndex = 0;

  if (commandMatches.length === 0) {
    hideCommands();
    return;
  }
  renderCommands();
  mentions.hidden = false;
  commandOpen = true;
}

function renderCommands(): void {
  mentions.replaceChildren();
  commandMatches.forEach((item, i) => {
    const row = el('div', `mention${i === commandIndex ? ' active' : ''}`);
    row.append(el('span', 'mention-name', `/${item.name}`));
    row.append(el('span', 'mention-path', item.description));
    // Nguồn phải nhìn thấy: lệnh của repo là prompt do người khác viết.
    if (item.source === 'project') row.append(el('span', 'mention-tag', 'from repo'));
    // Nhãn khác hẳn 'from repo': cái này đến từ dự án trên AstraWork, không phải
    // từ thư mục đang mở, và nó là thứ cả đội dùng chung.
    if (item.source === 'org') row.append(el('span', 'mention-tag', 'project standard'));
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      commandIndex = i;
      acceptCommand();
    });
    mentions.append(row);
  });
}

function handleCommandKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    hideCommands();
    e.preventDefault();
    return;
  }
  e.preventDefault();
  const delta = e.key === 'ArrowDown' ? 1 : -1;
  commandIndex = (commandIndex + delta + commandMatches.length) % commandMatches.length;
  renderCommands();
  const active = mentions.querySelector('.mention.active');
  if (active instanceof HTMLElement) active.scrollIntoView({ block: 'nearest' });
}

function acceptCommand(): void {
  const item = commandMatches[commandIndex];
  if (!item) return;

  const rest = input.value.replace(/^\/\S*/, '');
  input.value = `/${item.name}${rest || ' '}`;
  const next = item.name.length + 2;
  input.setSelectionRange(next, next);
  hideCommands();
  input.focus();
}

function hideCommands(): void {
  if (!commandOpen) return;
  mentions.hidden = true;
  commandOpen = false;
  commandMatches = [];
}

showMode(currentMode);
updateControls();
post({ type: 'ready' });
