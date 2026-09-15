/**
 * Đọc cấu hình từ VS Code settings.
 *
 * Phân chia có chủ đích:
 *   - settings.json giữ thứ KHÔNG bí mật: endpoint, chọn model, mức log.
 *   - SecretStorage giữ thứ bí mật: token AstraWork.
 * Không bao giờ trộn hai loại (documents/SECURITY.md §2.6).
 *
 * Từ v0.0.11 chỉ còn MỘT nguồn model: gateway AstraWork. Đường gọi thẳng FPT
 * đã bị gỡ — nó bỏ qua RBAC, audit, redaction và hạn mức, và sự tồn tại của
 * nó biến "chưa đăng nhập" thành một trạng thái vẫn chat được.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  ASTRAWORK_WEB_URL,
  DEFAULT_MODEL_ID,
  DEFAULT_PLAN_MODEL_ID,
  GATEWAY_BASE_URL,
  type LogLevel,
} from '@astra/core';

export type SandboxMode = 'docker' | 'host' | 'off';
export type PermissionModeSetting = 'plan' | 'ask' | 'acceptEdits';
export type NetworkProfileSetting = 'none' | 'restricted' | 'full';
export type McpModeSetting = 'off' | 'on';

export interface AstraConfig {
  /**
   * Gateway API. KHÔNG đọc từ settings — giá trị cố định ở
   * `core/config/endpoints.ts`. Vẫn đi qua đây vì mọi thứ hạ nguồn (session,
   * usage sync, policy) đã nhận địa chỉ từ config, và một chỗ duy nhất để đọc
   * vẫn đúng hơn là mười chỗ cùng import hằng số.
   */
  gatewayBaseUrl: string;
  /**
   * Trang web AstraWork (Next.js), KHÁC với gateway API. Cũng cố định.
   *
   * Hai địa chỉ vì đó là hai thứ khác nhau: người dùng đăng nhập ở web, còn
   * extension gọi API. Gộp lại thành một sẽ sai ở cả hai đầu — mở
   * `api.astrawork…/login` ra trang trắng, còn gọi `astrawork…/models` ra 404
   * của Next.js.
   */
  astraworkWebUrl: string;
  /**
   * Model cho việc SỬA CODE, và cho những lượt phụ chạy kèm (đặt tiêu đề, nén
   * hội thoại). Xem core/config/model.ts để biết vì sao chỉ có hai ô chứ không
   * phải một hay bốn.
   */
  model: string;
  /**
   * Model cho lượt CÓ ẢNH và lượt chạy trong chế độ plan. Cùng lý do tách đôi
   * ở core/config/model.ts: đọc và tóm tắt là việc khác với sửa code.
   */
  planModel: string;
    logLevel: LogLevel;
  /** Chế độ quyền mặc định khi mở phiên mới (M4). */
  permissionMode: PermissionModeSetting;
  /** Nơi tool bash chạy (M5). `off` = không có tool bash. */
  sandbox: SandboxMode;
  /** Profile mạng của container sandbox. Chỉ người dùng đổi được. */
  sandboxNetwork: NetworkProfileSetting;
  /** Thư mục chứa docker-compose.yml của sandbox. */
  sandboxDir: string;
  /**
   * Bật MCP (M7). Mặc định `off`, cùng lý do với sandbox: mỗi server MCP là mã
   * của người khác chạy cạnh code của bạn. Người dùng bật khi họ cần.
   */
  mcp: McpModeSetting;
  /** Tự nén hội thoại khi ngữ cảnh gần đầy (M6). */
  autoCompact: boolean;
  /**
   * Lệnh chạy sau mỗi lượt có sửa file (M6). Rỗng = tắt.
   *
   * CHỈ đọc từ cài đặt người dùng (global), không bao giờ từ cài đặt workspace
   * — xem `readVerifyCommand`.
   */
  verifyCommand: string;
}

export const SECRET_KEY_ASTRAWORK_TOKEN = 'astra.astrawork.token';

