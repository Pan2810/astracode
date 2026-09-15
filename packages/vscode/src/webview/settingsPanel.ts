/**
 * Nội dung bảng cài đặt, dựng TRONG một popup của webview chat.
 *
 * Trước v5 đây là một webview riêng; rồi thành lớp phủ kín panel; giờ là một
 * hộp thoại nổi (xem `.modal` trong media/chat.css). Lý do lần này: cài đặt là
 * việc ghé qua rồi đi — đổi model xong quay lại câu đang hỏi. Một lớp phủ kín
 * xoá mất hội thoại khỏi màn hình, nên người dùng mất chỗ đứng chỉ để đổi một
 * ô select.
 *
 * Bố cục theo lối Claude Code: mỗi mục là một nhóm có tiêu đề nhỏ viết hoa và
 * một nút hành động nằm ngay trên hàng tiêu đề; trong nhóm là các HÀNG — chữ
 * bên trái, điều khiển bên phải. Popup hẹp, nên chỉ những điều khiển rộng
 * (select) mới chiếm trọn hàng.
 *
 * Bắt buộc: dựng DOM bằng API DOM, KHÔNG dùng innerHTML với dữ liệu động. Tên
 * model đến từ endpoint bên ngoài — nội dung không tin cậy (documents/SECURITY.md §6).
 */
import type { ChatWebviewPayload, ContextBreakdownWire, SettingsWire } from '../chat/protocol.js';

type Post = (msg: ChatWebviewPayload) => void;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

/**
 * Một nhóm cài đặt: tiêu đề nhỏ + (tuỳ chọn) một nút hành động cùng hàng.
 *
 * Nút đi cùng tiêu đề chứ không nằm cuối nhóm: "Refresh" thuộc về cái tên
 * "Models", không thuộc về ô select cuối cùng mà mắt vừa đi qua.
 */
function group(title: string, children: (Node | string)[], action?: Node): HTMLElement {
  const head = el('div', { class: 'group-head' }, [
    el('h2', {}, [title]),
    ...(action ? [action] : []),
  ]);
  return el('section', { class: 'group' }, [head, ...children]);
}

/** Hàng chữ-trái / điều-khiển-phải. `desc` rỗng thì hàng chỉ có một dòng. */
function row(title: string, desc: string, control?: Node): HTMLElement {
  const text = el('div', { class: 'row-text' }, [
    el('span', { class: 'row-title' }, [title]),
    ...(desc ? [el('span', { class: 'row-desc' }, [desc])] : []),
  ]);
  return el('div', { class: 'row' }, [text, ...(control ? [control] : [])]);
}

/** Điều khiển rộng (select) — nhãn trên, mô tả dưới nhãn, điều khiển cuối. */
function field(label: string, desc: string, control: Node, footnote = ''): HTMLElement {
  return el('div', { class: 'field' }, [
    el('label', {}, [label]),
    ...(desc ? [el('p', { class: 'hint' }, [desc])] : []),
    control,
    ...(footnote ? [el('p', { class: 'hint' }, [footnote])] : []),
  ]);
}

function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls ? { class: cls } : {}, [text]);
  b.addEventListener('click', onClick);
  return b;
}

/** Nút hành động của hàng tiêu đề — chữ nhỏ, không viền. */
function headAction(text: string, onClick: () => void): HTMLButtonElement {
  return button(text, 'link-btn', onClick);
}

/** Toàn bộ bảng. Gọi lại mỗi khi state đổi — không vá từng mảnh. */
export function renderSettings(state: SettingsWire, post: Post): Node[] {
  return [
    renderAccount(state, post),
    renderModels(state, post),
    renderUsage(state, post),
    renderProjectAgents(state, post),
  ];
}

// ── Agent chung của dự án ───────────────────────────────────────────────────

/**
 * Bộ agent do dự án quy định (M10b).
 *
 * Mục này TỒN TẠI để không ai phải chạy lệnh mới biết mình đang có gì. Việc
 * đồng bộ vốn đã tự động (lúc mở, lúc đăng nhập, lúc đổi dự án, và mỗi 10 phút
 * khi đang chat) — thứ thiếu là một chỗ nhìn thấy nó, và một tính năng chạy
 * ngầm mà không để lại dấu vết nào thì người dùng có quyền cho rằng nó hỏng.
 *
 * Nút "Sync now" không phải cách duy nhất để cập nhật, chỉ là cách nhanh nhất
 * khi PM vừa nói "tôi vừa sửa xong". Nhãn viết thẳng như vậy thay vì "Refresh"
 * để không ai tưởng phải bấm nó thì mới có agent.
 */
