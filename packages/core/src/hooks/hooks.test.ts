import { describe, expect, it } from 'vitest';
import * as nodePath from 'node:path';
import { MemoryFileSystem } from '../fs/FileSystem.js';
import { Logger, MemorySink } from '../telemetry/logger.js';
import {
  HookRunner,
  MemoryApprovalStore,
  describeHook,
  fingerprintOf,
  loadHooks,
  type LoadedHook,
} from './hooks.js';

const WINDOWS = nodePath.sep === '\\';
const ROOT = WINDOWS ? 'C:\\work\\app' : '/work/app';
const HOME = WINDOWS ? 'C:\\Users\\dev' : '/home/dev';
const p = (...parts: string[]): string => nodePath.join(...parts);
const fs = (files: Record<string, string>): MemoryFileSystem =>
  new MemoryFileSystem({ files, caseInsensitive: WINDOWS });
const logger = (): Logger => new Logger({ sink: new MemorySink() });

const CONFIG = JSON.stringify({
  preToolUse: [
    { match: 'write_file|edit_file', command: 'node', args: ['-e', 'process.exit(0)'] },
  ],
  stop: [{ command: 'node', args: ['-e', ''] }],
});

/** Lệnh thật, chạy được trên mọi máy có Node — chính là máy đang chạy test. */
function nodeHook(over: Partial<LoadedHook> & { code: string }): LoadedHook {
  const spec = {
    match: over.match ?? '',
    command: process.execPath,
    args: ['-e', over.code],
    timeoutMs: over.timeoutMs ?? 15_000,
    description: over.description ?? '',
  };
  return {
    ...spec,
    event: over.event ?? 'preToolUse',
    source: over.source ?? 'user',
    path: '/x/hooks.json',
    fingerprint: fingerprintOf(over.event ?? 'preToolUse', spec),
  };
}

describe('loadHooks — cổng workspace trust', () => {
  it('KHÔNG đọc hooks.json của repo khi chưa tin cậy, và nói ra lý do', async () => {
    const r = await loadHooks({
      fs: fs({ [p(ROOT, '.astra', 'hooks.json')]: CONFIG }),
      workspaceRoot: ROOT,
    });

    expect(r.hooks).toEqual([]);
    expect(r.rejections[0]).toContain('chưa được tin cậy');
  });

  it('đọc hooks.json của repo khi đã tin cậy', async () => {
    const r = await loadHooks({
      fs: fs({ [p(ROOT, '.astra', 'hooks.json')]: CONFIG }),
      workspaceRoot: ROOT,
      allowProjectHooks: true,
    });

    expect(r.hooks.map((h) => h.event)).toEqual(['preToolUse', 'stop']);
    expect(r.hooks[0]!.source).toBe('project');
  });

  it('hooks.json của người dùng luôn được đọc', async () => {
    const r = await loadHooks({
      fs: fs({ [p(HOME, '.astra', 'hooks.json')]: CONFIG }),
      homeDir: HOME,
    });
    expect(r.hooks).toHaveLength(2);
    expect(r.hooks[0]!.source).toBe('user');
  });

  it('JSON hỏng hay sai schema → bỏ qua kèm lý do, không ném', async () => {
    const bad = await loadHooks({
      fs: fs({ [p(HOME, '.astra', 'hooks.json')]: '{ hỏng' }),
      homeDir: HOME,
    });
    expect(bad.hooks).toEqual([]);
    expect(bad.rejections[0]).toContain('không phải JSON');

    const wrong = await loadHooks({
      fs: fs({ [p(HOME, '.astra', 'hooks.json')]: '{"preToolUse":[{"args":[]}]}' }),
      homeDir: HOME,
    });
    expect(wrong.hooks).toEqual([]);
    expect(wrong.rejections[0]).toContain('sai schema');
  });

  it('mẫu match không biên dịch được → bỏ hook đó, giữ các hook khác', async () => {
    const r = await loadHooks({
      fs: fs({
        [p(HOME, '.astra', 'hooks.json')]: JSON.stringify({
          preToolUse: [
            { match: '([', command: 'a' },
            { match: 'bash', command: 'b' },
          ],
        }),
      }),
      homeDir: HOME,
    });
    expect(r.hooks.map((h) => h.command)).toEqual(['b']);
    expect(r.rejections[0]).toContain('match');
  });

  it('mẫu match có lượng từ lồng nhau bị bỏ — nó treo được extension host', async () => {
    // `(a+)+$` biên dịch được, nên phép kiểm cũ ("có compile được không") cho nó
    // qua. `match` lại được chạy TRƯỚC MỖI lời gọi tool, nên một mẫu như vậy
    // trong `.astra/hooks.json` là một cái treo máy nằm chờ. Sổ nợ #6.
    const r = await loadHooks({
      fs: fs({
        [p(HOME, '.astra', 'hooks.json')]: JSON.stringify({
          preToolUse: [
            { match: '(a+)+$', command: 'a' },
            { match: 'bash', command: 'b' },
          ],
        }),
      }),
      homeDir: HOME,
    });
    expect(r.hooks.map((h) => h.command)).toEqual(['b']);
    expect(r.rejections[0]).toContain('match');
  });
});

