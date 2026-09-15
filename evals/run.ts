/**
 * CLI của eval harness — mốc M2.5.
 *
 *   pnpm eval -- --model <id>                    # qua gateway AstraWork
 *   pnpm eval -- --model <id> --provider fpt     # gọi thẳng FPT (chỉ khi gateway chưa có)
 *   pnpm eval -- --model <id> --group security   # chỉ chạy nhóm bảo mật
 *   pnpm eval -- --model <id> --protocol xml     # ép đường XML fallback
 *   pnpm eval -- --list                          # xem danh sách task
 *
 * Chạy eval cần model THẬT. Bản thân harness được kiểm chứng bằng
 * lib/runner.test.ts với MockProvider, không cần credential.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AstraWorkAuth,
  GatewayProvider,
  Logger,
  MemorySink,
  MemoryTokenStore,
  ModelRegistry,
  GatewayModelSource,
  FptModelSource,
  EMPTY_MODELS_FILE,
  parseModelsFile,
  type ModelsFile,
  type Provider,
} from '@astra/core';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Capability profile do `astracode measure` sinh ra.
 *
 * Cùng file mà CLI và extension đọc (`~/.astra/models.json`) — eval phải chạy
 * đúng giao thức tool-calling mà sản phẩm sẽ dùng, nếu không thì nó đang đo một
 * cấu hình không ai chạy. Thiếu file thì rơi về mặc định an toàn.
 */
function loadProfiles(): ModelsFile {
  const path = join(process.env.ASTRA_HOME || join(homedir(), '.astra'), 'models.json');
  try {
    return parseModelsFile(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return EMPTY_MODELS_FILE;
  }
}
import { runSuite } from './lib/runner.js';
import { printProgress, printRun, saveRun } from './lib/report.js';
import { ALL_TASKS, selectTasks } from './tasks/index.js';
import type { TaskGroup } from './lib/types.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function loadEnv(): void {
  for (const file of ['.env', '.env.local']) {
    let raw: string;
    try {
      raw = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (line.trimStart().startsWith('#')) continue;
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1]!;
      let value = m[2]!.trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--')) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  if (flag('help') || flag('h')) {
    console.log(
      [
        '',
        'eval — đo chất lượng agent (M2.5)',
        '',
        '  --model <id>          model cần đo (bắt buộc)',
        '  --provider gateway    mặc định; hoặc `fpt` để gọi thẳng',
        '  --protocol native|xml ép đường tool-calling, mặc định native',
        '  --group codebase|security',
        '  --filter <chuỗi>      lọc theo id hoặc mục đích của task',
        '  --list                in danh sách task rồi thoát',
        '  --keep-workdir        giữ thư mục tạm để soi khi debug',
        '',
      ].join('\n'),
    );
    return;
  }

  if (flag('list')) {
    console.log(`\n${ALL_TASKS.length} task:\n`);
    for (const t of ALL_TASKS) {
      console.log(`  ${t.group.padEnd(9)} ${t.id.padEnd(34)} ${t.intent}`);
    }
    console.log();
    return;
  }

  loadEnv();

  const model = arg('model') ?? fail('Thiếu --model. Xem `pnpm eval -- --list` để biết task.');
  const providerName = arg('provider') ?? 'gateway';
  const protocol = (arg('protocol') ?? 'native') as 'native' | 'xml';
  const group = arg('group') as TaskGroup | undefined;

  const tasks = selectTasks({
    ...(group ? { group } : {}),
    ...(arg('filter') ? { filter: arg('filter')! } : {}),
  });
  if (tasks.length === 0) fail('Không task nào khớp bộ lọc.');

  const logger = new Logger({ sink: new MemorySink(), level: 'warn' });
  let provider: Provider;
  let providerLabel: string;

  if (providerName === 'fpt') {
    const baseURL = process.env.FPT_BASE_URL ?? fail('Thiếu FPT_BASE_URL trong .env');
    const apiKey = process.env.FPT_API_KEY ?? fail('Thiếu FPT_API_KEY trong .env');
    const registry = new ModelRegistry({
      source: new FptModelSource({ baseURL, getToken: () => Promise.resolve(apiKey) }),
      profiles: loadProfiles(),
      logger,
    });
    provider = new GatewayProvider({
      baseURL,
      getToken: () => Promise.resolve(apiKey),
      registry,
      logger,
    });
    providerLabel = `fpt:${baseURL}`;
  } else {
    const baseURL =
      process.env.ASTRAWORK_BASE_URL ?? fail('Thiếu ASTRAWORK_BASE_URL trong .env');
    const token = process.env.ASTRAWORK_TOKEN ?? fail('Thiếu ASTRAWORK_TOKEN trong .env');
    const auth = new AstraWorkAuth({
      baseURL,
      tokenStore: new MemoryTokenStore(token),
    });
    const registry = new ModelRegistry({
      source: new GatewayModelSource({ baseURL, getToken: () => auth.requireToken() }),
      profiles: loadProfiles(),
      logger,
    });
    provider = new GatewayProvider({
      baseURL: `${baseURL}/v1`,
      getToken: () => auth.requireToken(),
      onUnauthorized: () => auth.handleUnauthorized(),
      registry,
      logger,
    });
    providerLabel = `gateway:${baseURL}`;
  }

  console.log(`\nChạy ${tasks.length} task trên ${model} (${protocol})...\n`);

  const run = await runSuite(tasks, {
    makeProvider: () => provider,
    model,
    protocol,
    providerLabel,
    onTaskDone: printProgress,
    keepWorkdir: flag('keep-workdir'),
  });

  printRun(run);
  const file = await saveRun(run);
  console.log(`  Đã lưu ${file}\n`);

  // Nhóm bảo mật trượt là lỗi chặn, không phải cảnh báo.
  const sec = run.summary.byGroup.security;
  if (sec && sec.passed < sec.total) process.exit(1);
}

void main();
