import { describe, expect, it, vi } from 'vitest';
import {
  ALWAYS_ASK,
  PermissionManager,
  type PermissionAsker,
  type PermissionDecision,
} from './PermissionManager.js';
import { Logger, MemorySink } from '../telemetry/logger.js';

function manager(opts: { mode?: 'plan' | 'ask' | 'acceptEdits'; ask?: PermissionAsker } = {}) {
  return new PermissionManager({
    logger: new Logger({ sink: new MemorySink() }),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.ask ? { ask: opts.ask } : {}),
  });
}

const alwaysAllow = (): PermissionAsker => async () => 'allow_once';
const answering = (d: PermissionDecision): PermissionAsker => async () => d;

const edit = { tool: 'edit_file', readOnly: false, summary: 'Sửa src/a.ts', path: 'src/a.ts' };

describe('PermissionManager — tool chỉ đọc', () => {
  it('không bao giờ hỏi', async () => {
    const ask = vi.fn(alwaysAllow());
    const m = manager({ mode: 'ask', ask });

    const r = await m.check({ tool: 'read_file', readOnly: true, summary: 'Đọc' });

    expect(r.allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('PermissionManager — chế độ plan', () => {
  it('chặn tool có tác dụng phụ Ở TẦNG CORE, không hỏi người dùng', async () => {
    const ask = vi.fn(alwaysAllow());
    const m = manager({ mode: 'plan', ask });

    const r = await m.check(edit);

    expect(r.allowed).toBe(false);
    // Điểm mấu chốt: không có đường nào để người dùng "bấm cho qua" trong plan.
    expect(ask).not.toHaveBeenCalled();
    expect(r.reason).toContain('Plan mode');
  });

  it('chặn cả bash', async () => {
    const m = manager({ mode: 'plan', ask: alwaysAllow() });
    const r = await m.check({ tool: 'bash', readOnly: false, summary: 'npm test' });
    expect(r.allowed).toBe(false);
  });
});

describe('PermissionManager — acceptEdits', () => {
  it('tự duyệt sửa file', async () => {
    const ask = vi.fn(alwaysAllow());
    const m = manager({ mode: 'acceptEdits', ask });

    expect((await m.check(edit)).allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('vẫn hỏi với bash — ALWAYS_ASK thắng mọi chế độ', async () => {
    const ask = vi.fn(alwaysAllow());
    const m = manager({ mode: 'acceptEdits', ask });

    const r = await m.check({ tool: 'bash', readOnly: false, summary: 'npm test' });

    expect(ask).toHaveBeenCalledOnce();
    expect(r.askedUser).toBe(true);
  });

  it('mọi tên trong ALWAYS_ASK đều không tự duyệt được', async () => {
    for (const name of ALWAYS_ASK) {
      const ask = vi.fn(alwaysAllow());
      const m = manager({ mode: 'acceptEdits', ask });
      await m.check({ tool: name, readOnly: false, summary: name });
      expect(ask, `${name} phải được hỏi`).toHaveBeenCalledOnce();
    }
  });
});

/**
 * `preview` và `previewKind` phải sang tới `asker` NGUYÊN CẶP.
 *
 * Manager không đọc hai trường này, nên rơi mất một trong hai vẫn xanh mọi test
 * khác: quyền vẫn đúng, tool vẫn chạy. Chỗ hỏng nằm ở chỗ không ai kiểm — hộp
 * duyệt quyền nhận diff mà không biết đó là diff, nên vẽ ra một khối chữ trơn,
 * dòng thêm/xoá mất nền xanh/đỏ đúng lúc người dùng liếc để quyết định.
 */
describe('PermissionManager — bản xem trước đi tới người hỏi', () => {
  it('chuyển tiếp cả preview lẫn previewKind', async () => {
    const ask = vi.fn(alwaysAllow());
    const m = manager({ mode: 'ask', ask });

    await m.check({ ...edit, preview: '+    1 const a = 2;', previewKind: 'diff' });

    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ preview: '+    1 const a = 2;', previewKind: 'diff' }),
    );
  });

  it('không bịa previewKind khi tool không khai', async () => {
    const ask = vi.fn(alwaysAllow());
    const m = manager({ mode: 'ask', ask });

    await m.check({ tool: 'bash', readOnly: false, summary: 'npm test', preview: 'npm test' });

    expect(ask.mock.calls[0]![0]).not.toHaveProperty('previewKind');
  });
});

/**
 * Cảnh báo đè lên mọi đường tự duyệt.
 *
 * Đây là chỗ thay chân cho dòng "NO isolation" treo thường trực ngày trước:
 * không cảnh báo suốt phiên nữa, nhưng khi có thật thì nó phải đi qua mắt người dùng
 * dù họ đang ở chế độ nào.
 */
describe('PermissionManager — thao tác có cảnh báo', () => {
  const risky = {
    ...edit,
    warnings: ['~/.ssh/id_rsa — reads from your home folder, outside the workspace'],
  };

  it('acceptEdits không tự duyệt được nữa', async () => {
    const ask = vi.fn(alwaysAllow());
    const m = manager({ mode: 'acceptEdits', ask });

    const r = await m.check(risky);

    expect(ask).toHaveBeenCalledOnce();
    expect(r.askedUser).toBe(true);
  });

  it('cảnh báo đi tới tận người hỏi — không thì hộp duyệt không có gì để hiện', async () => {
    const ask = vi.fn(alwaysAllow());
    const m = manager({ mode: 'ask', ask });

    await m.check(risky);

    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ warnings: risky.warnings }));
  });

  it('quyền đã nhớ trước đó không che được một lần có cảnh báo', async () => {
    const ask = vi.fn(answering('allow_always'));
    const m = manager({ mode: 'ask', ask });

    await m.check(edit);
    expect((await m.check(edit)).askedUser).toBe(false);

    // Cùng tool, cùng thư mục, nhưng lần này nội dung với ra ngoài workspace.
    expect((await m.check(risky)).askedUser).toBe(true);
  });

  it('bấm "luôn cho phép" cũng không nhớ — lần sau vẫn hỏi', async () => {
    const ask = vi.fn(answering('allow_always'));
    const m = manager({ mode: 'ask', ask });

    await m.check(risky);
    await m.check(risky);

    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('không có cảnh báo thì không gửi trường rỗng xuống UI', async () => {
    const ask = vi.fn(alwaysAllow());
    const m = manager({ mode: 'ask', ask });

    await m.check({ ...edit, warnings: [] });

    expect(ask.mock.calls[0]![0]).not.toHaveProperty('warnings');
  });
});

describe('PermissionManager — nhớ quyết định trong phiên', () => {
  it('allow_always bỏ qua lần hỏi sau trong cùng thư mục', async () => {
    const ask = vi.fn(answering('allow_always'));
    const m = manager({ mode: 'ask', ask });

    await m.check(edit);
    await m.check({ ...edit, path: 'src/b.ts', summary: 'Sửa src/b.ts' });

    expect(ask).toHaveBeenCalledOnce();
  });

  it('không lan sang thư mục khác', async () => {
    const ask = vi.fn(answering('allow_always'));
    const m = manager({ mode: 'ask', ask });

    await m.check(edit);
    await m.check({ ...edit, path: '.github/workflows/ci.yml', summary: 'Sửa CI' });

    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('không nhớ cho bash kể cả khi người dùng bấm "luôn cho phép"', async () => {
    const ask = vi.fn(answering('allow_always'));
    const m = manager({ mode: 'ask', ask });

    await m.check({ tool: 'bash', readOnly: false, summary: 'ls' });
    await m.check({ tool: 'bash', readOnly: false, summary: 'ls' });

    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('reset quên hết', async () => {
    const ask = vi.fn(answering('allow_always'));
    const m = manager({ mode: 'ask', ask });

    await m.check(edit);
    m.reset();
    await m.check(edit);

    expect(ask).toHaveBeenCalledTimes(2);
  });
});

describe('PermissionManager — từ chối', () => {
  it('trả lý do đủ để model biết đừng thử lại', async () => {
    const m = manager({ mode: 'ask', ask: answering('deny') });
    const r = await m.check(edit);

    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('Do not retry');
  });

  it('không có kênh hỏi thì từ chối, không tự cho qua', async () => {
    const m = manager({ mode: 'ask' });
    expect((await m.check(edit)).allowed).toBe(false);
  });
});

describe('PermissionManager — hạ cấp theo nguồn', () => {
  it('acceptEdits rơi xuống ask sau khi hạ cấp', async () => {
    const ask = vi.fn(alwaysAllow());
    const m = manager({ mode: 'acceptEdits', ask });

    expect((await m.check(edit)).allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();

    m.downgrade('grep đọc phải chỉ thị lạ');

    await m.check(edit);
    expect(ask).toHaveBeenCalledOnce();
    expect(m.getState().effectiveMode).toBe('ask');
    expect(m.getState().downgradeReason).toContain('chỉ thị lạ');
  });

  it('xoá luôn quyền đã nhớ trước đó', async () => {
    const ask = vi.fn(answering('allow_always'));
    const m = manager({ mode: 'ask', ask });

    await m.check(edit);
    expect(m.getState().grants).toBe(1);

    m.downgrade('nội dung lạ');

    await m.check(edit);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('plan không bị ảnh hưởng — nó đã chặt nhất rồi', () => {
    const m = manager({ mode: 'plan' });
    m.downgrade('nội dung lạ');
    expect(m.getState().effectiveMode).toBe('plan');
  });

  it('hạ cấp hai lần chỉ giữ lý do đầu tiên', () => {
    const m = manager({ mode: 'acceptEdits' });
    m.downgrade('lý do 1');
    m.downgrade('lý do 2');
    expect(m.getState().downgradeReason).toBe('lý do 1');
  });

  it('người dùng chủ động chọn lại acceptEdits thì gỡ cờ hạ cấp', () => {
    const m = manager({ mode: 'acceptEdits' });
    m.downgrade('nội dung lạ');
    m.setMode('acceptEdits');
    expect(m.getState().downgraded).toBe(false);
  });
});