describe('fingerprint — duyệt theo NỘI DUNG lệnh', () => {
  const base = { match: 'x', command: 'node', args: ['a.js'], timeoutMs: 1000, description: '' };

  it('đổi lệnh thì vân tay đổi — duyệt cũ mất hiệu lực', () => {
    expect(fingerprintOf('preToolUse', base)).not.toBe(
      fingerprintOf('preToolUse', { ...base, command: 'curl' }),
    );
    expect(fingerprintOf('preToolUse', base)).not.toBe(
      fingerprintOf('preToolUse', { ...base, args: ['b.js'] }),
    );
  });

  it('đổi mô tả thì vân tay KHÔNG đổi — mô tả không quyết định chạy gì', () => {
    expect(fingerprintOf('preToolUse', base)).toBe(
      fingerprintOf('preToolUse', { ...base, description: 'khác hẳn' }),
    );
  });

  it('cùng lệnh nhưng khác sự kiện là hai thứ cần duyệt riêng', () => {
    expect(fingerprintOf('preToolUse', base)).not.toBe(fingerprintOf('stop', base));
  });

  it('describeHook nói rõ lệnh sẽ chạy và nguồn', () => {
    const text = describeHook(nodeHook({ code: '', source: 'project' }));
    expect(text).toContain('Lệnh:');
    expect(text).toContain('repo');
  });
});

