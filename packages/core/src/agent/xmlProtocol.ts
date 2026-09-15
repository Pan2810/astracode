/**
 * Tool calling qua thẻ XML — đường dự phòng cho model không có native
 * function calling.
 *
 * Vì sao XML chứ không phải JSON block: model yếu sinh JSON lồng nhau rất hay
 * hỏng — thiếu dấu ngoặc, thừa dấu phẩy, escape sai trong chuỗi nhiều dòng.
 * Thẻ XML một cấp thì mỗi tham số là một thẻ riêng, nội dung nhiều dòng không
 * cần escape gì, và parser bắt được từng thẻ độc lập nên một tham số hỏng
 * không làm hỏng cả lời gọi.
 *
 * Cùng interface Tool, chỉ khác lớp encode/decode. AgentLoop chọn đường nào
 * theo `toolCalling` trong models.json.
 */
import type { ToolDefinition } from '../provider/types.js';

export interface ParsedXmlToolCall {
  name: string;
  /** Tham số thô dạng chuỗi. Ép kiểu theo schema là việc của AgentLoop. */
  args: Record<string, string>;
  /** Vị trí trong text — dùng để cắt phần text thường ra khỏi lời gọi. */
  start: number;
  end: number;
}

/**
 * Đường XML không có `role: "tool"`, nên kết quả tool quay lại model dưới dạng
 * một message `user` do AgentLoop tự chèn. Ba hằng dưới đây là ĐỊNH DẠNG của
 * message đó, để chỗ sinh ra và chỗ đọc lại dùng chung một nguồn.
 *
 * Chỗ đọc lại quan trọng hơn vẻ ngoài của nó: khi mở lại một phiên cũ, những
 * message này phải hiện thành một dòng "đã chạy tool" chứ không phải nguyên
 * văn — người dùng không viết chúng, và đọc lại nguyên văn thì hội thoại cũ
 * trông như một bãi XML.
 */
export const XML_TOOL_RESULT_PREFIX = 'Hệ thống đã chạy công cụ bạn gọi. Kết quả:';
export const XML_TOOL_RESULT_HEADING = '### Kết quả của ';
export const XML_TOOL_RESULT_FOOTER =
  'Dựa vào kết quả trên: gọi công cụ tiếp theo, hoặc trả lời người dùng.';
export const XML_TOOL_RESULT_OPEN = '<tool_result untrusted="true">';
export const XML_TOOL_RESULT_CLOSE = '</tool_result>';

/** Một mục trong message kết quả tool. */
export interface XmlToolResult {
  name: string;
  /** Nội dung đã gỡ vỏ `<tool_result>`, chưa cắt ngắn. */
  content: string;
}

/**
 * Message `user` này có phải kết quả tool do AgentLoop chèn không.
 *
 * Trả về danh sách kết quả nếu đúng, `undefined` nếu đây là lời người dùng
 * thật. Nhận nhầm theo hướng nào cũng tệ, nên điều kiện là tiền tố CHÍNH XÁC —
 * một người dùng gõ đúng câu đó là chuyện không xảy ra ngoài đời.
 *
 * Thứ tự giữ nguyên thứ tự gọi, nên ghép được với `calls` của message trước
 * theo chỉ số.
 */
export function readXmlToolResults(content: string): XmlToolResult[] | undefined {
  if (!content.startsWith(XML_TOOL_RESULT_PREFIX)) return undefined;

  const out: XmlToolResult[] = [];
  let current: { name: string; lines: string[] } | undefined;

  const flush = (): void => {
    if (!current) return;
    out.push({ name: current.name, content: unwrapToolResult(current.lines.join('\n')) });
    current = undefined;
  };

  for (const line of content.split('\n')) {
    if (line.startsWith(XML_TOOL_RESULT_HEADING)) {
      flush();
      const name = line.slice(XML_TOOL_RESULT_HEADING.length).trim();
      if (name) current = { name, lines: [] };
      continue;
    }
    // Câu chốt ở cuối là lời dặn model, không thuộc kết quả nào.
    if (line.trim() === XML_TOOL_RESULT_FOOTER) {
      flush();
      continue;
    }
    current?.lines.push(line);
  }
  flush();

  return out;
}