export function readConfig(): AstraConfig {
  const c = vscode.workspace.getConfiguration('astra');
  return {
    // Cố định trong code, không đọc settings. Đổi địa chỉ là sửa
    // core/config/endpoints.ts rồi phát hành bản mới.
    gatewayBaseUrl: GATEWAY_BASE_URL,
    astraworkWebUrl: ASTRAWORK_WEB_URL,
    // Ô trống = dùng model mặc định, cùng lẽ với hai ô địa chỉ ở trên.
    model: c.get<string>('model', '').trim() || DEFAULT_MODEL_ID,
    planModel: c.get<string>('planModel', '').trim() || DEFAULT_PLAN_MODEL_ID,
    logLevel: c.get<LogLevel>('logLevel', 'info'),
    // Mặc định `ask`: mốc M4 vừa cho agent quyền ghi, và mặc định an toàn phải
    // là mặc định. Người dùng bật acceptEdits khi họ đã tin nó.
    permissionMode: c.get<PermissionModeSetting>('permissionMode', 'ask'),
    // Mặc định `host`: chạy lệnh trực tiếp trên máy người dùng. Bỏ qua Docker
    // làm mặc định vì không phải máy nào cũng có Docker, và agent cần chạy được
    // lệnh (test, build, psql, mysql...) ngay. Người dùng muốn cách ly thì đổi
    // sang `docker`; muốn tắt hẳn thì để `off`.
    sandbox: c.get<SandboxMode>('sandbox', 'host'),
    sandboxNetwork: c.get<NetworkProfileSetting>('sandbox.network', 'none'),
    sandboxDir: c.get<string>('sandbox.dir', 'sandbox').trim(),
    // Mặc định `off` — xem chú thích của trường mcp trong AstraConfig.
    mcp: c.get<McpModeSetting>('mcp', 'off'),
    // Mặc định bật: tắt nó nghĩa là chọn để lượt chat vỡ khi context đầy, và
    // đó không phải lựa chọn mặc định hợp lý cho ai cả.
    autoCompact: c.get<boolean>('autoCompact', true),
    // Cố ý KHÔNG dùng `c.get` — xem chú thích của inspectVerifyCommand.
    verifyCommand: inspectVerifyCommand().command,
  };
}

/**
 * Lệnh kiểm tra sau khi sửa — CHỈ lấy từ cài đặt người dùng.
 *
 * `.vscode/settings.json` nằm trong repo, nên nó đến từ bất kỳ ai gửi PR vào
 * đó. Một lệnh shell chạy tự động lấy từ đấy là RCE chỉ bằng việc mở thư mục
 * lên (nguyên tắc #8). `get()` gộp mọi tầng cài đặt lại nên không
 * dùng được ở đây; `inspect()` là cách duy nhất phân biệt được nguồn.
 *
 * Trả về cả `ignored` để UI nói được vì sao lệnh trong repo không chạy — im
 * lặng bỏ qua sẽ khiến người dùng tưởng tính năng hỏng.
 */
export function inspectVerifyCommand(): { command: string; ignoredFromWorkspace: boolean } {
  const c = vscode.workspace.getConfiguration('astra');
  const info = c.inspect<string>('verifyCommand');
  const fromWorkspace = (info?.workspaceValue ?? info?.workspaceFolderValue ?? '').trim();

  return {
    command: (info?.globalValue ?? '').trim(),
    ignoredFromWorkspace: fromWorkspace.length > 0,
  };
}

export async function updateConfig(
  key: string,
  value: unknown,
  target = vscode.ConfigurationTarget.Global,
): Promise<void> {
  await vscode.workspace.getConfiguration('astra').update(key, value, target);
}

/**
 * Thư mục sandbox/, giải theo workspace nếu là đường dẫn tương đối.
 * Trả undefined khi không có workspace — lúc đó cũng chẳng có gì để chạy lệnh.
 */
export function resolveSandboxDir(cfg: AstraConfig): string | undefined {
  if (!cfg.sandboxDir) return undefined;
  if (path.isAbsolute(cfg.sandboxDir)) return cfg.sandboxDir;

  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) return undefined;
  return path.join(root.uri.fsPath, ...cfg.sandboxDir.split(/[\\/]/));
}

/*
 * `astraworkLoginUrl()` và `validateConfig()` từng ở đây và đã bị gỡ.
 *
 * Cả hai chỉ tồn tại vì địa chỉ đến từ settings: một cái canh scheme trước khi
 * đưa cho `openExternal` (settings đọc được từ `.vscode/settings.json`, tức là
 * từ bất kỳ ai gửi PR), cái kia bắt các lỗi gõ tay — trống, kèm `/v1`, http ra
 * ngoài Internet. Địa chỉ giờ là hằng số https viết trong code, nên không lỗi
 * nào trong số đó xảy ra được nữa, và một hàm kiểm tra không bao giờ trả về gì
 * chỉ dạy người đọc rằng chỗ này có canh gác.
 *
 * Trang đăng nhập lấy ở `ASTRAWORK_LOGIN_URL` của core.
 */
