/**
 * Bộ tool của AstraCode.
 *
 * Chia theo NĂNG LỰC chứ không theo mốc phát triển: `createRegistry` nhận
 * đúng những gì phiên hiện tại có (sổ thay đổi, sandbox, todo store) và trả về
 * bộ tool tương ứng. Không có sandbox thì không có tool bash — chứ không phải
 * có tool bash rồi nó tự báo lỗi khi chạy. Model không nên nhìn thấy công cụ
 * mà nó không dùng được: nó sẽ lập kế hoạch quanh công cụ đó rồi bế tắc.
 */
import { ToolRegistry, type Tool, type ToolContext } from './Tool.js';
import { readFileTool } from './readFile.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { listDirTool } from './listDir.js';
import { writeFileTool } from './writeFile.js';
import { editFileTool } from './editFile.js';
import { bashTool } from './bash.js';
import { pythonTool } from './python.js';
import { installPackageTool } from './installPackage.js';
import { taskKillTool, taskStatusTool } from './taskTools.js';
import type { BackgroundJobs } from './background.js';
import { createTodoWriteTool, TodoStore } from './todoWrite.js';
import { askUserQuestionTool } from './askUserQuestion.js';
import type { AskUserFn } from './askUser.js';
import { findReferencesTool, impactOfTool } from './codeGraphTools.js';
import type { CodeGraphProvider } from '../graph/types.js';
import { NodeFileSystem, type FileSystem } from '../fs/FileSystem.js';
import { PathGuard } from '../security/pathGuard.js';
import { Denylist } from '../security/denylist.js';
import type { Logger } from '../telemetry/logger.js';
import type { ChangeLedger } from '../changes/ChangeLedger.js';
import type { Sandbox } from '../sandbox/Sandbox.js';

export const READ_ONLY_TOOLS: Tool[] = [listDirTool, globTool, grepTool, readFileTool];

/** Tool sửa file. Chỉ có tác dụng khi phiên có ChangeLedger để ghi lại. */
export const WRITE_TOOLS: Tool[] = [writeFileTool, editFileTool];

export function createReadOnlyRegistry(): ToolRegistry {
  return new ToolRegistry(READ_ONLY_TOOLS);
}

export interface RegistryOptions {
  /** Cho model sửa file không. Chế độ plan để false. */
  canWrite?: boolean;
  /** Có sandbox thì mới có tool bash. */
  hasSandbox?: boolean;
  /**
   * Phiên có sổ tác vụ nền không. Bật thì model thấy `task_status`/`task_kill`.
   *
   * Không có sandbox thì cờ này vô nghĩa — không có lệnh nào để chạy nền, và
   * hai tool kia chỉ tổ tốn context để trả lời "sổ đang rỗng".
   */
  hasBackgroundJobs?: boolean;
  /** Truyền store để bật todo_write. */
  todoStore?: TodoStore;
  /** Bật ask_user_question — chỉ có ý nghĩa khi ToolContext cũng có `askUser`. */
  hasAskUser?: boolean;
  /**
   * CodeGraph của workspace (M12). Có = model thấy `find_references`/`impact_of`
   * và ToolContext nhận field `codeGraph` cùng giá trị này.
   */
  codeGraph?: CodeGraphProvider;
  /**
   * Tool đến từ ngoài — hiện chỉ có MCP (M7). Chúng được thêm SAU cùng và
   * KHÔNG được ghi đè tool nội bộ: `ToolRegistry.register` ném khi trùng tên,
   * và tiền tố `mcp__` khiến việc đó không xảy ra. Giữ nguyên hành vi ném là
   * cố ý — một server cố chiếm tên `read_file` phải làm phiên hỏng ồn ào, chứ
   * không được im lặng thắng hoặc im lặng thua.
   */
  extraTools?: Tool[];
}