/** Gỡ vỏ `<tool_result>`. Không có vỏ thì trả nguyên văn. */
export function unwrapToolResult(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith(XML_TOOL_RESULT_OPEN)) return trimmed;

  const body = trimmed.slice(XML_TOOL_RESULT_OPEN.length);
  const end = body.lastIndexOf(XML_TOOL_RESULT_CLOSE);
  return (end === -1 ? body : body.slice(0, end)).trim();
}

export interface XmlParseResult {
  /** Phần văn bản thường, đã bỏ các khối thẻ tool. */
  text: string;
  calls: ParsedXmlToolCall[];
  /** Thẻ trông giống lời gọi tool nhưng sai cú pháp — để báo lại cho model. */
  malformed: string[];
  /**
   * Câu giải thích gửi thẳng cho model ở repair loop. Có mặt khi và chỉ khi
   * `malformed` không rỗng.
   */
  malformedReason?: string;
}

/**
 * Thẻ mở của một lời gọi tool.
 *
 * Cố ý DỄ TÍNH: model hay viết `<read_file >`, `<read_file\n>` hoặc thêm thuộc
 * tính thừa. Khớp cứng `<read_file>` thì những biến thể đó trượt hết — mà trượt
 * ở đây không phải là "bỏ qua một lời gọi": thẻ rò nguyên văn ra màn hình và
 * lượt kết thúc im lặng như thể model đã trả lời xong.
 *
 * Vẫn KHÔNG dễ tính tới mức bắt mọi thẻ: tên thẻ phải nằm đúng trong danh sách
 * tool, nếu không thì mọi đoạn HTML/JSX model in ra đều thành lời gọi.
 */
export function openTagPattern(names: string[]): string {
  return `<(${names.map(escapeRegex).join('|')})(?:\\s[^>]*)?>`;
}

/** Thẻ đóng tương ứng. Cho phép khoảng trắng trước dấu `>`. */
export function closeTagPattern(name: string): string {
  return `</${escapeRegex(name)}\\s*>`;
}

/**
 * Thẻ mở "hụt" — model làm rơi hẳn dấu `<`, viết thành `read_file>`.
 *
 * Nghe như chuyện không thể có, nhưng đó là thứ GLM-5.2 làm thật và làm đều:
 * `…xem cấu trúc các package.read_file>` rồi vẫn đóng đúng `</read_file>`.
 * Hay gặp nhất khi thẻ dính liền sau một câu văn, không có xuống dòng ngăn.
 *
 * Chỉ dùng để CỨU và để giấu khỏi màn hình, không bao giờ dùng để dạy model —
 * prompt vẫn chỉ nêu đúng một dạng viết.
 *
 * `(?<![/\\w])` chặn hai thứ: khớp trúng phần đuôi của chính thẻ đóng
 * (`</read_file>`), và khớp trúng một từ dài hơn có chứa tên tool.
 */
export function looseOpenTagPattern(names: string[]): string {
  return `(?<![/\\w])<?(${names.map(escapeRegex).join('|')})\\s*>`;
}

/**
 * Sinh phần mô tả tool nhét vào system prompt.
 *
 * Có VÍ DỤ HOÀN CHỈNH ở cuối là bắt buộc: model yếu làm theo ví dụ tốt hơn
 * nhiều so với làm theo đặc tả.
 */
