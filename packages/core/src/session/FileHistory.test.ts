import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../fs/FileSystem.js';
import { astraLayout, sessionHistoryDir } from '../home/layout.js';
import { Logger, MemorySink } from '../telemetry/logger.js';
import { ChangeLedger } from '../changes/ChangeLedger.js';
import { CheckpointStore } from './Checkpoint.js';
import { FileHistoryStore } from './FileHistory.js';
import { FsSessionStorage } from './FsSessionStorage.js';
import { SessionStore } from './SessionStore.js';

const HOME = process.platform === 'win32' ? 'C:\\Users\\test\\.astra' : '/home/test/.astra';
const layout = astraLayout(HOME);
const logger = (): Logger => new Logger({ sink: new MemorySink() });

function makeHistory(opts: { maxTurns?: number } = {}): {
  history: FileHistoryStore;
  fs: MemoryFileSystem;
} {
  const fs = new MemoryFileSystem({ files: {} });
  return { history: new FileHistoryStore({ fs, layout, logger: logger(), ...opts }), fs };
}

/** Dựng đúng đường đi thật: ledger ghi → checkpoint chụp → đĩa giữ. */
function capture(store: CheckpointStore, turnId: string, uri: string, before: string | null): void {
  const ledger = new ChangeLedger({ onRecord: (input) => store.capture(input) });
  ledger.record({
    uri,
    relativePath: uri,
    status: before === null ? 'created' : 'modified',
    originalContent: before,
    currentContent: 'sau khi sửa',
    turnId,
  });
}

describe('FileHistoryStore', () => {
  it('ghi bản chụp một lượt rồi nạp lại đúng nội dung', async () => {
    const { history } = makeHistory();
    const cps = new CheckpointStore();
    capture(cps, 't1', 'C:\\a.ts', 'bản gốc');

    await history.saveTurn('s1', cps.get('t1')!);
    const loaded = await history.load('s1');

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.entries[0]).toMatchObject({ uri: 'C:\\a.ts', content: 'bản gốc' });
  });

  // `content: null` là thông tin THẬT: lúc đó file chưa tồn tại, nên undo của nó
  // là xoá file đi. Lọc nhầm nó thành "thiếu dữ liệu" là để lại rác trên đĩa.
  it('giữ nguyên bản chụp của file mới tạo (content = null)', async () => {
    const { history } = makeHistory();
    const cps = new CheckpointStore();
    capture(cps, 't1', 'C:\\moi.ts', null);

    await history.saveTurn('s1', cps.get('t1')!);

    expect((await history.load('s1'))[0]?.entries[0]?.content).toBeNull();
  });

  it('nạp lại theo đúng thứ tự lượt, cũ nhất trước', async () => {
    const { history } = makeHistory();
    const cps = new CheckpointStore();
    capture(cps, 't1', 'C:\\a.ts', 'a');
    capture(cps, 't2', 'C:\\b.ts', 'b');

    await history.saveTurn('s1', { ...cps.get('t1')!, createdAt: 10 });
    await history.saveTurn('s1', { ...cps.get('t2')!, createdAt: 20 });

    expect((await history.load('s1')).map((c) => c.turnId)).toEqual(['t1', 't2']);
  });

  it('lượt không sửa file nào thì không tạo file rác', async () => {
    const { history, fs } = makeHistory();

    await history.saveTurn('s1', { turnId: 't0', createdAt: 1, entries: [] });

    expect(await fs.exists(sessionHistoryDir(layout, 's1'))).toBe(false);
  });

  it('cắt về N lượt gần nhất cho mỗi phiên', async () => {
    const { history } = makeHistory({ maxTurns: 2 });
    const cps = new CheckpointStore();

    for (let i = 1; i <= 5; i++) {
      capture(cps, `t${i}`, `C:\\f${i}.ts`, `nội dung ${i}`);
      await history.saveTurn('s1', { ...cps.get(`t${i}`)!, createdAt: i });
    }

    expect((await history.load('s1')).map((c) => c.turnId)).toEqual(['t4', 't5']);
  });

  it('phiên khác nhau không đụng vào nhau', async () => {
    const { history } = makeHistory();
    const cps = new CheckpointStore();
    capture(cps, 't1', 'C:\\a.ts', 'của s1');
    await history.saveTurn('s1', cps.get('t1')!);
    await history.saveTurn('s2', cps.get('t1')!);

    await history.removeSession('s1');

    expect(await history.load('s1')).toEqual([]);
    expect(await history.load('s2')).toHaveLength(1);
  });

  it('id phiên có ký tự lạ không ghi ra ngoài thư mục file-history', async () => {
    const { history, fs } = makeHistory();
    const cps = new CheckpointStore();
    capture(cps, 't1', 'C:\\a.ts', 'x');

    await history.saveTurn('../../thoát', cps.get('t1')!);

    expect(await fs.exists(join(HOME, 'thoát'))).toBe(false);
  });

  it('file hỏng chỉ mất một lượt, không mất cả phiên', async () => {
    const { history, fs } = makeHistory();
    const cps = new CheckpointStore();
    capture(cps, 't1', 'C:\\a.ts', 'còn đọc được');
    await history.saveTurn('s1', cps.get('t1')!);
    await fs.writeFile(join(sessionHistoryDir(layout, 's1'), 't2.json'), '{ hỏng');

    expect((await history.load('s1')).map((c) => c.turnId)).toEqual(['t1']);
  });
});

