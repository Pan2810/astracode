/**
 * Vòng đời sandbox trong extension (mốc M5).
 *
 * Quy tắc quan trọng nhất ở đây là một điều KHÔNG làm: **không bao giờ tự động
 * chuyển từ Docker sang chạy thẳng trên máy**. Docker hỏng thì tool bash biến
 * mất và người dùng thấy lý do — chứ không phải lệnh vẫn chạy, chỉ là mất lớp
 * cách ly mà không ai nói gì.
 *
 * Container được dựng LƯỜI, ở lần chạy lệnh đầu tiên chứ không lúc bật
 * extension: `compose up` mất vài giây và lần đầu còn phải build image. Người
 * chỉ hỏi về codebase không nên phải trả cái giá đó.
 */
import * as vscode from 'vscode';
import { DockerSandbox, HostSandbox, type Logger, type Sandbox } from '@astra/core';
import { resolveSandboxDir, type AstraConfig } from '../config.js';

export class SandboxManager implements vscode.Disposable {
  private sandbox: Sandbox | undefined;
  private signature = '';

  constructor(private readonly logger: Logger) {}

  /**
   * Sandbox hiện tại, hoặc undefined nếu người dùng chưa bật.
   * Không có = không có tool bash trong registry (xem createRegistry).
   */
  current(): Sandbox | undefined {
    return this.sandbox;
  }

  /** Dựng lại khi cấu hình đổi. Chữ ký để không dựng lại vô ích. */
  async apply(cfg: AstraConfig): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const trusted = vscode.workspace.isTrusted;
    const next = `${cfg.sandbox}|${cfg.sandboxNetwork}|${cfg.sandboxDir}|${root ?? ''}|${trusted}`;
    if (next === this.signature) return;
    this.signature = next;

    await this.disposeCurrent();

    if (cfg.sandbox === 'off' || !root) {
      this.sandbox = undefined;
      return;
    }

    // Workspace chưa tin cậy → không có tool chạy lệnh (M7). Kể cả sandbox
    // Docker: `docker-compose.yml` đọc từ chính thư mục chưa tin cậy đó, nên
    // "chạy trong container" ở đây là container do người viết repo mô tả.
    if (!trusted) {
      this.sandbox = undefined;
      this.logger.warn('workspace is not trusted — the command tool is disabled');
      return;
    }

    if (cfg.sandbox === 'host') {
      this.sandbox = new HostSandbox({ workspaceRoot: root, logger: this.logger });
      this.logger.warn('sandbox: running directly on the host, NO isolation', { workspace: root });
      return;
    }

    const sandboxDir = resolveSandboxDir(cfg);
    if (!sandboxDir) {
      this.sandbox = undefined;
      this.logger.warn('could not resolve the sandbox/ folder, disabling the bash tool');
      return;
    }

    this.sandbox = new DockerSandbox({
      workspaceRoot: root,
      sandboxDir,
      network: cfg.sandboxNetwork,
      logger: this.logger,
    });

    // Kiểm tra Docker NGAY, không đợi tới lệnh đầu tiên. Biết sớm thì người
    // dùng còn kịp bật Docker Desktop trước khi giao việc cho agent.
    const available = await this.sandbox.isAvailable();
    if (!available) {
      this.logger.warn('Docker is not ready — the bash tool will be missing this session');
      this.sandbox = undefined;
      void vscode.window
        .showWarningMessage(
          'AstraCode: cannot reach Docker, so the command tool is disabled. ' +
            'Start Docker Desktop and reload the window.',
          'Open settings',
        )
        .then((pick) => {
          if (pick === 'Open settings') {
            void vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'astra.sandbox',
            );
          }
        });
    }
  }

  private async disposeCurrent(): Promise<void> {
    const old = this.sandbox;
    this.sandbox = undefined;
    if (old) await old.dispose();
  }

  dispose(): void {
    void this.disposeCurrent();
  }
}
