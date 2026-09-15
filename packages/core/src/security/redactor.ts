/**
 * Redactor — docs/SECURITY.md §2.3, §2.4.
 *
 * Hai chỗ dùng:
 *   1. M1 — mọi log đi qua đây. Log không bao giờ được chứa token hay secret.
 *   2. M2 — mọi tool result đi qua đây TRƯỚC khi gửi lên model.
 *
 * Nguyên tắc: thà redact nhầm một chuỗi vô hại còn hơn để lọt một secret.
 * Nhưng false positive vẫn phải đếm được — mỗi lần redact đều sinh một hit để
 * đối chiếu sau (SECURITY.md nói rõ điều này khi bàn về io_controller).
 *
 * Cố ý KHÔNG bắt các pattern kiểu `password = "..."` ở chế độ mặc định: trong
 * codebase thật, thứ đó khớp vào tên biến, test fixture, và tài liệu nhiều hơn
 * là khớp vào secret thật. Bật `aggressive` khi cần.
 */

export interface RedactionRule {
  /** Tên loại secret, xuất hiện trong placeholder: [REDACTED:aws-key] */
  name: string;
  pattern: RegExp;
  /** Chỉ chạy khi bật chế độ aggressive. */
  aggressive?: boolean;
  /**
   * Giữ lại phần nào của chuỗi khớp (ví dụ header của private key) để người
   * đọc log vẫn hiểu chuyện gì xảy ra mà không thấy nội dung.
   */
  replace?: (match: string) => string;
}

export interface RedactionHit {
  rule: string;
  /** Vị trí trong chuỗi GỐC. */
  index: number;
  length: number;
}

export interface RedactionResult {
  text: string;
  hits: RedactionHit[];
}

/**
 * Thứ tự có ý nghĩa: rule cụ thể chạy trước rule tổng quát, để placeholder
 * mang đúng tên loại secret.
 */
export const DEFAULT_RULES: RedactionRule[] = [
  {
    name: 'private-key',
    // Cắt tới cuối input nếu file/chunk chỉ chứa nửa đầu khối key. Chỉ che
    // header sẽ làm gateway hết báo 422 nhưng vẫn gửi phần key còn lại đi.
    pattern:
      /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?(?:-----END[ A-Z]*PRIVATE KEY-----|$)/g,
  },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}\b/g },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Không đặt trần trên cho phần thân: `{36,255}\b` KHÔNG khớp một token dài
  // hơn 255 ký tự (mọi tiền tố đều bị theo sau bởi ký tự word nên `\b` không bao
  // giờ thoả), tức là token càng dài càng dễ lọt. Gateway thì khớp `{36,}` —
  // trần ở đây là một chỗ bộ rule của ta hẹp hơn bộ rule chặn phía nó.
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    name: 'bearer-token',
    pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/g,
    replace: () => 'Bearer [REDACTED:bearer-token]',
  },
  {
    // Chuỗi kết nối có mật khẩu nhúng. Chỉ che phần mật khẩu, giữ scheme/host
    // để log còn dùng để chẩn đoán được.
    name: 'connection-string',
    pattern:
      /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]{3,})@/gi,
    replace: (m) => {
      const parsed = /^([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]{3,})@$/i.exec(m);
      return parsed ? `${parsed[1]}${parsed[2]}:[REDACTED:connection-string]@` : m;
    },
  },
  {
    /**
     * Gán giá trị cho một tên trường nghe như secret.
     *
     * Phần giá trị cố ý chỉ loại KHOẢNG TRẮNG và DẤU NHÁY, không loại `,` `;`
     * hay backtick, và không đòi dấu nháy đóng khớp dấu mở. Bản trước hẹp hơn cả
     * ba điểm đó, và mỗi điểm là một lỗ so với bộ rule chặn cứng của gateway
     * (`password_assign`: `\bpassword\s*[:=]\s*['"]?[^\s'"]{6,}`):
     *
     *   password="a,b,c"      loại `,` nên ta bỏ qua, gateway thì chặn
     *   password: `${pw}`     loại backtick nên ta bỏ qua, gateway thì chặn
     *   password: "x1         `\2` đòi nháy đóng nên ta bỏ qua, gateway thì chặn
     *
     * Ba lỗ ấy là lý do đường phục hồi 422 từng che xong mà request vẫn bị chặn,
     * rồi cả lượt chết với đúng một dòng "422 status code (no body)". Bộ rule
     * này phải là TẬP CHA của bộ bên kia, nếu không việc che chỉ là hình thức —
     * `secretRules.test.ts` canh đúng quan hệ đó.
     *
     * Đổi lại là che rộng hơn trên mã nguồn bình thường (`password: string;` bị
     * che). Chấp nhận: lựa chọn còn lại không phải "gửi nguyên" mà là "gateway
     * từ chối cả request".
     *
     * ## Vì sao bản thay thế BỎ dấu `:`/`=`
     *
     * Vì `[REDACTED:secret-assignment]` tự nó là 28 ký tự không có khoảng trắng
     * hay dấu nháy, nên `password: [REDACTED:secret-assignment]` khớp
     * `password_assign` **y như bản chưa che**. Nghĩa là bản trước redact xong
     * request vẫn bị chặn — và vì kết quả tool đã đi qua đúng rule này từ trước,
     * mỗi lần agent đọc một file có dòng `password: string;` là cả lượt chat vào
     * đường chết mà không lối ra: che lại lần nữa cũng ra đúng chuỗi bị chặn đó.
     *
     * Bỏ dấu phân cách là thay đổi nhỏ nhất phá được điều kiện `\s*[:=]` của
     * rule bên kia. Dấu nháy mở thì GIỮ, để dấu nháy đóng còn lại trong văn bản
     * không thành lẻ đôi.
     */
    name: 'secret-assignment',
    aggressive: true,
    pattern:
      /\b(?:api[_-]?key|secret|passwd|password|token|access[_-]?key)\s*[:=]\s*(['"]?)([^\s'"]{6,})/gi,
    replace: (m) => {
      const sep = m.search(/[:=]/);
      if (sep < 0) return m;
      // Tên trường không bao giờ chứa `:` hay `=`, nên dấu ĐẦU TIÊN là dấu phân
      // cách kể cả khi giá trị còn dấu khác (`token: http://x`).
      const key = m.slice(0, sep).trimEnd();
      const quote = /^\s*(['"])/.exec(m.slice(sep + 1))?.[1] ?? '';
      // Giữ lại dấu câu đóng ở cuối. Không giữ thì `password: string;` mất dấu
      // `;` và đoạn code model đọc bị sai cú pháp ở chỗ chẳng liên quan gì.
      const tail = /[,;)\]}]*$/.exec(m)?.[0] ?? '';
      return `${key} ${quote}[REDACTED:secret-assignment]${tail}`;
    },
  },
];

