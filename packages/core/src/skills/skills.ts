/**
 * Skill — hướng dẫn model tự nạp khi cần (mốc M8).
 *
 * Khác slash command (M6) ở chỗ AI quyết định: command do người dùng gõ, skill
 * do MODEL chọn nạp. Vì model chọn nên phải giải quyết được hai vấn đề mà
 * command không có:
 *
 *   1. **Ngân sách ngữ cảnh.** Nhét toàn văn 20 skill vào system prompt là vài
 *      chục nghìn token trước khi người dùng gõ chữ nào. Nên khởi động chỉ đưa
 *      `name + description` (~15 token/skill), model gọi `load_skill(name)` mới
 *      nạp thân đầy đủ. Đó là "progressive disclosure".
 *
 *   2. **Model yếu không tự nhận ra cần skill.** Nên có hai đường thoát tất
 *      định, không phụ thuộc phán đoán của model: lọc trước bằng `triggers`
 *      (từ khoá xuất hiện trong hội thoại) và gọi tay `/tên-skill`.
 *
 * Bảo mật: skill từ repo là NỘI DUNG KHÔNG TIN CẬY, y hệt ASTRA.md. Nó chỉ
 * được nạp khi workspace trusted, bị cắt theo trần ký tự, bị quét injection
 * trên BẢN GỐC, và thân skill đi vào hội thoại ở vai `user` bọc delimiter chứ
 * không bao giờ vào `system`.
 */
import type { FileSystem } from '../fs/FileSystem.js';
import { scanForInjection, type InjectionScanResult } from '../security/injectionScan.js';

/** Trần ký tự thân một skill. Dài hơn thì nó nên là tài liệu, không phải skill. */
export const SKILL_MAX_CHARS = 12_000;

/**
 * Nguồn skill, xếp theo mức tin cậy giảm dần.
 *
 * `org` = chuẩn của dự án, đến từ gateway AstraWork (xem
 * `policy/ProjectAgents.ts`). Không có file trên đĩa nên `path` là URI giả.
 */
export type SkillSource = 'user' | 'project' | 'org';

/** Thư mục được quét, theo thứ tự ưu tiên tăng dần (sau ghi đè trước). */
export const SKILL_DIRS: { parts: string[]; source: SkillSource; compat: boolean }[] = [
  // Tương thích ngược: skill viết cho Claude Code chạy được ngay, không sửa gì
  // (ADR-008). Đặt TRƯỚC bản .astra để khi trùng tên thì bản
  // của AstraCode thắng — người dùng đã chủ động viết bản riêng thì họ muốn nó.
  { parts: ['.claude', 'skills'], source: 'project', compat: true },
  { parts: ['.astra', 'skills'], source: 'project', compat: false },
];

export interface Skill {
  name: string;
  /** Viết theo dạng "dùng khi nào", không phải "cái này là gì". */
  description: string;
  /** Từ khoá lọc trước. Rỗng = luôn hiện trong danh sách. */
  triggers: string[];
  /** Thân đầy đủ — CHỈ nạp khi model gọi load_skill hoặc người dùng gõ /tên. */
  body: string;
  /**
   * Hiện trong ô gợi ý `/` để người dùng gọi tay. Mặc định TRUE.
   *
   * Mặc định ngược với `disableModelInvocation` là có lý do: một skill nằm sẵn
   * trên máy người dùng thì họ gọi được: đó là thứ họ tự đặt vào đó. Cái cần
   * khai báo rõ ràng là chiều còn lại — chiều model tự quyết.
   */
  userInvocable: boolean;
  /** Cấm model tự gọi. Mặc định false. Skill bị cấm không vào danh mục prompt. */
  disableModelInvocation: boolean;
  /** Gợi ý đối số hiện mờ cạnh tên trong ô gợi ý. */
  argumentHint: string;
  source: SkillSource;
  /** `.claude/skills/` thay vì `.astra/skills/`. */
  compat: boolean;
  path: string;
  scan: InjectionScanResult;
}

export interface LoadSkillsOptions {
  fs: FileSystem;
  workspaceRoot?: string;
  homeDir?: string;
  /**
   * Nạp skill từ repo. Mặc định FALSE — thân skill là prompt tuỳ ý chạy với
   * quyền của phiên, nên repo lạ không được cấp đường đó chỉ vì được mở lên.
   */
  allowProjectSkills?: boolean;
  maxChars?: number;
  /** Trần số skill. Nhiều hơn thì phần mô tả trong prompt bắt đầu tốn thật. */
  maxSkills?: number;
  /**
   * Skill do dự án quy định, đã lấy về từ gateway.
   *
   * Áp SAU CÙNG nên trùng tên là nó thắng — cùng quy tắc với `orgAgents` trong
   * `loadAgents`, và cùng lý do: một cái chuẩn mà mỗi máy ghi đè được một kiểu
   * thì không còn là chuẩn.
   */
  orgSkills?: Skill[];
}

