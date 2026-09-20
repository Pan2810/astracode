/**
 * Đọc `tickets_md` thành danh sách ticket.
 *
 * Nguyên tắc: nhận diện theo CẤU TRÚC markdown, không theo hình dạng của key.
 * Không có regex kiểu `[A-Z]+-\d+` ở đây — `1024`, `ABC_42`, `feature/login`
 * hay `#77` đều là key hợp lệ, vì key là "ô/token ở vị trí key", không phải
 * "chuỗi trông giống mã Jira". AstraCode không được biết dự án nào đang dùng
 * quy ước đặt tên nào.
 *
 * Ba cấu trúc được nhận, xét theo thứ tự:
 *   1. Bảng markdown có một cột tên kiểu key/id/ticket  → mỗi dòng là một ticket
 *   2. Heading                                          → mỗi heading ở cấp
 *      "đông nhất" là một ticket (cấp có nhiều heading nhất; hoà thì lấy cấp nông hơn)
 *   3. Danh sách gạch đầu dòng                          → mỗi item là một ticket
 *
 * Trong cả ba, một field khai thẳng (`Key:`, `ID:`, `Mã:`…) luôn thắng phần
 * suy ra từ tiêu đề.
 */

const KEY_LABELS = ['key', 'id', 'ticket', 'issue', 'ticket key', 'issue key', 'ticket id', 'issue id', 'mã', 'ma', 'mã ticket', 'ma ticket', 'code'];
const TITLE_LABELS = ['summary', 'title', 'name', 'subject', 'description', 'tóm tắt', 'tom tat', 'mô tả', 'mo ta', 'tiêu đề', 'tieu de'];
const STATUS_LABELS = ['status', 'state', 'jira status', 'trạng thái', 'trang thai', 'tình trạng', 'tinh trang'];

/** Ký tự ngăn giữa key và tiêu đề trong một dòng: `KEY — tiêu đề`, `KEY: tiêu đề`, `KEY | tiêu đề`. */
const SEPARATORS = ['—', '–', '·', '|', ' - ', ' -- ', ':'];

const MAX_BODY_CHARS = 4000;