export interface RedactorOptions {
  rules?: RedactionRule[];
  /** Bật thêm các rule dễ báo nhầm. Mặc định tắt. */
  aggressive?: boolean;
  /**
   * Chuỗi cần che tuyệt đối dù không khớp rule nào — dùng cho token đang giữ
   * trong bộ nhớ. Đây là lớp chắn cuối cho log.
   */
  literals?: string[];
}

export interface RedactOptions {
  /** Bật rule dễ báo nhầm cho đúng một lần redact, không đổi mặc định của instance. */
  aggressive?: boolean;
}

export class Redactor {
  private readonly rules: RedactionRule[];
  private readonly literals: string[];
  private readonly aggressive: boolean;

  constructor(opts: RedactorOptions = {}) {
    this.rules = opts.rules ?? DEFAULT_RULES;
    this.aggressive = opts.aggressive ?? false;
    this.literals = (opts.literals ?? []).filter((s) => s.length >= 8);
  }

  /** Thêm một chuỗi phải che tuyệt đối (ví dụ token vừa nhận sau khi đăng nhập). */
  addLiteral(value: string | undefined | null): void {
    if (value && value.length >= 8 && !this.literals.includes(value)) {
      this.literals.push(value);
    }
  }

  removeLiteral(value: string): void {
    const i = this.literals.indexOf(value);
    if (i >= 0) this.literals.splice(i, 1);
  }

  redact(input: string, opts: RedactOptions = {}): RedactionResult {
    if (!input) return { text: input, hits: [] };

    const hits: RedactionHit[] = [];
    let text = input;
    const aggressive = opts.aggressive ?? this.aggressive;

    for (const literal of this.literals) {
      let from = 0;
      for (;;) {
        const idx = text.indexOf(literal, from);
        if (idx < 0) break;
        hits.push({ rule: 'literal', index: idx, length: literal.length });
        text = text.slice(0, idx) + '[REDACTED:literal]' + text.slice(idx + literal.length);
        from = idx + '[REDACTED:literal]'.length;
      }
    }

    for (const rule of this.rules) {
      if (rule.aggressive && !aggressive) continue;
      // Regex có cờ /g mang state qua các lần gọi — clone để không dính lastIndex.
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      text = text.replace(re, (match, ...rest) => {
        const offset = rest[rest.length - 2] as number;
        hits.push({ rule: rule.name, index: offset, length: match.length });
        return rule.replace ? rule.replace(match) : `[REDACTED:${rule.name}]`;
      });
    }

    return { text, hits };
  }

  /** Tiện cho chỗ chỉ cần chuỗi đã sạch. */
  redactText(input: string, opts: RedactOptions = {}): string {
    return this.redact(input, opts).text;
  }

  /**
   * Redact sâu trong object — dùng cho log có cấu trúc.
   * Key nhạy cảm bị che theo TÊN, không cần khớp pattern giá trị: một field tên
   * `authorization` thì giá trị của nó là secret bất kể trông ra sao.
   */
  redactObject<T>(value: T, depth = 0): T {
    if (depth > 8) return '[REDACTED:too-deep]' as unknown as T;
    if (typeof value === 'string') return this.redactText(value) as unknown as T;
    if (value === null || typeof value !== 'object') return value;

    if (Array.isArray(value)) {
      return value.map((v) => this.redactObject(v, depth + 1)) as unknown as T;
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k)
        ? `[REDACTED:key:${k}]`
        : this.redactObject(v, depth + 1);
    }
    return out as unknown as T;
  }
}

const SENSITIVE_KEYS =
  /^(authorization|auth|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|private[_-]?key|cookie|set-cookie)$/i;

/** Redactor mặc định cho toàn tiến trình. Token đăng nhập được nạp vào đây ở M1. */
export const defaultRedactor = new Redactor();