export function buildXmlToolPrompt(tools: ToolDefinition[]): string {
  const blocks = tools.map((tool) => {
    const params = describeParams(tool.parameters);
    return `### ${tool.name}
${tool.description}

Tham số:
${params}

Cách gọi:
<${tool.name}>
${exampleParams(tool.parameters)}
</${tool.name}>`;
  });

  return `# Cách gọi công cụ

Bạn KHÔNG có function calling. Để dùng công cụ, hãy viết thẻ XML trong phần trả
lời. Mỗi lượt chỉ gọi MỘT công cụ, và thẻ phải nằm ở cuối câu trả lời.

Quy tắc:
- Tên thẻ ngoài cùng là tên công cụ, viết KHÍT như trong danh sách dưới đây:
  đúng chữ thường, đúng dấu gạch dưới, không thuộc tính, không khoảng trắng thừa.
- Thẻ mở bắt đầu bằng dấu \`<\` và phải nằm ở ĐẦU MỘT DÒNG MỚI. Viết hết câu,
  xuống dòng, rồi mới mở thẻ — đừng để thẻ dính liền sau dấu chấm câu.
- Mỗi tham số là một thẻ con. Nội dung nhiều dòng viết thẳng, không cần escape.
- Không dùng \`<tool_call>\`, không dùng JSON, không bọc thêm thẻ nào ở ngoài.
- Không thêm giải thích nào SAU thẻ đóng.
- Sau khi bạn gọi, hệ thống sẽ trả kết quả rồi bạn đi tiếp.

## Công cụ có sẵn

${blocks.join('\n\n')}

## Ví dụ một lượt hoàn chỉnh

Người dùng: hàm nào xử lý đăng nhập?

Bạn trả lời:
Để tôi tìm trong mã nguồn.

<grep>
<pattern>function login</pattern>
<glob>**/*.ts</glob>
</grep>

Hệ thống trả về kết quả, rồi bạn dựa vào đó để trả lời tiếp.`;
}

function describeParams(schema: Record<string, unknown>): string {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required as string[] | undefined) ?? []);

  const lines = Object.entries(props).map(([name, def]) => {
    const type = String(def.type ?? 'string');
    const desc = typeof def.description === 'string' ? ` — ${def.description}` : '';
    return `- ${name} (${type}${required.has(name) ? ', bắt buộc' : ', tuỳ chọn'})${desc}`;
  });

  return lines.length > 0 ? lines.join('\n') : '- (không có)';
}

function exampleParams(schema: Record<string, unknown>): string {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required as string[] | undefined) ?? Object.keys(props);

  const shown = required.length > 0 ? required : Object.keys(props).slice(0, 1);
  return shown
    .map((name) => `<${name}>giá trị</${name}>`)
    .join('\n');
}

/**
 * Bóc lời gọi tool ra khỏi text model sinh.
 *
 * Chỉ nhận thẻ có tên nằm trong `toolNames` — nếu bắt mọi thẻ trông giống XML
 * thì mọi đoạn code HTML/JSX model in ra đều thành "lời gọi tool".
 */
export function parseXmlToolCalls(text: string, toolNames: string[]): XmlParseResult {
  const calls: ParsedXmlToolCall[] = [];
  const malformed: string[] = [];

  if (toolNames.length === 0) return { text, calls, malformed };

  const blockRe = new RegExp(`${openTagPattern(toolNames)}([\\s\\S]*?)</\\1\\s*>`, 'g');

  let cleaned = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = blockRe.exec(text)) !== null) {
    const [whole, name, body] = match as unknown as [string, string, string];
    cleaned += text.slice(lastIndex, match.index);
    lastIndex = match.index + whole.length;

    calls.push({
      name,
      args: parseParams(body),
      start: match.index,
      end: lastIndex,
    });
  }
  cleaned += text.slice(lastIndex);

  // Không có lời gọi nào đúng chuẩn thì thử cứu trước khi kết luận là hỏng.
  // Bắt model viết lại tốn nguyên một vòng gọi model, mà thứ nó viết sai chỉ là
  // một ký tự `<` — thông tin cần để chạy thì đã đủ cả.
  if (calls.length === 0) {
    const rescued = recoverBrokenCalls(cleaned, toolNames);
    if (rescued.calls.length > 0) {
      return { text: rescued.text.trim(), calls: rescued.calls, malformed };
    }
  }

  // Chỉ soi thẻ hỏng khi KHÔNG bóc được lời gọi nào. Lượt đã gọi được tool thì
  // vòng lặp còn đi tiếp, model sẽ có lượt sau để tự sửa — bắt lỗi ở đó chỉ
  // đốt thêm một vòng vì một đoạn JSX in dở.
  if (calls.length === 0) {
    const found = detectMalformed(cleaned, toolNames);
    malformed.push(...found.malformed);
    if (found.reason !== undefined) {
      return { text: cleaned.trim(), calls, malformed, malformedReason: found.reason };
    }
  }

  return { text: cleaned.trim(), calls, malformed };
}

