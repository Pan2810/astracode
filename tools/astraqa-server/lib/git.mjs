/**
 * Clone repo của một job. Nông nhất có thể — ta chỉ cần cây file để đọc.
 *
 * Token của repo (nếu có) được nhét vào userinfo của URL, và mọi message lỗi
 * đều đi qua `redact` trước khi rời hàm này: `git` in nguyên URL vào stderr khi
 * clone hỏng, nên đây là chỗ token dễ rò nhất trong cả server.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
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

async function git(args, { cwd, timeoutMs, extraEnv = {} }) {
  return run('git', args, {
    ...(cwd ? { cwd } : {}),
    env: { ...baseEnv(), ...extraEnv },
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
}

const repoCacheLocks = new Map();

function urlWithoutCredentials(repoUrl) {
  try {
    const parsed = new URL(repoUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return repoUrl;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return repoUrl;
  }
}

/**
 * Authenticate HTTP Git without putting the credential in origin.url or
 * FETCH_HEAD. Git's config-through-environment is process-local.
 */
function cacheRemote(repoUrl, repoToken) {
  const cleanUrl = urlWithoutCredentials(repoUrl);
  try {
    const parsed = new URL(repoUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { cleanUrl, extraEnv: {} };
    }
    const username = repoToken
      ? 'x-access-token'
      : decodeURIComponent(parsed.username || '');
    const password = repoToken
      ? String(repoToken)
      : decodeURIComponent(parsed.password || '');
    if (!username && !password) return { cleanUrl, extraEnv: {} };
    const basic = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    return {
      cleanUrl,
      extraEnv: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      },
    };
  } catch {
    return { cleanUrl, extraEnv: {} };
  }
}

function cacheKey(repoUrl, cacheScope) {
  return createHash('sha256')
    .update(String(cacheScope || '').trim())
    .update('\0')
    .update(String(urlWithoutCredentials(repoUrl) || '').trim())
    .digest('hex');
}

function authFailure(err) {
  const said = String(err?.stderr || err?.message || err || '').toLowerCase();
  return [
    'authentication failed', 'could not read username', 'invalid username or password',
    'access denied', 'permission denied', 'not authorized', 'authorization failed',
    'http 401', 'http 403', 'error: 401', 'error: 403',
    'repository not found', 'project not found',
  ].some((part) => said.includes(part));
}

/** Tuần tự hoá fetch của cùng một mirror trong một tiến trình server. */
async function withCacheLock(key, operation) {
  const previous = repoCacheLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  repoCacheLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (repoCacheLocks.get(key) === current) repoCacheLocks.delete(key);
  }
}

async function cachedAt(metaFile) {
  try {
    const value = JSON.parse(await fs.readFile(metaFile, 'utf8'));
    return String(value?.updated_at || '');
  } catch {
    return '';
  }
}

