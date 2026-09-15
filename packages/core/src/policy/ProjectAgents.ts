/**
 * Chuẩn agent theo dự án — phần "agent dùng chung" (M10b).
 *
 * PM khai vài subagent trên AstraWork, mọi member trong dự án ấy mở IDE lên là
 * có sẵn, không ai phải chép file. Dự án nằm trong JWT (xem `work/WorkItems.ts`),
 * nên endpoint này KHÔNG nhận `project_id`: token nào thì chuẩn nấy, và đổi dự
 * án là xin token khác rồi gọi lại.
 *
 * ## Vì sao món này được làm trước, chứ không phải "lời dặn chung"
 *
 * Subagent trong AstraCode chỉ có tool CHỈ ĐỌC (xem `skills/agents.ts`). Nội
 * dung PM viết vào đây, kể cả khi sai hoặc bị chèn chỉ thị lạ, cũng không sửa
 * được file và không chạy được lệnh. Đây là bề mặt rẻ nhất để dựng cả đường
 * ống "chuẩn từ AstraWork xuống IDE" mà chưa phải trả giá nào.
 *
 * ## Đây vẫn là prompt do người khác viết
 *
 * Tin cậy hơn `.astra/agents/` trong repo (kia là bất kỳ ai gửi PR; đây là một
 * tài khoản có RBAC và có audit ở gateway) nhưng KHÔNG phải là lời của hệ
 * thống. Nên vẫn đủ ba lớp như `config/memory.ts`: trần ký tự, trần số lượng,
 * quét injection và báo lên UI.
 *
 * ## Cái này CỐ Ý không chở
 *
 * Không có trường nào cho lệnh chạy được. Chuẩn dự án chỉ chở CHỮ. Ngày nào
 * payload này chứa một `command` mà client tự chạy, ngày đó một tài khoản PM bị
 * chiếm là mã tuỳ ý trên máy mọi dev trong dự án — và không lớp nào ở đây đỡ
 * được. Ràng buộc kiểu "cấm bật MCP", "chỉ dùng model X" thuộc `IdePolicy`, nơi
 * đã có bất biến chỉ-siết-không-nới; đừng nhét chúng vào đây.
 */
import { z } from 'zod';
import { scanForInjection } from '../security/injectionScan.js';
import { AGENT_MAX_CHARS, normalizeAgentName, type AgentDefinition } from '../skills/agents.js';
import { SKILL_MAX_CHARS, type Skill } from '../skills/skills.js';

/** Trần số agent một dự án đẩy xuống được. Xem `toAgentDefinitions`. */
export const MAX_PROJECT_AGENTS = 24;

/**
 * Mục này giao cho AI **con** hay cho chính agent đang chat.
 *
 * Đây là trường quan trọng nhất của cả payload, vì nó quyết định thứ PM viết ra
 * có LÀM được việc hay chỉ nói về việc:
 *
 *   `agent` — chạy trong ngữ cảnh riêng, bộ tool CHỈ ĐỌC, trả về một bản tóm
 *             tắt. Hợp với "khảo sát giúp tôi X rồi kết luận".
 *   `skill` — nạp vào chính agent đang chat qua `load_skill`, rồi agent ấy thi
 *             hành bằng bộ tool đầy đủ, qua hộp duyệt bình thường. Hợp với mọi
 *             quy trình phải SỬA file.
 *
 * Mặc định `agent` vì đó là hành vi của bản 0.0.27–0.0.31: một payload cũ không
 * có trường này phải cư xử y như trước.
 */
export const PROJECT_ENTRY_KINDS = ['agent', 'skill'] as const;
export type ProjectEntryKind = (typeof PROJECT_ENTRY_KINDS)[number];

export const ProjectAgentSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  kind: z.enum(PROJECT_ENTRY_KINDS).default('agent'),
  /** System prompt của agent con, hoặc thân skill. Khớp `body` phía client. */
  prompt: z.string().min(1),
});

