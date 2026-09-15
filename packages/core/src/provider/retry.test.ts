import { describe, expect, it, vi } from 'vitest';
import {
  backoffDelay,
  classifyHttpError,
  delay,
  parseGatewayErrorBody,
  parseRetryAfter,
  RAW_ERROR_BODY,
} from './retry.js';
import {
  AuthRequiredError,
  BudgetExceededError,
  ContentRejectedError,
  ProviderError,
  RateLimitedError,
} from '../errors.js';

/** Lỗi SDK openai cho một response FastAPI: message rỗng nghĩa, body ở bên cạnh. */
function sdkError(status: number, body: unknown): Record<string | symbol, unknown> {
  return {
    status,
    // Đúng câu SDK dựng khi body không có khoá `error` — xem `RAW_ERROR_BODY`.
    message: `${status} status code (no body)`,
    [RAW_ERROR_BODY]: JSON.stringify(body),
  };
}

describe('classifyHttpError', () => {
  it('429 kèm dấu hiệu budget -> BudgetExceededError, KHÔNG retry, KHÔNG failover', () => {
    const err = classifyHttpError({
      status: 429,
      message: 'Too Many Requests',
      error: { detail: 'Đã vượt hạn mức AI budget tháng này' },
    });
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.retryable).toBe(false);
    // Đổi model không cứu được: budget tính theo user, không theo model.
    expect(err.failoverable).toBe(false);
  });

  it('429 nhận ra budget qua từ khoá tiếng Anh', () => {
    expect(
      classifyHttpError({ status: 429, message: 'monthly quota exceeded' }),
    ).toBeInstanceOf(BudgetExceededError);
  });

  it('429 thường -> RateLimitedError, có retry và có failover', () => {
    const err = classifyHttpError({ status: 429, message: 'slow down' });
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryable).toBe(true);
    expect(err.failoverable).toBe(true);
  });

  it('429 đọc được Retry-After dạng giây', () => {
    const err = classifyHttpError({
      status: 429,
      message: 'rate limited',
      headers: { 'retry-after': '12' },
    }) as RateLimitedError;
    expect(err.retryAfterMs).toBe(12_000);
  });

  it('4xx khác 429 KHÔNG retry — retry một request sai chỉ hỏng nhanh hơn', () => {
    for (const status of [400, 404, 422]) {
      const err = classifyHttpError({ status, message: 'bad' });
      expect(err.retryable, `status ${status}`).toBe(false);
    }
  });

  it('403 (RBAC: user không được dùng model này) không retry, không failover', () => {
    const err = classifyHttpError({ status: 403, message: 'forbidden' });
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
    expect(err.failoverable).toBe(false);
  });

  it('5xx retry được và failover được', () => {
    for (const status of [500, 502, 503]) {
      const err = classifyHttpError({ status, message: 'oops' });
      expect(err.retryable, `status ${status}`).toBe(true);
      expect(err.failoverable, `status ${status}`).toBe(true);
    }
  });

  it('giữ nguyên AstraError đã phân loại sẵn', () => {
    const original = new AuthRequiredError();
    expect(classifyHttpError(original)).toBe(original);
  });

  it('lỗi không có status coi như retry được (thường là lỗi mạng)', () => {
    expect(classifyHttpError(new Error('socket hang up')).retryable).toBe(true);
  });
});

describe('parseRetryAfter', () => {
  it('đọc số giây', () => {
    expect(parseRetryAfter({ 'retry-after': '3' })).toBe(3000);
  });

  it('đọc HTTP-date', () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfter({ 'retry-after': future });
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThanOrEqual(6000);
  });

  it('đọc từ Headers', () => {
    expect(parseRetryAfter(new Headers({ 'Retry-After': '7' }))).toBe(7000);
  });

  it('trả undefined khi không có header', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter({})).toBeUndefined();
  });
});

describe('backoffDelay', () => {
  it('tăng theo cấp số nhân', () => {
    const fixed = () => 1; // bỏ jitter để so được
    expect(backoffDelay(1, { random: fixed })).toBe(500);
    expect(backoffDelay(2, { random: fixed })).toBe(1000);
    expect(backoffDelay(3, { random: fixed })).toBe(2000);
  });

  it('không vượt maxMs', () => {
    expect(backoffDelay(20, { random: () => 1, maxMs: 5000 })).toBe(5000);
  });

  it('có jitter — nếu không, cả nhóm dev cùng thử lại một thời điểm', () => {
    expect(backoffDelay(3, { random: () => 0 })).toBe(1000);
    expect(backoffDelay(3, { random: () => 1 })).toBe(2000);
  });
});