function renderProjectAgents(state: SettingsWire, post: Post): HTMLElement {
  const a = state.projectAgents;
  const children: (Node | string)[] = [];

  const total = a.names.length + a.skillNames.length;

  if (total === 0) {
    children.push(
      row(
        'No shared agents',
        a.source === 'none' && !a.stale
          ? 'This project has not defined any. Agents in .astra/agents/ still work as before.'
          : 'Nothing loaded yet — sign in, or pick the right project in the bar above the message box.',
      ),
    );
  } else {
    // Hai danh sách tách bạch, không gộp thành một rổ "project agents": chúng
    // KHÁC nhau ở điều người dùng quan tâm nhất — cái nào sửa được file. Gộp lại
    // là mời họ nhờ một agent con làm việc mà nó không có quyền làm.
    if (a.skillNames.length > 0) {
      children.push(
        row('Procedures', 'Loaded into this chat, and they can edit files for you.'),
        el(
          'div',
          { class: 'agent-chips' },
          a.skillNames.map((n) => el('span', { class: 'agent-chip' }, [`/${n}`])),
        ),
      );
    }
    if (a.names.length > 0) {
      children.push(
        row('Sub-agents', 'Investigate in their own context and report back. Read-only.'),
        el(
          'div',
          { class: 'agent-chips' },
          a.names.map((n) => el('span', { class: 'agent-chip' }, [n])),
        ),
      );
    }

    const when = a.updatedAt ? a.updatedAt.slice(0, 10) : '';
    children.push(
      el('p', { class: 'hint' }, [
        `Version ${a.version}` +
          (a.updatedBy ? ` · edited by ${a.updatedBy}` : '') +
          (when ? ` on ${when}` : '') +
          '. ' +
          (a.skillNames.length > 0
            ? `Type /${a.skillNames[0]} to run a procedure, or just describe the work.`
            : 'Describe the work and the matching agent is used automatically.'),
      ]),
    );
  }

  // Hai trạng thái phải nói ra, vì cả hai đều khiến thứ đang chạy KHÁC với thứ
  // người dùng nghĩ mình đang chạy.
  if (a.stale) {
    children.push(
      el('div', { class: 'problem' }, [
        'Could not reach AstraWork — this is the last set that arrived. It stays in use ' +
          'rather than emptying out mid-session.',
      ]),
    );
  }
  if (a.source === 'stub') {
    children.push(
      el('div', { class: 'problem' }, [
        'Loaded from the local stub file (~/.astra/project-agents.json), not from AstraWork. ' +
          'Delete that file once the gateway serves your project.',
      ]),
    );
  }

  return group(
    'Project agents',
    children,
    headAction('Sync now', () => post({ type: 'showProjectAgents' })),
  );
}

// ── Tài khoản ───────────────────────────────────────────────────────────────

function renderAccount(state: SettingsWire, post: Post): HTMLElement {
  const children: (Node | string)[] = [];

  if (state.authenticated) {
    children.push(
      row(
        state.username ?? 'Signed in',
        state.role ? `AstraWork · ${state.role}` : 'AstraWork account',
        button('Sign out', 'ghost', () => post({ type: 'signOut' })),
      ),
      el('p', { class: 'hint' }, [
        state.expiresAt
          ? `Session expires ${new Date(state.expiresAt).toLocaleString()}, and each message ` +
            'you send extends it. Leave AstraCode idle past that point and you sign in again.'
          : 'Models, quota and audit all follow this account.',
      ]),
    );
  } else {
    children.push(
      row(
        'Not signed in',
        'Sign-in opens AstraWork in your browser; bring that session\'s token back here.',
        button('Sign in', '', () => post({ type: 'signIn' })),
      ),
    );
  }

  return group('Account', children);
}

// ── Model ───────────────────────────────────────────────────────────────────

