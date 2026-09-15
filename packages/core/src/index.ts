/**
 * @astra/core — lõi agent của AstraCode.
 *
 * Ràng buộc: file nào trong package này cũng KHÔNG được import 'vscode'.
 * Mọi thứ phụ thuộc IDE đi qua interface (TokenStore, LogSink, ...) do
 * packages/vscode cài đặt. Eslint ép điều này ở eslint.config.js.
 */

export * from './errors.js';

// ─── M2: filesystem, bảo mật, tool, agent loop ─────────────────────────────

export { NodeFileSystem, MemoryFileSystem } from './fs/FileSystem.js';
export type { FileSystem, FileStat, DirEntry, MemoryFsOptions } from './fs/FileSystem.js';

export { PathGuard, PathGuardError, isWithin } from './security/pathGuard.js';
export type { PathGuardOptions, PathRejectReason } from './security/pathGuard.js';
export { Denylist, DEFAULT_DENY_PATTERNS } from './security/denylist.js';
export type { DenylistOptions, DenyDecision } from './security/denylist.js';
export {
  scanEscapes,
  describeEscapes,
  isExecutablePath,
} from './security/workspaceEscape.js';
export type { EscapeFinding, EscapeScanOptions } from './security/workspaceEscape.js';
export { scanForInjection, describeInjectionScan } from './security/injectionScan.js';
export type {
  InjectionSignal,
  InjectionFinding,
  InjectionScanResult,
  InjectionScanOptions,
} from './security/injectionScan.js';

export {
  ToolRegistry,
  ToolError,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  createReadOnlyRegistry,
  createRegistry,
  createToolContext,
  readFileTool,
  globTool,
  grepTool,
  listDirTool,
  writeFileTool,
  editFileTool,
  applyEdit,
  stripLineNumbers,
  bashTool,
  checkBlocked,
  taskStatusTool,
  taskKillTool,
  BackgroundJobs,
  BackgroundJobsError,
  describeJob,
  MAX_CONCURRENT_JOBS,
  DEFAULT_BACKGROUND_TIMEOUT,
  createTodoWriteTool,
  TodoStore,
  askUserQuestionTool,
  summarizeToolResult,
  walkFiles,
  SKIP_DIRS,
  zodToJsonSchema,
} from './tools/index.js';
export type {
  Tool,
  ToolContext,
  ToolResult,
  ToolIntent,
  ToolContextOptions,
  ToolSummaryInput,
  RegistryOptions,
  TodoItem,
  TodoStatus,
  TodoListener,
  MatchOutcome,
  MatchResult,
  BackgroundJob,
  JobStatus,
  JobEvent,
  JobListener,
  AskUserOption,
  AskUserQuestion,
  AskUserAnswer,
  AskUserResult,
  AskUserFn,
} from './tools/index.js';

// ─── M4: sổ thay đổi + quyền ───────────────────────────────────────────────

export { ChangeLedger, summarizeChanges } from './changes/ChangeLedger.js';
export type {
  FileChange,
  ChangeStatus,
  ChangeLedgerOptions,
  RevertOp,
  RecordChangeInput,
  ChangeListener,
} from './changes/ChangeLedger.js';
export { diffLines, diffStat, formatUnifiedDiff, splitLines } from './changes/diff.js';
export type { DiffLine, DiffOp, DiffStat, UnifiedDiffOptions } from './changes/diff.js';

export { PermissionManager, describeMode, ALWAYS_ASK } from './permissions/PermissionManager.js';
export type {
  PermissionMode,
  PermissionDecision,
  PermissionRequest,
  PermissionAsker,
  PermissionCheck,
  PermissionState,
  PermissionListener,
  PermissionManagerOptions,
} from './permissions/PermissionManager.js';

// ─── M5: sandbox ───────────────────────────────────────────────────────────

