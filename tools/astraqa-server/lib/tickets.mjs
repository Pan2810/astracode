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

/** `KEY — tiêu đề` → {key, title}. Không có dấu ngăn thì token đầu là key. */
function splitLead(text) {
  const t = clean(text);
  if (!t) return { key: '', title: '' };
  for (const sep of SEPARATORS) {
    const i = t.indexOf(sep);
    if (i > 0) {
      const key = clean(t.slice(0, i));
      const title = clean(t.slice(i + sep.length));
      if (key) return { key, title };
    }
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

  // Section headings inside tickets are repeated once per ticket. Counting them
  // as ticket headings makes a normal AstraQA document parse as duplicate
  // "description" / "acceptance criteria" tickets.
  const sectionNames = new Set(['description', 'acceptance criteria']);
  const ticketHeads = heads.filter((h) => !sectionNames.has(norm(h.text)));
  if (!ticketHeads.length) return [];

  // Cấp "đông nhất" là cấp của ticket: `# Sprint 12` rồi N × `## KEY …` thì
  // ticket nằm ở cấp 2, không phải cấp 1.
  const count = new Map();
  for (const h of ticketHeads) count.set(h.level, (count.get(h.level) ?? 0) + 1);
  let level = ticketHeads[0].level;
  for (const [lv, n] of [...count].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
    level = lv;
    void n;
    break;
  }

  const picked = ticketHeads.filter((h) => h.level === level);
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
    throw new Error(
      'tickets_md: không dò ra ticket nào. Hỗ trợ ba cấu trúc: bảng markdown có cột key/id/ticket, ' +
        'heading (mỗi heading một ticket), hoặc danh sách gạch đầu dòng. Trong cả ba, một dòng ' +
        '"Key: …" trong thân ticket luôn được ưu tiên.',
    );
  }

  const seen = new Map();
  for (const t of tickets) {
    t.body = t.body.length > MAX_BODY_CHARS ? `${t.body.slice(0, MAX_BODY_CHARS)}\n…(đã cắt)` : t.body;
    const k = norm(t.key);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const dup = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  if (dup.length) {
    throw new Error(`tickets_md: key bị trùng (${dup.join(', ')}). Mỗi ticket phải có key riêng.`);
  }

  return tickets;
}

/** Structured transport used by AstraQA; Markdown remains for existing callers. */
export function parseTicketsInput(body) {
  const hasTickets = Object.hasOwn(body ?? {}, 'tickets');
  const hasMarkdown = typeof body?.tickets_md === 'string' && Boolean(body.tickets_md.trim());
  if (!hasTickets) return parseTickets(body?.tickets_md);
  if (hasMarkdown) throw new Error('Send either tickets or tickets_md, not both.');
  if (body.tickets_schema_version !== 1) throw new Error('tickets_schema_version must be 1.');
  if (!Array.isArray(body.tickets) || body.tickets.length === 0) {
    throw new Error('tickets must be a non-empty array.');
  }
  const seen = new Set();
  return body.tickets.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`tickets[${index}] must be an object.`);
    }
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    if (!key) throw new Error(`tickets[${index}].key must be a non-empty string.`);
    const normalized = norm(key);
    if (seen.has(normalized)) throw new Error(`tickets: duplicate key ${key}.`);
    seen.add(normalized);
    const title = raw.summary ?? raw.title ?? '';
    const status = raw.status ?? '';
    const description = raw.description ?? '';
    const acceptance = raw.acceptance_criteria ?? [];
    if (typeof title !== 'string' || typeof status !== 'string' || typeof description !== 'string') {
      throw new Error(`tickets[${index}] summary, status and description must be strings.`);
    }
    if (!Array.isArray(acceptance) || acceptance.some((criterion) => typeof criterion !== 'string')) {
      throw new Error(`tickets[${index}].acceptance_criteria must be an array of strings.`);
    }
    const bodyText = [
      description,
      acceptance.length ? `Acceptance criteria:\n${acceptance.map((criterion, i) => `${i + 1}. ${criterion}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    return {
      key,
      title,
      status,
      description,
      acceptance_criteria: [...acceptance],
      body: bodyText,
    };
  });
}
