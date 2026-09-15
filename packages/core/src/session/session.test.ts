import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../provider/types.js';
import { Logger, MemorySink } from '../telemetry/logger.js';
import { ChangeLedger } from '../changes/ChangeLedger.js';
import { CheckpointStore } from './Checkpoint.js';
import {
  MemorySessionStorage,
  SessionStore,
  appendTurn,
  type SessionStorage,
} from './SessionStore.js';
import {
  SESSION_SCHEMA_VERSION,
  migrateSession,
  parseSession,
  titleFrom,
  toolCallsBalanced,
  type PersistedSession,
  type PersistedTurn,
} from './types.js';

const logger = (): Logger => new Logger({ sink: new MemorySink() });

function makeStore(storage: SessionStorage = new MemorySessionStorage()): SessionStore {
  return new SessionStore({ storage, logger: logger() });
}

const turn = (id: string, over: Partial<PersistedTurn> = {}): PersistedTurn => ({
  id,
  prompt: `yêu cầu ${id}`,
  startedAt: Date.now(),
  durationMs: 1000,
  iterations: 2,
  toolCalls: 1,
  totalTokens: 500,
  stoppedBy: 'answer',
  filesTouched: 0,
  ...over,
});

describe('titleFrom', () => {
  it('lấy dòng đầu và cắt ngắn', () => {
    expect(titleFrom('sửa hàm login\nchi tiết ở dưới')).toBe('sửa hàm login');
    expect(titleFrom('x'.repeat(200)).length).toBeLessThanOrEqual(81);
  });

  it('rỗng thì có tên mặc định', () => {
    expect(titleFrom('   ')).toBe('Phiên trống');
  });
});

