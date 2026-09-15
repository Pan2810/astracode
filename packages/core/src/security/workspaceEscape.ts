/**
 * Quét xem một lệnh hay một script có VỚI RA NGOÀI WORKSPACE không.
 *
 * ## Nó thay chỗ cho cái gì
 *
 * Trước đây khung chat treo thường trực một dòng đỏ: "lệnh chạy thẳng trên máy
 * này, KHÔNG có cách ly". Câu đó đúng nhưng vô dụng — nó nói về CẤU HÌNH chứ
 * không nói về việc sắp xảy ra, nên sau ngày thứ hai mắt người dùng bỏ qua nó,
 * kể cả đúng lúc agent chuẩn bị đọc `~/.ssh/id_rsa`. Một cảnh báo luôn bật là
 * một cảnh báo đã tắt.
 *
 * Đổi lại: im lặng khi lệnh ở trong workspace, và nói ĐÚNG LÚC + ĐÚNG CHỖ khi
 * có thứ chỉ ra ngoài — kèm bằng chứng là chính đoạn text ấy.
 *
 * ## Đây là cảnh báo, không phải rào chắn
 *
 * Cùng tinh thần với `BLOCKED` của tool bash: một biểu thức chính quy không
 * chặn được người cố tình. `subprocess.run(base64.b64decode(...))` đi qua đây
 * không sót một vết. Thứ chặn thật vẫn là container (`astra.sandbox`), và thứ
 * quyết định vẫn là con người bấm nút. Việc của file này là làm cho quyết định
 * ấy CÓ CĂN CỨ: nêu ra được "dòng này đọc %USERPROFILE%" thì người dùng đọc ba
 * giây là hiểu, còn "không có cách ly" thì đọc bao lâu cũng vậy.
 *
 * ## Vì sao chỉ bắt đường dẫn
 *
 * Ra ngoài workspace theo nghĩa HỆ THỐNG TỆP: đường dẫn tuyệt đối ở nơi khác,
 * thư mục nhà, biến môi trường trỏ về nơi khác, và `..` leo quá gốc. Mạng thì
 * không — một lệnh `pip install` hay `git push` chạm mạng là việc bình thường
 * hàng ngày, gắn cờ nó là quay lại đúng cái bẫy "cảnh báo luôn bật" ở trên.
 */
import * as nodePath from 'node:path';
import { isWithin } from './pathGuard.js';

export interface EscapeFinding {
  /** Đoạn text thật trong lệnh/script. Người dùng cần thấy CHÍNH nó. */
  evidence: string;
  /** Vì sao nó đáng để mắt tới, một câu, tiếng Anh (người dùng đọc). */
  why: string;
}

/**
 * Đuôi file được coi là "chạy được" — thứ sinh ra rồi có ngày sẽ được thực thi.
 *
 * Danh sách này quyết định file nào bị soi nội dung khi agent GHI nó. Nó cố ý
 * rộng hơn "script chạy được trên máy này": một file `.sh` trên Windows vẫn là
 * một file sẽ chạy ở đâu đó, và một `.ps1` nằm trong repo Linux cũng vậy.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  '.py',
  '.pyw',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.psm1',
  '.bat',
  '.cmd',
  '.js',
  '.cjs',
  '.mjs',
  '.ts',
  '.rb',
  '.pl',
  '.php',
  '.exe',
  '.com',
  '.scr',
  '.msi',
  '.jar',
  '.vbs',
  '.wsf',
  '.applescript',
]);

/** File này có phải thứ sẽ được đem chạy không? Quyết theo đuôi và theo tên. */
export function isExecutablePath(path: string): boolean {
  const ext = nodePath.extname(path).toLowerCase();
  if (EXECUTABLE_EXTENSIONS.has(ext)) return true;
  // Không có đuôi mà tên nói rõ nó là script: Makefile không tính (không tự
  // chạy), còn `entrypoint`/`install` kiểu Unix thì tính.
  const base = nodePath.basename(path).toLowerCase();
  return ext === '' && /^(entrypoint|install|setup|run|start|build|deploy)$/.test(base);
}

/**
 * Thư mục gốc THẬT của hệ thống tệp.
 *
 * Có danh sách này vì một chuỗi bắt đầu bằng `/` chưa chắc là đường dẫn: nó có
 * thể là path của URL (`/auth/me/usage`), là regex, là đối số kiểu `/nologo`.
 * Đoán bừa mọi chuỗi `/…` là đường dẫn sẽ cho ra một cảnh báo mỗi lượt, và một
 * cảnh báo mỗi lượt thì lại thành cái dòng đỏ thường trực vừa gỡ đi.
 */
const POSIX_ROOTS = [
  'etc',
  'var',
  'usr',
  'opt',
  'srv',
  'root',
  'home',
  'Users',
  'bin',
  'sbin',
  'lib',
  'boot',
  'proc',
  'sys',
  'dev',
  'mnt',
  'media',
  'tmp',
  'Applications',
  'Library',
  'System',
  'Volumes',
];

