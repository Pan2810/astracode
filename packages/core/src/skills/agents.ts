/**
 * Subagent — agent con có ngữ cảnh riêng (mốc M8).
 *
 * Lý do tồn tại là ngân sách ngữ cảnh, không phải "chia việc cho oai": một câu
 * hỏi kiểu *"chỗ nào trong repo xử lý authentication"* tốn hai chục lần grep và
 * vài file đọc dở, mà thứ agent cha thật sự cần chỉ là ba dòng kết luận. Chạy
 * nó trong ngữ cảnh riêng rồi trả về bản tóm tắt giữ ngữ cảnh cha sạch.
 *
 * **Quyền của con luôn HẸP HƠN cha, không bao giờ rộng hơn.** Ở bản này nghĩa
 * là: subagent chỉ có tool chỉ đọc. Không ghi file, không bash, không MCP.
 *
 * Vì sao siết đến mức đó thay vì "kế thừa rồi trừ bớt": agent con chạy KHÔNG có
 * người ngồi xem. Mọi cơ chế an toàn của AstraCode ở tầng ghi đều dựa vào một
 * hộp duyệt mà người dùng thật sự đọc — mà người dùng thì đang đọc luồng của
 * agent cha. Nên đường đúng là con không có gì để duyệt.
 */
import { z } from 'zod';
import type { FileSystem } from '../fs/FileSystem.js';
import { scanForInjection, type InjectionScanResult } from '../security/injectionScan.js';
import type { Logger } from '../telemetry/logger.js';
import { ToolRegistry, type Tool, type ToolContext, type ToolResult } from '../tools/Tool.js';
import { READ_ONLY_TOOLS } from '../tools/index.js';

/** Trần ký tự mô tả một agent. */
export const AGENT_MAX_CHARS = 8_000;

export interface AgentDefinition {
  name: string;
  description: string;
  /** System prompt riêng của agent con. */
  body: string;
  /**
   * `org` = chuẩn của dự án, đến từ gateway AstraWork (xem
   * `policy/ProjectAgents.ts`). Không có file trên đĩa nên `path` là URI giả.
   */
  source: 'user' | 'project' | 'org';
  compat: boolean;
  path: string;
  scan: InjectionScanResult;
}

export interface LoadAgentsOptions {
  fs: FileSystem;
  workspaceRoot?: string;
  homeDir?: string;
  allowProjectAgents?: boolean;
  maxChars?: number;
  /**
   * Agent do dự án quy định, đã lấy về từ gateway.
   *
   * Áp SAU CÙNG nên trùng tên là nó thắng — kể cả thắng bản trong `~/.astra/`
   * của chính người dùng. Chủ ý: một cái chuẩn mà mỗi máy ghi đè được một kiểu
   * thì không còn là chuẩn. Ai cần bản riêng thì đặt tên khác, và UI hiện rõ
   * agent nào đến từ đâu để chuyện ghi đè không diễn ra im lặng.
   */
  orgAgents?: AgentDefinition[];
}

const AGENT_DIRS: { parts: string[]; compat: boolean }[] = [
  { parts: ['.claude', 'agents'], compat: true },
  { parts: ['.astra', 'agents'], compat: false },
];

