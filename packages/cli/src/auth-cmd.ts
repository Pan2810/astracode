/**
 * `astracode login` / `logout` / `whoami`.
 *
 * Đường đăng nhập chính là SSO: mở trang AstraWork, người dùng đăng nhập bằng
 * Microsoft, trang `/ide-auth` deep-link về `vscode://…`. CLI không nhận được
 * deep-link đó, nên nó nhận MÃ MỘT LẦN dán vào — cùng cái mã mà trang kia
 * chuyển tiếp, dùng một lần và hết hạn sau 90 giây.
 *
 * Cũng nhận thẳng JWT (`--token`) cho CI và cho ai vừa bấm "AstraCode: Sao chép
 * token AstraWork" trong VS Code.
 *
 * KHÔNG có đăng nhập bằng mật khẩu ở đây cho tài khoản thường: gateway chỉ cho
 * admin dùng đường đó (`routers/auth.py`), vì mật khẩu cục bộ không đi qua MFA
 * và conditional access của tenant.
 */
import { createInterface } from 'node:readline/promises';
import { buildSession } from './session.js';
import { loadConfig } from './config.js';
import { FileTokenStore } from './tokenStore.js';
import { c, out } from './ui.js';

function flag(args: string[], name: string): string | undefined {
  const withEq = args.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function runLogin(args: string[]): Promise<void> {
  // `--gateway` và `--web` đã bỏ: địa chỉ AstraWork là hằng số trong bản build
  // (core/config/endpoints.ts), nên không còn gì để chỉ đường và cũng không còn
  // bước cấu hình nào trước khi đăng nhập.
  const cfg = loadConfig();
  const session = buildSession();

  const token = flag(args, 'token');
  if (token) {
    await session.auth.acceptAccessToken(token.trim());
    return report(session.auth);
  }

  const code = flag(args, 'code');
  if (code) {
    await session.auth.exchangeSsoCode(code.trim());
    return report(session.auth);
  }

  // Không có gì truyền vào → hướng dẫn rồi chờ dán. Link luôn in được: địa chỉ
  // web là hằng số, không còn nhánh "chưa cấu hình".
  const loginUrl = `${cfg.astraworkWebUrl}/login?next=%2Fide-auth`;

  out('');
  out('  Đăng nhập AstraWork:');
  out(`    1. Mở ${c.cyan(loginUrl)}`);
  out('    2. Đăng nhập bằng Microsoft');
  // Trang /ide-auth được viết cho EXTENSION: nó tự bắn `vscode://` và không
  // in mã ra màn hình bao giờ — mã chỉ đi vào clipboard qua một nút. Nói
  // "trang hiện mã" là sai và người dùng sẽ ngồi tìm một thứ không tồn tại.
  out('    3. Trang kế tiếp sẽ tự mở VS Code — kệ nó, bấm dòng chữ nhỏ');
  out(`       cuối thẻ: ${c.dim('"Không mở được? Sao chép mã để dán tay"')}`);
  out('    4. Dán vào đây (mã không hiện ra, nó nằm sẵn trong clipboard)');
  out('');
  out(c.dim('  Hoặc trong VS Code: lệnh "AstraCode: Sao chép token AstraWork" rồi dán token vào đây.'));
  out('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const value = (await rl.question('  Mã hoặc token > ')).trim();
  rl.close();
  if (!value) {
    out(c.red('  Không có gì được nhập.'));
    process.exit(2);
  }

  // Một JWT có ba phần ngăn bằng dấu chấm; mã SSO thì không. Đoán đúng kiểu
  // giúp người dùng khỏi phải nhớ mình đang cầm cái gì.
  if (value.split('.').length === 3) await session.auth.acceptAccessToken(value);
  else await session.auth.exchangeSsoCode(value);

  return report(session.auth);
}

async function report(auth: { state(): Promise<{ authenticated: boolean; username?: string; role?: string; expiresAt?: Date }> }): Promise<void> {
  const st = await auth.state();
  out('');
  if (!st.authenticated) {
    out(c.red('  Chưa đăng nhập được.'));
    process.exit(1);
  }
  out(
    c.green('  Đã đăng nhập. ') +
      c.dim(
        `${st.username ?? ''}${st.role ? ` (${st.role})` : ''}` +
          (st.expiresAt ? ` — hết hạn ${st.expiresAt.toLocaleString()}` : ''),
      ),
  );
  out('');
}

export async function runLogout(): Promise<void> {
  await new FileTokenStore().clear();
  out(c.dim('\n  Đã xoá token khỏi ~/.astra.\n'));
}

export async function runWhoami(): Promise<void> {
  const session = buildSession();
  const st = await session.auth.state();
  if (!st.authenticated) {
    out(c.yellow('\n  Chưa đăng nhập. Chạy `astracode login`.\n'));
    process.exit(1);
  }
  out('');
  out(`  ${c.bold(st.username ?? '(không rõ)')}${st.role ? c.dim(` (${st.role})`) : ''}`);
  out(c.dim(`  gateway: ${session.config.gatewayBaseUrl}`));
  if (st.expiresAt) out(c.dim(`  token hết hạn: ${st.expiresAt.toLocaleString()}`));
  out('');
}
