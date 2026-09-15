/**
 * Canh MỘT quan hệ duy nhất: bộ rule che của AstraCode phải là TẬP CHA của bộ
 * rule chặn cứng ở gateway AstraWork.
 *
 * Vì sao cần một file test riêng cho việc này. Gateway quét mọi chuỗi trong body
 * bằng sáu regex `is_secret=True` (`astrawork/backend/gateway/app/middleware/
 * sanitization.py`, `DETECTION_RULES`) và trả **422 cho cả request** nếu một
 * regex khớp. SDK openai lại vứt body của lỗi đó, nên AstraCode chỉ nhận được
 * `"422 status code (no body)"`. Đường phục hồi duy nhất là che nội dung rồi gửi
 * lại — và nó chỉ có nghĩa khi bộ rule của ta bắt được MỌI thứ bộ rule bên kia
 * bắt, VÀ bản thay thế không khớp tiếp một rule nào.
 *
 * Hai điều kiện đó từng cùng bị vi phạm, và đó là lý do 422 làm lượt chat chết:
 *
 *   1. `password="a,b,c"` — bản cũ loại `,` khỏi phần giá trị nên bỏ qua;
 *   2. `password: [REDACTED:secret-assignment]` — chính chuỗi thay thế lại khớp
 *      `password_assign`, nên che xong request vẫn bị chặn y như trước.
 *
 * Regex dưới đây là bản CHÉP TAY từ file gateway. Chép tay là có chủ đích: hai
 * repo khác nhau, không import được nhau, nên thứ duy nhất giữ chúng không lệch
 * là một test đọc được cạnh nhau. Bên kia đổi rule thì sửa ở đây, đừng nới bên
 * mình cho vừa.
 */
import { describe, expect, it } from 'vitest';
import { Redactor } from './redactor.js';

/**
 * Sáu rule `is_secret=True` của gateway — khớp là 422 cho cả request.
 * Nguồn: `middleware/sanitization.py:62-67`.
 */
const GATEWAY_BLOCKING_RULES: Array<[string, RegExp]> = [
  ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['private_key_pem', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  [
    'generic_api_key',
    /\b(?:api[_-]?key|token|secret)\b\s*[:=]\s*['"]?[A-Za-z0-9_-]{20,}/i,
  ],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  [
    'jwt_token',
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  ],
  ['password_assign', /\bpassword\s*[:=]\s*['"]?[^\s'"]{6,}/i],
];

/** Rule nào của gateway khớp chuỗi này. Rỗng = request đi qua được. */
function blockedBy(text: string): string[] {
  return GATEWAY_BLOCKING_RULES.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/**
 * Mẫu thật, không phải mẫu bịa cho vừa test.
 *
 * Phần lớn là mã nguồn hoàn toàn vô hại — đó mới là điểm: rule `password_assign`
 * của gateway khớp `password: string;` trong một interface TypeScript, nên thứ
 * làm chết lượt chat thường không phải secret mà là code bình thường.
 */
const SAMPLES: string[] = [
  // Mã nguồn bình thường, không có secret nào.
  'password: string;',
  'interface LoginDto { password: string; email: string }',
  'password: loginDto.password,',
  'password="abc,def,ghi"',
  'password: `${pw}`',
  'const password = "hunter2placeholder";',
  'password=short',
  'PASSWORD: fromEnvironmentVariable',
  'token: process.env.GITHUB_TOKEN_VALUE_1',
  'api_key: config.apiKey,',
  // Secret thật.
  'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
  'api_key = "abcdefghij0123456789xyz"',
  'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.abcdefghijklmnop',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
  // Không có gì để che.
  'const timeout = 30_000;',
  'Bearer abcdefghijklmnopqrstuvwxyz012345',
];

describe('bộ rule che của AstraCode so với bộ rule chặn của gateway', () => {
  const redactor = new Redactor();
  const mask = (text: string): string => redactor.redactText(text, { aggressive: true });

  it('mọi mẫu bị gateway chặn đều được bộ rule của ta nhận ra', () => {
    const missed = SAMPLES.filter((s) => blockedBy(s).length > 0 && mask(s) === s);
    expect(missed).toEqual([]);
  });

  it('sau khi che, KHÔNG mẫu nào còn khớp một rule chặn nào của gateway', () => {
    // Đây là bất biến thật sự quan trọng: che mà vẫn bị chặn thì đường phục hồi
    // 422 chỉ tốn thêm một request rồi kết thúc ở đúng chỗ cũ.
    const stillBlocked = SAMPLES.map((s) => [s, blockedBy(mask(s))] as const).filter(
      ([, rules]) => rules.length > 0,
    );
    expect(stillBlocked).toEqual([]);
  });

  it('chuỗi thay thế tự nó không khớp rule nào — kể cả rule giá trị rộng nhất', () => {
    // `password: [REDACTED:secret-assignment]` từng khớp `password_assign` vì
    // chuỗi thay thế dài và không có khoảng trắng. Bản thay thế bỏ dấu phân cách
    // chính là để phá điều kiện `\s*[:=]` đó.
    for (const placeholder of [
      'password [REDACTED:secret-assignment];',
      'token [REDACTED:secret-assignment]',
      'api_key "[REDACTED:secret-assignment]"',
      '[REDACTED:aws-access-key]',
      '[REDACTED:private-key]',
      '[REDACTED:github-token]',
      '[REDACTED:jwt]',
      'Bearer [REDACTED:bearer-token]',
      '[REDACTED:literal]',
    ]) {
      expect(blockedBy(placeholder)).toEqual([]);
    }
  });

  it('che nhiều lần cho ra cùng một kết quả (idempotent)', () => {
    // Đường phục hồi có thể che một message đã từng đi qua redactor ở
    // `pushToolResult`. Không idempotent thì mỗi lần che lại nuốt thêm một mẩu
    // văn bản thật.
    for (const sample of SAMPLES) {
      const once = mask(sample);
      expect(mask(once)).toBe(once);
    }
  });

  it('giữ lại dấu câu đóng để đoạn code còn đọc được', () => {
    expect(mask('password: string;')).toBe('password [REDACTED:secret-assignment];');
    expect(mask('password: loginDto.password,')).toBe(
      'password [REDACTED:secret-assignment],',
    );
  });

  it('không che dòng không có gì để che', () => {
    expect(mask('const timeout = 30_000;')).toBe('const timeout = 30_000;');
  });

  it('giá trị ngắn không bị che — rule bên kia cũng không khớp', () => {
    expect(blockedBy('password=short')).toEqual([]);
    expect(mask('password=short')).toBe('password=short');
  });
});
