import { describe, expect, it } from 'vitest';
import { AbortedError, ProviderError } from '@astra/core';
import { turnEndReasonForError } from './turnOutcome.js';

describe('turnEndReasonForError', () => {
  it('HTTP 422 là error, không phải cancelled', () => {
    expect(turnEndReasonForError(new ProviderError('422 status code (no body)', 422))).toBe('error');
  });

  it('chỉ các lỗi abort thật mới thành aborted', () => {
    expect(turnEndReasonForError(new AbortedError())).toBe('aborted');
    expect(turnEndReasonForError(new DOMException('Aborted', 'AbortError'))).toBe('aborted');
    expect(
      turnEndReasonForError(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })),
    ).toBe('aborted');
  });

  it('exception thông thường là error', () => {
    expect(turnEndReasonForError(new Error('gateway rejected the request'))).toBe('error');
  });
});