export const ProjectStandardSchema = z.object({
  /**
   * Tăng mỗi lần PM lưu. Client không so sánh để quyết định gì — nó chỉ hiện ra
   * cho người dùng biết mình đang chạy bản nào, và đi kèm số đo để PM thấy ai
   * còn ở bản cũ.
   */
  version: z.number().int().nonnegative().default(0),
  /** Ai sửa lần cuối. Hiện nguyên văn trên UI nên coi như dữ liệu, không phải lệnh. */
  updated_by: z.string().optional(),
  updated_at: z.string().optional(),
  agents: z.array(ProjectAgentSchema).default([]),
});

export type ProjectAgent = z.infer<typeof ProjectAgentSchema>;
export type ProjectStandard = z.infer<typeof ProjectStandardSchema>;

/**
 * Chưa có chuẩn nào. Khác `DEFAULT_IDE_POLICY` ở chỗ đây là trạng thái BÌNH
 * THƯỜNG chứ không phải suy giảm: đa số dự án sẽ không khai agent nào, và
 * "không có agent chung" không phải một lỗi cần kêu lên.
 */
export const EMPTY_PROJECT_STANDARD: ProjectStandard = { version: 0, agents: [] };

/** Đường dẫn giả cho agent đến từ gateway — nó không có file trên đĩa. */
export const PROJECT_AGENT_PATH = 'astrawork://ide/agents';

/**
 * Đổi payload của gateway thành `AgentDefinition` để ghép chung với agent đọc
 * từ đĩa.
 *
 * Ba việc xảy ra ở đây và không ở đâu khác: chuẩn hoá tên (cùng hàm với file
 * .md, nếu không thì `task` gọi bằng tên nào cũng trượt), cắt theo trần ký tự,
 * và quét injection. Trùng tên trong cùng payload thì bản ĐẦU thắng — ngược với
 * catalog MCP, vì ở đây bỏ cả hai sẽ làm mất một agent mà PM tin là đang có.
 */
export function toAgentDefinitions(
  standard: ProjectStandard,
  opts: { maxChars?: number; maxAgents?: number } = {},
): AgentDefinition[] {
  const maxChars = opts.maxChars ?? AGENT_MAX_CHARS;

  return usable(standard, 'agent', opts.maxAgents).map(({ raw, name }) => ({
    name,
    description: raw.description.trim() || name,
    body: raw.prompt.trim().slice(0, maxChars),
    source: 'org' as const,
    compat: false,
    path: `${PROJECT_AGENT_PATH}#${name}`,
    scan: scanOf(raw),
  }));
}

/**
 * Phần `kind: "skill"` của cùng payload, đổi thành `Skill`.
 *
 * Khác `toAgentDefinitions` ở đúng một chỗ đáng nói: skill được nạp vào chính
 * agent đang chat và thi hành bằng bộ tool ĐẦY ĐỦ, nên trần ký tự lấy theo
 * `SKILL_MAX_CHARS` (12k) chứ không phải trần của agent con (8k) — thân skill
 * là một quy trình từng bước, không phải một lời dặn ngắn.
 *
 * `triggers` để rỗng, tức là skill của dự án LUÔN hiện trong danh mục prompt.
 * Cố ý: chuẩn của dự án không nên chỉ xuất hiện khi người dùng tình cờ gõ trúng
 * một từ khoá mà PM đoán trước.
 */
export function toSkillDefinitions(
  standard: ProjectStandard,
  opts: { maxChars?: number; maxSkills?: number } = {},
): Skill[] {
  const maxChars = opts.maxChars ?? SKILL_MAX_CHARS;

  return usable(standard, 'skill', opts.maxSkills).map(({ raw, name }) => ({
    name,
    description: raw.description.trim() || name,
    triggers: [],
    body: raw.prompt.trim().slice(0, maxChars),
    // Người dùng gõ `/tên` gọi được, và model cũng tự gọi được: đây là quy ước
    // dự án muốn cả đội dùng, giấu nó khỏi một trong hai đường là vô nghĩa.
    userInvocable: true,
    disableModelInvocation: false,
    argumentHint: '',
    source: 'org' as const,
    compat: false,
    path: `${PROJECT_AGENT_PATH}#${name}`,
    scan: scanOf(raw),
  }));
}

