/**
 * Vòng đời MCP trong extension (mốc M7).
 *
 * Ba việc, và việc thứ nhất là quan trọng nhất:
 *
 *   1. **Cổng workspace trust.** `vscode.workspace.isTrusted` được đọc ở ĐÂY và
 *      truyền xuống core. Thư mục chưa tin cậy thì không server nào chạy, và
 *      `.astra/mcp.json` của repo thậm chí không được đọc. Mở một repo lạ lên
 *      không được phép là hành động đủ để khởi chạy phần mềm của người khác.
 *
 *   2. Nối catalog + cấu hình → khởi chạy → gom tool cho ChatController.
 *
 *   3. Duyệt tường minh từng server trước khi bật: hiện image, digest, mount,
 *      profile mạng. Việc bật được ghi vào `~/.astra/mcp.json` — nguồn tin cậy,
 *      không phải settings.json của workspace.
 */
import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CompositeMcpLauncher,
  DockerMcpLauncher,
  McpManager,
  ProcessMcpLauncher,
  loadCatalog,
  resolveMcpServers,
  type Logger,
  type McpRejection,
  type McpServerStatus,
  type ResolvedServer,
  type Tool,
} from '@astra/core';
import { VsCodeFileSystem } from '../fs/VsCodeFileSystem.js';
import { resolveSandboxDir, type AstraConfig } from '../config.js';

export interface McpState {
  enabled: boolean;
  workspaceTrusted: boolean;
  catalogPath: string;
  servers: McpServerStatus[];
  rejections: McpRejection[];
}

export class McpService implements vscode.Disposable {
  private manager: McpManager | undefined;
  private resolved: ResolvedServer[] = [];
  private state: McpState = {
    enabled: false,
    workspaceTrusted: false,
    catalogPath: '',
    servers: [],
    rejections: [],
  };
  private signature = '';
  private readonly onChangeEmitter = new vscode.EventEmitter<McpState>();
  readonly onDidChange = this.onChangeEmitter.event;

  constructor(
    private readonly logger: Logger,
    private readonly secrets: vscode.SecretStorage,
    private readonly globalStorage: vscode.Uri,
  ) {}

  current(): McpState {
    return this.state;
  }

  /** Tool để nhập vào registry của lượt chat. Rỗng khi MCP tắt. */
  tools(): Tool[] {
    return this.manager?.tools() ?? [];
  }

  /** Có server vùng C đang chạy không — chat hiện cảnh báo thường trực. */
  hasZoneC(): boolean {
    return this.manager?.hasZoneC() ?? false;
  }

  /** Dựng lại theo cấu hình. Chữ ký để không khởi động lại container vô ích. */
  async apply(cfg: AstraConfig): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const trusted = vscode.workspace.isTrusted;
    const next = `${cfg.mcp}|${cfg.sandboxDir}|${root ?? ''}|${trusted}`;
    if (next === this.signature) return;
    this.signature = next;

    await this.stop();

    if (cfg.mcp === 'off') {
      this.publish({
        enabled: false,
        workspaceTrusted: trusted,
        catalogPath: '',
        servers: [],
        rejections: [],
      });
      return;
    }

    const mcpDir = this.mcpDir(cfg);
    if (!mcpDir) {
      this.publish({
        enabled: true,
        workspaceTrusted: trusted,
        catalogPath: '',
        servers: [],
        rejections: [
          { source: 'catalog', message: 'Could not resolve the sandbox/mcp folder — MCP is off.' },
        ],
      });
      return;
    }

    const fs = new VsCodeFileSystem();
    const catalogPath = path.join(mcpDir, 'servers.json');
    const { catalog, rejections: catalogIssues } = await loadCatalog({ fs, path: catalogPath });

    const resolution = await resolveMcpServers({
      fs,
      catalog,
      ...(root ? { workspaceRoot: root } : {}),
      homeDir: os.homedir(),
      // Cổng trust — xem chú thích đầu file.
      workspaceTrusted: trusted,
    });

    this.resolved = resolution.servers;