export { PathTranslator, SandboxUnavailableError } from './sandbox/Sandbox.js';
export type {
  Sandbox,
  SandboxInfo,
  NetworkProfile,
  ExecOptions,
  ExecResult,
  OutputChunk,
} from './sandbox/Sandbox.js';
export { DockerSandbox } from './sandbox/DockerSandbox.js';
export type { DockerSandboxOptions } from './sandbox/DockerSandbox.js';
export { HostSandbox } from './sandbox/HostSandbox.js';
export type { HostSandboxOptions } from './sandbox/HostSandbox.js';

export { buildSystemPrompt, roughTokenCount } from './prompts/system.js';
export type { SystemPromptOptions } from './prompts/system.js';

// ─── M6: bộ nhớ, ngữ cảnh, phiên ───────────────────────────────────────────

export {
  ContextBudget,
  describeUsage,
  estimateConversationTokens,
  estimateMessageTokens,
  estimateTokens,
  toolResultCharBudget,
} from './context/tokens.js';
export type { ContextBudgetOptions, ContextUsage } from './context/tokens.js';
export {
  Compactor,
  buildGoalReminder,
  findCutIndex,
  mechanicalSummary,
} from './context/compaction.js';
export type { CompactionResult, CompactorOptions } from './context/compaction.js';
export { StaticContextCache } from './context/staticContextCache.js';
export type {
  StaticContextSegment,
  StaticContextCacheResult,
} from './context/staticContextCache.js';

export {
  ASTRAWORK_LOGIN_URL,
  ASTRAWORK_WEB_URL,
  GATEWAY_BASE_URL,
} from './config/endpoints.js';
export {
  DEFAULT_MODEL_ID,
  DEFAULT_PLAN_MODEL_ID,
  defaultModelForRole,
} from './config/model.js';
export { FX_VND_PER_USD, turnCostUsd, usdFromVnd } from './config/pricing.js';
export { WorkItemsClient, withUsageLine } from './work/WorkItems.js';
export type {
  AstraProject,
  AstraTask,
  AstraTaskDetail,
  AstraTaskList,
  AstraTaskUsage,
  TaskDoneReport,
  TaskDoneResult,
  WorkItemsClientOptions,
} from './work/WorkItems.js';
export { loadMemory, diffMemory, MEMORY_MAX_CHARS } from './config/memory.js';
export type {
  MemoryBundle,
  MemoryFile,
  MemorySource,
  LoadMemoryOptions,
} from './config/memory.js';
export { resolvePins, renderPinnedContext } from './config/pins.js';
export type { PinnedRef, ResolvedPin } from './config/pins.js';
export {
  loadCommands,
  parseCommandFile,
  parseSlashInput,
  renderCommand,
  substituteArgs,
  COMMAND_MAX_CHARS,
  COMMAND_MAX_DEPTH,
  COMMAND_DIRS,
} from './config/commands.js';
export type { CommandSource, LoadCommandsOptions, SlashCommand } from './config/commands.js';
export {
  buildSlashEntries,
  resolveSlash,
  renderSkillInvocation,
  hasArgPlaceholder,
} from './config/slash.js';
export type {
  BuiltinCommand,
  SlashEntry,
  SlashInputs,
  SlashKind,
  SlashTarget,
} from './config/slash.js';
export { fuzzyMatch, fuzzyRank } from './text/fuzzy.js';
export type { FuzzyMatch, RankedItem } from './text/fuzzy.js';

export {
  SessionStore,
  MemorySessionStorage,
  appendTurn,
} from './session/SessionStore.js';
export type {
  SessionStorage,
  SessionStoreOptions,
  SessionSummary,
} from './session/SessionStore.js';
export {
  SESSION_SCHEMA_VERSION,
  migrateSession,
  newSessionId,
  parseSession,
  titleFrom,
  toolCallsBalanced,
} from './session/types.js';
export type {
  PersistedSession,
  PersistedTurn,
  PersistedToolSummary,
} from './session/types.js';
export { CheckpointStore } from './session/Checkpoint.js';
export type {
  Checkpoint,
  CheckpointEntry,
  CheckpointStoreOptions,
} from './session/Checkpoint.js';
export { FsSessionStorage } from './session/FsSessionStorage.js';
export { FileHistoryStore, parseCheckpoint } from './session/FileHistory.js';
export type { FileHistoryOptions } from './session/FileHistory.js';