export function createRegistry(opts: RegistryOptions = {}): ToolRegistry {
  const tools: Tool[] = [...READ_ONLY_TOOLS];
  if (opts.canWrite) tools.push(...WRITE_TOOLS);
  if (opts.hasSandbox) {
    tools.push(bashTool, pythonTool, installPackageTool);
    if (opts.hasBackgroundJobs) tools.push(taskStatusTool, taskKillTool);
  }
  if (opts.todoStore) tools.push(createTodoWriteTool(opts.todoStore));
  if (opts.hasAskUser) tools.push(askUserQuestionTool);
  if (opts.codeGraph) tools.push(findReferencesTool, impactOfTool);
  if (opts.extraTools?.length) tools.push(...opts.extraTools);
  return new ToolRegistry(tools);
}

export interface ToolContextOptions {
  workspaceRoot: string;
  logger: Logger;
  fs?: FileSystem;
  /** Nội dung .astraignore của project, nếu có. */
  astraignore?: string;
  signal?: AbortSignal;
  ledger?: ChangeLedger;
  turnId?: string;
  sandbox?: Sandbox;
  /** Sổ tác vụ nền của phiên. Không truyền = không chạy nền được. */
  jobs?: BackgroundJobs;
  /** Output trực tiếp của tool chạy lâu — AgentLoop gắn vào, xem Tool.ts. */
  onOutput?: (text: string) => void;
  /** Kênh hỏi người dùng qua nút bấm. Không truyền = ask_user_question tự báo lỗi. */
  askUser?: AskUserFn;
  /** CodeGraph của workspace (M12). Không truyền = hai tool graph tự báo lỗi. */
  codeGraph?: CodeGraphProvider;
}

/**
 * Dựng ToolContext hoàn chỉnh. Đi qua hàm này để không ai quên gắn pathGuard
 * hay denylist — quên một trong hai là thủng lớp bảo vệ duy nhất.
 */
export function createToolContext(opts: ToolContextOptions): ToolContext {
  const fs = opts.fs ?? new NodeFileSystem();
  return {
    workspaceRoot: opts.workspaceRoot,
    fs,
    pathGuard: new PathGuard({ workspaceRoot: opts.workspaceRoot, fs }),
    denylist: new Denylist(opts.astraignore ? { astraignore: opts.astraignore } : {}),
    logger: opts.logger,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.ledger ? { ledger: opts.ledger } : {}),
    ...(opts.turnId ? { turnId: opts.turnId } : {}),
    ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
    ...(opts.jobs ? { jobs: opts.jobs } : {}),
    ...(opts.onOutput ? { onOutput: opts.onOutput } : {}),
    ...(opts.askUser ? { askUser: opts.askUser } : {}),
    ...(opts.codeGraph ? { codeGraph: opts.codeGraph } : {}),
  };
}

export { ToolRegistry, ToolError } from './Tool.js';
export type { Tool, ToolContext, ToolResult, ToolIntent } from './Tool.js';
export { readFileTool } from './readFile.js';
export { globTool } from './glob.js';
export { grepTool } from './grep.js';
export { listDirTool } from './listDir.js';
export { writeFileTool } from './writeFile.js';
export { editFileTool, applyEdit, stripLineNumbers } from './editFile.js';
export type { MatchOutcome, MatchResult } from './editFile.js';
export { bashTool, checkBlocked } from './bash.js';
export { pythonTool } from './python.js';
export { installPackageTool } from './installPackage.js';
export { taskStatusTool, taskKillTool } from './taskTools.js';
export {
  BackgroundJobs,
  BackgroundJobsError,
  describeJob,
  MAX_CONCURRENT_JOBS,
  DEFAULT_BACKGROUND_TIMEOUT,
} from './background.js';
export type { BackgroundJob, JobStatus, JobEvent, JobListener } from './background.js';
export { createTodoWriteTool, TodoStore } from './todoWrite.js';
export type { TodoItem, TodoStatus, TodoListener } from './todoWrite.js';
export { askUserQuestionTool } from './askUserQuestion.js';
export type { AskUserOption, AskUserQuestion, AskUserAnswer, AskUserResult, AskUserFn } from './askUser.js';
export { findReferencesTool, impactOfTool } from './codeGraphTools.js';
export { summarizeToolResult } from './summary.js';
export type { ToolSummaryInput } from './summary.js';
export { walkFiles, SKIP_DIRS } from './walk.js';
export { zodToJsonSchema } from './jsonSchema.js';
