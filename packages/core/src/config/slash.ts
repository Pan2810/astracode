/**
 * Một danh sách `/` duy nhất, dựng từ ba nguồn.
 *
 * Với người dùng, "gõ gạch chéo" là MỘT thao tác — họ không phân biệt cái nào
 * là lệnh dựng sẵn, cái nào là file `.md` trong repo, cái nào là skill. Nên chỗ
 * quyết định "gõ `/x` thì cái gì chạy" phải là một hàm, không phải hai bản sao
 * ở CLI và extension. Hai bản sao là cách chắc chắn để `/speckit-plan` chạy
 * trong VS Code nhưng im lặng trong terminal.
 *
 * Thứ tự ưu tiên khi trùng tên: **builtin > command > skill**. Builtin đứng đầu
 * vì `/clear` phải luôn là `/clear`: một repo lạ không được cướp lệnh thoát
 * hiểm của người dùng bằng cách đặt một file cùng tên.
 */
import { substituteArgs, type CommandSource, type SlashCommand } from './commands.js';
import type { Skill, SkillSource } from '../skills/skills.js';

export type SlashKind = 'builtin' | 'command' | 'skill';

export interface SlashEntry {
  name: string;
  description: string;
  /** Gợi ý đối số, hiện mờ sau tên. Rỗng nếu không khai. */
  argumentHint: string;
  kind: SlashKind;
  source?: CommandSource | SkillSource;
  /** Đến từ thư mục `.claude/` (tương thích Claude Code). */
  compat?: boolean;
  /** Nội dung nguồn bị quét injection đánh dấu khả nghi. */
  suspicious?: boolean;
}

export interface BuiltinCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

export interface SlashInputs {
  builtins?: readonly BuiltinCommand[];
  commands?: readonly SlashCommand[];
  skills?: readonly Skill[];
}

/**
 * Danh sách hiện trong ô gợi ý.
 *
 * Skill khai `user-invocable: false` bị loại ở đây chứ không phải lúc chạy:
 * hiện một mục rồi báo lỗi khi chọn thì tệ hơn là không hiện.
 */
export function buildSlashEntries(inputs: SlashInputs): SlashEntry[] {
  const byName = new Map<string, SlashEntry>();

  for (const skill of inputs.skills ?? []) {
    if (!skill.userInvocable) continue;
    byName.set(skill.name, {
      name: skill.name,
      description: skill.description,
      argumentHint: skill.argumentHint,
      kind: 'skill',
      source: skill.source,
      compat: skill.compat,
      suspicious: skill.scan.suspicious,
    });
  }

  for (const command of inputs.commands ?? []) {
    byName.set(command.name, {
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
      kind: 'command',
      source: command.source,
      compat: command.compat,
      suspicious: command.scan.suspicious,
    });
  }

  for (const builtin of inputs.builtins ?? []) {
    byName.set(builtin.name, {
      name: builtin.name,
      description: builtin.description,
      argumentHint: builtin.argumentHint ?? '',
      kind: 'builtin',
    });
  }

  return [...byName.values()].sort((a, b) => {
    // Builtin lên đầu: đó là thứ dùng nhiều nhất và là thứ luôn có mặt.
    if (a.kind !== b.kind) {
      if (a.kind === 'builtin') return -1;
      if (b.kind === 'builtin') return 1;
    }
    return a.name.localeCompare(b.name);
  });
}

export type SlashTarget =
  | { kind: 'builtin'; name: string }
  | { kind: 'command'; command: SlashCommand }
  | { kind: 'skill'; skill: Skill }
  /** Có tồn tại nhưng khai `user-invocable: false` — nói rõ thay vì "không có". */
  | { kind: 'not-user-invocable'; name: string };

/** Cùng thứ tự ưu tiên với `buildSlashEntries`. */
export function resolveSlash(name: string, inputs: SlashInputs): SlashTarget | undefined {
  const n = name.trim().toLowerCase();

  if ((inputs.builtins ?? []).some((b) => b.name === n)) return { kind: 'builtin', name: n };

  const command = (inputs.commands ?? []).find((c) => c.name === n);
  if (command) return { kind: 'command', command };

  const skill = (inputs.skills ?? []).find((s) => s.name === n);
  if (skill) {
    return skill.userInvocable
      ? { kind: 'skill', skill }
      : { kind: 'not-user-invocable', name: n };
  }
  return undefined;
}

/** Thân prompt có chỗ nhận đối số hay không. */
export function hasArgPlaceholder(body: string): boolean {
  return /\$(ARGUMENTS|[1-9])\b/.test(body);
}

/**
 * Tin nhắn gửi cho model khi người dùng gõ `/tên-skill`.
 *
 * Thân skill đi vào hội thoại ở vai `user` bọc delimiter, KHÔNG vào system
 * prompt — người dùng chủ động gọi nó không làm nó tin cậy hơn, vì thứ họ tin
 * là công việc, không phải từng dòng trong file.
 *
 * Đối số đi đâu là có chủ ý: skill khai `$ARGUMENTS` thì thay vào đúng chỗ nó
 * chừa ra (spec-kit dựa hoàn toàn vào cơ chế này). Skill không khai thì phần
 * người dùng gõ được để NGOÀI khối untrusted — đó là lời của người dùng, không
 * phải nội dung file, và nó không nên bị hạ mức tin cậy chỉ vì đi kèm.
 */
export function renderSkillInvocation(skill: Skill, args: string): string {
  const trimmed = args.trim();
  const templated = hasArgPlaceholder(skill.body);
  const body = templated ? substituteArgs(skill.body, trimmed) : skill.body;

  return (
    `Làm theo hướng dẫn của skill "${skill.name}" dưới đây.\n\n` +
    `<skill_instructions untrusted="true" name="${skill.name}">\n` +
    `${body}\n</skill_instructions>` +
    (!templated && trimmed ? `\n\nViệc cần làm: ${trimmed}` : '')
  );
}