describe('delay', () => {
  it('bỏ chờ ngay khi bị hủy', async () => {
    vi.useRealTimers();
    const ac = new AbortController();
    const p = delay(10_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow(/abort/i);
  });

  it('từ chối ngay nếu signal đã aborted trước khi gọi', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(delay(1000, ac.signal)).rejects.toThrow(/abort/i);
  });

  it('trả về ngay với ms <= 0', async () => {
    await expect(delay(0)).resolves.toBeUndefined();
  });
});

describe('parseGatewayErrorBody', () => {
  it('đọc shape FastAPI: detail + findings', () => {
    const body = parseGatewayErrorBody(
      JSON.stringify({
        detail: 'Request rejected: credential-like content detected',
        findings: { password_assign: 2, email: 1 },
      }),
    );
    expect(body?.detail).toBe('Request rejected: credential-like content detected');
    expect(body?.findings).toEqual({ password_assign: 2, email: 1 });
  });

  it('đọc shape OpenAI: error.message', () => {
    const body = parseGatewayErrorBody(JSON.stringify({ error: { message: 'bad request' } }));
    expect(body?.error?.message).toBe('bad request');
  });

  it('detail dạng mảng của RequestValidationError vẫn ép về một câu đọc được', () => {
    const body = parseGatewayErrorBody(
      JSON.stringify({ detail: [{ loc: ['body', 'messages'], msg: 'field required' }] }),
    );
    expect(body?.detail).toContain('field required');
  });

  it('bỏ qua findings có giá trị không phải số', () => {
    const body = parseGatewayErrorBody(JSON.stringify({ findings: { a: 1, b: 'nhiều' } }));
    expect(body?.findings).toEqual({ a: 1 });
  });

  it('không phải JSON object thì trả undefined', () => {
    expect(parseGatewayErrorBody('<html>502 Bad Gateway</html>')).toBeUndefined();
    expect(parseGatewayErrorBody('[1,2,3]')).toBeUndefined();
    expect(parseGatewayErrorBody('')).toBeUndefined();
    expect(parseGatewayErrorBody(undefined)).toBeUndefined();
  });
});

describe('classifyHttpError với body đã chụp lại', () => {
  it('422 kèm findings -> ContentRejectedError, không retry, không failover', () => {
    const err = classifyHttpError(
      sdkError(422, {
        detail: 'Request rejected: credential-like content detected',
        findings: { password_assign: 1 },
      }),
    );
    expect(err).toBeInstanceOf(ContentRejectedError);
    const rejected = err as ContentRejectedError;
    expect(rejected.findings).toEqual({ password_assign: 1 });
    expect(rejected.detail).toContain('credential-like content');
    // Đổi model không đổi được nội dung hội thoại.
    expect(err.retryable).toBe(false);
    expect(err.failoverable).toBe(false);
    // Câu hiện cho người dùng phải nêu được rule, không phải một mã số trần.
    expect(err.message).toContain('password_assign');
  });

  it('nhận ra content rejection qua câu chữ khi gateway cũ chưa gửi findings', () => {
    const err = classifyHttpError(
      sdkError(422, { detail: 'Request rejected: credential-like content detected' }),
    );
    expect(err).toBeInstanceOf(ContentRejectedError);
  });

  it('422 vì sai shape request KHÔNG bị nhận nhầm thành content rejection', () => {
    const err = classifyHttpError(
      sdkError(422, { detail: [{ loc: ['body', 'messages'], msg: 'field required' }] }),
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ContentRejectedError);
    // Và câu gateway thật sự nói phải thay thế được "no body".
    expect(err.message).toContain('field required');
    expect(err.message).not.toContain('no body');
  });

  it('422 không có body giữ nguyên đường cũ — vẫn là ProviderError "no body"', () => {
    const err = classifyHttpError({ status: 422, message: '422 status code (no body)' });
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ContentRejectedError);
    expect(err.message).toContain('no body');
  });

  it('body của gateway giúp nhận ra budget ở 429 mà message trơn không nói gì', () => {
    const err = classifyHttpError(
      sdkError(429, { detail: 'Đã vượt hạn mức AI budget của tháng' }),
    );
    expect(err).toBeInstanceOf(BudgetExceededError);
  });

  it('403 kèm body policy vẫn là ProviderError, không thành ContentRejectedError', () => {
    // 403 là chặn theo chính sách nội dung (assess/policy_block) — khác hẳn 422
    // vốn sửa được bằng cách che. Nhận nhầm sẽ thành thử lại một việc bị cấm.
    const err = classifyHttpError(
      sdkError(403, { detail: 'Yêu cầu bị chặn bởi chính sách an toàn', findings: { x: 1 } }),
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ContentRejectedError);
  });
});