describe('HookRunner', () => {
  it('hook CHƯA duyệt thì không chạy, và không có kênh hỏi thì cũng không chạy', async () => {
    const hook = nodeHook({ code: 'process.exit(1)', match: 'write_file' });
    const runner = new HookRunner({
      hooks: [hook],
      logger: logger(),
      approvals: new MemoryApprovalStore(),
    });

    const r = await runner.run({ event: 'preToolUse', toolName: 'write_file' });
    // Không chạy = không chặn: hook chưa duyệt không được có tác dụng nào cả.
    expect(r.allowed).toBe(true);
    expect(r.ran).toEqual([]);
  });

  it('hỏi người dùng một lần rồi nhớ theo vân tay', async () => {
    const hook = nodeHook({ code: 'process.exit(0)', match: 'write_file' });
    const approvals = new MemoryApprovalStore();
    let asked = 0;

    const runner = new HookRunner({
      hooks: [hook],
      logger: logger(),
      approvals,
      ask: async () => {
        asked++;
        return true;
      },
    });

    await runner.run({ event: 'preToolUse', toolName: 'write_file' });
    await runner.run({ event: 'preToolUse', toolName: 'write_file' });

    expect(asked).toBe(1);
    expect(approvals.isApproved(hook.fingerprint)).toBe(true);
  });

  it('người dùng từ chối → hook không chạy và không được nhớ', async () => {
    const hook = nodeHook({ code: 'process.exit(1)', match: 'write_file' });
    const approvals = new MemoryApprovalStore();
    const runner = new HookRunner({
      hooks: [hook],
      logger: logger(),
      approvals,
      ask: async () => false,
    });

    const r = await runner.run({ event: 'preToolUse', toolName: 'write_file' });
    expect(r.allowed).toBe(true);
    expect(approvals.isApproved(hook.fingerprint)).toBe(false);
  });

  it('preToolUse thoát khác 0 → CHẶN tool, lý do lấy từ output của hook', async () => {
    const hook = nodeHook({
      code: 'console.log("không được sửa file trong infra/"); process.exit(2)',
      match: 'write_file',
    });
    const runner = new HookRunner({
      hooks: [hook],
      logger: logger(),
      approvals: new MemoryApprovalStore([hook.fingerprint]),
    });

    const r = await runner.run({ event: 'preToolUse', toolName: 'write_file' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('infra/');
    expect(r.reason).toContain('Đừng thử lại');
  });

  it('preToolUse thoát 0 → cho qua', async () => {
    const hook = nodeHook({ code: 'process.exit(0)', match: 'write_file' });
    const runner = new HookRunner({
      hooks: [hook],
      logger: logger(),
      approvals: new MemoryApprovalStore([hook.fingerprint]),
    });

    const r = await runner.run({ event: 'preToolUse', toolName: 'write_file' });
    expect(r.allowed).toBe(true);
    expect(r.ran).toHaveLength(1);
  });

  it('postToolUse thoát khác 0 KHÔNG chặn — tool đã chạy rồi', async () => {
    const hook = nodeHook({ code: 'process.exit(3)', event: 'postToolUse' });
    const runner = new HookRunner({
      hooks: [hook],
      logger: logger(),
      approvals: new MemoryApprovalStore([hook.fingerprint]),
    });

    expect((await runner.run({ event: 'postToolUse', toolName: 'write_file' })).allowed).toBe(true);
  });

  it('chỉ chạy hook khớp `match`', async () => {
    const hook = nodeHook({ code: 'process.exit(1)', match: '^bash$' });
    const runner = new HookRunner({
      hooks: [hook],
      logger: logger(),
      approvals: new MemoryApprovalStore([hook.fingerprint]),
    });

    expect((await runner.run({ event: 'preToolUse', toolName: 'read_file' })).ran).toEqual([]);
    expect((await runner.run({ event: 'preToolUse', toolName: 'bash' })).allowed).toBe(false);
  });

  it('hook nhận ngữ cảnh qua env, KHÔNG qua argv', async () => {
    // In ra tên tool lấy từ env rồi chặn — nếu env không tới nơi, chuỗi rỗng.
    const hook = nodeHook({
      code: 'console.log("TOOL=" + process.env.ASTRA_HOOK_TOOL + " EV=" + process.env.ASTRA_HOOK_EVENT); process.exit(1)',
      match: 'write_file',
    });
    const runner = new HookRunner({
      hooks: [hook],
      logger: logger(),
      approvals: new MemoryApprovalStore([hook.fingerprint]),
    });

    const r = await runner.run({
      event: 'preToolUse',
      toolName: 'write_file',
      args: { path: 'a.ts' },
    });
    expect(r.reason).toContain('TOOL=write_file');
    expect(r.reason).toContain('EV=preToolUse');
  });

  it('lệnh không tồn tại KHÔNG chặn tool — hook hỏng không được làm agent đứng im', async () => {
    const spec = { match: '', command: 'khong-co-lenh-nay-dau', args: [], timeoutMs: 5000, description: '' };
    const hook: LoadedHook = {
      ...spec,
      event: 'preToolUse',
      source: 'user',
      path: '/x',
      fingerprint: fingerprintOf('preToolUse', spec),
    };
    const runner = new HookRunner({
      hooks: [hook],
      logger: logger(),
      approvals: new MemoryApprovalStore([hook.fingerprint]),
    });

    expect((await runner.run({ event: 'preToolUse', toolName: 'x' })).allowed).toBe(true);
  });

  it('hook treo quá timeout thì bị giết và coi như chặn (thoát khác 0)', async () => {
    const hook = nodeHook({
      code: 'setTimeout(() => {}, 60000)',
      match: 'write_file',
      timeoutMs: 300,
    });
    const runner = new HookRunner({
      hooks: [hook],
      logger: logger(),
      approvals: new MemoryApprovalStore([hook.fingerprint]),
    });

    const r = await runner.run({ event: 'preToolUse', toolName: 'write_file' });
    expect(r.allowed).toBe(false);
  }, 15_000);

  it('has() cho biết có hook của sự kiện nào', () => {
    const hook = nodeHook({ code: '', event: 'stop' });
    const runner = new HookRunner({
      hooks: [hook],
      logger: logger(),
      approvals: new MemoryApprovalStore(),
    });
    expect(runner.has('stop')).toBe(true);
    expect(runner.has('preToolUse')).toBe(false);
  });
});
