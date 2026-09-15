/**
 * Tiến trình con hai chiều — dùng cho transport stdio của MCP (mốc M7).
 *
 * Nằm trong core/sandbox/ vì đây là thư mục DUY NHẤT được spawn tiến trình
 * (eslint ép, xem eslint.config.js). `process.ts` bên cạnh chỉ chạy lệnh rồi
 * đọc output; MCP thì cần giữ tiến trình sống và viết vào stdin của nó, nên
 * tách riêng thay vì nhồi thêm cờ vào runProcess — hai vòng đời khác nhau.
 *
 * Giống process.ts ở hai điểm không được phép khác: env KHÔNG kế thừa từ
 * extension host, và giết thì giết cả cây tiến trình.
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface StdioSpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Trần ký tự stderr giữ lại. Chỉ để chẩn đoán, không đưa cho model. */
  maxStderrChars?: number;
}

export interface StdioProcess {
  /** Ghi vào stdin. Ném nếu tiến trình đã chết. */
  write(data: string): void;
  onStdout(cb: (chunk: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  /** Gọi đúng một lần, khi tiến trình kết thúc hoặc không khởi chạy được. */
  onExit(cb: (info: { code: number; reason?: string }) => void): void;
  /** Đóng stdin rồi giết cây tiến trình nếu nó không tự thoát. */
  kill(graceMs?: number): Promise<void>;
  pid: number | undefined;
}

export function spawnStdio(
  file: string,
  args: string[],
  opts: StdioSpawnOptions = {},
): StdioProcess {
  const child: ChildProcess = spawn(file, args, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: { PATH: process.env.PATH ?? '', ...opts.env },
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  const stdoutCbs: ((c: string) => void)[] = [];
  const stderrCbs: ((c: string) => void)[] = [];
  const exitCbs: ((i: { code: number; reason?: string }) => void)[] = [];
  let exited = false;

  child.stdout?.on('data', (d: string) => {
    for (const cb of stdoutCbs) cb(d);
  });
  child.stderr?.on('data', (d: string) => {
    for (const cb of stderrCbs) cb(d);
  });

  const fireExit = (code: number, reason?: string): void => {
    if (exited) return;
    exited = true;
    for (const cb of exitCbs) cb(reason === undefined ? { code } : { code, reason });
  };

  child.on('error', (err) => fireExit(-1, `không khởi chạy được: ${err.message}`));
  child.on('close', (code, sig) => fireExit(code ?? (sig ? 143 : 1), sig ? `bị ${sig}` : undefined));

  // stdin bị đóng phía kia (server chết) sẽ ném EPIPE lên toàn tiến trình nếu
  // không bắt. Nuốt ở đây; việc báo lỗi là của onExit.
  child.stdin?.on('error', () => {
    /* server đã đóng — onExit sẽ nói lý do */
  });

  return {
    pid: child.pid,
    write(data: string): void {
      if (exited || !child.stdin?.writable) {
        throw new Error('tiến trình MCP đã dừng, không ghi được vào stdin');
      }
      child.stdin.write(data);
    },
    onStdout(cb): void {
      stdoutCbs.push(cb);
    },
    onStderr(cb): void {
      stderrCbs.push(cb);
    },
    onExit(cb): void {
      exitCbs.push(cb);
    },
    async kill(graceMs = 2000): Promise<void> {
      if (exited) return;
      // Đóng stdin trước: server MCP đúng chuẩn sẽ tự thoát khi stdin EOF, và
      // thoát tự nguyện thì nó còn kịp dọn (đóng file, kết thúc giao dịch).
      try {
        child.stdin?.end();
      } catch {
        /* đã đóng */
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          killTree(child.pid);
          resolve();
        }, graceMs);
        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

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
    process.kill(pid, 'SIGKILL');
  } catch {
    /* tiến trình đã chết */
  }
}