function norm(s) {
  return String(s).normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Bóc trang trí markdown khỏi một ô/tiêu đề để còn lại giá trị trần. */
function clean(s) {
  let v = String(s ?? '').trim();
  // `#` chỉ là dấu heading khi có khoảng trắng theo sau — `#77` là một key hợp lệ.
  v = v.replace(/^#{1,6}\s+/, '');
  v = v.replace(/^\*{1,3}(.*?)\*{1,3}$/s, '$1');
  v = v.replace(/`/g, '');
  v = v.replace(/^\[([^\]]+)\]\([^)]*\)$/, '$1'); // [KEY](url)
  v = v.replace(/^\[([^\]]+)\]$/, '$1'); // [KEY]
  v = v.replace(/^[-–—•*]+\s*/, '');
  v = v.replace(/[\s:：\-–—|]+$/, '');
  return v.trim();
}

function labelMatches(label, set) {
  const n = norm(label);
  return set.includes(n) || set.some((l) => n === `${l}s` || n.startsWith(`${l} `));
}

/** Đánh dấu dòng nào nằm trong khối ``` để phần dò cấu trúc bỏ qua chúng. */
function fenceFlags(lines) {
  const flags = new Array(lines.length).fill(false);
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      flags[i] = true;
      open = !open;
      continue;
    }
    flags[i] = open;
  }
  return flags;
}

/** `- **Status:** Done` / `Status: Done` / `Mã: ABC_42` → {label, value}. */
function parseField(line) {
  const m = /^\s*(?:[-*+]\s+)?\*{0,2}([^:：*\n|]{1,40}?)\*{0,2}\s*[:：]\s*(.*)$/.exec(line);
  if (!m) return undefined;
  const label = m[1].trim();
  if (!label || /\s{2,}/.test(label)) return undefined;
  return { label, value: m[2].trim() };
}

function fieldsOf(lines) {
  const out = {};
  for (const line of lines) {
    const f = parseField(line);
    if (!f) continue;
    const value = clean(f.value);
    if (!value) continue;
    if (out.key === undefined && labelMatches(f.label, KEY_LABELS)) out.key = value;
    else if (out.title === undefined && labelMatches(f.label, TITLE_LABELS)) out.title = value;
    else if (out.status === undefined && labelMatches(f.label, STATUS_LABELS)) out.status = value;
  }
  return out;
}

/**
 * `KEY — tiêu đề` → {key, title}. Không có dấu ngăn thì token đầu là key.
 *
 * Dấu ngăn được chọn theo VỊ TRÍ SỚM NHẤT trong chuỗi, không theo thứ tự ưu
 * tiên của danh sách. Chọn theo danh sách thì `WEB-5: Có dấu | và hai chấm` bị
 * cắt ở `|` (vì `|` đứng trước `:` trong `SEPARATORS`) và key thành
 * `"WEB-5: Có dấu"` — một key rác, lặng lẽ, trên một ticket trông vẫn bình
 * thường. Một tiêu đề có `|` là chuyện thường; đứng sau dấu ngăn thật thì nó
 * phải nằm trong tiêu đề.
 *
 * Hoà vị trí thì thứ tự trong `SEPARATORS` quyết định — dấu dài hơn (` -- `)
 * khai ở trước dấu ngắn hơn.
 */
function splitLead(text) {
  const t = clean(text);
  if (!t) return { key: '', title: '' };
  let best = null;
  for (const sep of SEPARATORS) {
    const i = t.indexOf(sep);
    if (i > 0 && (best === null || i < best.i)) best = { i, sep };
  }
  if (best) {
    const key = clean(t.slice(0, best.i));
    const title = clean(t.slice(best.i + best.sep.length));
    if (key) return { key, title };
  }
  const parts = t.split(/\s+/);
  if (parts.length === 1) return { key: clean(parts[0]), title: '' };
  return { key: clean(parts[0]), title: clean(parts.slice(1).join(' ')) };
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function isSeparatorRow(line) {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');
}

function fromTable(lines, fenced) {
  for (let i = 0; i < lines.length - 1; i++) {
    if (fenced[i] || !lines[i].trim().startsWith('|')) continue;
    if (!isSeparatorRow(lines[i + 1])) continue;

    const header = splitRow(lines[i]);
    const keyCol = header.findIndex((h) => labelMatches(h, KEY_LABELS));
    if (keyCol < 0) continue;
    const titleCol = header.findIndex((h) => labelMatches(h, TITLE_LABELS));
    const statusCol = header.findIndex((h) => labelMatches(h, STATUS_LABELS));

    const tickets = [];
    for (let r = i + 2; r < lines.length; r++) {
      if (fenced[r] || !lines[r].trim().startsWith('|')) break;
      const cells = splitRow(lines[r]);
      const key = clean(cells[keyCol] ?? '');
      if (!key) continue;
      const body = header
        .map((h, c) => (cells[c] ? `${clean(h)}: ${clean(cells[c])}` : ''))
        .filter(Boolean)
        .join('\n');
      tickets.push({
        key,
        title: titleCol >= 0 ? clean(cells[titleCol] ?? '') : '',
        status: statusCol >= 0 ? clean(cells[statusCol] ?? '') : '',
        body,
        // Dòng 1-based trong `tickets_md`. Chỉ dùng cho thông báo lỗi, nhưng
        // một lỗi "key trùng" không kèm số dòng thì người sửa phải tự đi tìm
        // trong một tệp 190 ticket.
        line: r + 1,
      });
    }
    if (tickets.length) return tickets;
  }
  return [];
}

function fromHeadings(lines, fenced) {
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (m) heads.push({ level: m[1].length, text: m[2], line: i });
  }
  if (!heads.length) return [];

  // Cấp "đông nhất" là cấp của ticket: `# Sprint 12` rồi N × `## KEY …` thì
  // ticket nằm ở cấp 2, không phải cấp 1.
  const count = new Map();
  for (const h of heads) count.set(h.level, (count.get(h.level) ?? 0) + 1);
  let level = heads[0].level;
  for (const [lv, n] of [...count].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
    level = lv;
    void n;
    break;
  }

  const picked = heads.filter((h) => h.level === level);
  const tickets = [];
  for (let i = 0; i < picked.length; i++) {
    const start = picked[i].line;
    const nextHead = heads.find((h) => h.line > start && h.level <= level);
    const end = nextHead ? nextHead.line : lines.length;
    const bodyLines = lines.slice(start + 1, end);
    const fields = fieldsOf(bodyLines);
    const lead = splitLead(picked[i].text);
    const key = fields.key ?? lead.key;
    if (!key) continue;
    tickets.push({
      key,
      title: fields.title ?? lead.title,
      status: fields.status ?? '',
      body: bodyLines.join('\n').trim(),
      line: start + 1,
    });
  }
  return tickets;
}

function fromList(lines, fenced) {
  const tickets = [];
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const m = /^([ \t]*)[-*+]\s+(.+?)\s*$/.exec(lines[i]);
    if (!m || m[1].length > 1) continue; // chỉ item ở cấp ngoài cùng
    // Dòng con thụt vào thuộc về item này.
    const sub = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^[ \t]{2,}\S/.test(lines[j])) sub.push(lines[j]);
      else if (lines[j].trim() === '') continue;
      else break;
    }
    const fields = fieldsOf(sub);
    const lead = splitLead(m[2]);
    const key = fields.key ?? lead.key;
    if (!key) continue;
    tickets.push({
      key,
      title: fields.title ?? lead.title,
      status: fields.status ?? '',
      body: sub.join('\n').trim(),
      line: i + 1,
    });
  }
  return tickets;
}