/**
 * Lọc, chuẩn hoá tên, bỏ mục hỏng và mục trùng — dùng chung cho cả hai loại.
 *
 * Trần đếm RIÊNG cho mỗi loại chứ không đếm chung: một dự án khai 24 skill vẫn
 * còn quyền khai agent, vì hai thứ tốn ở hai chỗ khác nhau trong prompt.
 *
 * Trùng tên thì bản ĐẦU thắng — ngược với catalog MCP, vì ở đây bỏ cả hai sẽ
 * làm mất một mục mà PM tin là đang có.
 */
function usable(
  standard: ProjectStandard,
  kind: ProjectEntryKind,
  max = MAX_PROJECT_AGENTS,
): { raw: ProjectAgent; name: string }[] {
  const out: { raw: ProjectAgent; name: string }[] = [];
  const seen = new Set<string>();

  for (const raw of standard.agents) {
    if (out.length >= max) break;
    // `?? 'agent'` không thừa dù kiểu nói `kind` luôn có mặt: zod điền mặc định
    // khi payload đi qua `parse`, còn một object dựng thẳng trong code thì không.
    // Thiếu nhánh này, một chỗ gọi như thế làm MỌI mục biến mất — im lặng, và
    // trông hệt như "dự án chưa khai gì".
    if ((raw.kind ?? 'agent') !== kind) continue;

    const name = normalizeAgentName(raw.name);
    if (!name || !raw.prompt.trim() || seen.has(name)) continue;
    seen.add(name);
    out.push({ raw, name });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Quét nội dung GỐC, không phải bản đã cắt: một chỉ thị lạ nằm sau trần ký tự
 * vẫn là dấu hiệu payload có vấn đề, kể cả khi model không đọc tới.
 */
function scanOf(raw: ProjectAgent) {
  return scanForInjection(`${raw.name}\n${raw.description}\n${raw.prompt}`);
}

// ─── Lấy chuẩn về ───────────────────────────────────────────────────────────

/** Nơi giữ bản chuẩn lấy được lần cuối. Extension dùng globalState, CLI dùng file. */
export interface ProjectStandardCache {
  read(): ProjectStandard | undefined;
  write(standard: ProjectStandard): void;
}

export interface ProjectAgentsClientOptions {
  /** Gốc gateway, KHÔNG kèm /v1. */
  baseURL: string;
  getToken: () => Promise<string>;
  cache?: ProjectStandardCache;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export class ProjectAgentsClient {
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;

  constructor(private readonly opts: ProjectAgentsClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  }

  /**
   * Chuẩn đang áp dụng cho dự án trong token.
   *
   * Gọi không được → bản cache cuối, giống `IdePolicyClient`, nhưng vì lý do
   * khác: ở kia giữ cache là để không nới quyền, ở đây là để một lần mất mạng
   * không làm biến mất bộ agent mà cả đội đang gọi giữa lúc làm việc.
   *
   * Endpoint chưa tồn tại (404) đi chung nhánh với mất mạng, cố ý: trong lúc
   * gateway đang deploy, route biến mất vài giây không phải là "PM vừa xoá hết
   * agent". Còn xoá thật thì server trả 200 với `agents: []`, và nhánh đó xoá
   * cache đúng như mong đợi.
   */
  async load(): Promise<{ standard: ProjectStandard; stale: boolean }> {
    try {
      const res = await this.fetchImpl(`${this.opts.baseURL.replace(/\/+$/, '')}/ide/agents`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${await this.opts.getToken()}`,
        },
      });
      if (!res.ok) throw new Error(`GET /ide/agents returned ${res.status}`);
      const standard = ProjectStandardSchema.parse(await res.json());
      this.opts.cache?.write(standard);
      return { standard, stale: false };
    } catch {
      const cached = this.opts.cache?.read();
      return { standard: cached ?? EMPTY_PROJECT_STANDARD, stale: true };
    }
  }
}
