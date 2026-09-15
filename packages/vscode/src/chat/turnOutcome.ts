/**
 * Phân loại exception khi một lượt chat thoát ra ngoài AgentLoop.
 *
 * Đặt riêng khỏi ChatController để test được mà không phải dựng VS Code host.
 */
import { isAbortError } from '@astra/core';
import type { TurnEndReason } from './protocol.js';

export type FailedTurnEndReason = Extract<TurnEndReason, 'aborted' | 'error'>;

/** Chỉ abort thật mới được phép hiện thành "cancelled" trên UI. */
export function turnEndReasonForError(err: unknown): FailedTurnEndReason {
  return isAbortError(err) ? 'aborted' : 'error';
}
