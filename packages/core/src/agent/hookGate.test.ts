/**
 * Hooks nhìn từ AgentLoop (M8).
 *
 * Test của HookRunner kiểm tra logic quyết định; test này kiểm tra rằng quyết
 * định đó thật sự nằm TRÊN ĐƯỜNG ĐI của tool — và nằm SAU cổng quyền, tức là
 * hook không mở được thứ mà quyền đã đóng.
 */
import { describe, expect, it, vi } from 'vitest';
import * as nodePath from 'node:path';
import { AgentLoop, type AgentEvent } from './AgentLoop.js';
import { MockProvider } from '../provider/MockProvider.js';
import { ToolRegistry, type ToolContext } from '../tools/Tool.js';
import { readFileTool } from '../tools/readFile.js';
import { editFileTool } from '../tools/editFile.js';
import { MemoryFileSystem } from '../fs/FileSystem.js';
import { PathGuard } from '../security/pathGuard.js';
import { Denylist } from '../security/denylist.js';
import { ChangeLedger } from '../changes/ChangeLedger.js';
import { PermissionManager, type PermissionAsker } from '../permissions/PermissionManager.js';
import { Logger, MemorySink } from '../telemetry/logger.js';
import {
  HookRunner,
  MemoryApprovalStore,
  fingerprintOf,
  type HookEvent,
  type LoadedHook,
} from '../hooks/hooks.js';

const WINDOWS = nodePath.sep === '\\';
const ROOT = WINDOWS ? 'C:\\work\\app' : '/work/app';
const p = (...parts: string[]): string => nodePath.join(ROOT, ...parts);

function hook(code: string, event: HookEvent = 'preToolUse', match = ''): LoadedHook {
  const spec = {
    match,
    command: process.execPath,
    args: ['-e', code],
    timeoutMs: 10_000,
    description: '',
  };
  return {
    ...spec,
    event,
    source: 'project',
    path: p('.astra', 'hooks.json'),
    fingerprint: fingerprintOf(event, spec),
  };
}

function setup(opts: {
  hooks: LoadedHook[];
  mode?: 'plan' | 'ask' | 'acceptEdits';
  ask?: PermissionAsker;
  turns: MockProvider['opts']['turns'];
}): { loop: AgentLoop; fs: MemoryFileSystem } {
  const fs = new MemoryFileSystem({
    files: { [p('src', 'a.ts')]: 'const a = 1;\n' },
    caseInsensitive: WINDOWS,
  });
  const logger = new Logger({ sink: new MemorySink() });

  const toolContext: ToolContext = {
    workspaceRoot: ROOT,
    fs,
    pathGuard: new PathGuard({ workspaceRoot: ROOT, fs }),
    denylist: new Denylist(),
    logger,
    ledger: new ChangeLedger({ caseInsensitive: WINDOWS }),
    turnId: 't1',
  };

  const loop = new AgentLoop({
    provider: new MockProvider({ turns: opts.turns }),
    tools: new ToolRegistry([readFileTool, editFileTool]),
    toolContext,
    logger,
    systemPrompt: 'Bạn là AstraCode.',
    permissions: new PermissionManager({
      logger,
      mode: opts.mode ?? 'acceptEdits',
      ...(opts.ask ? { ask: opts.ask } : {}),
    }),
    hooks: new HookRunner({
      hooks: opts.hooks,
      logger,
      approvals: new MemoryApprovalStore(opts.hooks.map((h) => h.fingerprint)),
    }),
  });

  return { loop, fs };
}

async function drain(loop: AgentLoop, msg: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const gen = loop.run(msg);
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return events;
}

const editCall = {
  id: 'c1',
  name: 'edit_file',
  arguments: JSON.stringify({
    path: 'src/a.ts',
    old_string: 'const a = 1;',
    new_string: 'const a = 2;',
  }),
};

describe('AgentLoop — hooks', () => {
  it('preToolUse chặn thì file KHÔNG bị đụng và model nhận lý do', async () => {
    const { loop, fs } = setup({
      hooks: [hook('console.log("file này bị khoá"); process.exit(1)', 'preToolUse', 'edit_file')],
      turns: [{ toolCalls: [editCall] }, { text: ['Được, tôi dừng.'] }],
    });

    const events = await drain(loop, 'sửa file đi');
    const blocked = events.find((e) => e.type === 'hook_blocked');

    expect(blocked?.reason).toContain('bị khoá');
    expect(events.some((e) => e.type === 'tool_start')).toBe(false);
    expect(await fs.readFile(p('src', 'a.ts'))).toBe('const a = 1;\n');
  }, 20_000);

  it('preToolUse cho qua thì tool chạy bình thường', async () => {
    const { loop, fs } = setup({
      hooks: [hook('process.exit(0)', 'preToolUse', 'edit_file')],
      turns: [{ toolCalls: [editCall] }, { text: ['Xong.'] }],
    });

    const events = await drain(loop, 'sửa file đi');

    expect(events.some((e) => e.type === 'hook_blocked')).toBe(false);
    expect(events.some((e) => e.type === 'tool_end')).toBe(true);
    expect(await fs.readFile(p('src', 'a.ts'))).toBe('const a = 2;\n');
  }, 20_000);

  it('hook KHÔNG mở được thứ mà quyền đã đóng', async () => {
    const ask = vi.fn<PermissionAsker>(async () => 'allow_once');
    const { loop, fs } = setup({
      // Hook này "cho phép" (exit 0) nhưng chế độ plan vẫn phải thắng.
      hooks: [hook('process.exit(0)', 'preToolUse', 'edit_file')],
      mode: 'plan',
      ask,
      turns: [{ toolCalls: [editCall] }, { text: ['Tôi chỉ lập kế hoạch.'] }],
    });

    const events = await drain(loop, 'sửa file đi');

    expect(events.some((e) => e.type === 'permission_denied')).toBe(true);
    expect(events.some((e) => e.type === 'tool_start')).toBe(false);
    expect(await fs.readFile(p('src', 'a.ts'))).toBe('const a = 1;\n');
  }, 20_000);

  it('hook chỉ áp cho tool khớp `match`', async () => {
    const { loop } = setup({
      hooks: [hook('process.exit(1)', 'preToolUse', '^edit_file$')],
      turns: [
        { toolCalls: [{ id: 'r1', name: 'read_file', arguments: JSON.stringify({ path: 'src/a.ts' }) }] },
        { text: ['Đã đọc.'] },
      ],
    });

    const events = await drain(loop, 'đọc file');
    expect(events.some((e) => e.type === 'hook_blocked')).toBe(false);
    expect(events.some((e) => e.type === 'tool_end')).toBe(true);
  }, 20_000);

  it('hook stop lỗi không làm hỏng lượt — người dùng đã có câu trả lời', async () => {
    const { loop } = setup({
      hooks: [hook('process.exit(9)', 'stop')],
      turns: [{ text: ['Xong rồi.'] }],
    });

    const events = await drain(loop, 'chào');
    expect(events.some((e) => e.type === 'done')).toBe(true);
  }, 20_000);
});