describe('parseSession / migrateSession', () => {
  const valid: PersistedSession = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: 's1',
    title: 'sửa login',
    workspaceRoot: '/work/app',
    createdAt: 1,
    updatedAt: 2,
    messages: [{ role: 'user', content: 'chào' }],
    turns: [turn('t1')],
    totalTokens: 500,
    compactions: 0,
  };

  it('đọc được phiên hợp lệ', () => {
    expect(parseSession(JSON.stringify(valid))?.id).toBe('s1');
  });

  it('JSON hỏng thì trả undefined, không ném', () => {
    expect(parseSession('{ hỏng')).toBeUndefined();
  });

  /**
   * Bản cũ đọc file của bản mới sẽ HIỂU NHẦM chứ không phải đọc thiếu — và
   * hiểu nhầm một lịch sử hội thoại tạo ra hành vi không giải thích được.
   */
  it('từ chối phiên có schemaVersion mới hơn bản đang chạy', () => {
    expect(migrateSession({ ...valid, schemaVersion: SESSION_SCHEMA_VERSION + 1 })).toBeUndefined();
  });

  it('nâng phiên không có schemaVersion lên bản hiện tại', () => {
    const old: Record<string, unknown> = { ...valid };
    delete old.schemaVersion;
    expect(migrateSession(old)?.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
  });

  it('thiếu id thì bỏ cả phiên', () => {
    expect(migrateSession({ ...valid, id: '' })).toBeUndefined();
  });

  /**
   * `toolSummaries` (v2) giữ bản tóm tắt tool mà NGƯỜI DÙNG đã đọc — thứ không
   * dựng lại được từ `messages`, vì trong đó là bản gửi model bằng tiếng Việt.
   */
  describe('toolSummaries (v2)', () => {
    it('đọc lại nguyên vẹn', () => {
      const withSummaries = {
        ...valid,
        toolSummaries: { c1: { summary: 'Edited a.ts (+2/−1)', isError: false } },
      };

      expect(parseSession(JSON.stringify(withSummaries))?.toolSummaries).toEqual({
        c1: { summary: 'Edited a.ts (+2/−1)', isError: false },
      });
    });

    /**
     * Phiên v1 phải mở được y như trước. Mất bản tiếng Anh là chấp nhận được;
     * mở không ra một hội thoại của chính người dùng thì không.
     */
    it('phiên v1 không có trường này vẫn mở được', () => {
      const v1: Record<string, unknown> = { ...valid, schemaVersion: 1 };
      const out = migrateSession(v1);

      expect(out?.id).toBe('s1');
      expect(out?.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
      expect(out?.toolSummaries).toBeUndefined();
    });

    it('bỏ mục hỏng thay vì bỏ cả phiên', () => {
      const out = migrateSession({
        ...valid,
        toolSummaries: {
          ok: { summary: 'Read 12 lines', isError: false },
          thiếuSummary: { isError: true },
          khôngPhảiObject: 'rác',
        },
      });

      expect(out?.id).toBe('s1');
      expect(Object.keys(out?.toolSummaries ?? {})).toEqual(['ok']);
    });

    it('isError thiếu thì coi như không hỏng, không phải undefined', () => {
      const out = migrateSession({ ...valid, toolSummaries: { c1: { summary: 'Done' } } });
      expect(out?.toolSummaries?.c1).toEqual({ summary: 'Done', isError: false });
    });
  });

  it('bỏ message hỏng nhưng giữ phần còn lại', () => {
    const parsed = migrateSession({
      ...valid,
      messages: [{ role: 'user', content: 'ok' }, { role: 'user' }, { role: 'lạ', content: 'x' }],
    });
    expect(parsed?.messages).toEqual([{ role: 'user', content: 'ok' }]);
  });

  it('giữ nguyên tool call của assistant', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'grep', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'kết quả' },
    ];
    expect(migrateSession({ ...valid, messages })?.messages).toEqual(messages);
  });

  /**
   * Một message `tool` mồ côi làm API từ chối CẢ request. Mở phiên mới còn hơn
   * một phiên gửi đâu lỗi đó mà người dùng không hiểu vì sao.
   */
  it('từ chối phiên có tool result mồ côi', () => {
    expect(
      migrateSession({
        ...valid,
        messages: [{ role: 'tool', toolCallId: 'c-lạ', content: 'kết quả' }],
      }),
    ).toBeUndefined();
  });

  it('turns hỏng thì bỏ turn đó chứ không bỏ phiên', () => {
    const parsed = migrateSession({ ...valid, turns: [turn('t1'), { prompt: 'thiếu id' }] });
    expect(parsed?.turns).toHaveLength(1);
  });
});

