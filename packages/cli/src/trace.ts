/** JSONL audit trail for a real AstraCode AgentLoop run. */
import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { defaultRedactor, type AgentEvent, type AgentRunResult } from '@astra/core';

const CONTENT_LIMIT = 4_000;
/** Enough to explain what a tool found, without turning an audit trail into a
 * second unbounded copy of the workspace. The full, redacted excerpt remains
 * an explicit opt-in below. */
const RESULT_SUMMARY_LIMIT = 900;

export interface TraceOptions {
  file: string;
  /** Explicitly include bounded, redacted excerpts of model/tool output. */
  includeContent?: boolean;
}

/**
 * This writer is deliberately best-effort: audit storage failure must not
 * change the behaviour of the read-only agent it observes.
 */
export class AgentTrace {
  private seq = 0;
  private iteration = 0;
  private text = '';
  private writeError = '';

  constructor(private readonly opts: TraceOptions, readonly sessionId: string) {
    this.write('session_started', {
      schema_version: 1,
      cwd: process.cwd(),
      content_captured: Boolean(opts.includeContent),
    });
  }

  beginTurn(turnId: string, prompt: string): void {
    this.iteration = 0;
    this.text = '';
    this.write('turn_started', {
      turn_id: turnId,
      prompt_chars: prompt.length,
      ...(this.opts.includeContent ? { prompt: this.clean(prompt) } : {}),
    });
  }

  event(turnId: string, event: AgentEvent): void {
    if (event.type === 'thinking') {
      this.flushText(turnId);
      this.iteration = event.iterations ?? this.iteration + 1;
      this.write('loop_started', { turn_id: turnId, iteration: this.iteration });
      return;
    }
    if (event.type === 'text') {
      this.text += String(event.delta ?? '');
      return;
    }
    if (event.type === 'tool_start') {
      const args = this.cleanValue(event.toolArgs);
      this.write('tool_started', {
        turn_id: turnId,
        iteration: this.iteration,
        call_id: event.callId ?? '',
        tool: event.toolName ?? '',
        action: describeAction(event.toolName ?? '', args),
        args,
      });
      return;
    }
    if (event.type === 'tool_end') {
      const result = event.toolResult;
      const content = String(result?.content ?? '');
      this.write('tool_finished', {
        turn_id: turnId,
        iteration: this.iteration,
        call_id: event.callId ?? '',
        tool: event.toolName ?? '',
        duration_ms: event.durationMs ?? 0,
        status: result?.isError ? 'error' : 'ok',
        is_error: Boolean(result?.isError),
        untrusted: result?.untrusted !== false,
        trust_zone: result?.trustZone ?? 'B',
        result_summary: this.resultSummary(content),
        result_chars: content.length,
        result_sha256: digest(content),
        meta: this.cleanValue(result?.meta),
        ...(event.preview ? { action_preview: this.clean(event.preview) } : {}),
        ...(event.previewKind ? { action_preview_kind: event.previewKind } : {}),
        ...(this.opts.includeContent ? { result_excerpt: this.clean(content) } : {}),
      });
      return;
    }

    this.write('agent_event', {
      turn_id: turnId,
      iteration: this.iteration,
      event: event.type,
      reason: this.clean(String(event.reason ?? '')),
      tool: event.toolName ?? '',
      iterations: event.iterations,
      duration_ms: event.durationMs,
      context: event.contextUsage
        ? {
            used_tokens: event.contextUsage.used,
            usable_tokens: event.contextUsage.usable,
            context_window: event.contextUsage.contextWindow,
            ratio: event.contextUsage.ratio,
            level: event.contextUsage.level,
          }
        : undefined,
    });
  }

  finishTurn(turnId: string, result: AgentRunResult): void {
    this.flushText(turnId);
    this.write('turn_finished', {
      turn_id: turnId,
      iterations: result.iterations,
      stopped_by: result.stoppedBy,
      tool_calls: result.toolCalls,
      injection_warnings: result.injectionWarnings,
      usage: result.usage,
      ...(result.error ? { error: this.clean(result.error.message) } : {}),
    });
  }

  private flushText(turnId: string): void {
    if (!this.text) return;
    const text = this.text;
    this.text = '';
    this.write('loop_response', {
      turn_id: turnId,
      iteration: this.iteration,
      chars: text.length,
      sha256: digest(text),
      ...(this.opts.includeContent ? { excerpt: this.clean(text) } : {}),
    });
  }

  private clean(text: string): string {
    const bounded = text.length > CONTENT_LIMIT ? `${text.slice(0, CONTENT_LIMIT)}\n…[truncated]` : text;
    return defaultRedactor.redactText(bounded, { aggressive: true });
  }

  /** A trace must say what a tool returned even in its safe default mode. */
  private resultSummary(content: string): string {
    const bounded =
      content.length > RESULT_SUMMARY_LIMIT
        ? `${content.slice(0, RESULT_SUMMARY_LIMIT)}\n…[truncated; see sha256 for full result]`
        : content;
    return defaultRedactor.redactText(bounded, { aggressive: true });
  }

  private cleanValue(value: unknown): unknown {
    return defaultRedactor.redactObject(value);
  }

  private write(type: string, data: Record<string, unknown>): void {
    const record = {
      ts: new Date().toISOString(),
      seq: ++this.seq,
      type,
      session_id: this.sessionId,
      ...data,
      ...(this.writeError ? { previous_write_error: this.writeError } : {}),
    };
    try {
      mkdirSync(dirname(this.opts.file), { recursive: true });
      appendFileSync(this.opts.file, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
      this.writeError = '';
    } catch (error) {
      this.writeError = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    }
  }
}

/** Human-readable intent beside the machine-readable, redacted arguments. */
function describeAction(tool: string, args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return `Call ${tool}`;
  const record = args as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  if (text(record.command)) return `Run command: ${text(record.command)}`;
  if (text(record.path)) return `${tool} ${text(record.path)}`;
  if (text(record.pattern)) return `${tool} for ${text(record.pattern)}`;
  if (text(record.query)) return `${tool}: ${text(record.query)}`;
  if (text(record.url)) return `${tool} ${text(record.url)}`;
  return `Call ${tool}`;
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