export async function loadSkills(opts: LoadSkillsOptions): Promise<Skill[]> {
  const maxChars = opts.maxChars ?? SKILL_MAX_CHARS;
  const found = new Map<string, Skill>();

  // Project trước, user sau: trùng tên thì bản của người dùng ghi đè bản repo.
  if (opts.workspaceRoot && opts.allowProjectSkills) {
    for (const dir of SKILL_DIRS) {
      for (const s of await readSkillDir(
        opts.fs,
        join(opts.workspaceRoot, ...dir.parts),
        'project',
        dir.compat,
        maxChars,
      )) {
        found.set(s.name, s);
      }
    }
  }

  if (opts.homeDir) {
    for (const dir of SKILL_DIRS) {
      for (const s of await readSkillDir(
        opts.fs,
        join(opts.homeDir, ...dir.parts),
        'user',
        dir.compat,
        maxChars,
      )) {
        found.set(s.name, s);
      }
    }
  }

  // Sau cùng: chuẩn của dự án thắng khi trùng tên. Xem `LoadSkillsOptions`.
  for (const s of opts.orgSkills ?? []) found.set(s.name, s);

  return [...found.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, opts.maxSkills ?? 60);
}

async function readSkillDir(
  fs: FileSystem,
  dir: string,
  source: SkillSource,
  compat: boolean,
  maxChars: number,
): Promise<Skill[]> {
  let entries;
  try {
    if (!(await fs.exists(dir))) return [];
    entries = await fs.readDir(dir);
  } catch {
    return [];
  }

  const out: Skill[] = [];
  for (const entry of entries) {
    // Mỗi skill là MỘT THƯ MỤC chứa SKILL.md — đó là định dạng của Claude Code
    // và cũng là thứ cho phép skill mang theo file phụ sau này.
    if (entry.type !== 'directory') continue;

    const path = join(dir, entry.name, 'SKILL.md');
    let raw: string;
    try {
      if (!(await fs.exists(path))) continue;
      raw = await fs.readFile(path);
    } catch {
      continue;
    }

    const parsed = parseSkillFile(raw, entry.name);
    if (!parsed) continue;

    out.push({
      ...parsed,
      body: parsed.body.slice(0, maxChars),
      source,
      compat,
      path,
      // Quét trên BẢN GỐC, không phải bản đã cắt: quét sau khi cắt thì phần bị
      // cắt thành điểm mù (cùng lý do với ASTRA.md ở M6).
      scan: scanForInjection(raw),
    });
  }
  return out;
}

export interface ParsedSkill {
  name: string;
  description: string;
  triggers: string[];
  userInvocable: boolean;
  disableModelInvocation: boolean;
  argumentHint: string;
  body: string;
}

/**
 * Frontmatter tối giản, cùng khuôn với command (M6): `key: value` một cấp.
 *
 * Khoá lồng nhau (`metadata:` của spec-kit) bị bỏ qua chứ không làm hỏng cả
 * file: dòng con thụt lề không khớp regex nên rơi ra ngoài, và đó là hành vi
 * đúng — ta chỉ cần sáu trường phẳng, không cần một parser YAML đầy đủ với
 * anchor và merge key.
 */
export function parseSkillFile(raw: string, fallbackName: string): ParsedSkill | undefined {
  let name = fallbackName;
  let description = '';
  let triggers: string[] = [];
  let argumentHint = '';
  let userInvocable = true;
  let disableModelInvocation = false;
  let body = raw;

  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (match) {
    body = raw.slice(match[0].length);
    for (const line of match[1]!.split(/\r?\n/)) {
      // Chỉ nhận dòng KHÔNG thụt lề: dòng thụt lề là con của một khoá lồng
      // (`metadata:`), và `author: ...` bên trong nó không phải khoá cấp một.
      if (/^\s/.test(line)) continue;
      const kv = /^([a-zA-Z_-]+)\s*:\s*(.*)$/.exec(line.trim());
      if (!kv) continue;
      const key = kv[1]!.toLowerCase();
      const value = kv[2]!.trim().replace(/^["']|["']$/g, '');
      if (key === 'name' && value) name = value;
      else if (key === 'description') description = value;
      else if (key === 'triggers' || key === 'keywords') triggers = parseList(value);
      else if (key === 'argument-hint' || key === 'argument_hint') argumentHint = value;
      else if (key === 'user-invocable' || key === 'user_invocable') {
        userInvocable = value.toLowerCase() !== 'false';
      } else if (key === 'disable-model-invocation' || key === 'disable_model_invocation') {
        disableModelInvocation = value.toLowerCase() === 'true';
      }
    }
  }

  const normalized = normalizeName(name);
  if (!normalized || !body.trim()) return undefined;

  return {
    name: normalized,
    description: description || firstLine(body),
    triggers,
    userInvocable,
    disableModelInvocation,
    argumentHint,
    body: body.trim(),
  };
}

/** `[a, b]` hoặc `a, b` — cả hai đều gặp trong skill viết cho Claude Code. */
function parseList(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, '').toLowerCase())
    .filter(Boolean)
    .slice(0, 20);
}

/** Cùng luật với tên command — xem `normalizeName` ở config/commands.ts. */
function normalizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
}

function firstLine(body: string): string {
  const line = body.trim().split(/\r?\n/)[0] ?? '';
  return line.replace(/^#+\s*/, '').slice(0, 120);
}

function join(root: string, ...parts: string[]): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  return [base, ...parts].join(sep);
}
