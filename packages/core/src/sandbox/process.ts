/**
 * Chỗ DUY NHẤT trong core được spawn tiến trình (M5, eslint ép ở config gốc).
 *
 * Ba thứ phải làm đúng ở đây, và làm sai thì không ai phát hiện cho tới lúc
 * người dùng bực:
 *
 *   1. Giết cả CÂY tiến trình khi hết giờ. `child.kill()` chỉ giết shell, còn
 *      `npm test` nó sinh ra thì sống tiếp và giữ cổng, giữ file. Trên Windows
 *      phải nhờ `taskkill /T`.
 *   2. Không bao giờ dùng `shell: true` với chuỗi lệnh ghép sẵn. Lệnh đi vào
 *      argv của bash như MỘT đối số (`-lc <lệnh>`), không nối chuỗi.
 *   3. Đọc output theo dòng và có trần. Một lệnh in ra 500 MB không được phép
 *      làm chết extension host.
 */
import { spawn } from 'node:child_process';
import type { ExecResult, OutputChunk } from './Sandbox.js';

export interface SpawnOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /** Trần ký tự output gom lại. Vượt thì ngừng phát, tiến trình vẫn chạy tiếp. */
  maxOutputChars?: number;
}

export type ProcessStream = AsyncIterable<OutputChunk> & { result: Promise<ExecResult> };

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_OUTPUT = 200_000;

/**
 * Biến môi trường được cho đi qua — DANH SÁCH TRẮNG, không phải `...process.env`.
 *
 * Trước đây tiến trình con chỉ nhận `PATH`. Nghe thì chặt, nhưng nó làm hỏng
 * đúng thứ mà bash tool sinh ra để làm, và hỏng theo kiểu không ai lần ra:
 *
 *   powershell -NoProfile -Command "git --version"   với env chỉ có PATH
 *   → "'git' không được nhận dạng…"    kể cả khi git NẰM TRONG PATH
 *
 * Vì `PATHEXT` mới là thứ nói cho Windows biết `git` nghĩa là `git.exe`. Thiếu
 * nó thì thêm git vào PATH cũng vô ích, nên người dùng sửa PATH xong vẫn thấy
 * y nguyên lỗi cũ và kết luận là do sản phẩm.
 *
 * Danh sách này giữ nguyên chủ ý ban đầu: env của extension host chứa token,
 * đường dẫn nội bộ và biến CI, và không cái nào trong số đó có tên ở đây. Thêm
 * biến mới thì hỏi "thiếu nó thì công cụ chạy sai à?" — không phải "có nó thì
 * tiện hơn à?".
 */
function envAllowlist(platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32'
    ? [
        // Thiếu là không giải được tên chương trình. Đây là cái quan trọng nhất.
        'PATHEXT',
        // Thiếu là nhiều API Windows và chính powershell.exe hành xử lạ.
        'SystemRoot',
        'windir',
        'COMSPEC',
        // Công cụ nào cũng cần chỗ ghi file tạm.
        'TEMP',
        'TMP',
        // git đọc .gitconfig, npm/pnpm đọc config từ đây. Thiếu là chạy được
        // nhưng bằng một cấu hình khác với cấu hình người dùng đang thấy.
        'USERPROFILE',
        'HOMEDRIVE',
        'HOMEPATH',
        'APPDATA',
        'LOCALAPPDATA',
        'ProgramData',
        'ProgramFiles',
        'ProgramFiles(x86)',
        'ProgramW6432',
        'PROCESSOR_ARCHITECTURE',
        'NUMBER_OF_PROCESSORS',
      ]
    : [
        // Cùng lý do với USERPROFILE ở trên: không có HOME thì `~` vô nghĩa và
        // git chạy bằng cấu hình mặc định thay vì cấu hình của người dùng.
        'HOME',
        'USER',
        'LOGNAME',
        'SHELL',
        'TMPDIR',
        'TERM',
        // Locale quyết định encoding output. Bỏ đi là tự chọn hộ người dùng
        // một bộ ký tự khác với bộ mà terminal của họ đang dùng.
        'LANG',
        'LC_ALL',
      ];
}

/**
 * Env cho tiến trình con: `PATH` cộng danh sách trắng ở trên.
 *
 * Nhận `platform` và `source` làm tham số để test được cả hai hệ mà không phải
 * mock `node:child_process` — thứ không spy được trong ESM.
 */
