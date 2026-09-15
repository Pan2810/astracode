/**
 * Demo M1 — chứng minh lớp provider chạy thật, ngoài VS Code.
 *
 *   pnpm demo
 *
 * Nghiệm thu của M1 (docs/PLAN.md): đăng nhập -> nhập prompt -> stream ra
 * terminal -> Ctrl+C hủy được.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import {
  AstraWorkAuth,
  ConsoleSink,
  GatewayProvider,
  Logger,
  MemoryTokenStore,
  ModelRegistry,
  GatewayModelSource,
  defaultRedactor,
  EMPTY_MODELS_FILE,
  newTraceId,
  AstraError,
  type ChatMessage,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

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
      const value = m[2]!.trim().replace(/^["']|["']$/g, '');
      if (!process.env[m[1]!]) process.env[m[1]!] = value;
    }
  }
}

async function main(): Promise<void> {
  loadEnv();

  const baseURL = process.env.ASTRAWORK_BASE_URL;
  if (!baseURL) {
    console.error('\n  Thiếu ASTRAWORK_BASE_URL. Sao chép .env.example thành .env.\n');
    process.exit(2);
  }

  const logger = new Logger({
    sink: new ConsoleSink(),
    level: (process.env.ASTRA_LOG_LEVEL as 'debug' | 'info') ?? 'info',
  });

  // ── Đăng nhập ───────────────────────────────────────────────────────────
  const auth = new AstraWorkAuth({
    baseURL,
    tokenStore: new MemoryTokenStore(process.env.ASTRAWORK_TOKEN),
    redactor: defaultRedactor,
  });

  if (process.env.ASTRAWORK_TOKEN) {
    defaultRedactor.addLiteral(process.env.ASTRAWORK_TOKEN);
  }

  if (!(await auth.getToken())) {
    const user = process.env.ASTRAWORK_ADMIN_USER;
    const pass = process.env.ASTRAWORK_ADMIN_PASSWORD;
    if (user && pass) {
      // Đường này CHỈ dùng được cho tài khoản admin — xem auth.py của AstraWork.
      await auth.loginWithPassword(user, pass);
    } else {
      console.error(
        `\n  Chưa có token.\n` +
          `  Cách 1 — tài khoản admin: đặt ASTRAWORK_ADMIN_USER / ASTRAWORK_ADMIN_PASSWORD\n` +
          `  Cách 2 — tài khoản thường: mở URL sau, đăng nhập, lấy code rồi đặt vào\n` +
          `           ASTRAWORK_TOKEN (hoặc đổi code bằng POST /auth/sso/exchange):\n` +
          `           ${auth.ssoLoginUrl('/')}\n`,
      );
      process.exit(2);
    }
  }

  const state = await auth.state();
  console.log(`\n  Đã đăng nhập: ${state.username ?? '?'} (${state.role ?? '?'})`);

  // ── Ghép model ──────────────────────────────────────────────────────────
  const registry = new ModelRegistry({
    source: new GatewayModelSource({
      baseURL,
      getToken: () => auth.requireToken(),
    }),
    profiles: EMPTY_MODELS_FILE,
    logger,
  });
  await registry.load();

  const usable = registry.usable();
  if (usable.length === 0) {
    console.error('\n  Không có model nào dùng được cho tài khoản này.\n');
    process.exit(1);
  }
  console.log(`  Model dùng được: ${usable.map((m) => m.id).join(', ')}`);

  const chosen = process.env.ASTRA_MODEL ?? registry.resolve('editor');
  console.log(`  Đang dùng: ${chosen}\n`);

  // ── Vòng chat ───────────────────────────────────────────────────────────
  const provider = new GatewayProvider({
    baseURL: `${baseURL.replace(/\/+$/, '')}/v1`,
    getToken: () => auth.requireToken(),
    onUnauthorized: () => auth.handleUnauthorized(),
    registry,
    logger,
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history: ChatMessage[] = [];

  // Ctrl+C lần đầu hủy lượt đang chạy; lần hai thoát hẳn.
  let inflight: AbortController | undefined;
  process.on('SIGINT', () => {
    if (inflight && !inflight.signal.aborted) {
      inflight.abort();
      process.stdout.write('\n  (đã hủy)\n');
    } else {
      rl.close();
      process.exit(0);
    }
  });

  console.log('  Gõ câu hỏi, Ctrl+C để hủy lượt đang chạy, Ctrl+C lần nữa để thoát.\n');

  for (;;) {
    const input = (await rl.question('> ')).trim();
    if (!input) continue;
    if (input === '/exit') break;

    history.push({ role: 'user', content: input });
    inflight = new AbortController();

    try {
      for await (const ev of provider.stream({
        ...(chosen ? { model: chosen } : {}),
        messages: history,
        signal: inflight.signal,
        traceId: newTraceId(),
      })) {
        switch (ev.type) {
          case 'text':
            process.stdout.write(ev.delta);
            break;
          case 'retrying':
            process.stdout.write(`\n  [thử lại lần ${ev.attempt} sau ${ev.delayMs}ms]\n`);
            break;
          case 'model_switched':
            process.stdout.write(`\n  [chuyển sang ${ev.to}: ${ev.reason}]\n`);
            break;
          case 'usage':
            process.stdout.write(
              `\n  [${ev.usage.promptTokens} vào / ${ev.usage.completionTokens} ra]`,
            );
            break;
          case 'done':
            process.stdout.write('\n\n');
            break;
          default:
            break;
        }
      }
    } catch (err) {
      if (err instanceof AstraError) {
        console.error(`\n  ${err.code}: ${err.message}\n`);
      } else {
        console.error(`\n  Lỗi: ${String(err)}\n`);
      }
    } finally {
      inflight = undefined;
    }
  }

  rl.close();
}

void main();
