import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../fs/FileSystem.js';
import { HistoryLog } from './HistoryLog.js';
import { astraLayout } from './layout.js';

const HOME = process.platform === 'win32' ? 'C:\\Users\\test\\.astra' : '/home/test/.astra';
const layout = astraLayout(HOME);

function makeLog(opts: { maxEntries?: number; maxChars?: number } = {}): {
  log: HistoryLog;
  fs: MemoryFileSystem;
} {
  const fs = new MemoryFileSystem({ files: {} });
  return { log: new HistoryLog({ fs, layout, ...opts }), fs };
}

const entry = (display: string, project = 'C:\\a'): Parameters<HistoryLog['append']>[0] => ({
  display,
  project,
  sessionId: 's1',
  timestamp: 1,
});

describe('HistoryLog', () => {
  it('ghi rồi đọc lại, mới nhất trước', async () => {
    const { log } = makeLog();

    await log.append(entry('câu một'));
    await log.append(entry('câu hai'));

    expect((await log.recent()).map((e) => e.display)).toEqual(['câu hai', 'câu một']);
  });

  it('chưa có file thì đọc ra mảng rỗng, không ném', async () => {
    expect(await makeLog().log.recent()).toEqual([]);
  });

  // Gửi lại đúng một câu là chuyện thường. Lịch sử đầy bản sao làm mũi tên lên
  // trở nên vô dụng.
  it('không ghi trùng dòng ngay trước', async () => {
    const { log } = makeLog();

    await log.append(entry('lặp lại'));
    await log.append(entry('lặp lại'));
    await log.append(entry('khác'));

    expect((await log.recent()).map((e) => e.display)).toEqual(['khác', 'lặp lại']);
  });

  it('lọc theo dự án khi được yêu cầu', async () => {
    const { log } = makeLog();

    await log.append(entry('của repo A', 'C:\\a'));
    await log.append(entry('của repo B', 'C:\\b'));

    expect((await log.recent(50, 'C:\\a')).map((e) => e.display)).toEqual(['của repo A']);
  });

  it('cắt về N dòng gần nhất, không lớn dần mãi', async () => {
    const { log, fs } = makeLog({ maxEntries: 3 });

    for (let i = 0; i < 10; i++) await log.append(entry(`câu ${i}`));

    const lines = (await fs.readFile(layout.historyLog)).trim().split('\n');
    expect(lines.length).toBe(3);
    expect((await log.recent()).map((e) => e.display)).toEqual(['câu 9', 'câu 8', 'câu 7']);
  });

  it('prompt quá dài bị cắt chứ không bị bỏ', async () => {
    const { log } = makeLog({ maxChars: 10 });

    await log.append(entry('x'.repeat(100)));

    expect((await log.recent())[0]?.display).toBe('x'.repeat(10));
  });

  it('bỏ qua prompt rỗng hoặc chỉ có khoảng trắng', async () => {
    const { log } = makeLog();

    await log.append(entry('   \n  '));

    expect(await log.recent()).toEqual([]);
  });

  // Đúng lý do chọn JSONL: một dòng hỏng chỉ mất một dòng.
  it('một dòng hỏng không làm mất cả lịch sử', async () => {
    const fs = new MemoryFileSystem({
      files: {
        [layout.historyLog]: [
          JSON.stringify({ display: 'còn đọc được', project: '', sessionId: '', timestamp: 1 }),
          '{ dòng hỏng',
          JSON.stringify({ display: 'cũng đọc được', project: '', sessionId: '', timestamp: 2 }),
        ].join('\n'),
      },
    });
    const log = new HistoryLog({ fs, layout });

    expect((await log.recent()).map((e) => e.display)).toEqual(['cũng đọc được', 'còn đọc được']);
  });
});
