#!/usr/bin/env node
/**
 * `astracode` — AstraCode ngoài VS Code.
 *
 * Cùng agent loop, cùng gateway, cùng lớp quyền. Thứ duy nhất khác là giao
 * diện: terminal thay cho webview.
 *
 * Chạy được là nhờ một ràng buộc kiến trúc có từ M1 — `packages/core` không
 * import `vscode` (eslint ép). Nhờ đó CLI này gần như chỉ là lắp ráp, không
 * phải viết lại gì.
 */
import { bootstrapHome } from './bootstrap.js';
import { runChat } from './chat.js';
import { runLogin, runLogout, runWhoami } from './auth-cmd.js';
import { runMeasure } from './measure.js';
import { runModels } from './models-cmd.js';
import { c, err, out } from './ui.js';

const USAGE = `
  ${c.bold('astracode')} — coding agent trong terminal

  ${c.bold('Dùng')}
    astracode                      mở phiên chat trong thư mục hiện tại
    astracode --mode=plan          mở phiên chỉ đọc (không sửa file)
    astracode -p "câu hỏi"         chạy một lượt rồi thoát (script, CI)
    echo "câu hỏi" | astracode     tương tự, qua pipe
    astracode --raw                không tô markdown, in chữ thô
    astracode --trace-jsonl FILE   ghi audit từng loop/tool theo JSONL (opt-in)
    astracode --trace-content      kèm excerpt đã redact, tối đa 4.000 ký tự/event

  ${c.bold('Lệnh')}
    login [--token JWT] [--code MÃ]     đăng nhập AstraWork
          [--token JWT | --code MÃ]
    logout                         xoá token khỏi ~/.astra
    whoami                         đang đăng nhập bằng tài khoản nào
    models                         model nào dùng được, biết gì về chúng
    measure [model...]             đo năng lực model → ~/.astra/models.json
    help                           bản này

  ${c.bold('Ghi chú')}
    ~/.astra/ dùng chung với extension VS Code — đo model một lần, cả hai cùng thấy.
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  // Trước mọi lệnh, kể cả `help`: layout của ~/.astra phải đúng trước khi có ai
  // đọc nó, và một lệnh in trợ giúp cũng là dịp tốt để dọn rác.
  await bootstrapHome();

  switch (cmd) {
    case undefined:
    case 'chat':
      return runChat(rest);
    case 'login':
      return runLogin(rest);
    case 'logout':
      return runLogout();
    case 'whoami':
      return runWhoami();
    case 'models':
      return runModels();
    case 'measure':
      return runMeasure(rest);
    case 'help':
    case '--help':
    case '-h':
      out(USAGE);
      return;
    case '--version':
    case '-v':
      out('astracode 0.0.1');
      return;
    default:
      // Cờ đứng đầu (`astracode --mode=plan`) là mở phiên chat, không phải lệnh sai.
      if (cmd.startsWith('-')) return runChat([cmd, ...rest]);
      err(c.red(`\n  Không có lệnh "${cmd}".`));
      out(USAGE);
      process.exit(2);
  }
}

main().catch((e: unknown) => {
  err('');
  err(c.red(`  ${e instanceof Error ? e.message : String(e)}`));
  err('');
  process.exit(1);
});