/**
 * HAI ô chọn model, chia theo loại việc — không phải ba ô theo vai trò.
 *
 * Ba ô editor/planner/fast trước đây bắt người dùng biết model nào giỏi việc
 * nào trên gateway của đội — thứ chỉ đo mới biết. Hai ô còn lại hỏi một câu ai
 * cũng trả lời được: việc sửa code chạy bằng gì, việc đọc ảnh và lập kế hoạch
 * chạy bằng gì (xem core/config/model.ts).
 */
function renderModels(state: SettingsWire, post: Post): HTMLElement {
  const children: (Node | string)[] = [];

  if (state.lastError) children.push(el('div', { class: 'problem' }, [state.lastError]));

  if (state.models.length === 0) {
    children.push(
      el('p', { class: 'hint' }, [
        state.authenticated
          ? 'No models yet. Refresh to read the list again.'
          : 'Once you sign in, the AstraWork model list shows up here.',
      ]),
    );
  } else {
    // Không còn mục "Automatic": ô trống trong settings nghĩa là dùng model mặc
    // định, nên `selected` luôn là một cái tên cụ thể. Bày một lựa chọn dẫn tới
    // đúng chỗ vừa rời đi chỉ làm bảng này khó tin.
    const picker = (selected: string, onPick: (id: string) => void): HTMLSelectElement => {
      const select = el('select', {}) as HTMLSelectElement;
      for (const m of state.models) {
        const opt = el('option', { value: m.id }, [
          `${m.label}${m.available ? '' : ' — unavailable'}`,
        ]) as HTMLOptionElement;
        if (!m.available) opt.disabled = true;
        select.append(opt);
      }

      // Model đã chọn nhưng gateway không cấp: giữ nó lại thành một mục riêng.
      // Không có mục ấy thì ô select tự nhảy về mục đầu danh sách, và bảng cài
      // đặt nói sai — người dùng tưởng mình chưa chọn gì, trong khi
      // settings.json vẫn giữ một cái tên mà tài khoản này không dùng được.
      if (selected && !state.models.some((m) => m.id === selected)) {
        select.append(
          el('option', { value: selected }, [
            `${selected} — not on this account`,
          ]) as HTMLOptionElement,
        );
      }

      select.value = selected;
      select.addEventListener('change', () => onPick(select.value));
      return select;
    };

    const activeModel = state.models.find((m) => m.id === state.active);
    const notes: string[] = [];
    if (state.active && state.active !== state.selected) notes.push(`Now using ${state.active}`);
    if (activeModel && !activeModel.safeForWrite) {
      notes.push('not eligible for work with write access');
    }

    children.push(
      field(
        'Coding model',
        'Edits, commands, titles and summaries.',
        picker(state.selected, (value) => post({ type: 'setModel', value })),
        notes.join(' · '),
      ),
    );

    // Vai này không cầm quyền ghi, nên không có ghi chú safeForWrite ở đây —
    // một cảnh báo về quyền ghi cạnh ô model chỉ đọc là câu nói sai.
    children.push(
      field(
        'Planning model',
        'Images, and everything while plan mode is on.',
        picker(state.selectedPlan, (value) => post({ type: 'setPlanModel', value })),
        state.activePlan && state.activePlan !== state.selectedPlan
          ? `Now using ${state.activePlan}`
          : '',
      ),
    );

    children.push(renderModelDetails(state));
  }

  return group(
    'Models',
    children,
    headAction('Refresh', () => post({ type: 'refreshModels' })),
  );
}

/**
 * Bảng năng lực, GẤP LẠI.
 *
 * Năm cột trong một popup hẹp là thứ không đọc được nếu không cuộn ngang, mà
 * người mở cài đặt hầu như luôn chỉ để đổi một ô select. Ai cần bảng thì bấm
 * một lần; ai không cần thì không phải cuộn qua nó.
 */
