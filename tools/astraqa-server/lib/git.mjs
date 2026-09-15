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
