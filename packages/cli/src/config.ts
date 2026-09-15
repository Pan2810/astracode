/**
 * Cấu hình CLI: `~/.astra/settings.json`, ghi đè được bằng `settings.local.json`
 * rồi bằng biến môi trường.
 *
 * Cùng ý nghĩa với `astra.*` trong settings.json của extension, cùng mặc định.
 * Hai đầu phải khớp — người dùng chuyển qua lại giữa terminal và VS Code trong
 * cùng một phiên làm việc, và "cùng repo, cùng model, khác quyền" là cách nhanh
 * nhất để mất niềm tin vào cả hai.
 *
 * ## Vì sao có hai file
 *
 * `settings.json` là thứ chép sang máy khác được, dán vào issue được, cho vào
 * dotfiles được. `settings.local.json` là phần chỉ đúng trên máy này (gateway
 * chạy localhost, mức log đang bật để soi một lỗi). Không tách ra thì mỗi lần
 * muốn chia sẻ cấu hình người dùng phải tự nhớ xoá những dòng nào.
 *
 * Bí mật KHÔNG nằm ở cả hai file — token ở `credentials.json`. Xem tokenStore.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  ASTRAWORK_WEB_URL,
  DEFAULT_MODEL_ID,
  DEFAULT_PLAN_MODEL_ID,
  GATEWAY_BASE_URL,
} from '@astra/core';
import { legacyConfigPath, settingsLocalPath, settingsPath, ensureHome } from './home.js';

export type PermissionModeSetting = 'plan' | 'ask' | 'acceptEdits';

export interface CliConfig {
  /**
   * Gốc gateway AstraWork. KHÔNG kèm `/v1` — CLI tự thêm.
   *
   * KHÔNG đọc từ file hay biến môi trường: hằng số ở core/config/endpoints.ts,
   * đúng địa chỉ mà extension dùng. Có mặt trong CliConfig để phần còn lại của
   * CLI vẫn đọc cấu hình ở một chỗ.
   */
  gatewayBaseUrl: string;
  /** Trang web AstraWork (Next.js), để mở đăng nhập. Cũng cố định. */
  astraworkWebUrl: string;
  /**
   * Model cho việc SỬA CODE — cùng ý nghĩa với `astra.model` của extension.
   * Ba khoá `models.editor/planner/fast` cũ đã bỏ; xem core/config/model.ts.
   */
  model: string;
  /**
   * Model cho việc LẬP KẾ HOẠCH (và đọc ảnh, ở bề mặt nào có ảnh) — cùng ý
   * nghĩa với `astra.planModel` của extension.
   */
  planModel: string;
  /**
   * Mặc định `ask`, giống extension. CLI không phải là lý do để nới quyền:
   * một agent chạy trong terminal đụng đúng những file mà bản trong VS Code đụng.
   */
  permissionMode: PermissionModeSetting;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const DEFAULTS: CliConfig = {
  // Địa chỉ AstraWork của đội, xem core/config/endpoints.ts. KHÔNG ghi đè được
  // — hai dòng này đi thẳng vào `loadConfig` mà không qua file hay env.
  gatewayBaseUrl: GATEWAY_BASE_URL,
  astraworkWebUrl: ASTRAWORK_WEB_URL,
  model: DEFAULT_MODEL_ID,
  planModel: DEFAULT_PLAN_MODEL_ID,
  permissionMode: 'ask',
  logLevel: 'warn',
};

function readJson(path: string): Partial<CliConfig> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<CliConfig>) : {};
  } catch {
    // Chưa có file, hoặc file hỏng. Cả hai đều không đáng làm hỏng lệnh đang
    // chạy — `astracode login` sẽ ghi lại nó.
    return {};
  }
}

/**
 * Bản đã trộn từ đĩa, chưa tính biến môi trường.
 *
 * `config.json` cũ vẫn được đọc khi chưa có `settings.json`: migrate có thể
 * chưa chạy (người dùng lùi bản, hoặc chép tay `~/.astra` từ máy khác sang), và
 * lúc đó im lặng quên hết cấu hình là hành vi tệ nhất có thể.
 */
function readFiles(): Partial<CliConfig> {
  const base = readJson(settingsPath());
  const primary = Object.keys(base).length > 0 ? base : readJson(legacyConfigPath());
  const local = readJson(settingsLocalPath());
  return { ...primary, ...local };
}

export function loadConfig(): CliConfig {
  const file = readFiles();
  const env = process.env;
  return {
    // Cố ý bỏ qua cả `file` lẫn `env`: `ASTRAWORK_BASE_URL` và
    // `gatewayBaseUrl` trong settings.json không còn nghĩa gì. Một khoá cũ sót
    // lại trong `~/.astra/settings.json` cũng không đổi được đích đến nữa.
    gatewayBaseUrl: DEFAULTS.gatewayBaseUrl,
    astraworkWebUrl: DEFAULTS.astraworkWebUrl,
    model: env.ASTRA_MODEL || file.model || DEFAULTS.model,
    planModel: env.ASTRA_PLAN_MODEL || file.planModel || DEFAULTS.planModel,
    permissionMode: (env.ASTRA_PERMISSION_MODE as PermissionModeSetting) ||
      file.permissionMode || DEFAULTS.permissionMode,
    logLevel: (env.ASTRA_LOG_LEVEL as CliConfig['logLevel']) || file.logLevel || DEFAULTS.logLevel,
  };
}

/**
 * Ghi vào `settings.json`.
 *
 * Không bao giờ ghi vào `settings.local.json`: file đó là của người dùng, và một
 * lệnh tự thêm dòng vào đấy sẽ làm hỏng đúng thứ mà việc tách file muốn bảo vệ.
 */
export function saveConfig(patch: Partial<CliConfig>): void {
  ensureHome();
  const merged = { ...readJson(settingsPath()), ...patch };
  writeFileSync(settingsPath(), JSON.stringify(merged, null, 2) + '\n', 'utf8');
}