function renderModelDetails(state: SettingsWire): HTMLElement {
  const head = el('tr', {}, [
    el('th', {}, ['Model']),
    el('th', {}, ['Tools']),
    el('th', {}, ['Context']),
    el('th', {}, ['Injection']),
    el('th', {}, ['Status']),
  ]);

  const rows = state.models.map((m) => {
    // "chưa đo" KHÔNG phải một trạng thái xấu — model đó sẵn sàng như mọi model
    // khác, chỉ là năng lực đang lấy từ giả định thay vì từ phép đo. Bảng này
    // nói ra sự khác biệt đó cho người quản model, không cảnh báo thành viên.
    const status = !m.allowed
      ? 'not permitted'
      : !m.online
        ? 'offline'
        : m.profileSource === 'inferred'
          ? 'ready (unmeasured)'
          : 'ready';

    return el('tr', { class: m.available ? '' : 'dim' }, [
      el('td', {}, [m.id]),
      el('td', { class: m.toolCalling === 'native' ? 'ok' : 'warn' }, [m.toolCalling]),
      el('td', {}, [m.contextWindow > 0 ? m.contextWindow.toLocaleString('en-US') : '—']),
      el('td', { class: m.injectionResistance === 'low' ? 'warn' : '' }, [m.injectionResistance]),
      el('td', {}, [status]),
    ]);
  });

  const summary = el('summary', {}, [
    `Capabilities of ${state.models.length} model${state.models.length === 1 ? '' : 's'}`,
  ]);

  return el('details', { class: 'disclosure' }, [
    summary,
    el('div', { class: 'table-scroll' }, [
      el('table', {}, [el('thead', {}, [head]), el('tbody', {}, rows)]),
    ]),
  ]);
}

// ── Mức dùng ────────────────────────────────────────────────────────────────

/**
 * Mức dùng — CHỈ những con số AstraWork đang giữ.
 *
 * Trước đây mục này bày ba khối: phiên đang mở, tổng trên máy, và tình trạng
 * đẩy. Cả ba đều do AstraCode tự đếm, nên không con số nào trong đó khớp với
 * thẻ "AI 利用状況" trên trang cá nhân AstraWork — cùng một người, hai bảng, hai
 * con số, và không ai nói được cái nào đúng.
 *
 * Giờ chỉ còn một nguồn: `GET /auth/me/usage`, đúng lời gọi mà trang web dùng.
 * Số ở đây bằng số bên kia vì chúng LÀ một, không phải vì có ai đó đồng bộ
 * chúng với nhau.
 *
 * Thanh Context ở lại: nó đo hội thoại đang mở đã chiếm bao nhiêu cửa sổ ngữ
 * cảnh của model, không phải mức dùng tài khoản — không có gì để lệch.
 */
