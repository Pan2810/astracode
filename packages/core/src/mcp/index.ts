/** Bề mặt công khai của tầng MCP (mốc M7). */
export {
  CatalogPolicySchema,
  CatalogServerSchema,
  DEFAULT_POLICY,
  DIGEST_RE,
  McpCatalogSchema,
  RepoConfigSchema,
  SERVER_NAME_RE,
  UserConfigSchema,
  UserServerSchema,
} from './types.js';
export type {
  CatalogServer,
  McpCatalog,
  McpLaunchSpec,
  McpNetwork,
  McpPolicy,
  McpRejection,
  McpResolution,
  McpRisk,
  McpToolInfo,
  McpTrustLevel,
  McpUserConfig,
  ResolvedServer,
  UserServer,
} from './types.js';

export { loadCatalog, isPinned } from './catalog.js';
export type { LoadCatalogOptions, LoadedCatalog } from './catalog.js';

export { resolveMcpServers, runnableServers } from './config.js';
export type { ResolveMcpOptions } from './config.js';

export { LineDecoder, encodeMessage, isResponse, MAX_LINE_CHARS } from './protocol.js';
export type {
  DecodeResult,
  JsonRpcError,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from './protocol.js';

export { McpClient, McpClientError, MCP_PROTOCOL_VERSION } from './McpClient.js';
export type {
  McpCallResult,
  McpClientOptions,
  McpServerInfo,
  McpTransport,
} from './McpClient.js';

export {
  CompositeMcpLauncher,
  DockerMcpLauncher,
  McpLaunchError,
  ProcessMcpLauncher,
} from './launcher.js';
export type { DockerMcpLauncherOptions, McpLauncher } from './launcher.js';

export { McpManager, mcpToolName, parseMcpToolName, MCP_TOOL_PREFIX } from './McpManager.js';
export type {
  McpManagerOptions,
  McpServerState,
  McpServerStatus,
  McpToolStatus,
} from './McpManager.js';
