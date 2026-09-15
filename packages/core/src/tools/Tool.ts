/**
 * Giao diện tool và registry — mốc M2.
 *
 * Ba quyết định đáng nói:
 *
 * 1. Schema khai báo bằng zod, JSON Schema sinh ra từ đó. Một nguồn sự thật
 *    cho cả kiểu TypeScript lẫn định nghĩa gửi lên model — hai bên lệch nhau
 *    là lỗi im lặng khó tìm nhất ở tầng này.
 *
 * 2. Tool KHÔNG tự import node:fs. Nó nhận `fs` và `pathGuard` qua ctx. Đây là
 *    cách ép nguyên tắc "filesystem một cửa" (nguyên tắc #7).
 *
 * 3. Tool trả về kết quả có cấu trúc, không phải chuỗi. Việc bọc delimiter
 *    untrusted và cắt ngắn là của AgentLoop — tool không nên biết nó đang nói
 *    chuyện với model nào.
 */
import type { z } from 'zod';
import { zodToJsonSchema } from './jsonSchema.js';
import type { FileSystem } from '../fs/FileSystem.js';
import type { PathGuard } from '../security/pathGuard.js';
import type { Denylist } from '../security/denylist.js';
import type { Logger } from '../telemetry/logger.js';
import type { ToolDefinition } from '../provider/types.js';
import type { ChangeLedger } from '../changes/ChangeLedger.js';
import type { Sandbox } from '../sandbox/Sandbox.js';
import type { BackgroundJobs } from './background.js';
import type { AskUserFn } from './askUser.js';
import type { CodeGraphProvider } from '../graph/types.js';

export interface ToolContext {
  workspaceRoot: string;
  fs: FileSystem;
  pathGuard: PathGuard;
  denylist: Denylist;
  logger: Logger;
  signal?: AbortSignal;
  /** Sổ thay đổi của phiên (M4). Tool ghi file PHẢI ghi vào đây. */
  ledger?: ChangeLedger;
  /** Lượt chat hiện tại — để sổ rollback được theo lượt. */
  turnId?: string;
  /** Sandbox chạy lệnh (M5). Không có = tool bash không chạy được. */
  sandbox?: Sandbox;
  /**
   * Sổ tác vụ nền của phiên. Không có = `run_in_background` không dùng được và
   * `task_status`/`task_kill` không được đăng ký.
   *
   * Sống ở PHIÊN chứ không ở lượt: một lệnh bật ở lượt này phải hỏi được kết
   * quả ở lượt sau, đó mới là lý do tồn tại của nó.
   */
  jobs?: BackgroundJobs;
  /**
   * Kênh output trực tiếp cho tool chạy lâu (bash).
   *
   * Chỉ để HIỂN THỊ. Model vẫn chỉ nhận `ToolResult.content` ở cuối — nếu tool
   * đẩy được nội dung vào context qua đường này thì mọi lớp cắt ngắn, quét
   * injection và bọc delimiter của AgentLoop đều bị đi vòng qua.
   */
  onOutput?: (text: string) => void;
  /**
   * Hỏi người dùng chọn giữa vài lựa chọn qua nút bấm, thay vì để họ gõ lại.
   * Không có = `ask_user_question` không được đăng ký (xem
   * `RegistryOptions.hasAskUser`); tool vẫn tự kiểm phòng thủ ở `execute()`.
   */
  askUser?: AskUserFn;
  /**
   * CodeGraph của workspace (M12). Không có = `find_references`/`impact_of`
   * không được đăng ký (xem `RegistryOptions.codeGraph` ở `tools/index.ts`).
   */
  codeGraph?: CodeGraphProvider;
}