function renderUsage(state: SettingsWire, post: Post): HTMLElement {
  const usage = state.usage;
  const account = state.account;
  const percent = Math.round(usage.contextRatio * 100);
  const num = (n: number): string => n.toLocaleString('en-US');
  // USD, hai chữ số lẻ: một lượt chat thường tốn vài cent, nên làm tròn về số
  // nguyên sẽ hiện "$0" cho gần như mọi tài khoản.
  const money = (n: number): string =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2,
    }).format(n);

  const a = account.usage;
  // Ô "Balance" chỉ có mặt khi gateway thật sự báo hạn mức. Một ô "—" thường
  // trực đọc ra thành "số dư bằng không đọc không được", và với một thứ là tiền
  // thì đoán nhầm hướng đó là đoán nhầm đắt nhất.
  const hasBudget = a?.budgetUsd !== undefined && a.budgetUsd > 0;
  const children: (Node | string)[] = [
    el('div', { class: 'stats' }, [
      stat('Turns', a ? num(a.turns) : '—'),
      stat('Tokens', a ? num(a.totalTokens) : '—'),
      stat('Spent', a ? money(a.costUsd) : '—'),
      ...(hasBudget ? [stat('Balance', money(a!.remainingUsd ?? 0))] : []),
    ]),
  ];

  // Thanh tiền: phần ĐÃ TIÊU trên tổng. Đặt ngay dưới bốn ô số vì nó nói lại
  // đúng hai trong bốn ô ấy dưới dạng một hình — thanh nằm xa số của chính nó
  // thì phải đọc hai lần mới ghép được.
  if (a && hasBudget) {
    const total = a.budgetUsd!;
    const spent = Math.min(a.costUsd, total);
    const pct = Math.round((spent / total) * 100);
    const fill = el('div', { class: 'meter-fill' });
    fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    // Gần cạn thì đổi màu. Ngưỡng giống đồng hồ ngữ cảnh của khung chat để hai
    // thanh trong cùng một sản phẩm không dạy hai bảng màu khác nhau.
    const level = pct >= 90 ? ' high' : pct >= 70 ? ' warn' : '';
    children.push(
      el('div', { class: `meter${level}` }, [
        el('div', { class: 'meter-head' }, [
          el('span', {}, ['Spend against your limit']),
          el('span', { class: 'meter-value' }, [
            `${pct}% · ${money(a.costUsd)} of ${money(total)}`,
          ]),
        ]),
        el('div', { class: 'meter-bar' }, [fill]),
      ]),
    );
  }

  if (!account.available) {
    children.push(el('p', { class: 'hint' }, ['Sign in to see this account\'s usage.']));
  } else if (a) {
    const fromIde = a.bySource.astracode ?? 0;
    children.push(
      el('p', { class: 'hint' }, [
        `${num(a.daysActive)} active days · ${num(fromIde)} of those turns came from AstraCode` +
          (a.lastUsed ? ` · last used ${new Date(a.lastUsed).toLocaleString()}` : ''),
      ]),
    );
    if (!hasBudget) {
      // Nói ra rằng KHÔNG CÓ SỐ, thay vì lặng lẽ bỏ trống chỗ đáng lẽ có thanh
      // tiền: chỗ trống ấy đọc ra thành "tính năng hỏng" chứ không thành "tài
      // khoản này không bị chặn bởi hạn mức nào".
      children.push(
        el('p', { class: 'hint' }, [
          'AstraWork does not report a spending limit for this account, so there is no ' +
            'percentage to show — only what has been spent.',
        ]),
      );
    }
  }

  children.push(
    el('p', { class: 'hint' }, [
      'The same numbers your AstraWork profile shows — the gateway counts every turn as it ' +
        'runs it, so nothing is uploaded from here.' +
        (account.fetchedAt
          ? ` Read at ${new Date(account.fetchedAt).toLocaleTimeString()}.`
          : ''),
    ]),
  );

  // Thanh ngữ cảnh: về hội thoại đang mở, không phải về tài khoản. Đặt cuối và
  // tách khỏi ba ô số ở trên để không ai cộng nó vào cùng một phép tính.
  //
  // Bề rộng đặt qua CSSOM chứ không phải thuộc tính `style=`: CSP của webview
  // là `style-src ${cspSource}`, không có 'unsafe-inline', nên một style viết
  // thẳng vào thẻ sẽ bị chặn và thanh nằm im ở 0%.
  const fill = el('div', { class: 'meter-fill' });
  fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  children.push(
    el('div', { class: 'meter' }, [
      el('div', { class: 'meter-head' }, [
        el('span', {}, ['Context in this conversation']),
        el('span', { class: 'meter-value' }, [
          usage.contextUsable > 0
            ? `${percent}% · ${num(usage.contextUsed)} / ${num(usage.contextUsable)}`
            : 'not measured yet',
        ]),
      ]),
      el('div', { class: 'meter-bar' }, [fill]),
    ]),
  );

  // Bảy phần cộng lại đúng bằng contextWindow — chỉ có mặt sau lượt chat đầu
  // tiên (trước đó chưa có system prompt/registry nào để đo, xem
  // `ChatController.computeContextBreakdown`). Đặt NGAY dưới thanh tổng ở
  // trên vì nó là lời giải thích cho chính con số của thanh đó, không phải
  // một số liệu khác.
  if (usage.contextBreakdown) children.push(renderContextBreakdown(usage.contextBreakdown));

  // Chỉ hiện lỗi này khi CÒN đăng nhập: lỗi thường là chính `AuthRequiredError`
  // vừa xoá token (xem `AccountUsageStore.read`), và lúc đó nhóm Account ở
  // trên đã tự chuyển sang "Not signed in" kèm nút "Sign in" thật. Hiện thêm
  // một dòng đỏ tĩnh, không có gì bấm được, đúng ngay dưới nút đó chỉ khiến
  // người dùng bấm vào chữ mà không có gì xảy ra.
  if (account.error && state.authenticated) {
    children.push(el('div', { class: 'problem' }, [account.error]));
  }

  // Đường ĐẨY số đo, khác hẳn ba con số phía trên (đó là số ĐỌC về từ gateway).
  // Chỉ hiện khi đang hỏng: một dòng "mọi thứ bình thường" thường trực sẽ bị mắt
  // bỏ qua trong tuần đầu, và sau đó nó không còn báo được gì nữa.
  const sync = state.metricsSync;
  if (sync.lastError) {
    const since = sync.syncedAt
      ? `since ${new Date(sync.syncedAt).toLocaleString()}`
      : 'yet';
    const waiting =
      sync.pendingTurns > 0
        ? ` ${sync.pendingTurns} turn${sync.pendingTurns === 1 ? '' : 's'} are waiting, and the next turn retries.`
        : '';
    children.push(
      el('div', { class: 'problem' }, [
        `Usage metrics have not reached the AstraWork productivity board ${since} — ` +
          `${sync.lastError}.${waiting} Your work is unaffected; the board will be missing these turns.`,
      ]),
    );
  }

  // Nút luôn đọc là "Refresh"; giờ đọc lần cuối đi vào dòng mờ bên cạnh. Đặt
  // thời gian LÊN nút sẽ biến một hành động thành một mẩu trạng thái mà không
  // ai nghĩ là bấm được.
  const action = headAction(account.loading ? 'Reading…' : 'Refresh', () =>
    post({ type: 'syncUsage' }),
  );
  action.disabled = account.loading;

  return group('Usage', children, action);
}

