import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../fs/FileSystem.js';
import { Logger, MemorySink } from '../telemetry/logger.js';
import { StateStore, parseState, STATE_SCHEMA_VERSION } from './StateStore.js';
import { astraLayout } from './layout.js';

const HOME = process.platform === 'win32' ? 'C:\\Users\\test\\.astra' : '/home/test/.astra';
const layout = astraLayout(HOME);
const logger = (): Logger => new Logger({ sink: new MemorySink() });

function makeStore(files: Record<string, string> = {}, now = () => 1_000): {
  store: StateStore;
  fs: MemoryFileSystem;
} {
  const fs = new MemoryFileSystem({ files });
  return { store: new StateStore({ fs, layout, logger: logger(), now }), fs };
}

describe('StateStore — đọc', () => {
  it('chưa có file thì trả bản rỗng kèm machineId mới, không ném', async () => {
    const { store } = makeStore();
    const state = await store.load();

    expect(state.startups).toBe(0);
    expect(state.machineId).not.toBe('');
    expect(state.projects).toEqual({});
  });

  it('file hỏng KHÔNG làm mất state: lấy bản backup gần nhất', async () => {
    const good = JSON.stringify({ schemaVersion: 1, machineId: 'm1', startups: 7, projects: {} });
    const { store } = makeStore({
      [layout.state]: '{ hỏng giữa chừng',
      [join(layout.backups, 'state.json.backup.100')]: good,
    });

    expect((await store.load()).startups).toBe(7);
  });

  // Bản cũ đọc file của bản mới rồi ghi đè là cách làm hỏng cấu hình của người
  // đang cài song song hai bản.
  it('schemaVersion mới hơn bản đang chạy ⇒ không đọc', () => {
    const raw = JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION + 1, machineId: 'm' });
    expect(parseState(raw)).toBeUndefined();
  });
});

describe('StateStore — ghi', () => {
  it('recordStartup cộng dồn qua các lần chạy', async () => {
    const { store } = makeStore();

    await store.recordStartup('0.0.18');
    const state = await store.recordStartup('0.0.18');

    expect(state.startups).toBe(2);
    expect(state.lastVersion).toBe('0.0.18');
  });

  it('touchProject cộng dồn số phiên và số lượt theo từng repo', async () => {
    const { store } = makeStore();

    await store.touchProject('C:\\a', { sessions: 1, turns: 3 });
    await store.touchProject('C:\\a', { turns: 2 });
    await store.touchProject('C:\\b', { sessions: 1 });

    expect(await store.project('C:\\a')).toMatchObject({ sessions: 1, turns: 5, lastUsedAt: 1_000 });
    expect(await store.project('C:\\b')).toMatchObject({ sessions: 1, turns: 0 });
  });

  // Hai lượt kết thúc gần nhau là chuyện bình thường. Không nối đuôi thì bên
  // ghi sau đọc trước khi bên trước ghi xong, và một trong hai lần mất trắng.
  it('hai lần update chạy song song không nuốt mất nhau', async () => {
    const { store } = makeStore();

    await Promise.all([
      store.touchProject('C:\\a', { turns: 1 }),
      store.touchProject('C:\\a', { turns: 1 }),
      store.touchProject('C:\\a', { turns: 1 }),
    ]);

    expect((await store.project('C:\\a'))?.turns).toBe(3);
  });

  it('giữ bản sao trước khi ghi đè, và cắt bớt bản cũ', async () => {
    let clock = 100;
    const fs = new MemoryFileSystem({ files: {} });
    const store = new StateStore({
      fs,
      layout,
      logger: logger(),
      maxBackups: 2,
      now: () => clock++,
    });

    for (let i = 0; i < 5; i++) await store.recordStartup();

    const backups = (await fs.readDir(layout.backups)).filter((e) =>
      e.name.startsWith('state.json.backup.'),
    );
    expect(backups.length).toBe(2);
  });

  it('nhớ tối đa N dự án, quên dự án lâu không đụng nhất trước', async () => {
    let clock = 1;
    const fs = new MemoryFileSystem({ files: {} });
    const store = new StateStore({ fs, layout, logger: logger(), maxProjects: 2, now: () => clock++ });

    await store.touchProject('C:\\cu-nhat');
    await store.touchProject('C:\\giua');
    await store.touchProject('C:\\moi-nhat');

    const state = await store.load();
    expect(Object.keys(state.projects).sort()).toEqual(['C:\\giua', 'C:\\moi-nhat']);
  });
});

describe('StateStore — model không gọi được tool native', () => {
  // Ở HOME chứ không ở globalState của VS Code: đo bằng CLI thì extension khỏi
  // tốn một request hỏng để học lại đúng điều vừa học.
  it('nhớ được và đọc lại được', async () => {
    const { store, fs } = makeStore();

    await store.markNativeUnsupported('model-x');
    await store.markNativeUnsupported('model-x');

    expect(await store.isNativeUnsupported('model-x')).toBe(true);
    expect(await store.isNativeUnsupported('model-y')).toBe(false);
    expect(parseState(await fs.readFile(layout.state))?.nativeToolsUnsupported).toEqual(['model-x']);
  });
});