describe('toolCallsBalanced', () => {
  it('bắt được tool result mồ côi', () => {
    expect(toolCallsBalanced([{ role: 'tool', toolCallId: 'x', content: 'a' }])).toBe(false);
  });

  it('cặp đầy đủ thì hợp lệ', () => {
    expect(
      toolCallsBalanced([
        { role: 'assistant', content: null, toolCalls: [{ id: 'x', name: 'g', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'x', content: 'a' },
      ]),
    ).toBe(true);
  });
});

describe('SessionStore', () => {
  it('lưu rồi mở lại được', async () => {
    const s = makeStore();
    const session = s.create('/work/app', 'model-x');
    session.messages.push({ role: 'user', content: 'chào' });
    await s.save(session);

    const loaded = await s.load(session.id);
    expect(loaded?.messages).toEqual([{ role: 'user', content: 'chào' }]);
    expect(loaded?.model).toBe('model-x');
  });

  it('phiên không tồn tại thì trả undefined', async () => {
    expect(await makeStore().load('không-có')).toBeUndefined();
  });

  it('liệt kê mới nhất trước', async () => {
    const s = makeStore();
    const a = s.create('/work/app');
    const b = s.create('/work/app');
    await s.save(a);
    b.updatedAt = Date.now() + 1000;
    await s.save(b);
    // save() tự đặt updatedAt = now, nên ép lại để test tất định.
    b.updatedAt = Date.now() + 5000;

    const list = await s.list();
    expect(list).toHaveLength(2);
    expect(list[0]!.updatedAt).toBeGreaterThanOrEqual(list[1]!.updatedAt);
  });

  it('lọc theo workspace, không phân biệt dấu gạch cuối', async () => {
    const s = makeStore();
    await s.save(s.create('/work/app'));
    await s.save(s.create('/work/khac'));

    expect(await s.list('/work/app/')).toHaveLength(1);
  });

  it('bỏ qua phiên hỏng trên đĩa thay vì chết cả danh sách', async () => {
    const storage = new MemorySessionStorage();
    await storage.write('session-hong.json', 'không phải json');
    const s = makeStore(storage);
    await s.save(s.create('/work/app'));

    expect(await s.list()).toHaveLength(1);
  });

  it('không lưu được thì không ném — hội thoại vẫn còn trong bộ nhớ', async () => {
    const broken: SessionStorage = {
      read: async () => undefined,
      write: async () => {
        throw new Error('đĩa đầy');
      },
      remove: async () => undefined,
      keys: async () => [],
    };
    await expect(makeStore(broken).save(makeStore().create('/work/app'))).resolves.toBeUndefined();
  });

  it('dọn phiên vượt trần, giữ phiên mới', async () => {
    const storage = new MemorySessionStorage();
    const s = new SessionStore({ storage, logger: logger(), maxSessions: 2 });
    for (let i = 0; i < 5; i++) {
      const session = s.create('/work/app');
      session.updatedAt = i;
      await storage.write(`session-${session.id}.json`, JSON.stringify(session));
    }

    expect(await s.prune()).toBe(3);
    expect(await s.list()).toHaveLength(2);
  });

  it('id có ký tự lạ không thoát ra ngoài thư mục lưu trữ', async () => {
    const storage = new MemorySessionStorage();
    const s = makeStore(storage);
    const session = s.create('/work/app');
    session.id = '../../evil';
    await s.save(session);

    expect((await storage.keys())[0]).toBe('session-evil.json');
  });
});

describe('appendTurn', () => {
  it('lượt đầu đặt tiêu đề cho phiên', () => {
    const s = makeStore().create('/work/app');
    appendTurn(s, turn('t1', { prompt: 'sửa hàm login' }));
    expect(s.title).toBe('sửa hàm login');
  });

  it('cộng dồn token, không đổi tiêu đề ở lượt sau', () => {
    const s = makeStore().create('/work/app');
    appendTurn(s, turn('t1', { prompt: 'việc đầu', totalTokens: 100 }));
    appendTurn(s, turn('t2', { prompt: 'việc sau', totalTokens: 250 }));

    expect(s.title).toBe('việc đầu');
    expect(s.totalTokens).toBe(350);
  });
});

// ─── Checkpoint ─────────────────────────────────────────────────────────────

describe('CheckpointStore', () => {
  const write = (
    turnId: string,
    uri: string,
    before: string | null,
    after: string | null,
  ): Parameters<CheckpointStore['capture']>[0] => ({
    uri,
    relativePath: uri,
    status: before === null ? 'created' : after === null ? 'deleted' : 'modified',
    originalContent: before,
    currentContent: after,
    turnId,
  });

  it('chụp trạng thái trước lượt, không phải trước cả phiên', () => {
    const cp = new CheckpointStore();
    cp.capture(write('t1', '/a.ts', 'A', 'B'));
    cp.capture(write('t2', '/a.ts', 'B', 'C'));

    expect(cp.restore('t2')).toEqual([{ uri: '/a.ts', content: 'B' }]);
  });

  it('chỉ chụp lần đụng đầu tiên trong một lượt', () => {
    const cp = new CheckpointStore();
    cp.capture(write('t1', '/a.ts', 'A', 'B'));
    cp.capture(write('t1', '/a.ts', 'B', 'C'));

    expect(cp.restore('t1')).toEqual([{ uri: '/a.ts', content: 'A' }]);
  });

  /** Bỏ qua lượt sau sẽ để lại file ở trạng thái chưa từng tồn tại. */
  it('hoàn tác một lượt thì gộp cả các lượt sau nó', () => {
    const cp = new CheckpointStore();
    cp.capture(write('t1', '/a.ts', 'A', 'B'));
    cp.capture(write('t2', '/b.ts', null, 'mới'));
    cp.capture(write('t3', '/a.ts', 'B', 'C'));

    expect(cp.restore('t1').sort((x, y) => x.uri.localeCompare(y.uri))).toEqual([
      { uri: '/a.ts', content: 'A' },
      { uri: '/b.ts', content: null },
    ]);
  });

  it('file mới tạo được hoàn tác bằng cách xoá', () => {
    const cp = new CheckpointStore();
    cp.capture(write('t1', '/moi.ts', null, 'nội dung'));
    expect(cp.restore('t1')).toEqual([{ uri: '/moi.ts', content: null }]);
  });

  it('hoàn tác xong thì lượt đó biến khỏi lịch sử', () => {
    const cp = new CheckpointStore();
    cp.capture(write('t1', '/a.ts', 'A', 'B'));
    cp.capture(write('t2', '/a.ts', 'B', 'C'));

    cp.restore('t2');
    expect(cp.lastTurnId()).toBe('t1');
    expect(cp.restore('t2')).toEqual([]);
  });

  it('lượt không có thay đổi file nào thì không vào lịch sử undo', () => {
    const cp = new CheckpointStore();
    cp.capture(write('t1', '/a.ts', 'A', 'B'));
    expect(cp.lastTurnId()).toBe('t1');
  });

  it('không giữ nội dung file khổng lồ, nhưng có đếm', () => {
    const cp = new CheckpointStore({ maxFileChars: 10 });
    cp.capture(write('t1', '/to.ts', 'x'.repeat(100), 'y'));

    expect(cp.restore('t1')).toEqual([]);
    expect(cp.skippedFiles()).toBe(1);
  });

  it('quên lượt cũ khi vượt trần', () => {
    const cp = new CheckpointStore({ maxTurns: 2 });
    cp.capture(write('t1', '/a.ts', 'A', 'B'));
    cp.capture(write('t2', '/b.ts', 'A', 'B'));
    cp.capture(write('t3', '/c.ts', 'A', 'B'));

    expect(cp.size()).toBe(2);
    expect(cp.restore('t1')).toEqual([]);
  });

  it('gắn được vào ChangeLedger qua onRecord', () => {
    const cp = new CheckpointStore({ caseInsensitive: false });
    const ledger = new ChangeLedger({
      caseInsensitive: false,
      onRecord: (input) => cp.capture(input),
    });

    ledger.record(write('t1', '/a.ts', 'A', 'B'));
    ledger.record(write('t2', '/a.ts', 'B', 'C'));

    expect(cp.restore('t2')).toEqual([{ uri: '/a.ts', content: 'B' }]);
    // Sổ vẫn giữ bản gốc của cả phiên — hai vai trò khác nhau.
    expect(ledger.get('/a.ts')?.originalContent).toBe('A');
  });
});

describe('ChangeLedger.applyUndo', () => {
  it('file về đúng bản gốc thì gỡ khỏi sổ', () => {
    const ledger = new ChangeLedger({ caseInsensitive: false });
    ledger.record({
      uri: '/a.ts',
      relativePath: 'a.ts',
      status: 'modified',
      originalContent: 'A',
      currentContent: 'B',
      turnId: 't1',
    });

    ledger.applyUndo([{ uri: '/a.ts', content: 'A' }]);
    expect(ledger.get('/a.ts')).toBeUndefined();
  });

  it('file còn khác bản gốc thì giữ bản ghi và cập nhật nội dung', () => {
    const ledger = new ChangeLedger({ caseInsensitive: false });
    ledger.record({
      uri: '/a.ts',
      relativePath: 'a.ts',
      status: 'modified',
      originalContent: 'A',
      currentContent: 'C',
      turnId: 't2',
    });

    ledger.applyUndo([{ uri: '/a.ts', content: 'B' }]);
    expect(ledger.get('/a.ts')?.currentContent).toBe('B');
  });
});