/**
 * Danh sách "System prompt / System tools / MCP tools / Memory / Skills /
 * Messages / Free" dưới thanh Context — mỗi dòng một chấm màu riêng, một
 * thanh ngang tỉ lệ theo `contextWindow` (không theo giá trị lớn nhất trong
 * bảy dòng), và số token bên phải. Bảy màu khớp bảy biến `--vscode-charts-*`
 * có sẵn, nên không cần khai màu tuỳ ý — theme nào cũng có đủ.
 */
function renderContextBreakdown(b: ContextBreakdownWire): HTMLElement {
  const rows: Array<{ label: string; value: number; color: string }> = [
    { label: 'System prompt', value: b.systemPrompt, color: 'blue' },
    { label: 'System tools', value: b.systemTools, color: 'purple' },
    { label: 'MCP tools', value: b.mcpTools, color: 'green' },
    { label: 'Memory', value: b.memory, color: 'orange' },
    { label: 'Skills', value: b.skills, color: 'red' },
    { label: 'Messages', value: b.messages, color: 'yellow' },
    { label: 'Free', value: b.free, color: 'foreground' },
  ];
  const window = b.contextWindow > 0 ? b.contextWindow : 1;

  const children: HTMLElement[] = rows.map((r) => {
    const fill = el('div', { class: 'breakdown-fill' }, []);
    fill.style.width = `${Math.min(100, Math.max(r.value > 0 ? 1 : 0, (r.value / window) * 100))}%`;
    fill.style.background = `var(--vscode-charts-${r.color})`;
    const dot = el('span', { class: 'breakdown-dot' }, []);
    dot.style.background = `var(--vscode-charts-${r.color})`;
    return el('div', { class: 'breakdown-row' }, [
      dot,
      el('span', { class: 'breakdown-label' }, [r.label]),
      el('div', { class: 'breakdown-bar' }, [fill]),
      el('span', { class: 'breakdown-value' }, [num(r.value)]),
    ]);
  });

  const cacheLine = renderCacheLine(b);
  if (cacheLine) children.push(cacheLine);

  return el('div', { class: 'breakdown' }, children);
}

/**
 * Two cache figures shown side by side, each from its own source: the
 * gateway's own reported prompt-cache hit, and AstraCode's independent local
 * cache (see `ContextBreakdownWire.cachedTokens` / `astraCachedTokens`).
 * Neither implies the other — a provider with no prompt cache still lets
 * AstraCode's own number show through, and vice versa.
 */
function renderCacheLine(b: ContextBreakdownWire): HTMLElement | undefined {
  const parts: string[] = [];
  if (b.cachedTokens !== undefined) parts.push(`Gateway cache: ${num(b.cachedTokens)}`);
  if (b.astraCachedTokens !== undefined) parts.push(`AstraCode cache: ${num(b.astraCachedTokens)}`);
  if (parts.length === 0) return undefined;
  return el('div', { class: 'breakdown-cache-line' }, [parts.join(' · ')]);
}

const num = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function stat(label: string, value: string): HTMLElement {
  return el('div', { class: 'stat' }, [
    el('span', { class: 'stat-value' }, [value]),
    el('span', { class: 'stat-label' }, [label]),
  ]);
}

