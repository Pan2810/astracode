/**
 * DockerSandbox — chạy lệnh của agent trong container ở sandbox/ (M5).
 *
 * Đây là biện pháp bảo mật THẬT cho tool bash. Cấu hình cứng nằm ở
 * sandbox/docker-compose.yml (không mạng, rootfs chỉ đọc, cap_drop ALL,
 * no-new-privileges, chỉ mount workspace) — lớp này không dựng lại chúng, chỉ
 * gọi compose. Cố ý như vậy: kiểm soát bảo mật nằm ở file người dùng đọc và
 * kiểm tra được, không nằm rải rác trong chuỗi tham số TypeScript sinh ra.
 *
 * Vòng đời container gắn với workspace: `up -d` lần dùng đầu, tái dùng cho các
 * lệnh sau, `down` khi extension tắt. Dựng container cho mỗi lệnh sẽ mất 1–3
 * giây mỗi lần và biến agent thành thứ không ai muốn chờ.
 */
import type {
  ExecOptions,
  ExecResult,
  NetworkProfile,
  OutputChunk,
  Sandbox,
  SandboxInfo,
} from './Sandbox.js';
import { PathTranslator, SandboxUnavailableError } from './Sandbox.js';
import { runProcess, runToCompletion } from './process.js';
import type { Logger } from '../telemetry/logger.js';

export interface DockerSandboxOptions {
  /** Thư mục workspace trên host — thứ được mount vào /workspace. */
  workspaceRoot: string;
  /** Đường dẫn tới thư mục sandbox/ chứa docker-compose.yml. */
  sandboxDir: string;
  network?: NetworkProfile;
  logger: Logger;
  /** Trần thời gian cho `compose up`. Lần đầu phải build image nên khá lâu. */
  startupTimeoutMs?: number;
}

/** Tên service theo profile, khớp với sandbox/docker-compose.yml. */
const SERVICE_BY_PROFILE: Record<NetworkProfile, string> = {
  none: 'runner',
  restricted: 'runner-restricted',
  full: 'runner-full',
};

export class DockerSandbox implements Sandbox {
  private readonly translator: PathTranslator;
  private readonly network: NetworkProfile;
  private started = false;
  private startPromise: Promise<void> | undefined;
  private availability: boolean | undefined;

  constructor(private readonly opts: DockerSandboxOptions) {
    this.network = opts.network ?? 'none';
    this.translator = new PathTranslator(opts.workspaceRoot);
  }

  info(): SandboxInfo {
    const net =
      this.network === 'none'
        ? 'no network'
        : this.network === 'restricted'
          ? 'network via allowlist'
          : 'full network';
    return {
      kind: 'docker',
      label: `Docker · ${net}`,
      network: this.network,
      isolated: true,
      // Container là Linux kể cả khi host là Windows — lệnh đi vào `sh -lc`
      // trong image, không đi qua PowerShell của máy.
      shell: 'bash',
    };
  }

  async isAvailable(): Promise<boolean> {
    if (this.availability !== undefined) return this.availability;
    try {
      // `docker version` chứ không phải `docker --version`: cái sau chỉ đọc
      // binary, cái này thật sự nói chuyện với daemon. Docker Desktop chưa bật
      // vẫn trả lời `--version` bình thường.
      const r = await runToCompletion('docker', ['version', '--format', '{{.Server.Version}}'], {
        timeoutMs: 10_000,
      });
      this.availability = r.exitCode === 0;
      if (!this.availability) {
        this.opts.logger.warn('docker daemon không trả lời', { stderr: r.stderr.slice(0, 200) });
      }
    } catch {
      this.availability = false;
    }
    return this.availability;
  }

  private composeArgs(...rest: string[]): string[] {
    return [
      'compose',
      '-f',
      `${this.opts.sandboxDir}/docker-compose.yml`,
      '--profile',
      this.network,
      ...rest,
    ];
  }

  private composeEnv(): Record<string, string> {
    return {
      ASTRA_WORKSPACE: this.opts.workspaceRoot,
      ASTRA_NET_PROFILE: this.network,
      // Docker Desktop trên Windows cần các biến này để tìm được daemon.
      ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
      ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    };
  }

  /** Đảm bảo container đang chạy. Gọi đồng thời nhiều lần vẫn chỉ up một lần. */
  private async ensureStarted(): Promise<void> {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      if (!(await this.isAvailable())) {
        throw new SandboxUnavailableError(
          'Cannot reach the Docker daemon.',
          'Start Docker Desktop and try again, or set astra.sandbox to "host" if you accept running commands directly on your machine.',
        );
      }

      this.opts.logger.info('khởi động sandbox', {
        profile: this.network,
        workspace: this.opts.workspaceRoot,
      });

      const service = SERVICE_BY_PROFILE[this.network];
      const r = await runToCompletion('docker', this.composeArgs('up', '-d', service), {
        cwd: this.opts.sandboxDir,
        env: this.composeEnv(),
        timeoutMs: this.opts.startupTimeoutMs ?? 300_000,
      });

      if (r.exitCode !== 0) {
        throw new SandboxUnavailableError(
          `Could not start the sandbox container: ${r.stderr.trim().slice(0, 400)}`,
          'Run `docker compose up -d` in the sandbox/ directory yourself to see the full error.',
        );
      }
      this.started = true;
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  exec(
    command: string,
    opts: ExecOptions = {},
  ): AsyncIterable<OutputChunk> & { result: Promise<ExecResult> } {
    let resolveResult: (r: ExecResult) => void;
    let rejectResult: (e: unknown) => void;
    const result = new Promise<ExecResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    // Arrow function để `this` bên trong stream() vẫn là instance — generator
    // khai báo inline trong object literal thì không.
    const iterable: AsyncIterable<OutputChunk> = {
      [Symbol.asyncIterator]: () =>
        this.stream(command, opts, resolveResult, rejectResult),
    };

    return Object.assign(iterable, { result });
  }

  private async *stream(
    command: string,
    opts: ExecOptions,
    resolveResult: (r: ExecResult) => void,
    rejectResult: (e: unknown) => void,
  ): AsyncGenerator<OutputChunk> {
    try {
      await this.ensureStarted();
    } catch (err) {
      rejectResult(err);
      throw err;
    }

    const service = SERVICE_BY_PROFILE[this.network];
    const containerCwd = opts.cwd ? this.translator.toContainer(opts.cwd) : '/workspace';
    // Đường dẫn host trong lệnh được đổi sang đường container: model nghĩ theo
    // đường host vì đó là thứ nó thấy trong read_file.
    const translated = this.translator.rewriteCommand(command);

    const proc = runProcess(
      'docker',
      this.composeArgs('exec', '-T', '--workdir', containerCwd, service, 'bash', '-lc', translated),
      {
        cwd: this.opts.sandboxDir,
        env: this.composeEnv(),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );

    try {
      for await (const chunk of proc) {
        // Đổi ngược /workspace/... về đường host trước khi model nhìn thấy.
        yield { stream: chunk.stream, text: this.translator.rewriteOutput(chunk.text) };
      }
      resolveResult(await proc.result);
    } catch (err) {
      rejectResult(err);
      throw err;
    }
  }

  async dispose(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    try {
      await runToCompletion('docker', this.composeArgs('down', '--remove-orphans'), {
        cwd: this.opts.sandboxDir,
        env: this.composeEnv(),
        timeoutMs: 60_000,
      });
      this.opts.logger.info('đã dừng sandbox');
    } catch (err) {
      this.opts.logger.warn('không dừng được sandbox', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
