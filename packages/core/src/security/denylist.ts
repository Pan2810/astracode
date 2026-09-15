/**
 * Chặn đọc file bí mật — docs/SECURITY.md §2.1, §2.2.
 *
 * Chặn Ở TẦNG CORE, không phải bằng câu dặn trong system prompt. Lý do:
 * prompt là gợi ý cho model, còn đây là quy tắc. Model bị injection vẫn có thể
 * quyết định đọc `.env`; chỗ duy nhất chặn được việc đó là code.
 *
 * Danh sách cố ý theo TÊN FILE chứ không theo nội dung: quét nội dung nghĩa là
 * đã đọc file vào bộ nhớ tiến trình rồi mới quyết định — quá muộn.
 */
import * as nodePath from 'node:path';
import ignoreModule, { type Ignore } from 'ignore';

/**
 * `ignore` là gói CommonJS nhưng khai báo type bằng `export default`. Dưới
 * moduleResolution NodeNext, default import của một gói CJS trỏ vào cả object
 * `module.exports`, không phải vào `.default` — nên gọi thẳng sẽ báo
 * "not callable". Gói này gán cả hai (`module.exports` là hàm VÀ có
 * `.default`), nên lấy `.default` là đúng cho cả lúc biên dịch lẫn lúc chạy.
 */
const createIgnore = ignoreModule.default;

/**
 * Mẫu mặc định, cú pháp .gitignore. Cân nhắc kỹ trước khi thêm: mỗi mẫu quá
 * rộng sẽ chặn nhầm file mã nguồn hợp lệ và làm agent mù một vùng repo.
 */
export const DEFAULT_DENY_PATTERNS: string[] = [
  // Biến môi trường — nguồn rò rỉ số một
  '.env',
  '.env.*',
  '!.env.example',
  '!.env.sample',
  '!.env.template',

  // Khoá riêng và chứng chỉ
  '*.pem',
  '*.key',
  '*.pfx',
  '*.p12',
  '*.jks',
  '*.keystore',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',

  // Thư mục credential của công cụ
  '.ssh/',
  '.aws/',
  '.gnupg/',
  '.azure/',
  '.kube/config',
  '.docker/config.json',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',

  // Đặt tên phổ biến cho file bí mật
  'credentials',
  'credentials.*',
  'secrets.*',
  '*.secret',
  '*_secret*',
  'service-account*.json',
  '*serviceaccount*.json',
];

export interface DenylistOptions {
  /** Thay toàn bộ mẫu mặc định. Bỏ trống để dùng DEFAULT_DENY_PATTERNS. */
  patterns?: string[];
  /** Nội dung .astraignore của project, nối thêm vào mẫu mặc định. */
  astraignore?: string;
}

export interface DenyDecision {
  denied: boolean;
  /** Mẫu nào khớp — hiển thị cho người dùng biết vì sao bị chặn. */
  source?: 'default' | 'astraignore';
}

/**
 * Quyết định một đường dẫn có được đọc không.
 *
 * Nhận đường dẫn TƯƠNG ĐỐI so với workspace root, dùng `/`. Gọi
 * `PathGuard.toRelative()` để lấy dạng đó.
 */
export class Denylist {
  private readonly defaults: Ignore;
  private readonly project: Ignore | undefined;

  constructor(opts: DenylistOptions = {}) {
    this.defaults = createIgnore().add(opts.patterns ?? DEFAULT_DENY_PATTERNS);
    if (opts.astraignore?.trim()) {
      this.project = createIgnore().add(opts.astraignore);
    }
  }

  check(relativePath: string): DenyDecision {
    const p = normalize(relativePath);
    if (!p || p === '.') return { denied: false };

    // `ignore` yêu cầu đường dẫn tương đối, không có ./ hay / ở đầu.
    if (this.defaults.ignores(p)) return { denied: true, source: 'default' };
    if (this.project?.ignores(p)) return { denied: true, source: 'astraignore' };
    return { denied: false };
  }

  isDenied(relativePath: string): boolean {
    return this.check(relativePath).denied;
  }

  /** Lọc một danh sách — dùng cho glob và readDir. */
  filter(relativePaths: string[]): string[] {
    return relativePaths.filter((p) => !this.isDenied(p));
  }

  /** Câu giải thích đưa lại cho model khi nó cố đọc file bị chặn. */
  explain(relativePath: string): string {
    const d = this.check(relativePath);
    if (!d.denied) return '';
    return d.source === 'astraignore'
      ? `Bị chặn bởi .astraignore của project: ${relativePath}`
      : `Bị chặn vì có thể chứa thông tin bí mật: ${relativePath}. ` +
          `Đây là quy tắc ở tầng công cụ, không phải lựa chọn của bạn — đừng thử đường vòng.`;
  }
}

function normalize(p: string): string {
  return p
    .split(nodePath.sep)
    .join('/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}