export interface ToolResult {
  /** Nội dung đưa lại cho model. */
  content: string;
  /**
   * Nội dung này đến từ nguồn không tin cậy (file trong repo, web, MCP...).
   * AgentLoop dùng cờ này để bọc delimiter và để quét injection.
   * Mặc định TRUE — an toàn phải là mặc định, không phải lựa chọn.
   */
  untrusted?: boolean;
  /**
   * Vùng tin cậy của nguồn (documents/SECURITY.md §0).
   *   B = file trong repo, output lệnh của chính repo — mặc định.
   *   C = nội dung từ bên ngoài hẳn: web, MCP server, repo lạ.
   *
   * Zone C làm phiên TỰ HẠ CẤP quyền về `ask` (M4). Cố ý không để bash mặc
   * định là C: hạ cấp sau mỗi lần chạy test sẽ khiến acceptEdits vô dụng, và
   * người dùng sẽ tắt cảnh báo — lúc đó cơ chế mất tác dụng thật sự.
   */
  trustZone?: 'B' | 'C';
  /** Metadata cho UI: file nào được đọc, bao nhiêu kết quả... */
  meta?: Record<string, unknown>;
  /** Tool chạy nhưng thất bại có kiểm soát (file không có, pattern sai...). */
  isError?: boolean;
}

export interface Tool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  /** Model đọc mô tả này để quyết định gọi. Viết theo hướng "dùng khi nào". */
  description: string;
  schema: TSchema;
  /**
   * JSON Schema gửi lên model, thay cho bản sinh từ `schema` (M7).
   *
   * Chỉ tool MCP dùng: schema thật do server bên ngoài định nghĩa và chỉ tồn
   * tại ở dạng JSON Schema. Dịch ngược nó sang zod để rồi sinh lại JSON Schema
   * là thêm một chỗ mất thông tin, mà đổi lại không được gì — việc kiểm đối số
   * vẫn do chính server đó làm.
   */
  jsonSchema?: Record<string, unknown>;
  /** Tool chỉ đọc — không cần người dùng duyệt (M4 dùng để phân loại). */
  readOnly: boolean;
  execute(args: z.infer<TSchema>, ctx: ToolContext): Promise<ToolResult>;
  /**
   * Mô tả thao tác sắp làm, để hộp duyệt quyền nói được điều gì cụ thể thay vì
   * "cho phép write_file?". Chạy TRƯỚC execute nên không được gây tác dụng phụ;
   * đọc file để dựng diff xem trước thì được.
   */
  describe?(args: z.infer<TSchema>, ctx: ToolContext): Promise<ToolIntent>;
}

/** Thứ người dùng nhìn thấy trong hộp duyệt quyền. */
export interface ToolIntent {
  summary: string;
  /** Đường dẫn tương đối bị tác động — PermissionManager nhớ quyền theo nó. */
  path?: string;
  /** Diff hoặc trích đoạn để người dùng quyết định có căn cứ. */
  preview?: string;
  /**
   * `preview` là loại nội dung gì. Mặc định `text`.
   *
   * Do TOOL khai chứ không để UI đoán theo hình dạng chuỗi. Đoán là sai được:
   * một script shell có dòng bắt đầu bằng `-` trông y hệt một dòng bị xoá
   * trong diff, và tô đỏ nó trong hộp duyệt quyền là nói dối người dùng đúng
   * lúc họ đang quyết định có cho chạy hay không.
   */
  previewKind?: PreviewKind;
  /**
   * Điều người dùng PHẢI biết trước khi bấm duyệt — mỗi phần tử một câu.
   *
   * Có warning thì thao tác này bị hỏi BẤT KỂ chế độ quyền: `acceptEdits` và
   * mọi "luôn cho phép" đã nhớ đều không áp dụng nữa (xem `PermissionManager`).
   * Nên đây không phải chỗ để ghi chú chung chung — mỗi dòng thêm vào đây là
   * một lần dừng tay người dùng, và một dòng không đáng dừng sẽ dạy họ bấm
   * Allow mà không đọc.
   *
   * Chỗ dùng hiện nay: lệnh hoặc script với tay ra ngoài workspace — xem
   * `security/workspaceEscape.ts`.
   */
  warnings?: string[];
}

export type PreviewKind = 'diff' | 'command' | 'text';

/** Lỗi tool ném ra khi đối số hợp lệ nhưng thao tác không làm được. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const t of tools) this.register(t);
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool trùng tên: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  all(): Tool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Định nghĩa gửi lên model theo chuẩn OpenAI. */
  definitions(): ToolDefinition[] {
    return this.all().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.jsonSchema ?? zodToJsonSchema(t.schema),
    }));
  }
}
