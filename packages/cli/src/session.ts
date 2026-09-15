/**
 * Lắp phiên CLI: auth → registry → provider.
 *
 * Đúng những mảnh mà `packages/vscode/src/session.ts` lắp, theo đúng thứ tự đó.
 * Không có bản sao logic nào ở đây — nếu có thì hai đầu sẽ trôi ra xa nhau và
 * "chạy được trong VS Code nhưng không chạy trong terminal" sẽ thành một loại
 * bug thường trực.
 */
import {
  AstraWorkAuth,
  BUNDLED_MODELS_FILE,
  GatewayModelSource,
  GatewayProvider,
  Logger,
  ModelRegistry,
  IdePolicyClient,
  IdePolicySchema,
  defaultRedactor,
  mergeModelsFiles,
  parseModelsFile,
  type IdePolicy,
  type ModelsFile,
  type PolicyCache,
} from '@astra/core';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig, type CliConfig } from './config.js';
import { FileTokenStore } from './tokenStore.js';
import { ensureHome, modelsPath, policyPath } from './home.js';
import { c, err } from './ui.js';

export interface CliSession {
  config: CliConfig;
  auth: AstraWorkAuth;
  registry: ModelRegistry;
  provider: GatewayProvider;
  logger: Logger;
  profiles: ModelsFile;
  /** Lấy trần cấu hình của tổ chức (M9). Gọi khi đã có token. */
  loadPolicy: () => Promise<{ policy: IdePolicy; stale: boolean }>;
}

/**
 * Cache policy trên đĩa.
 *
 * Ghi best-effort: không ghi được thì lần sau phải gọi mạng lại, chứ không phải
 * lý do làm hỏng lệnh đang chạy. Đọc thì khác — đọc hỏng mà im lặng trả
 * `undefined` sẽ khiến máy mất mạng rơi về mặc định LỎNG HƠN bản đã cache, nên
 * chỗ đó phải là JSON hợp lệ hoặc không có gì cả.
 */
function filePolicyCache(): PolicyCache {
  return {
    read(): IdePolicy | undefined {
      try {
        return IdePolicySchema.parse(JSON.parse(readFileSync(policyPath(), 'utf8')));
      } catch {
        return undefined;
      }
    },
    write(policy: IdePolicy): void {
      try {
        ensureHome();
        writeFileSync(policyPath(), JSON.stringify(policy, null, 2) + '\n', 'utf8');
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Capability profile: bản ship sẵn theo AstraCode, chồng thêm bản của người
 * dùng ở `~/.astra/models.json` nếu có.
 *
 * Thiếu file của người dùng KHÔNG phải lỗi và cũng không còn làm suy giảm gì —
 * model không có profile chạy bằng `INFERRED_DEFAULTS`, và đó là đường mặc
 * định. File HỎNG thì khác: nói ra, vì im lặng bỏ qua sẽ khiến người vừa chạy
 * `astracode measure` tưởng việc đo không có tác dụng gì.
 */
export function loadProfiles(): ModelsFile {
  let raw: string;
  try {
    raw = readFileSync(modelsPath(), 'utf8');
  } catch {
    return BUNDLED_MODELS_FILE;
  }
  try {
    return mergeModelsFiles(BUNDLED_MODELS_FILE, parseModelsFile(JSON.parse(raw)));
  } catch (e) {
    err(c.yellow(`  Bỏ qua ${modelsPath()}: ${(e as Error).message}`));
    return BUNDLED_MODELS_FILE;
  }
}

export function buildSession(): CliSession {
  // Không còn kiểm tra địa chỉ ở đây: nó là hằng số trong bản build, nên
  // "chưa cấu hình" và "gõ nhầm kèm /v1" đều không xảy ra được nữa.
  const config = loadConfig();

  const logger = new Logger({ level: config.logLevel, redactor: defaultRedactor });
  const auth = new AstraWorkAuth({
    baseURL: config.gatewayBaseUrl,
    tokenStore: new FileTokenStore(),
    redactor: defaultRedactor,
  });

  const fileProfiles = loadProfiles();
  // Model do người dùng chỉ định thắng routing sinh ra từ phép đo — giống
  // hệt thứ tự ưu tiên bên extension.
  const profiles: ModelsFile = {
    ...fileProfiles,
    routing: {
      ...fileProfiles.routing,
      // Hai model, chia theo loại việc — cùng đường chia với extension, xem
      // core/config/model.ts.
      editor: config.model || fileProfiles.routing.editor,
      fast: config.model || fileProfiles.routing.fast,
      planner: config.planModel || fileProfiles.routing.planner,
      vision: config.planModel || fileProfiles.routing.vision,
    },
  };

  const registry = new ModelRegistry({
    source: new GatewayModelSource({
      baseURL: config.gatewayBaseUrl,
      getToken: () => auth.requireToken(),
    }),
    profiles,
    logger,
  });

  const provider = new GatewayProvider({
    baseURL: `${config.gatewayBaseUrl}/v1`,
    getToken: () => auth.requireToken(),
    onUnauthorized: () => auth.handleUnauthorized(),
    registry,
    logger,
  });

  const policyClient = new IdePolicyClient({
    baseURL: config.gatewayBaseUrl,
    getToken: () => auth.requireToken(),
    cache: filePolicyCache(),
  });

  return {
    config,
    auth,
    registry,
    provider,
    logger,
    profiles,
    loadPolicy: () => policyClient.load(),
  };
}
