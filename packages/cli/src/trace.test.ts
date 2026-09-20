import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentRunResult } from '@astra/core';
import { AgentTrace } from './trace.js';

describe('AgentTrace', () => {
  it('records loop and tool provenance without tool content by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astra-trace-'));
    const file = join(dir, 'run.jsonl');
    try {
      const trace = new AgentTrace({ file }, 'session-1');
      trace.beginTurn('turn-1', 'check login');
      trace.event('turn-1', { type: 'thinking', iterations: 1 });
      trace.event('turn-1', { type: 'text', delta: 'I will inspect the route.' });
      trace.event('turn-1', { type: 'tool_start', callId: 'c1', toolName: 'read_file', toolArgs: { path: 'src/login.ts' } });
      trace.event('turn-1', {
        type: 'tool_end', callId: 'c1', toolName: 'read_file', durationMs: 12,
        toolResult: { content: 'const password = "very-secret-value";', untrusted: true },
      });
      trace.finishTurn('turn-1', {
        text: 'done', messages: [], iterations: 1, toolCalls: 1,
        injectionWarnings: 0, stoppedBy: 'answer', usage: {},
      } as AgentRunResult);

      const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(rows.map((row) => row.type)).toEqual([
        'session_started', 'turn_started', 'loop_started', 'tool_started', 'tool_finished', 'loop_response', 'turn_finished',
      ]);
      const tool = rows.find((row) => row.type === 'tool_finished');
      expect(tool.result_chars).toBeGreaterThan(0);
      expect(tool.result_excerpt).toBeUndefined();
      expect(tool.result_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(rows.find((row) => row.type === 'loop_response').excerpt).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('redacts content when explicit capture is requested', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astra-trace-'));
    const file = join(dir, 'run.jsonl');
    try {
      const trace = new AgentTrace({ file, includeContent: true }, 'session-2');
      trace.beginTurn('turn-2', 'inspect');
      trace.event('turn-2', { type: 'thinking', iterations: 1 });
      trace.event('turn-2', {
        type: 'tool_end', callId: 'c1', toolName: 'read_file',
        toolResult: { content: 'token: sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDE', isError: false },
      });
      const tool = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).find((row) => row.type === 'tool_finished');
      expect(tool.result_excerpt).toContain('[REDACTED:');
      expect(tool.result_excerpt).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