// ─── Thư mục nhà `~/.astra` ────────────────────────────────────────────────
// Layout dùng chung CLI ↔ extension. Xem home/layout.ts để biết vì sao chỉ được
// có MỘT nơi biết file nào nằm ở đâu.

export {
  ASTRA_DIR,
  astraHome,
  astraLayout,
  graphDir,
  projectDir,
  projectSlug,
  safeName,
  sessionHistoryDir,
} from './home/layout.js';
export type { AstraLayout } from './home/layout.js';
export {
  STATE_SCHEMA_VERSION,
  StateStore,
  emptyState,
  parseState,
  stateStoreAt,
} from './home/StateStore.js';
export type {
  AstraProjectState,
  AstraState,
  StateStoreOptions,
} from './home/StateStore.js';
export { HistoryLog } from './home/HistoryLog.js';
export type { HistoryEntry, HistoryLogOptions } from './home/HistoryLog.js';
export { HomeCleanup } from './home/Cleanup.js';
export type { CleanupOptions, CleanupReport } from './home/Cleanup.js';
export { migrateHome } from './home/migrate.js';
export type { MigrateOptions, MigrateReport } from './home/migrate.js';
export { readAccessToken, writeAccessToken } from './home/credentials.js';
export type { AstraCredentials } from './home/credentials.js';

// ─── M7: MCP đóng gói sẵn + workspace trust ────────────────────────────────

export * from './mcp/index.js';

// ─── M8: skill, subagent, hooks ────────────────────────────────────────────

export * from './skills/index.js';

export {
  HookRunner,
  HookSchema,
  HooksConfigSchema,
  MemoryApprovalStore,
  EMPTY_HOOKS,
  describeHook,
  fingerprintOf,
  loadHooks,
} from './hooks/hooks.js';
export type {
  HookApprovalStore,
  HookEvent,
  HookOutcome,
  HookRunnerOptions,
  HookSource,
  HookSpec,
  HooksConfig,
  LoadHooksOptions,
  LoadHooksResult,
  LoadedHook,
} from './hooks/hooks.js';

export { AgentLoop, isNativeToolsUnsupported } from './agent/AgentLoop.js';
export type {
  AgentEvent,
  AgentLoopOptions,
  AgentRunResult,
  ToolOutputChunk,
  ToolProtocol,
} from './agent/AgentLoop.js';
export {
  buildXmlToolPrompt,
  parseXmlToolCalls,
  coerceArgs,
  readXmlToolResults,
  unwrapToolResult,
  // Khuôn của message kết quả tool ở đường XML. Extension cần chúng để dựng
  // fixture đúng khuôn thay vì chép tay — chép tay thì đổi khuôn ở đây không
  // làm test bên kia đỏ, và lỗi lộ ra ở chỗ xa nhất: một phiên cũ mở lại thấy
  // kết quả tool nằm lẫn vào lời người dùng.
  XML_TOOL_RESULT_PREFIX,
  XML_TOOL_RESULT_HEADING,
  XML_TOOL_RESULT_FOOTER,
  XML_TOOL_RESULT_OPEN,
  XML_TOOL_RESULT_CLOSE,
} from './agent/xmlProtocol.js';
export type { ParsedXmlToolCall, XmlParseResult, XmlToolResult } from './agent/xmlProtocol.js';
export { XmlTextStream } from './agent/xmlStream.js';

// ─── M1: provider, auth, registry, telemetry ───────────────────────────────

export { Redactor, defaultRedactor, DEFAULT_RULES } from './security/redactor.js';
export type {
  RedactOptions,
  RedactionRule,
  RedactionHit,
  RedactionResult,
  RedactorOptions,
} from './security/redactor.js';

