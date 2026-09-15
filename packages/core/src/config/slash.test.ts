import { describe, expect, it } from 'vitest';
import { buildSlashEntries, renderSkillInvocation, resolveSlash } from './slash.js';
import type { SlashCommand } from './commands.js';
import type { Skill } from '../skills/skills.js';

const clean = { suspicious: false, score: 0, findings: [] };

const command = (name: string, over: Partial<SlashCommand> = {}): SlashCommand => ({
  name,
  description: `mô tả ${name}`,
  argumentHint: '',
  body: `thân ${name}`,
  source: 'user',
  compat: false,
  path: `${name}.md`,
  scan: clean,
  ...over,
});

const skill = (name: string, over: Partial<Skill> = {}): Skill => ({
  name,
  description: `mô tả ${name}`,
  triggers: [],
  body: `thân ${name}`,
  userInvocable: true,
  disableModelInvocation: false,
  argumentHint: '',
  source: 'project',
  compat: true,
  path: `${name}/SKILL.md`,
  scan: clean,
  ...over,
});

const BUILTINS = [{ name: 'clear', description: 'xoá' }];

describe('buildSlashEntries', () => {
  it('gộp builtin, command và skill vào một danh sách', () => {
    const entries = buildSlashEntries({
      builtins: BUILTINS,
      commands: [command('deploy')],
      skills: [skill('speckit-plan')],
    });
    expect(entries.map((e) => e.name)).toEqual(['clear', 'deploy', 'speckit-plan']);
    expect(entries.map((e) => e.kind)).toEqual(['builtin', 'command', 'skill']);
  });

  it('builtin đứng đầu dù xếp chữ cái đứng sau', () => {
    const entries = buildSlashEntries({
      builtins: [{ name: 'zzz', description: '' }],
      commands: [command('aaa')],
    });
    expect(entries[0]!.name).toBe('zzz');
  });

  /** Một repo lạ không được cướp lệnh thoát hiểm của người dùng. */
  it('trùng tên thì builtin thắng command, command thắng skill', () => {
    const entries = buildSlashEntries({
      builtins: BUILTINS,
      commands: [command('clear'), command('plan')],
      skills: [skill('clear'), skill('plan')],
    });
    expect(entries.find((e) => e.name === 'clear')!.kind).toBe('builtin');
    expect(entries.find((e) => e.name === 'plan')!.kind).toBe('command');
  });

  it('skill khai user-invocable: false không hiện trong ô gợi ý', () => {
    const entries = buildSlashEntries({ skills: [skill('an', { userInvocable: false })] });
    expect(entries).toEqual([]);
  });

  it('mang theo argument-hint và cờ khả nghi để UI hiện', () => {
    const entries = buildSlashEntries({
      skills: [
        skill('plan', { argumentHint: 'định hướng', scan: { ...clean, suspicious: true } }),
      ],
    });
    expect(entries[0]).toMatchObject({ argumentHint: 'định hướng', suspicious: true });
  });
});

describe('resolveSlash', () => {
  const sources = {
    builtins: BUILTINS,
    commands: [command('deploy')],
    skills: [skill('speckit-plan'), skill('noi-bo', { userInvocable: false })],
  };

  it('tìm được builtin, command và skill', () => {
    expect(resolveSlash('clear', sources)).toEqual({ kind: 'builtin', name: 'clear' });
    expect(resolveSlash('deploy', sources)!.kind).toBe('command');
    expect(resolveSlash('speckit-plan', sources)!.kind).toBe('skill');
  });

  it('không có thì trả undefined', () => {
    expect(resolveSlash('khong-co', sources)).toBeUndefined();
  });

  /** "Không gọi tay được" khác hẳn "không tồn tại" — nói đúng cái nào là cái nào. */
  it('phân biệt skill cấm gọi tay với skill không tồn tại', () => {
    expect(resolveSlash('noi-bo', sources)).toEqual({ kind: 'not-user-invocable', name: 'noi-bo' });
  });

  it('không phân biệt hoa thường', () => {
    expect(resolveSlash('DePloy', sources)!.kind).toBe('command');
  });
});

describe('renderSkillInvocation', () => {
  it('bọc thân skill trong khối untrusted', () => {
    const text = renderSkillInvocation(skill('plan'), '');
    expect(text).toContain('<skill_instructions untrusted="true" name="plan">');
    expect(text).toContain('thân plan');
    expect(text).toContain('</skill_instructions>');
  });

  /** Đây là thứ spec-kit dựa hoàn toàn vào: SKILL.md của nó có khối $ARGUMENTS. */
  it('thay $ARGUMENTS bằng phần người dùng gõ', () => {
    const s = skill('plan', { body: 'Input:\n```text\n$ARGUMENTS\n```\nLàm đi.' });
    const text = renderSkillInvocation(s, 'dùng Postgres');
    expect(text).toContain('dùng Postgres');
    expect(text).not.toContain('$ARGUMENTS');
  });

  /**
   * Skill không chừa chỗ thì lời của người dùng phải nằm NGOÀI khối untrusted:
   * đó là chỉ thị thật, không phải nội dung file.
   */
  it('skill không có placeholder thì đối số nằm ngoài khối untrusted', () => {
    const text = renderSkillInvocation(skill('plan'), 'làm nhanh');
    expect(text.indexOf('</skill_instructions>')).toBeLessThan(text.indexOf('làm nhanh'));
    expect(text).toContain('Việc cần làm: làm nhanh');
  });

  it('không có đối số thì không thêm dòng thừa', () => {
    expect(renderSkillInvocation(skill('plan'), '   ')).not.toContain('Việc cần làm');
  });
});