async function updateMirror({ repoUrl, repoToken, cacheDir, cacheScope, redact, timeoutMs }) {
  const key = cacheKey(repoUrl, cacheScope);
  return withCacheLock(key, async () => {
    const resolvedCacheDir = path.resolve(cacheDir);
    const root = path.join(path.resolve(cacheDir), key);
    const mirror = path.join(root, 'mirror.git');
    const metaFile = path.join(root, 'source.json');
    const { cleanUrl, extraEnv } = cacheRemote(repoUrl, repoToken);
    // Mirrors can contain private source. Do not rely only on the host's
    // umask: make both the cache root and each hashed repository private.
    await fs.mkdir(resolvedCacheDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await Promise.all([
      fs.chmod(resolvedCacheDir, 0o700).catch(() => {}),
      fs.chmod(root, 0o700).catch(() => {}),
    ]);

    let hasMirror = false;
    try {
      hasMirror = (await fs.stat(path.join(mirror, 'HEAD'))).isFile();
    } catch {}

    if (!hasMirror) {
      const staging = path.join(root, `mirror-${process.pid}-${Date.now()}.tmp`);
      try {
        await git(['-c', 'credential.helper=', 'clone', '--mirror', '--quiet', cleanUrl, staging], {
          timeoutMs,
          extraEnv,
        });
        // A persistent cache must never retain the credential in origin.url.
        await git(['remote', 'set-url', 'origin', cleanUrl], { cwd: staging, timeoutMs: 30_000 });
        await fs.rename(staging, mirror);
      } catch (err) {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
        const detail = redact(err?.stderr || err?.message || String(err)).trim();
        throw new Error(`git clone thất bại: ${detail.split('\n').slice(-3).join(' ') || 'không rõ nguyên nhân'}`);
      }
      const updatedAt = new Date().toISOString();
      await fs.writeFile(metaFile, JSON.stringify({ updated_at: updatedAt }, null, 2), 'utf8');
      return { mirror, used: false, updatedAt, warning: '' };
    }

    // Keep the saved remote credential-free. Authentication is process-local
    // through Git config env, so neither origin.url nor FETCH_HEAD stores it.
    await git(['remote', 'set-url', 'origin', cleanUrl], { cwd: mirror, timeoutMs: 30_000 });
    try {
      await git(['fetch', '--prune', '--quiet', cleanUrl, '+refs/*:refs/*'], {
        cwd: mirror,
        timeoutMs,
        extraEnv,
      });
      const updatedAt = new Date().toISOString();
      await fs.writeFile(metaFile, JSON.stringify({ updated_at: updatedAt }, null, 2), 'utf8');
      return { mirror, used: false, updatedAt, warning: '' };
    } catch (err) {
      // Token/access failures are not an outage. Falling back here would let a
      // revoked credential keep reading private code forever without saying so.
      if (authFailure(err)) {
        const detail = redact(err?.stderr || err?.message || String(err)).trim();
        throw new Error(`git fetch thất bại: ${detail.split('\n').slice(-3).join(' ') || 'không rõ nguyên nhân'}`);
      }
      const updatedAt = await cachedAt(metaFile);
      return {
        mirror,
        used: true,
        updatedAt,
        warning:
          `Không truy cập được Git; đã phân tích source cache` +
          `${updatedAt ? ` lưu lúc ${updatedAt}` : ''}. Kết quả có thể không phản ánh commit mới nhất.`,
      };
    }
  });
}

async function cloneCachedRepo({ repoUrl, ref, repoToken, destDir, cacheDir, cacheScope, redact, timeoutMs }) {
  const cache = await updateMirror({ repoUrl, repoToken, cacheDir, cacheScope, redact, timeoutMs });
  try {
    // Keep tag refs in the disposable clone too: `ref` is allowed to be a tag,
    // and cloning with --no-tags before checking it out would make a cached tag
    // fail even though the mirror contains it.
    await git(['clone', '--quiet', cache.mirror, destDir], { timeoutMs });
    if (ref) await git(['checkout', '--quiet', ref], { cwd: destDir, timeoutMs });
  } catch (err) {
    const detail = redact(err?.stderr || err?.message || String(err)).trim();
    throw new Error(
      cache.used
        ? `Source cache không chứa ref "${redact(ref || 'HEAD')}": ${detail.split('\n').slice(-3).join(' ')}`
        : `git clone từ cache thất bại: ${detail.split('\n').slice(-3).join(' ') || 'không rõ nguyên nhân'}`,
    );
  }
  return cache;
}

/**
 * @returns {Promise<{head: string, sourceCache: {used: boolean, updated_at: string, warning: string}|null}>}
 * @throws Error đã che secret.
 */
export async function cloneRepo({ repoUrl, ref, repoToken, destDir, cacheDir = '', cacheScope = '', redact, timeoutMs = 300_000 }) {
  const url = urlWithToken(repoUrl, repoToken);
  const common = ['-c', 'credential.helper=', 'clone', '--no-tags', '--quiet'];
  let sourceCache = null;

  try {
    if (cacheDir) {
      const cached = await cloneCachedRepo({ repoUrl, ref, repoToken, destDir, cacheDir, cacheScope, redact, timeoutMs });
      sourceCache = {
        used: cached.used,
        updated_at: cached.updatedAt,
        warning: cached.warning,
      };
    } else if (/^[a-f0-9]{40}$/i.test(ref || '')) {
      // A pin may be older than a shallow clone's history. Fetch the complete
      // branch history and fail if this exact commit is not reachable.
      await git([...common, url, destDir], { timeoutMs });
      await git(['checkout', '--quiet', ref], { cwd: destDir, timeoutMs });
    } else if (ref) {
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
  return { head, sourceCache };
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