/**
 * Cứu lời gọi có thẻ đóng đàng hoàng nhưng thẻ mở bị hụt dấu `<`.
 *
 * Neo vào THẺ ĐÓNG chứ không vào thẻ mở: thẻ đóng là phần model viết đúng, và
 * nó cho biết chắc chắn tên công cụ. Từ đó lùi ngược tìm chỗ mở gần nhất.
 *
 * Ba điều kiện để nhận, cố ý chặt — cứu nhầm một đoạn văn xuôi thành lời gọi
 * còn tệ hơn là bắt model viết lại:
 * 1. có thẻ đóng `</tên>` của đúng một công cụ đã biết;
 * 2. trước nó có `tên>` không nằm trong một từ khác;
 * 3. phần thân giữa hai chỗ đó bóc ra được ÍT NHẤT một tham số.
 *
 * Điều kiện 3 nghĩa là lời gọi không tham số (`list_dir` mặc định) không cứu
 * được — chấp nhận: nó vào repair loop như cũ, và đó là nhánh hiếm.
 */
function recoverBrokenCalls(
  text: string,
  names: string[],
): { text: string; calls: ParsedXmlToolCall[] } {
  const calls: ParsedXmlToolCall[] = [];
  let cleaned = '';
  let cursor = 0;

  const closeRe = new RegExp(`</(${names.map(escapeRegex).join('|')})\\s*>`, 'g');
  let m: RegExpExecArray | null;

  while ((m = closeRe.exec(text)) !== null) {
    const name = m[1]!;
    const closeEnd = m.index + m[0].length;
    if (m.index < cursor) continue;

    // Chỗ mở gần thẻ đóng nhất — model có thể nhắc tên công cụ trong câu văn
    // trước đó, lấy cái cuối cùng mới đúng là chỗ lời gọi bắt đầu.
    const openRe = new RegExp(looseOpenTagPattern([name]), 'g');
    const before = text.slice(cursor, m.index);
    let start = -1;
    let bodyStart = -1;
    let om: RegExpExecArray | null;
    while ((om = openRe.exec(before)) !== null) {
      start = cursor + om.index;
      bodyStart = cursor + om.index + om[0].length;
    }
    if (start < 0) continue;

    const args = parseParams(text.slice(bodyStart, m.index));
    if (Object.keys(args).length === 0) continue;

    cleaned += text.slice(cursor, start);
    calls.push({ name, args, start, end: closeEnd });
    cursor = closeEnd;
  }

  cleaned += text.slice(cursor);
  return { text: cleaned, calls };
}

/** Tên thẻ khác hoa/thường, khác dấu nối, vẫn là cùng một ý định. */
function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/[-_.]/g, '');
}

/**
 * Nhận ra "model ĐỊNH gọi tool nhưng viết sai" và nói cho nó biết sai ở đâu.
 *
 * Không nhận ra được thì lượt kết thúc im lặng với một mảnh thẻ rò ra màn hình
 * — hỏng mà không ai biết, kể cả người dùng lẫn model. Bốn dạng dưới đây là
 * những gì model thật sự viết ra khi nó chệch khỏi định dạng.
 */
