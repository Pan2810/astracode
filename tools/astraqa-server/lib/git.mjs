/**
 * Clone repo của một job. Nông nhất có thể — ta chỉ cần cây file để đọc.
 *
 * Token của repo (nếu có) được nhét vào userinfo của URL, và mọi message lỗi
 * đều đi qua `redact` trước khi rời hàm này: `git` in nguyên URL vào stderr khi
 * clone hỏng, nên đây là chỗ token dễ rò nhất trong cả server.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

function baseEnv() {
  // Không kế thừa cả process.env: chỉ những biến OS cần để `git` chạy được.
  const pass = [
    'PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'COMSPEC', 'ComSpec',
    'PATHEXT', 'LANG', 'LC_ALL',
  ];
  const env = {};
  for (const k of pass) if (process.env[k] !== undefined) env[k] = process.env[k];
  // Không bao giờ để git bật hộp thoại/nhắc nhập mật khẩu: server không có ai ngồi trả lời.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = '';
  env.GCM_INTERACTIVE = 'never';
  return env;
}

export function urlWithToken(repoUrl, repoToken) {
  if (!repoToken) return repoUrl;
  try {
    const u = new URL(repoUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return repoUrl;
    u.username = 'x-access-token';
    u.password = repoToken;
    return u.toString();
  } catch {
    return repoUrl;
  }
}

async function git(args, { cwd, timeoutMs }) {
  return run('git', args, {
    ...(cwd ? { cwd } : {}),
    env: baseEnv(),
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
}

/**
 * @returns {Promise<{head: string}>}
 * @throws Error đã che secret.
 */
export async function cloneRepo({ repoUrl, ref, repoToken, destDir, redact, timeoutMs = 300_000 }) {
  const url = urlWithToken(repoUrl, repoToken);
  const common = ['-c', 'credential.helper=', 'clone', '--no-tags', '--quiet'];

  try {
    if (ref) {
      try {
        // Nhánh/tag: một lần fetch nông là đủ.
        await git([...common, '--depth', '1', '--single-branch', '--branch', ref, url, destDir], { timeoutMs });
      } catch {
        // `ref` có thể là commit sha — nó không đi được với `--branch`.
        await git([...common, '--depth', '50', url, destDir], { timeoutMs });
        await git(['checkout', '--quiet', ref], { cwd: destDir, timeoutMs });
      }
    } else {
      await git([...common, '--depth', '1', '--single-branch', url, destDir], { timeoutMs });
    }
  } catch (err) {
    const detail = redact(err?.stderr || err?.message || String(err)).trim();
    throw new Error(`git clone thất bại: ${detail.split('\n').slice(-3).join(' ') || 'không rõ nguyên nhân'}`);
  }

  let head = '';
  try {
    const { stdout } = await git(['rev-parse', 'HEAD'], { cwd: destDir, timeoutMs: 30_000 });
    head = stdout.trim();
  } catch {
    // Không có HEAD cũng không chặn phân tích — chỉ mất một dòng trong report.
  }
  return { head };
}

/** Commit có mặt trong bản clone chưa? Trả sha đầy đủ, hoặc `null`. */
async function shaOf(repoDir, rev, timeoutMs) {
  try {
    const { stdout } = await git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
      cwd: repoDir,
      timeoutMs,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * `base..HEAD` đã đổi những tệp nào.
 *
 * ## Vì sao phải đào thêm
 *
 * Bản clone là `--depth 1`: nó chỉ có đúng một commit, nên `base` gần như chắc
 * chắn chưa có mặt. Bốn cách lấy về, thử theo đúng thứ tự từ rẻ tới đắt, và
 * kiểm lại sau mỗi lần — dừng ngay khi đủ, để một repo lớn không bị kéo cả lịch
 * sử về chỉ vì `base` cách HEAD ba commit:
 *
 *   1. đã có sẵn (bên gọi đưa `ref` đủ sâu, hoặc base chính là HEAD)
 *   2. `fetch origin <base>` — rẻ nhất, nhưng chỉ chạy khi remote cho phép xin
 *      thẳng một sha (`uploadpack.allowReachableSHA1InWant`)
 *   3. `fetch --deepen` 100 rồi 500 — base là tổ tiên của nhánh đang clone
 *   4. `fetch --unshallow` — đắt nhất, và cũng là lần thử cuối
 *
 * ## Không tìm thấy KHÔNG phải lỗi
 *
 * `base_revision` là thứ bên gọi nhớ từ lần chạy trước; nó có thể đã bị
 * force-push đè, có thể thuộc một fork, có thể là một sha gõ nhầm. Ðánh hỏng cả
 * job vì chuyện ấy là vứt đi 184 lượt phân tích đã chạy xong để đổi lấy một
 * danh sách tệp phụ trợ. Trả `files: null` kèm một câu cảnh báo, và để bên gọi
 * tự quyết.
 *
 * @returns {Promise<{base: string|null, files: string[]|null, warning: string|null}>}
 */
export async function diffSinceBase({ repoDir, base, redact = (s) => s, timeoutMs = 300_000, log = () => {} }) {
  const wanted = String(base ?? '').trim();
  if (!wanted) return { base: null, files: null, warning: null };

  let sha = await shaOf(repoDir, wanted, 30_000);
  const attempts = [
    { why: `fetch thẳng ${wanted}`, args: ['fetch', '--no-tags', '--quiet', 'origin', wanted] },
    { why: 'deepen 100', args: ['fetch', '--no-tags', '--quiet', '--deepen', '100', 'origin'] },
    { why: 'deepen 500', args: ['fetch', '--no-tags', '--quiet', '--deepen', '500', 'origin'] },
    { why: 'unshallow', args: ['fetch', '--no-tags', '--quiet', '--unshallow', 'origin'] },
  ];
  for (const attempt of attempts) {
    if (sha) break;
    try {
      await git(attempt.args, { cwd: repoDir, timeoutMs });
    } catch (err) {
      // Mỗi cách đều có lý do chính đáng để hỏng (remote không cho xin sha,
      // repo không phải shallow…). Ghi lại rồi thử cách sau.
      log(`base_revision: ${attempt.why} không được — ${redact(err?.stderr || err?.message || String(err)).trim().split('\n').slice(-1)[0]}`);
      continue;
    }
    sha = await shaOf(repoDir, wanted, 30_000);
    if (sha) log(`base_revision: lấy được ${wanted} bằng ${attempt.why}`);
  }

  if (!sha) {
    return {
      base: null,
      files: null,
      warning:
        `base_revision "${wanted}" không có trong bản clone và không fetch về được ` +
        `(đã thử: ${attempts.map((a) => a.why).join(', ')}) — changed_files là null.`,
    };
  }

  try {
    const { stdout } = await git(['diff', '--name-only', `${sha}..HEAD`], { cwd: repoDir, timeoutMs });
    const files = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    return { base: sha, files, warning: null };
  } catch (err) {
    const detail = redact(err?.stderr || err?.message || String(err)).trim().split('\n').slice(-1)[0];
    return { base: sha, files: null, warning: `git diff ${wanted}..HEAD hỏng: ${detail} — changed_files là null.` };
  }
}