/**
 * `C:\x`, `C:/x`, `/etc/x`, `\\server\share` — ứng viên đường dẫn tuyệt đối.
 *
 * Lookbehind ở đầu là thứ giữ cho nó không cắn vào GIỮA một đường dẫn tương
 * đối: không có nó thì `src/../lib/build.js` bị đọc thành `/lib/build.js`, một
 * đường dẫn tuyệt đối ở ngoài workspace — báo động cho một lệnh hoàn toàn bình
 * thường. Ký tự ngay trước phải là khoảng trắng, dấu nháy, hoặc dấu phân cách,
 * chứ không phải chữ, dấu chấm hay một separator khác.
 */
const ABSOLUTE = new RegExp(
  String.raw`(?<![\w./\\~-])` +
    String.raw`(?:[A-Za-z]:[\\/][^\s"'\`,;)|]*` +
    String.raw`|\\\\[^\s"'\`,;)|]+` +
    String.raw`|/(?:${POSIX_ROOTS.join('|')})(?:/[^\s"'\`,;)|]*)?)`,
  'g',
);

/**
 * Thiết bị ảo `/dev/*` — đọc/ghi chúng là chuyện thường ngày của mọi shell
 * (`2>/dev/null`, `< /dev/null`), không phải "với ra ngoài workspace" theo
 * nghĩa đáng báo. Khớp TOÀN CHUỖI, không phải prefix: không được nới thành
 * `/dev/` vì `bash.ts` đang dùng đúng chuỗi `of=/dev/` để bắt `dd … of=/dev/sda`
 * — một prefix ở đây sẽ vô hiệu hoá luôn cảnh báo đó.
 */
const NULL_DEVICES = new Set([
  '/dev/null',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
  '/dev/zero',
  '/dev/urandom',
  '/dev/random',
]);

/**
 * Thư mục chỉ để TRA CỨU chương trình hoặc thông tin hệ thống — `which`, `ls`,
 * `cat /etc/os-release`. Đọc ở đây là chuyện bình thường mỗi ngày; GHI vào đây
 * thì không (xem `WRITE_TARGET`). Cố ý KHÔNG có `/tmp`, `/etc` nói chung,
 * `/home`, `/var`: đó là nơi có thể chứa dữ liệu người dùng, tra cứu ở đó vẫn
 * đáng báo.
 */
const LOOKUP_ROOTS = [
  '/usr/local/bin',
  '/usr/bin',
  '/usr/sbin',
  '/bin',
  '/sbin',
  '/opt/homebrew/bin',
  '/etc/os-release',
  '/proc/version',
];

/**
 * Đích của một phép GHI ngay trước ứng viên đường dẫn: `>`, `>>`, `dd of=`,
 * `tee`. Nhìn vào một đoạn ngắn NGAY TRƯỚC vị trí khớp — đây là phép THU HẸP
 * miễn trừ của `LOOKUP_ROOTS`, không phải một lời khẳng định bảo mật riêng.
 */
const WRITE_TARGET = /(?:>>?|\bof=|\btee\s+(?:-a\s+)?)\s*$/;

/** Có phải một đường dẫn nằm trong `LOOKUP_ROOTS` (khớp chính nó hoặc một thư mục con). */
function isLookupPath(candidate: string): boolean {
  return LOOKUP_ROOTS.some((root) => candidate === root || candidate.startsWith(`${root}/`));
}

/**
 * Thư mục nhà và biến môi trường trỏ ra khỏi workspace.
 *
 * `~` đứng một mình không tính (nó là ký tự bình thường trong văn bản); phải là
 * `~/` hoặc `~\` mới là đường dẫn.
 */