/** Agent định nghĩa bằng một file .md có frontmatter, giống command của M6. */
export async function loadAgents(opts: LoadAgentsOptions): Promise<AgentDefinition[]> {
  const maxChars = opts.maxChars ?? AGENT_MAX_CHARS;
  const found = new Map<string, AgentDefinition>();

  if (opts.workspaceRoot && opts.allowProjectAgents) {
    for (const d of AGENT_DIRS) {
      for (const a of await readAgentDir(
        opts.fs,
        join(opts.workspaceRoot, ...d.parts),
        'project',
        d.compat,
        maxChars,
      )) {
        found.set(a.name, a);
      }
    }
  }
  if (opts.homeDir) {
    for (const d of AGENT_DIRS) {
      for (const a of await readAgentDir(
        opts.fs,
        join(opts.homeDir, ...d.parts),
        'user',
        d.compat,
        maxChars,
      )) {
        found.set(a.name, a);
      }
    }
  }

  // Sau cùng: chuẩn của dự án thắng khi trùng tên. Xem `LoadAgentsOptions`.
  for (const a of opts.orgAgents ?? []) found.set(a.name, a);

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function readAgentDir(
  fs: FileSystem,
  dir: string,
  source: 'user' | 'project',
  compat: boolean,
  maxChars: number,
): Promise<AgentDefinition[]> {
  let entries;
  try {
    if (!(await fs.exists(dir))) return [];
    entries = await fs.readDir(dir);
  } catch {
    return [];
  }

  const out: AgentDefinition[] = [];
  for (const entry of entries) {
    if (entry.type !== 'file' || !entry.name.toLowerCase().endsWith('.md')) continue;
    const path = join(dir, entry.name);
    let raw: string;
    try {
      raw = await fs.readFile(path);
    } catch {
      continue;
    }

    const parsed = parseAgentFile(raw, entry.name.replace(/\.md$/i, ''));
    if (!parsed) continue;

    out.push({
      ...parsed,
      body: parsed.body.slice(0, maxChars),
      source,
      compat,
      path,
      scan: scanForInjection(raw),
    });
  }
  return out;
}

export function parseAgentFile(
  raw: string,
  fallbackName: string,
): { name: string; description: string; body: string } | undefined {
  let name = fallbackName;
  let description = '';
  let body = raw;

  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (match) {
    body = raw.slice(match[0].length);
    for (const line of match[1]!.split(/\r?\n/)) {
      const kv = /^([a-zA-Z_-]+)\s*:\s*(.*)$/.exec(line.trim());
      if (!kv) continue;
      const key = kv[1]!.toLowerCase();
      const value = kv[2]!.trim().replace(/^["']|["']$/g, '');
      if (key === 'name' && value) name = value;
      if (key === 'description') description = value;
    }
  }

  const normalized = normalizeAgentName(name);
  if (!normalized || !body.trim()) return undefined;

  return { name: normalized, description: description || normalized, body: body.trim() };
}

/**
 * Tên agent đã chuẩn hoá — MỘT chỗ quyết định.
 *
 * Agent từ gateway đi qua đúng hàm này. Nếu hai đường chuẩn hoá khác nhau thì
 * `task` gọi bằng tên nào cũng có nguy cơ trượt, mà lỗi lại hiện ra thành "không
 * có agent tên …" chứ không chỉ vào nguyên nhân.
 */
export function normalizeAgentName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Chạy một lượt agent con và trả về văn bản cuối cùng. */
export type SubagentRunner = (input: {
  systemPrompt: string;
  prompt: string;
  tools: ToolRegistry;
  signal?: AbortSignal;
}) => Promise<{ text: string; iterations: number; toolCalls: number }>;

export interface TaskToolOptions {
  /** Agent khai báo sẵn. Rỗng vẫn dùng được: `task` chạy agent tổng quát. */
  agents: AgentDefinition[];
  /** Cách chạy vòng lặp con. Extension truyền bản dựng AgentLoop thật. */
  run: SubagentRunner;
  logger: Logger;
  /** Trần ký tự bản tóm tắt trả về cha. */
  maxResultChars?: number;
  /**
   * Tool cho agent con. Mặc định = bộ chỉ đọc.
   *
   * Người gọi CÓ THỂ truyền bộ khác, nhưng đây là chỗ duy nhất quyết định, và
   * mặc định phải là bộ hẹp nhất — xem chú thích đầu file.
   */
  childTools?: Tool[];
}

const DEFAULT_MAX_RESULT = 8_000;

/** Trần ký tự cho mô tả mỗi agent khi liệt kê cho model. */
const ROSTER_DESC_CHARS = 140;

/**
 * Danh sách agent như model nhìn thấy: TÊN KÈM MÔ TẢ.
 *
 * Trước đây chỗ này chỉ liệt kê tên. Hệ quả không lộ ra thành lỗi nào: mô tả
 * vẫn được đọc, quét, lưu và hiện trên UI — chỉ mỗi model, tức là bên DUY NHẤT
 * quyết định có gọi agent hay không, là không bao giờ thấy nó. Model đành đoán
 * từ cái tên, nên một agent tên `reviewer` gần như không bao giờ được chọn trừ
 * khi người dùng gọi đích danh.
 *
 * Cắt mô tả ở đây chứ không ở nguồn: mô tả đầy đủ vẫn cần cho trang xem của
 * người dùng, còn chỗ này nằm trong system prompt của MỌI lượt nên nó phải trả
 * giá theo token.
 */
function roster(agents: AgentDefinition[]): string {
  return agents
    .map((a) => {
      const desc = a.description.trim().replace(/\s+/g, ' ').slice(0, ROSTER_DESC_CHARS);
      return desc && desc !== a.name ? `${a.name} — ${desc}` : a.name;
    })
    .join('; ');
}

export function createTaskTool(opts: TaskToolOptions): Tool {
  const names = opts.agents.map((a) => a.name);

  return {
    name: 'task',
    description:
      'Chỉ dùng khi người dùng yêu cầu rõ việc delegate hoặc dùng subagent. ' +
      'Giao một việc tra cứu tốn nhiều bước cho agent con có ngữ cảnh riêng, ' +
      'rồi nhận về bản tóm tắt. Dùng khi việc cần nhiều lần tìm/đọc mà kết quả ' +
      'cuối chỉ là vài dòng kết luận — ví dụ "tìm mọi chỗ gọi hàm X và tóm tắt". ' +
      'Agent con CHỈ ĐỌC được: không dùng tool này để implement, fix, refactor, sửa file hoặc chạy test. ' +
      (names.length
        ? `Agent khai báo sẵn (dùng đúng tên ở bên trái dấu gạch): ${roster(opts.agents)}. ` +
          'Chỉ chọn một agent trong danh sách sau khi người dùng đã chủ động yêu cầu delegate.'
        : ''),
    schema: z.object({
      prompt: z.string().min(1).describe('Việc cần làm, mô tả đầy đủ và tự chứa'),
      agent: z.string().optional().describe('Tên agent khai báo sẵn, nếu muốn dùng'),
    }),
    // Không phải readOnly: nó tiêu token thật và chạy lâu thật. Người dùng nên
    // thấy và duyệt được — nhất là vì agent con chạy không ai xem.
    readOnly: false,
    async describe(args: { prompt: string; agent?: string }) {
      return {
        summary: `Delegate to a subagent${args.agent ? ` "${args.agent}"` : ''}`,
        preview: args.prompt.slice(0, 1000),
      };
    },
    async execute(
      args: { prompt: string; agent?: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const def = args.agent ? opts.agents.find((a) => a.name === args.agent) : undefined;
      if (args.agent && !def) {
        return {
          content:
            `Không có agent tên "${args.agent}". ` +
            (names.length ? `Đang có: ${names.join(', ')}.` : 'Chưa khai báo agent nào.') +
            ' Gọi lại không kèm `agent` để dùng agent tổng quát.',
          isError: true,
          untrusted: false,
        };
      }

      const systemPrompt = [
        'Bạn là agent con của AstraCode, chạy trong một ngữ cảnh riêng.',
        'Bạn CHỈ ĐỌC được: không sửa file, không chạy lệnh, không gọi agent con khác.',
        'Hãy tự tìm hiểu rồi trả lời gọn, có dẫn đường dẫn file cụ thể.',
        'Câu trả lời của bạn được đưa nguyên văn cho agent cha, nên đừng hỏi lại.',
        def ? `\n---\n${def.body}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const childTools = new ToolRegistry(opts.childTools ?? READ_ONLY_TOOLS);

      opts.logger.info('chạy agent con', {
        agent: def?.name ?? '(tổng quát)',
        tools: childTools.names(),
      });

      try {
        const r = await opts.run({
          systemPrompt,
          prompt: args.prompt,
          tools: childTools,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });

        const max = opts.maxResultChars ?? DEFAULT_MAX_RESULT;
        const text = r.text.length > max ? `${r.text.slice(0, max)}\n… (bị cắt)` : r.text;

        return {
          // Văn bản này sinh ra từ nội dung file mà agent con vừa đọc, nên nó
          // mang theo mọi rủi ro của nội dung đó. Đặt untrusted là bắt buộc,
          // không phải phòng xa (cùng lý do với bản tóm tắt khi nén ở M6).
          content: text || '(agent con không trả về gì)',
          untrusted: true,
          trustZone: 'B',
          meta: {
            agent: def?.name ?? 'general',
            iterations: r.iterations,
            toolCalls: r.toolCalls,
          },
        };
      } catch (err) {
        return {
          content: `Agent con lỗi: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
          untrusted: false,
        };
      }
    },
  };
}

function join(root: string, ...parts: string[]): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  return [base, ...parts].join(sep);
}
