/**
 * Skill, subagent và hooks của một lượt chat (mốc M8).
 *
 * Tách khỏi ChatController vì ba thứ này dùng chung đúng một quy tắc và quy tắc
 * đó đáng nằm ở một chỗ đọc được: **nguồn từ repo chỉ được nạp khi workspace
 * được tin cậy**. Skill là prompt do người khác viết, agent cũng vậy, còn hook
 * thì thẳng là lệnh chạy tự động. Rải điều kiện `isTrusted` ra ba chỗ trong một
 * file 1200 dòng là cách chắc chắn để một hôm nào đó thiếu mất một chỗ.
 *
 * Toàn bộ được dựng LẠI mỗi lượt: người dùng sửa SKILL.md rồi hỏi tiếp là cách
 * dùng bình thường, y như ASTRA.md ở M6.
 */
import * as vscode from 'vscode';
import * as os from 'node:os';
import {
  AgentLoop,
  HookRunner,
  SkillIndex,
  createLoadSkillTool,
  createTaskTool,
  loadAgents,
  loadHooks,
  loadSkills,
  type AgentDefinition,
  type HookApprovalStore,
  type LoadedHook,
  type Logger,
  type Provider,
  type Skill,
  type Tool,
  type ToolContext,
} from '@astra/core';
import { VsCodeFileSystem } from '../fs/VsCodeFileSystem.js';
import { isDelegationRequested } from './delegation.js';

export interface ExtrasInput {
  workspaceRoot: string;
  logger: Logger;
  /** Provider và model để chạy agent con. */
  provider: Provider;
  model: string;
  protocol: 'native' | 'xml';
  toolContext: ToolContext;
  approvals: HookApprovalStore;
  /** Hỏi người dùng duyệt nội dung một hook. */
  askHook: (hook: LoadedHook) => Promise<boolean>;
  /** Văn bản dùng để lọc skill theo `triggers`. Thường là tin nhắn vừa gõ. */
  conversation: string;
  /**
   * Agent do dự án quy định, lấy từ gateway (M10b).
   *
   * KHÔNG đi qua cổng `isTrusted` như ba nguồn trên: nó không đến từ thư mục
   * vừa mở mà từ tài khoản đã đăng nhập, nên "mở một repo lạ" không phải lý do
   * để mất nó. Đổi lại nó vẫn là prompt do người khác viết, và đã bị cắt + quét
   * ở `toAgentDefinitions`.
   */
  orgAgents?: AgentDefinition[];
  /** Skill do dự án quy định. Cùng nguồn với `orgAgents`, cùng lý do bỏ qua `isTrusted`. */
  orgSkills?: Skill[];
  /** Trần vòng lặp cho agent con. Nhỏ hơn cha có chủ ý. */
  subagentMaxIterations?: number;
}

export interface Extras {
  skills: Skill[];
  agents: AgentDefinition[];
  index: SkillIndex;
  /** Đoạn danh mục chèn vào system prompt — chỉ tên + mô tả. */
  skillCatalog: string;
  /** `load_skill` và, khi người dùng yêu cầu rõ, `task` để nhét vào registry của lượt. */
  tools: Tool[];
  hooks: HookRunner | undefined;
  /** Lý do một nguồn bị bỏ qua — hiện ra cho người dùng, không nuốt. */
  rejections: string[];
}

export async function buildExtras(input: ExtrasInput): Promise<Extras> {
  const fs = new VsCodeFileSystem();
  const home = os.homedir();
  // MỘT chỗ quyết định, dùng lại cho cả ba nguồn.
  const trusted = vscode.workspace.isTrusted;

  const [skills, agents, hookResult] = await Promise.all([
    loadSkills({
      fs,
      workspaceRoot: input.workspaceRoot,
      homeDir: home,
      allowProjectSkills: trusted,
      orgSkills: input.orgSkills ?? [],
    }),
    loadAgents({
      fs,
      workspaceRoot: input.workspaceRoot,
      homeDir: home,
      allowProjectAgents: trusted,
      orgAgents: input.orgAgents ?? [],
    }),
    loadHooks({
      fs,
      workspaceRoot: input.workspaceRoot,
      homeDir: home,
      allowProjectHooks: trusted,
    }),
  ]);

  const index = new SkillIndex({ skills });

  const tools: Tool[] = [];
  if (skills.length > 0) tools.push(createLoadSkillTool(index));

  // Agent con cố ý chỉ đọc. Không đưa `task` vào mọi lượt để model không thể
  // tự đẩy một yêu cầu fix/implement sang agent không có quyền thực hiện nó.
  if (isDelegationRequested(input.conversation, agents.map((agent) => agent.name))) {
    tools.push(
      createTaskTool({
        agents,
        logger: input.logger,
        run: async ({ systemPrompt, prompt, tools: childTools, signal }) => {
          const loop = new AgentLoop({
            provider: input.provider,
            tools: childTools,
            toolContext: input.toolContext,
            logger: input.logger.child({ subagent: true }),
            systemPrompt,
            model: input.model,
            protocol: input.protocol,
            // Trần thấp hơn cha: agent con chạy không ai xem, nên nó không được
            // phép đốt cả quota của lượt một mình.
            maxIterations: input.subagentMaxIterations ?? 12,
            // KHÔNG truyền permissions và KHÔNG truyền hooks: bộ tool của con
            // chỉ có tool đọc, nên không có gì để duyệt — và một hộp duyệt bật
            // lên giữa lượt của con là thứ người dùng không hiểu vì sao có.
          });

          const gen = loop.run(prompt, [], signal);
          let next = await gen.next();
          while (!next.done) next = await gen.next();
          const r = next.value;
          return { text: r.text, iterations: r.iterations, toolCalls: r.toolCalls };
        },
      }),
    );
  }

  const hooks =
    hookResult.hooks.length > 0
      ? new HookRunner({
          hooks: hookResult.hooks,
          logger: input.logger,
          approvals: input.approvals,
          ask: input.askHook,
          cwd: input.workspaceRoot,
        })
      : undefined;

  return {
    skills,
    agents,
    index,
    skillCatalog: index.promptSection(input.conversation),
    tools,
    hooks,
    rejections: hookResult.rejections,
  };
}

/** Nơi lưu quyết định duyệt hook — `globalState`, không phải file trong repo. */
export class VsCodeApprovalStore implements HookApprovalStore {
  private static readonly KEY = 'astra.hooks.approved';

  constructor(private readonly memento: vscode.Memento) {}

  isApproved(fingerprint: string): boolean {
    return this.list().includes(fingerprint);
  }

  async approve(fingerprint: string): Promise<void> {
    const next = [...new Set([...this.list(), fingerprint])];
    await this.memento.update(VsCodeApprovalStore.KEY, next);
  }

  /** Cho lệnh "quên mọi hook đã duyệt" — người dùng phải rút lại được. */
  async revokeAll(): Promise<void> {
    await this.memento.update(VsCodeApprovalStore.KEY, []);
  }

  private list(): string[] {
    return this.memento.get<string[]>(VsCodeApprovalStore.KEY, []);
  }
}