function detectMalformed(
  text: string,
  names: string[],
): { malformed: string[]; reason?: string } {
  const malformed: string[] = [];
  const add = (name: string): void => {
    if (!malformed.includes(name)) malformed.push(name);
  };
  let reason: string | undefined;

  // 1. Thẻ mở đúng tên, thiếu thẻ đóng — model bị cắt giữa chừng hoặc quên đóng.
  for (const m of text.matchAll(new RegExp(openTagPattern(names), 'g'))) {
    const name = m[1]!;
    add(name);
    reason ??=
      `Thẻ <${name}> mở mà không có thẻ đóng </${name}>. ` +
      `Viết lại lời gọi đầy đủ, mở và đóng đúng tên thẻ.`;
  }

  // 2. Thẻ đóng lạc lõng — thường là thẻ mở bị viết sai nên không khớp cặp.
  const closeRe = new RegExp(`</(${names.map(escapeRegex).join('|')})\\s*>`, 'g');
  for (const m of text.matchAll(closeRe)) {
    const name = m[1]!;
    add(name);
    reason ??=
      `Có thẻ đóng </${name}> nhưng không có thẻ mở <${name}> khớp với nó. ` +
      `Viết lại cả cặp thẻ.`;
  }

  // 3. Tên thẻ gần đúng: <readFile>, <Read_File>, <read-file>.
  const byNormalized = new Map(names.map((n) => [normalizeName(n), n]));
  for (const m of text.matchAll(/<\/?([A-Za-z][A-Za-z0-9_.-]*)/g)) {
    const raw = m[1]!;
    const real = byNormalized.get(normalizeName(raw));
    if (real === undefined || real === raw) continue;
    add(real);
    reason ??=
      `Tên thẻ <${raw}> viết sai. Tên thẻ phải trùng KHÍT tên công cụ: <${real}>.`;
  }

  // 4. Định dạng của model khác: <tool_call>, <function_call>, <invoke>.
  const wrapper = /<\/?(tool_call|tool_use|function_call|invoke|function)\b/i.exec(text);
  if (wrapper && malformed.length === 0) {
    add(wrapper[1]!);
    reason ??=
      `Không dùng thẻ <${wrapper[1]}>. Lời gọi công cụ lấy chính TÊN CÔNG CỤ ` +
      `làm tên thẻ ngoài cùng, mỗi tham số là một thẻ con — ví dụ: ` +
      `<${names[0] ?? 'read_file'}>…</${names[0] ?? 'read_file'}>`;
  }

  return reason === undefined ? { malformed } : { malformed, reason };
}

/** Thẻ con một cấp. Cố ý KHÔNG đệ quy — tool nào cũng chỉ nhận tham số phẳng. */
function parseParams(body: string): Record<string, string> {
  const args: Record<string, string> = {};
  const re = /<([a-zA-Z_][a-zA-Z0-9_]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    args[m[1]!] = m[2]!.trim();
  }
  return args;
}

/**
 * Ép kiểu tham số từ chuỗi sang kiểu mà schema chờ đợi.
 *
 * XML không có kiểu — mọi thứ về đây đều là chuỗi. Không ép thì zod sẽ báo lỗi
 * `limit: expected number, received string` ở MỌI lời gọi, và repair loop sẽ
 * đốt hết lượt thử vào một việc mà code làm được.
 */
export function coerceArgs(
  raw: Record<string, string>,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    const type = props[key]?.type;

    if (type === 'number' || type === 'integer') {
      const n = Number(value);
      out[key] = Number.isFinite(n) ? n : value;
      continue;
    }
    if (type === 'boolean') {
      const v = value.toLowerCase();
      out[key] = v === 'true' || v === '1' || v === 'yes' ? true : v === 'false' || v === '0' || v === 'no' ? false : value;
      continue;
    }
    if (type === 'array') {
      // Một giá trị mỗi dòng — dễ cho model hơn là JSON array.
      out[key] = value.includes('\n')
        ? value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        : value
          ? [value]
          : [];
      continue;
    }
    out[key] = value;
  }

  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