export function inheritedEnv(
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = { PATH: source.PATH ?? '' };
  for (const key of envAllowlist(platform)) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Chạy `file args...` và phát output. Không có shell nào ở giữa: người gọi
 * quyết định chương trình và từng đối số.
 */
export function runProcess(file: string, args: string[], opts: SpawnOptions = {}): ProcessStream {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxOutput = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  const started = Date.now();

  const queue: OutputChunk[] = [];
  let waiter: (() => void) | undefined;
  let finished = false;
  let emitted = 0;
  let truncatedNotice = false;

  let resolveResult: (r: ExecResult) => void;
  let rejectResult: (e: unknown) => void;
  const result = new Promise<ExecResult>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  const child = spawn(file, args, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    // env KHÔNG kế thừa process.env. Đây là chủ ý: env của extension host chứa
    // token, đường dẫn nội bộ, và biến CI. Tiến trình con chỉ thấy danh sách
    // trắng ở `ENV_PASSTHROUGH` cộng những gì người gọi liệt kê.
    env: { ...inheritedEnv(), ...opts.env },
    shell: false,
    windowsHide: true,
    ...detachOption(),
  });

  const push = (stream: OutputChunk['stream'], text: string): void => {
    if (emitted >= maxOutput) {
      if (!truncatedNotice) {
        truncatedNotice = true;
        queue.push({
          stream: 'stderr',
          text: `\n… output vượt ${maxOutput} ký tự, phần sau bị bỏ qua\n`,
        });
        waiter?.();
      }
      return;
    }
    emitted += text.length;
    queue.push({ stream, text });
    waiter?.();
  };

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (d: string) => push('stdout', d));
  child.stderr?.on('data', (d: string) => push('stderr', d));

  let timedOut = false;
  let aborted = false;

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, timeoutMs)
      : undefined;

  const onAbort = (): void => {
    aborted = true;
    killTree(child.pid);
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  const settle = (exitCode: number): void => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    waiter?.();
    resolveResult({ exitCode, timedOut, aborted, durationMs: Date.now() - started });
  };

  child.on('error', (err) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    waiter?.();
    rejectResult(err);
  });

  child.on('close', (code, sig) => {
    // Bị giết vì hết giờ thì exit code là null; đừng báo 0 cho model, nó sẽ
    // tưởng lệnh chạy xong bình thường.
    settle(code ?? (sig ? 124 : 1));
  });

  const iterator: AsyncIterable<OutputChunk> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (finished) return;
        await new Promise<void>((r) => {
          waiter = r;
        });
        waiter = undefined;
      }
    },
  };

  return Object.assign(iterator, { result });
}

/**
 * `detached` cho `spawn`, theo hệ điều hành.
 *
 * Trên POSIX, `detached: true` làm tiến trình con thành TRƯỞNG NHÓM tiến trình,
 * và đó là điều kiện để `killTree` giết được cả nhóm bằng `kill(-pid)`. Không có
 * nó thì `bash -lc "sleep 999 &"` hết giờ chỉ chết cái `bash`, còn `sleep` mồ côi
 * chạy tiếp — model nhận "timeout" trong khi lệnh vẫn đang chạy.
 *
 * Không `unref()`: ta vẫn giữ tham chiếu để đọc stdout và chờ `close`. `detached`
 * ở đây chỉ để tạo nhóm, không phải để tiến trình sống sót qua tiến trình cha.
 *
 * Windows không cần: `taskkill /T` đi theo quan hệ cha-con sẵn có.
 *
 * Nhận `platform` làm tham số để test được cả hai hệ trên một máy — cùng lý do
 * như `inheritedEnv`.
 */
export function detachOption(
  platform: NodeJS.Platform = process.platform,
): { detached: true } | Record<string, never> {
  return platform === 'win32' ? {} : { detached: true };
}

/**
 * Giết cả CÂY tiến trình.
 *
 * Windows: `taskkill /T` theo quan hệ cha-con.
 * POSIX: `kill(-pid)` lên cả NHÓM tiến trình — có được nhóm là nhờ
 * `detached: true` ở `spawn` (xem `detachOption`). Bản trước gọi
 * `process.kill(pid)` lên đúng một pid rồi "để init dọn nốt", nhưng init không
 * dọn gì cả: nó chỉ nhận nuôi tiến trình mồ côi, và chúng chạy tiếp.
 *
 * Vẫn có đường lùi về `kill(pid)`: nếu `spawn` không tạo được nhóm (đã từng thấy
 * ở một số môi trường container), `kill(-pid)` ném `ESRCH`/`EPERM` — lúc đó giết
 * được tiến trình trực tiếp vẫn hơn là không giết gì.
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      /* đã cố hết sức */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
    return;
  } catch {
    /* Không có nhóm (hoặc không có quyền) — thử đúng pid ở dưới. */
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* tiến trình đã chết */
  }
}

/** Chạy tới khi xong và gom hết output. Dùng cho lệnh kiểm tra ngắn. */
export async function runToCompletion(
  file: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = runProcess(file, args, opts);
  let stdout = '';
  let stderr = '';
  for await (const chunk of proc) {
    if (chunk.stream === 'stdout') stdout += chunk.text;
    else stderr += chunk.text;
  }
  const r = await proc.result;
  return { stdout, stderr, exitCode: r.exitCode };
}