    this.manager = new McpManager({
      logger: this.logger,
      launcher: new CompositeMcpLauncher(
        new DockerMcpLauncher({
          mcpDir,
          workspaceRoot: root ?? '',
          stateDir: this.globalStorage.fsPath,
          logger: this.logger,
          secrets: await this.readSecrets(),
        }),
        new ProcessMcpLauncher({ logger: this.logger, ...(root ? { cwd: root } : {}) }),
      ),
    });

    const servers = await this.manager.start(resolution.servers);

    this.publish({
      enabled: true,
      workspaceTrusted: trusted,
      catalogPath,
      servers,
      rejections: [...catalogIssues, ...resolution.rejections],
    });

    for (const r of this.state.rejections) {
      this.logger.warn('MCP configuration rejected', { source: r.source, reason: r.message });
    }
  }

  /**
   * Bật/tắt một server. Ghi vào `~/.astra/mcp.json` chứ không vào settings của
   * workspace: cấu hình nằm trong repo là cấu hình người khác sửa được.
   */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const file = vscode.Uri.file(path.join(os.homedir(), '.astra', 'mcp.json'));
    let doc: { enable?: string[]; [k: string]: unknown } = {};
    try {
      const bytes = await vscode.workspace.fs.readFile(file);
      doc = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      /* chưa có file — tạo mới */
    }

    const list = new Set(Array.isArray(doc.enable) ? doc.enable : []);
    if (enabled) list.add(name);
    else list.delete(name);
    doc.enable = [...list].sort();

    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.join(os.homedir(), '.astra')));
    await vscode.workspace.fs.writeFile(
      file,
      new TextEncoder().encode(`${JSON.stringify(doc, null, 2)}\n`),
    );

    this.logger.info('MCP server toggled', { server: name, enabled });
    // Buộc apply() làm lại: chữ ký không đổi nhưng nội dung file thì đổi.
    this.signature = '';
  }

  /** Mô tả một server để hộp duyệt nói được điều cụ thể. */
  describe(name: string): string | undefined {
    const s = this.resolved.find((x) => x.name === name);
    if (!s) return undefined;

    const lines = [
      `Server MCP: ${s.name}`,
      s.description ? `Description: ${s.description}` : '',
      s.launch.kind === 'compose'
        ? `Image: ${s.launch.image}\nDigest: ${s.launch.digest}`
        : `Command on this machine: ${s.launch.command} ${s.launch.args.join(' ')}`,
      `Network: ${networkLabel(s.network)}`,
      `Mounts: ${s.mounts.length ? s.mounts.join(', ') : 'none'}`,
      `Isolation: ${s.isolated ? 'runs in a container' : 'RUNS DIRECTLY ON THIS MACHINE — no isolation'}`,
      `Trust zone: ${s.trustLevel}${s.trustLevel === 'C' ? ' (its output downgrades the session\'s permissions)' : ''}`,
      `Risk level: ${s.risk}`,
      s.notes ? `Notes: ${s.notes}` : '',
    ];
    return lines.filter(Boolean).join('\n');
  }

  async stop(): Promise<void> {
    const old = this.manager;
    this.manager = undefined;
    if (old) await old.dispose();
  }

  dispose(): void {
    void this.stop();
    this.onChangeEmitter.dispose();
  }

  private publish(state: McpState): void {
    this.state = state;
    this.onChangeEmitter.fire(state);
  }

  private mcpDir(cfg: AstraConfig): string | undefined {
    const sandboxDir = resolveSandboxDir(cfg);
    return sandboxDir ? path.join(sandboxDir, 'mcp') : undefined;
  }

  /**
   * Bí mật bơm vào container MCP (ví dụ chuỗi kết nối Postgres).
   * Đọc từ SecretStorage — KHÔNG BAO GIỜ từ file trong repo.
   */
  private async readSecrets(): Promise<Record<string, string>> {
    const url = await this.secrets.get('astra.mcp.postgresUrl');
    return url ? { ASTRA_MCP_POSTGRES_URL: url } : {};
  }
}

function networkLabel(n: ResolvedServer['network']): string {
  switch (n) {
    case 'none':
      return 'no network';
    case 'restricted':
      return 'egress proxy only (allowlist)';
    case 'full':
      return 'FULL NETWORK';
  }
}
