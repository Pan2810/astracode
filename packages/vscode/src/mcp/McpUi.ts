/**
 * UI quản lý MCP — `AstraCode: Quản lý server MCP` (mốc M7).
 *
 * Điều quan trọng nhất ở màn này không phải bật/tắt cho tiện, mà là **hộp
 * duyệt trước khi bật**. Duyệt một server MCP là quyết định chạy image của
 * người khác cạnh mã nguồn của mình, nên hộp đó phải hiện đủ thứ để quyết định
 * có căn cứ: image, digest, mount, profile mạng, có cách ly không, và danh sách
 * tool nó cung cấp (khi đã từng chạy).
 *
 * Nút "luôn cho phép" cố ý KHÔNG tồn tại: việc bật server đã là quyết định lâu
 * dài rồi, còn từng lời gọi tool thì đi qua PermissionManager như mọi tool khác.
 */
import * as vscode from 'vscode';
import type { Logger, McpServerStatus } from '@astra/core';
import type { McpService } from './McpService.js';
import { readConfig, updateConfig } from '../config.js';

export async function manageMcpServers(mcp: McpService, logger: Logger): Promise<void> {
  const state = mcp.current();

  if (!state.workspaceTrusted) {
    const pick = await vscode.window.showWarningMessage(
      'This workspace is not trusted, so AstraCode loaded no MCP server. ' +
        'MCP servers can read your source, and some of them talk to the internet.',
      'Manage workspace trust',
    );
    if (pick) {
      await vscode.commands.executeCommand('workbench.trust.manage');
    }
    return;
  }

  if (readConfig().mcp === 'off') {
    const pick = await vscode.window.showInformationMessage(
      'MCP is off. Turn it on to use the servers in the catalog?',
      'Turn MCP on',
      'Leave it off',
    );
    if (pick !== 'Turn MCP on') return;
    await updateConfig('mcp', 'on');
    return;
  }

  if (state.servers.length === 0) {
    const detail = state.rejections.map((r) => `• [${r.source}] ${r.message}`).join('\n');
    await vscode.window.showWarningMessage(
      `No MCP server in the catalog${state.catalogPath ? ` (${state.catalogPath})` : ''}.`,
      { modal: detail.length > 0, detail },
    );
    return;
  }

  const items = state.servers.map((s) => toItem(s));
  if (state.rejections.length > 0) {
    items.push({
      label: '$(warning) Show rejected configuration',
      description: `${state.rejections.length} entries`,
      server: undefined,
      showRejections: true,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Server MCP',
    placeHolder: 'Pick a server to toggle or inspect',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  if (picked.showRejections) {
    await vscode.window.showInformationMessage('Rejected MCP configuration', {
      modal: true,
      detail: state.rejections.map((r) => `[${r.source}] ${r.message}`).join('\n\n'),
    });
    return;
  }

  const server = picked.server!;
  if (server.enabled) {
    await disable(mcp, server, logger);
  } else {
    await enable(mcp, server, logger);
  }
}

interface ServerItem extends vscode.QuickPickItem {
  server: McpServerStatus | undefined;
  showRejections?: boolean;
}

function toItem(s: McpServerStatus): ServerItem {
  const icon = s.blockedReason
    ? '$(error)'
    : s.state === 'ready'
      ? '$(pass-filled)'
      : s.state === 'failed'
        ? '$(warning)'
        : s.enabled
          ? '$(circle-outline)'
          : '$(circle-slash)';

  const bits: string[] = [
    s.enabled ? 'on' : 'off',
    s.state === 'ready' ? `${s.tools.length} tool` : s.state,
    `risk ${s.risk}`,
    `zone ${s.trustLevel}`,
  ];
  if (!s.isolated) bits.push('NO isolation');

  const flagged = s.tools.filter((t) => t.descriptionHidden).length;
  if (flagged > 0) bits.push(`${flagged} description(s) hidden as suspected injection`);

  return {
    label: `${icon} ${s.name}`,
    description: bits.join(' · '),
    ...(s.blockedReason || s.error ? { detail: s.blockedReason ?? s.error } : {}),
    server: s,
  };
}

async function enable(mcp: McpService, s: McpServerStatus, logger: Logger): Promise<void> {
  if (s.blockedReason) {
    await vscode.window.showErrorMessage(`Could not enable "${s.name}"`, {
      modal: true,
      detail: s.blockedReason,
    });
    return;
  }

  const detail = [
    mcp.describe(s.name) ?? '',
    '',
    s.tools.length > 0
      ? `Tools it provides:\n${s.tools.map((t) => `  • ${t.rawName}`).join('\n')}`
      : 'Its tools are unknown — the list only exists after the first run.',
    '',
    'Enabling a server means running third-party software next to your source. ' +
      'Every tool call it makes still needs your approval, one at a time.',
  ].join('\n');

  const pick = await vscode.window.showWarningMessage(
    `Enable the MCP server "${s.name}"?`,
    { modal: true, detail },
    'Enable',
  );
  if (pick !== 'Enable') return;

  await mcp.setEnabled(s.name, true);
  logger.info('user enabled an MCP server', { server: s.name });
  await reload(mcp);
}

async function disable(mcp: McpService, s: McpServerStatus, logger: Logger): Promise<void> {
  await mcp.setEnabled(s.name, false);
  logger.info('user disabled an MCP server', { server: s.name });
  await reload(mcp);
  void vscode.window.showInformationMessage(`MCP server "${s.name}" turned off.`);
}

async function reload(mcp: McpService): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'AstraCode: reloading MCP…' },
    () => mcp.apply(readConfig()),
  );
}