/**
 * @returns {{key: string, title: string, status: string, body: string}[]}
 * @throws nếu không dò ra ticket nào, hoặc có key trùng — cả hai đều là đầu vào
 *   hỏng, và đoán bừa ở đây sẽ biến thành một report sai mà không ai thấy.
 */
export function parseTickets(md) {
  if (typeof md !== 'string' || !md.trim()) {
    throw new Error('tickets_md rỗng.');
  }
  const lines = md.split(/\r?\n/);
  const fenced = fenceFlags(lines);

  let tickets = fromTable(lines, fenced);
  if (!tickets.length) tickets = fromHeadings(lines, fenced);
  if (!tickets.length) tickets = fromList(lines, fenced);

  if (!tickets.length) {
    // Chỉ ra dòng đầu tiên có chữ: gần như luôn là chỗ người gửi tưởng mình
    // đang khai một ticket. "Không dò ra ticket nào" mà không kèm một mẩu văn
    // bản thật thì người sửa không biết server đã đọc tới đâu.
    const firstIdx = lines.findIndex((l) => l.trim());
    const where =
      firstIdx >= 0
        ? ` Ðọc từ dòng ${firstIdx + 1}: "${lines[firstIdx].trim().slice(0, 60)}".`
        : '';
    throw new Error(
      `tickets_md: không dò ra ticket nào.${where} Hỗ trợ ba cấu trúc: bảng markdown có cột key/id/ticket, ` +
        'heading (mỗi heading một ticket), hoặc danh sách gạch đầu dòng. Trong cả ba, một dòng ' +
        '"Key: …" trong thân ticket luôn được ưu tiên.',
    );
  }

  /*
   * Key trùng vẫn là lỗi — nhưng lỗi phải chỉ được chỗ.
   *
   * Hai ticket đụng nhau sau khi chuẩn hoá (`norm` bỏ hoa/thường và khoảng
   * trắng thừa), nên hai key GỐC có thể trông khác nhau: `WEB-1001` và
   * `web-1001` là cùng một key với server mà là hai dòng khác nhau với mắt
   * người. Thông báo vì thế phải nói cả hai chữ gốc lẫn hai số dòng — không có
   * chúng thì người sửa cầm một tệp 190 ticket và một câu "có key trùng".
   */
  const seen = new Map();
  for (const t of tickets) {
    t.body = t.body.length > MAX_BODY_CHARS ? `${t.body.slice(0, MAX_BODY_CHARS)}\n…(đã cắt)` : t.body;
    const k = norm(t.key);
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(t);
  }
  const clashes = [...seen].filter(([, group]) => group.length > 1);
  if (clashes.length) {
    const where = (t) => `"${t.key}" (dòng ${t.line ?? '?'})`;
    const detail = clashes
      .map(([k, group]) => {
        const shown = group.slice(0, 2).map(where).join(' và ');
        const more = group.length > 2 ? `, và ${group.length - 2} chỗ nữa` : '';
        return `${shown}${more} cùng là key "${k}"`;
      })
      .join('; ');
    throw new Error(`tickets_md: key bị trùng — ${detail}. Mỗi ticket phải có key riêng.`);
  }

  return tickets;
}

