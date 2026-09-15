/**
 * "Thư mục này có được nạp skill/command của nó không?" — bản CLI của
 * `vscode.workspace.isTrusted`.
 *
 * Vì sao cần: thân một skill là prompt tuỳ ý chạy với quyền của phiên. `git
 * clone` một repo lạ rồi gõ `astracode` trong đó KHÔNG được là đủ để
 * `.claude/skills/` của repo đó bắt đầu nói chuyện với model. Extension đã có
 * rào này sẵn từ VS Code; CLI phải tự dựng, nếu không thì "chạy trong terminal"
 * thành đường vòng qua đúng cái rào đó.
 *
 * Hỏi một lần cho mỗi thư mục, và CHỈ hỏi khi có gì đó để nạp — một lời hỏi bảo
 * mật bật lên ở nơi không có rủi ro là cách nhanh nhất dạy người dùng bấm "có"
 * mà không đọc.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Interface } from 'node:readline/promises';
import { ensureHome, trustPath } from './home.js';
import { c, out } from './ui.js';

/** Thư mục khiến một repo "có gì đó để nạp". Khớp với COMMAND_DIRS + SKILL_DIRS. */
const PROJECT_SOURCES = [
  ['.claude', 'skills'],
  ['.claude', 'commands'],
  ['.astra', 'skills'],
  ['.astra', 'commands'],
  ['.astra', 'agents'],
];

interface TrustFile {
  trusted: string[];
}

function readTrustFile(): TrustFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(trustPath(), 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as TrustFile).trusted)) {
      return { trusted: (parsed as TrustFile).trusted.filter((t) => typeof t === 'string') };
    }
  } catch {
    /* Chưa có file, hoặc file hỏng — coi như chưa tin cậy gì. */
  }
  return { trusted: [] };
}

/** So sánh không phân biệt hoa thường trên Windows, phân biệt ở nơi khác. */
function key(path: string): string {
  const abs = resolve(path);
  return sep === '\\' ? abs.toLowerCase() : abs;
}

/**
 * Đã tin cậy chưa. Thư mục con của một thư mục đã tin cậy cũng được tính —
 * người dùng tin `~/work/repo` thì họ tin cả `~/work/repo/packages/cli`.
 */
export function isTrusted(root: string): boolean {
  const target = key(root);
  return readTrustFile().trusted.some((t) => {
    const trusted = key(t);
    return target === trusted || target.startsWith(trusted + sep);
  });
}

export function trustRoot(root: string): void {
  const file = readTrustFile();
  const next = [...new Set([...file.trusted, resolve(root)])];
  try {
    ensureHome();
    writeFileSync(trustPath(), JSON.stringify({ trusted: next }, null, 2) + '\n', 'utf8');
  } catch {
    // Ghi hỏng thì phiên này vẫn chạy với quyết định vừa rồi, chỉ là lần sau
    // phải hỏi lại. Hỏi lại là hướng an toàn, nên không cần làm ầm lên.
  }
}

/** Repo này có thư mục skill/command nào để mà nạp không. */
export function hasProjectSources(root: string): boolean {
  return PROJECT_SOURCES.some((parts) => existsSync(join(root, ...parts)));
}

/**
 * Trả về: thư mục này có được để agent SỬA FILE trong đó không.
 *
 * Vì sao tách khỏi `ensureProjectTrust`: hàm kia cố ý chỉ hỏi khi repo CÓ thư
 * mục skill/command để nạp, nên nó trả `false` cho một repo bình thường — dùng
 * nó làm cổng ghi thì mọi repo không có `.claude/` đều thành chỉ đọc.
 *
 * Vì sao cần cổng này: [OPEN-ISSUES #2] `canWrite = mode !== 'plan'` không hỏi
 * gì về mức tin cậy, trong khi bên VS Code chặn cứng bằng `workspace.isTrusted`.
 * `git clone` một repo lạ rồi chạy `astracode --mode=acceptEdits` trong đó là
 * agent ghi file ngay. Hai bề mặt dùng chung một lõi mà mức bảo vệ khác nhau là
 * loại lệch khó phát hiện nhất.
 *
 * Quyết định lưu CHUNG một chỗ với `ensureProjectTrust`: người dùng chỉ trả lời
 * một lần cho một thư mục, đúng như hộp workspace trust của VS Code hỏi một lần
 * cho cả hai việc.
 *
 * Không có terminal tương tác thì luôn là KHÔNG (trừ khi đã tin cậy từ trước).
 * Tự duyệt khi không ai ngồi xem là bỏ hẳn cổng.
 */
export async function ensureWorkspaceTrust(root: string, rl?: Interface): Promise<boolean> {
  if (isTrusted(root)) return true;
  if (!rl) return false;

  out('');
  out(c.yellow('  ┌ Thư mục này chưa được đánh dấu tin cậy.'));
  out(c.yellow('  │ Agent sẽ được phép TẠO và SỬA file trong đó.'));
  out(c.yellow('  │ Chỉ đồng ý nếu bạn tin nội dung repo này.'));
  out(c.yellow(`  └ ${root}`));

  for (;;) {
    const answer = (
      await rl.question(
        `  Cho agent sửa file trong thư mục này? [${c.green('y')}] có  [${c.red('n')}] chỉ đọc > `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'y') {
      trustRoot(root);
      out(c.dim('  Đã ghi nhớ. Rút lại bằng cách xoá ~/.astra/trust.json.'));
      return true;
    }
    // Mặc định là KHÔNG, y như `ensureProjectTrust`: Enter cho qua phải rơi về
    // phía an toàn.
    if (answer === 'n' || answer === '') return false;
    out(c.dim('  Trả lời y hoặc n.'));
  }
}

/**
 * Trả về: thư mục này có được nạp nguồn của repo không.
 *
 * Không có terminal tương tác thì luôn là KHÔNG. Tự duyệt khi không ai ngồi
 * xem là bỏ hẳn cổng, đúng nguyên tắc đã áp cho hộp duyệt quyền ở `ask.ts`.
 */
export async function ensureProjectTrust(root: string, rl?: Interface): Promise<boolean> {
  if (!hasProjectSources(root)) return false;
  if (isTrusted(root)) return true;
  if (!rl) return false;

  const found = PROJECT_SOURCES.filter((parts) => existsSync(join(root, ...parts))).map((parts) =>
    parts.join('/'),
  );

  out('');
  out(c.yellow(`  ┌ Thư mục này có nguồn của riêng nó: ${found.join(', ')}`));
  out(c.yellow('  │ Skill, command và agent là PROMPT sẽ chạy với quyền của phiên này.'));
  out(c.yellow('  │ Chỉ đồng ý nếu bạn tin nội dung repo.'));
  out(c.yellow(`  └ ${root}`));

  for (;;) {
    const answer = (
      await rl.question(`  Nạp nguồn của thư mục này? [${c.green('y')}] có  [${c.red('n')}] không > `)
    )
      .trim()
      .toLowerCase();
    if (answer === 'y') {
      trustRoot(root);
      out(c.dim('  Đã ghi nhớ. Rút lại bằng cách xoá ~/.astra/trust.json.'));
      return true;
    }
    // Mặc định là KHÔNG: nhấn Enter cho qua phải rơi về phía an toàn.
    if (answer === 'n' || answer === '') return false;
    out(c.dim('  Trả lời y hoặc n.'));
  }
}