export {
  Logger,
  ConsoleSink,
  MemorySink,
  MultiSink,
  ExchangeRecorder,
  newTraceId,
} from './telemetry/logger.js';
export type {
  LogLevel,
  LogRecord,
  LogSink,
  LoggerOptions,
  RecordedExchange,
} from './telemetry/logger.js';

export { AstraWorkAuth, decodeJwtClaims } from './auth/AstraWorkAuth.js';
export type { AstraWorkAuthOptions, SsoConfig } from './auth/AstraWorkAuth.js';
export { MemoryTokenStore } from './auth/types.js';
export type { TokenStore, AuthState } from './auth/types.js';

export { GatewayProvider } from './provider/GatewayProvider.js';
export type { GatewayProviderOptions } from './provider/GatewayProvider.js';
export { MockProvider, collect, textOf, toolCallsOf } from './provider/MockProvider.js';
export type { ScriptedTurn, MockProviderOptions } from './provider/MockProvider.js';
export { backoffDelay, classifyHttpError, parseRetryAfter, delay } from './provider/retry.js';
export type {
  ChatMessage,
  FinishReason,
  ImageAttachment,
  ModelRole,
  Provider,
  ProviderEvent,
  StreamRequest,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from './provider/types.js';

export {
  ModelRegistry,
  parseModelsFile,
  ModelsFileSchema,
  AvailableModelSchema,
  EMPTY_MODELS_FILE,
  BUNDLED_MODELS_FILE,
  INFERRED_DEFAULTS,
  mergeModelsFiles,
} from './registry/ModelRegistry.js';
export { GatewayModelSource, FptModelSource } from './registry/ModelSource.js';
export type { ModelSource, SourceOptions } from './registry/ModelSource.js';
export type {
  AvailableModel,
  ModelProfile,
  ModelsFile,
  ModelRegistryOptions,
  ResolvedModel,
} from './registry/ModelRegistry.js';

// ─── M9: chính sách tổ chức từ gateway ──────────────────────────────────────
export {
  IdePolicyClient,
  IdePolicySchema,
  DEFAULT_IDE_POLICY,
  PERMISSION_MODES,
  SANDBOX_NETWORKS,
  applyIdePolicy,
} from './policy/IdePolicy.js';
export type {
  IdePolicy,
  PolicyCache,
  PolicyPermissionMode,
  PolicyNetwork,
  UserPreferences,
  EffectiveSettings,
  LockedField,
} from './policy/IdePolicy.js';

// ─── M10b: chuẩn agent theo dự án ───────────────────────────────────────────
export {
  ProjectAgentsClient,
  ProjectStandardSchema,
  ProjectAgentSchema,
  EMPTY_PROJECT_STANDARD,
  MAX_PROJECT_AGENTS,
  PROJECT_AGENT_PATH,
  PROJECT_ENTRY_KINDS,
  toAgentDefinitions,
  toSkillDefinitions,
} from './policy/ProjectAgents.js';
export type {
  ProjectStandard,
  ProjectAgent,
  ProjectEntryKind,
  ProjectStandardCache,
  ProjectAgentsClientOptions,
} from './policy/ProjectAgents.js';

// ─── M10: đẩy số đo lên AstraWork ───────────────────────────────────────────
export { OtlpExporter } from './telemetry/OtlpExporter.js';
export type {
  OtlpExporterOptions,
  UsageSample,
  ToolDecisionSample,
} from './telemetry/OtlpExporter.js';
export { mintIngestToken } from './telemetry/ingestToken.js';
export type { IngestToken, MintIngestTokenOptions } from './telemetry/ingestToken.js';
export { fetchAccountUsage } from './telemetry/accountUsage.js';

// ─── CodeGraph — symbol table + dependency graph ──────────────────────────

export * from './graph/index.js';
export type { AccountUsage, FetchAccountUsageOptions } from './telemetry/accountUsage.js';