const HOME_REFERENCES: Array<{ re: RegExp; why: string }> = [
  { re: /~[\\/][^\s"'`,;)|]*/g, why: 'reads from your home folder, outside the workspace' },
  {
    re: /%(?:USERPROFILE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|SystemRoot|windir|ProgramData|ProgramFiles(?:\(x86\))?)%/gi,
    why: 'expands to a Windows folder outside the workspace',
  },
  {
    re: /\$(?:env:)?\{?(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMPDIR|XDG_[A-Z_]+)\}?/g,
    why: 'expands to a folder outside the workspace',
  },
  {
    re: /(?:os\.path\.)?expanduser\s*\(|Path\s*\.\s*home\s*\(\)|os\.environ\s*\[\s*['"](?:HOME|USERPROFILE)['"]\s*\]/g,
    why: 'resolves your home folder at runtime',
  },
];

/** Lệnh đổi thư mục làm việc — nơi một script rời workspace một cách lặng lẽ. */
const CHDIR = /\b(?:cd|chdir|pushd|Set-Location|sl)\s+(?!-)([^\s;&|]+)|os\.chdir\s*\(\s*([^)]*)\)/g;

/** Trần số phát hiện đưa ra UI. Mười dòng cảnh báo thì không ai đọc dòng nào. */
const MAX_FINDINGS = 6;

/**
 * Bỏ những dòng không phải "hành vi": shebang và comment mở đầu.
 *
 * `#!/usr/bin/env python3` có mặt ở đầu gần như mọi script Python và nó KHÔNG
 * phải là đọc file ngoài workspace theo nghĩa đáng báo — nó là cách nói "chạy
 * bằng python". Không bỏ nó ra thì mỗi file `.py` sinh ra đều kéo theo một
 * cảnh báo, và người dùng học được rằng cảnh báo này vô nghĩa.
 */
function stripNoise(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (/^\s*#!/.test(line) ? '' : line))
    .join('\n');
}

/** Bỏ phần scheme của URL để `https://host/etc/x` không bị đọc là `/etc/x`. */
function stripUrls(text: string): string {
  return text.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'`,;)|]*/g, ' ');
}

function push(out: EscapeFinding[], seen: Set<string>, evidence: string, why: string): void {
  const trimmed = evidence.trim().slice(0, 120);
  if (!trimmed || seen.has(trimmed)) return;
  seen.add(trimmed);
  out.push({ evidence: trimmed, why });
}

export interface EscapeScanOptions {
  workspaceRoot: string;
}

/**
 * Tìm mọi chỗ trong `text` chỉ ra ngoài workspace.
 *
 * `text` là một lệnh shell, một đoạn mã Python, hay nội dung một file script —
 * cùng một phép quét cho cả ba, vì cùng một câu hỏi: cái sắp chạy này có với
 * tay ra khỏi thư mục đang mở không.
 *
 * Danh sách rỗng KHÔNG có nghĩa là an toàn (xem đầu file). Nó có nghĩa là
 * không có gì lộ thiên để chỉ cho người dùng xem.
 */
export function scanEscapes(text: string, opts: EscapeScanOptions): EscapeFinding[] {
  const root = nodePath.resolve(opts.workspaceRoot);
  const body = stripUrls(stripNoise(text));
  const out: EscapeFinding[] = [];
  const seen = new Set<string>();

  for (const match of body.matchAll(ABSOLUTE)) {
    const candidate = match[0].replace(/[.,;:)]+$/, '');
    // Trong workspace thì không phải "ra ngoài" — đường dẫn tuyệt đối tới chính
    // file mình vừa sửa là chuyện bình thường.
    if (isWithin(root, candidate)) continue;

    // Thiết bị ảo: đọc/ghi /dev/null luôn vô hại, bỏ qua hẳn.
    if (NULL_DEVICES.has(candidate)) continue;

    // Tra cứu chương trình/thông tin hệ thống ở thư mục chuẩn: bình thường khi
    // ĐỌC (which, ls, cat /etc/os-release); vẫn đáng báo khi GHI vào đó.
    const before = body.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0);
    if (isLookupPath(candidate) && !WRITE_TARGET.test(before)) continue;

    push(
      out,
      seen,
      candidate,
      candidate.startsWith('\\\\')
        ? 'points at a network share outside the workspace'
        : 'is an absolute path outside the workspace',
    );
  }

  for (const rule of HOME_REFERENCES) {
    for (const match of body.matchAll(rule.re)) push(out, seen, match[0], rule.why);
  }

  // `..` leo quá gốc. Chỉ tính khi giải ra THẬT SỰ ở ngoài: `src/../lib` vẫn
  // nằm trong workspace, và gắn cờ nó là dạy người dùng bỏ qua cảnh báo.
  for (const token of body.split(/[\s"'`,;|()]+/)) {
    if (!token.includes('..')) continue;
    const resolved = nodePath.resolve(root, token.replace(/^[.][/\\]/, ''));
    if (!isWithin(root, resolved)) {
      push(out, seen, token, 'climbs above the workspace folder with ..');
    }
  }

  for (const match of body.matchAll(CHDIR)) {
    const target = (match[1] ?? match[2] ?? '').replace(/^['"]|['"]$/g, '');
    if (!target || target === '.' || target.startsWith('$') || target.startsWith('%')) continue;
    const resolved = nodePath.isAbsolute(target)
      ? nodePath.normalize(target)
      : nodePath.resolve(root, target);
    if (!isWithin(root, resolved)) {
      push(out, seen, match[0], 'moves the working directory outside the workspace');
    }
  }

  return out.slice(0, MAX_FINDINGS);
}

/**
 * Câu cảnh báo cho hộp duyệt quyền. Tiếng Anh: người dùng đọc nó trong IDE.
 *
 * Một dòng cho mỗi phát hiện, bằng chứng đứng trước lý do — người ta nhận ra
 * `~/.ssh/id_rsa` nhanh hơn nhiều so với đọc hết một câu giải thích.
 */
export function describeEscapes(findings: EscapeFinding[]): string[] {
  return findings.map((f) => `${f.evidence} — ${f.why}`);
}
