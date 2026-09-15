/**
 * Khởi chạy server MCP (mốc M7).
 *
 * Mỗi server một container riêng, dựng bằng `docker compose run` trên
 * `sandbox/mcp/docker-compose.mcp.yml`. Như với sandbox bash (M5), các cờ siết
 * (read_only, cap_drop ALL, non-root, network none, mount tối thiểu) nằm TRONG
 * file compose chứ không sinh ra ở đây — người dùng phải đọc và kiểm tra được
 * biện pháp bảo mật của mình mà không cần đọc TypeScript.
 *
 * Digest được truyền vào qua biến môi trường `MCP_<TÊN>_DIGEST` và compose khai
 * báo `image: mcp/x@${MCP_X_DIGEST:?}`. Nghĩa là: thiếu digest thì compose tự
 * từ chối chạy. Hai lớp — lớp này chặn ở `resolveMcpServers`, compose chặn lần
 * nữa ở dưới — cố ý không rút gọn thành một.
 */
import { spawnStdio } from '../sandbox/stdio.js';
import type { Logger } from '../telemetry/logger.js';
import type { McpTransport } from './McpClient.js';
import { isPinned } from './catalog.js';
import type { ResolvedServer } from './types.js';

export interface McpLauncher {
  launch(server: ResolvedServer): Promise<McpTransport>;
}

export class McpLaunchError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'McpLaunchError';
  }
}

export interface DockerMcpLauncherOptions {
  /** Thư mục chứa docker-compose.mcp.yml (thường `<sandboxDir>/mcp`). */
  mcpDir: string;
  /** Workspace trên host — compose mount nó vào /workspace. */
  workspaceRoot: string;
  /** Thư mục state của AstraCode (server `memory` ghi vào đây). KHÔNG trong repo. */
  stateDir: string;
  logger: Logger;
  /**
   * Bí mật bơm vào container lúc chạy (ví dụ `ASTRA_MCP_POSTGRES_URL`).
   * Lấy từ SecretStorage ở tầng extension — KHÔNG bao giờ đọc từ file trong repo.
   */
  secrets?: Record<string, string>;
}

export class DockerMcpLauncher implements McpLauncher {
  constructor(private readonly opts: DockerMcpLauncherOptions) {}

  async launch(server: ResolvedServer): Promise<McpTransport> {
    if (server.launch.kind !== 'compose') {
      throw new McpLaunchError(`Server "${server.name}" is not a catalog server`);
    }
    if (!isPinned(server.launch.digest)) {
      // Chặn lần hai. resolveMcpServers đã chặn rồi, nhưng chỗ sinh tiến trình
      // là chỗ cuối cùng còn ngăn được, nên nó phải tự kiểm chứ không tin ai.
      throw new McpLaunchError(
        `Server "${server.name}" has no pinned sha256 digest — not starting it.`,
        'Put the real digest in sandbox/mcp/servers.json (docker buildx imagetools inspect <image>).',
      );
    }

    const args = [
      'compose',
      '-f',
      `${this.opts.mcpDir}/docker-compose.mcp.yml`,
      '--profile',
      server.name,
      'run',
      '--rm',
      // -T: không cấp TTY. Có TTY thì Docker chèn ký tự điều khiển vào luồng và
      // JSON-RPC theo dòng vỡ ngay.
      '-T',
      server.name,
    ];

    this.opts.logger.info('khởi chạy server MCP', {
      server: server.name,
      image: server.launch.image,
      digest: server.launch.digest.slice(0, 19),
      network: server.network,
    });

    const proc = spawnStdio('docker', args, {
      cwd: this.opts.mcpDir,
      env: this.env(server),
    });

    return toTransport(proc);
  }

  private env(server: ResolvedServer): Record<string, string> {
    const digestVar = `MCP_${server.name.toUpperCase().replace(/-/g, '_')}_DIGEST`;
    return {
      [digestVar]: server.launch.kind === 'compose' ? server.launch.digest : '',
      ASTRA_WORKSPACE: this.opts.workspaceRoot,
      ASTRA_STATE_DIR: this.opts.stateDir,
      ...this.opts.secrets,
      // Docker Desktop trên Windows cần các biến này để tìm được daemon.
      ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
      ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    };
  }
}

/**
 * Server tuỳ chỉnh khai báo ở `~/.astra/mcp.json` — chạy THẲNG TRÊN MÁY.
 *
 * Không có lớp cách ly nào. Nó tồn tại vì người dùng có quyền cắm công cụ của
 * riêng họ vào máy của họ, nhưng UI phải nói rõ điều đó trước khi bật, và
 * `ResolvedServer.isolated = false` là chỗ mang thông tin ấy đi.
 */
export class ProcessMcpLauncher implements McpLauncher {
  constructor(
    private readonly opts: { cwd?: string; logger: Logger },
  ) {}

  async launch(server: ResolvedServer): Promise<McpTransport> {
    if (server.launch.kind !== 'process') {
      throw new McpLaunchError(`Server "${server.name}" is not a custom server`);
    }

    this.opts.logger.warn('khởi chạy server MCP KHÔNG cách ly', {
      server: server.name,
      command: server.launch.command,
    });

    const proc = spawnStdio(server.launch.command, server.launch.args, {
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      env: server.launch.env,
    });

    return toTransport(proc);
  }
}

/** Chọn launcher theo cách khai báo của server. */
export class CompositeMcpLauncher implements McpLauncher {
  constructor(
    private readonly docker: McpLauncher,
    private readonly process: McpLauncher,
  ) {}

  launch(server: ResolvedServer): Promise<McpTransport> {
    return server.launch.kind === 'compose'
      ? this.docker.launch(server)
      : this.process.launch(server);
  }
}

function toTransport(proc: ReturnType<typeof spawnStdio>): McpTransport {
  return {
    send: (line) => proc.write(line),
    onData: (cb) => proc.onStdout(cb),
    onStderr: (cb) => proc.onStderr(cb),
    onExit: (cb) => proc.onExit(cb),
    close: () => proc.kill(),
  };
}