/**
 * `tickets: [{key, summary, status, description}]` — danh sách đã có cấu trúc.
 *
 * Ðường này tồn tại vì `tickets_md` là một phép ĐOÁN. AstraQA vốn đã có từng
 * trường tách bạch trong hệ của nó; ép chúng thành markdown rồi bắt server dò
 * ngược lại là thêm một chỗ để hỏng — và nó hỏng đúng ở những tiêu đề chứa
 * `|`, `#`, `(`, hay xuống dòng, tức là những tiêu đề viết bình thường.
 *
 * Ở đây không có phép dò nào: key là key, summary là summary. `description` vào
 * `body` — đúng hai trường mà `queryTerms` được phép đọc (§1.1).
 *
 * Trùng key vẫn là lỗi, cùng một lý do như bên markdown, chỉ khác là chỉ được
 * chỗ bằng chỉ số mảng thay vì số dòng.
 *
 * @returns {{key: string, title: string, status: string, body: string, index: number}[]}
 */
export function parseJsonTickets(raw) {
  if (!Array.isArray(raw)) throw new Error('"tickets" phải là một mảng.');
  if (raw.length === 0) throw new Error('"tickets" là mảng rỗng — không có ticket nào để đối chiếu.');

  const tickets = raw.map((t, i) => {
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      throw new Error(`tickets[${i}] phải là một object {key, summary, status, description}.`);
    }
    const key = String(t.key ?? '').trim();
    if (!key) throw new Error(`tickets[${i}].key phải là chuỗi không rỗng.`);
    const body = String(t.description ?? '').trim();
    return {
      key,
      title: String(t.summary ?? '').trim(),
      status: String(t.status ?? '').trim(),
      body: body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n…(đã cắt)` : body,
      index: i,
    };
  });

  const seen = new Map();
  for (const t of tickets) {
    const k = norm(t.key);
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(t);
  }
  const clashes = [...seen].filter(([, group]) => group.length > 1);
  if (clashes.length) {
    const where = (t) => `"${t.key}" (tickets[${t.index}])`;
    const detail = clashes
      .map(([k, group]) => `${group.slice(0, 2).map(where).join(' và ')} cùng là key "${k}"`)
      .join('; ');
    throw new Error(`tickets: key bị trùng — ${detail}. Mỗi ticket phải có key riêng.`);
  }

  return tickets;
}

/**
 * Chọn nguồn ticket của một job: JSON thắng markdown khi có cả hai.
 *
 * "Thắng" chứ không phải "gộp": gộp hai nguồn nghĩa là phải quyết xem bản nào
 * đúng khi chúng nói khác nhau về cùng một key, và không có câu trả lời đúng
 * cho việc ấy. JSON thắng vì nó là dữ liệu đã có cấu trúc — `tickets_md` chỉ là
 * cùng dữ liệu đó sau khi đã bị ép qua markdown.
 *
 * @returns {{tickets: object[], source: 'json'|'markdown'}}
 */
export function resolveTickets(body = {}) {
  if (body.tickets !== undefined && body.tickets !== null) {
    return { tickets: parseJsonTickets(body.tickets), source: 'json' };
  }
  return { tickets: parseTickets(body.tickets_md), source: 'markdown' };
}