describe('CheckpointStore — nạp lại từ đĩa', () => {
  // Đây là toàn bộ mục đích của file-history: trước đây mở lại phiên cũ là mất
  // hẳn khả năng hoàn tác.
  it('/undo dùng được sau khi mở lại phiên', async () => {
    const { history } = makeHistory();
    const before = new CheckpointStore();
    capture(before, 't1', 'C:\\a.ts', 'bản trước lượt');
    await history.saveTurn('s1', before.get('t1')!);

    const after = new CheckpointStore();
    after.hydrate(await history.load('s1'));

    expect(after.lastTurnId()).toBe('t1');
    expect(after.restore('t1')).toEqual([{ uri: 'C:\\a.ts', content: 'bản trước lượt' }]);
  });

  it('hydrate thay thế hẳn chứ không gộp với phiên đang mở', () => {
    const store = new CheckpointStore();
    capture(store, 'cũ', 'C:\\cua-phien-truoc.ts', 'x');

    store.hydrate([{ turnId: 'mới', createdAt: 1, entries: [] }]);

    expect(store.get('cũ')).toBeUndefined();
    expect(store.size()).toBe(1);
  });

  // Không xoá bản trên đĩa thì lần mở lại sau sẽ hồi sinh đúng lượt vừa hoàn tác.
  it('restoreWithTurns nói ra những lượt vừa bị tiêu thụ để xoá trên đĩa', async () => {
    const { history } = makeHistory();
    const store = new CheckpointStore();
    capture(store, 't1', 'C:\\a.ts', 'a');
    capture(store, 't2', 'C:\\b.ts', 'b');
    await history.saveTurn('s1', { ...store.get('t1')!, createdAt: 1 });
    await history.saveTurn('s1', { ...store.get('t2')!, createdAt: 2 });

    const { removedTurnIds } = store.restoreWithTurns('t2');
    await history.removeTurns('s1', removedTurnIds);

    expect(removedTurnIds).toEqual(['t2']);
    expect((await history.load('s1')).map((c) => c.turnId)).toEqual(['t1']);
  });
});

describe('FsSessionStorage', () => {
  it('phiên của hai dự án nằm hai thư mục, không thấy nhau', async () => {
    const fs = new MemoryFileSystem({ files: {} });
    const a = new SessionStore({
      storage: new FsSessionStorage(fs, join(layout.projects, 'repo-a')),
      logger: logger(),
    });
    const b = new SessionStore({
      storage: new FsSessionStorage(fs, join(layout.projects, 'repo-b')),
      logger: logger(),
    });

    await a.save(a.create('C:\\repo-a'));
    await b.save(b.create('C:\\repo-b'));

    expect(await a.list()).toHaveLength(1);
    expect(await b.list()).toHaveLength(1);
  });

  // Trần phiên tính chung là lý do làm nhiều ở repo này đẩy phiên repo kia ra
  // khỏi đĩa. Tách thư mục làm trần đó thành trần theo từng repo.
  it('dọn phiên cũ của repo này không đụng phiên của repo kia', async () => {
    const fs = new MemoryFileSystem({ files: {} });
    const a = new SessionStore({
      storage: new FsSessionStorage(fs, join(layout.projects, 'repo-a')),
      logger: logger(),
      maxSessions: 1,
    });
    const b = new SessionStore({
      storage: new FsSessionStorage(fs, join(layout.projects, 'repo-b')),
      logger: logger(),
      maxSessions: 1,
    });
    await b.save(b.create('C:\\repo-b'));

    for (let i = 0; i < 3; i++) await a.save(a.create('C:\\repo-a'));
    await a.prune();

    expect(await a.list()).toHaveLength(1);
    expect(await b.list()).toHaveLength(1);
  });

  it('khoá có ký tự lạ không ghi ra ngoài thư mục dự án', async () => {
    const fs = new MemoryFileSystem({ files: {} });
    const storage = new FsSessionStorage(fs, join(layout.projects, 'repo-a'));

    await storage.write('../../thoat.json', 'x');

    expect(await fs.exists(join(HOME, 'thoat.json'))).toBe(false);
    expect(await storage.keys()).toEqual(['....thoat.json']);
  });
});
