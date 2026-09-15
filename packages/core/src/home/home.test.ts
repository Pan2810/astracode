import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../fs/FileSystem.js';
import { Logger, MemorySink } from '../telemetry/logger.js';
import { readAccessToken, writeAccessToken } from './credentials.js';
import { astraHome, astraLayout, projectDir, projectSlug, safeName } from './layout.js';
import { migrateHome } from './migrate.js';

const HOME = process.platform === 'win32' ? 'C:\\Users\\test\\.astra' : '/home/test/.astra';
const logger = (): Logger => new Logger({ sink: new MemorySink() });

describe('astraHome', () => {
  it('mặc định là <home>/.astra', () => {
    const home = process.platform === 'win32' ? 'C:\\Users\\test' : '/home/test';
    expect(astraHome({ homeDir: home })).toBe(join(home, '.astra'));
  });

  it('ASTRA_HOME thắng, và khoảng trắng thừa không tạo ra thư mục rỗng', () => {
    expect(astraHome({ homeDir: '/home/test', override: '  /tmp/astra ' })).toBe('/tmp/astra');
    expect(astraHome({ homeDir: '/home/test', override: '   ' })).toBe(join('/home/test', '.astra'));
  });
});

describe('projectSlug', () => {
  it('đọc ra được là repo nào', () => {
    expect(projectSlug('C:\\Work\\AstraCode')).toMatch(/^c-work-astracode-/);
  });

  it('cùng một thư mục ⇒ cùng một slug, kể cả khác hoa thường và dấu / cuối', () => {
    const a = projectSlug('C:\\Work\\AstraCode');
    const b = projectSlug('c:\\work\\astracode\\');
    expect(a).toBe(b);
  });

  // Đây là lý do có hash: bỏ nó đi thì hai repo này dùng chung một thư mục
  // phiên, và lần dọn của repo trước xoá phiên của repo sau.
  it('hai đường dẫn khác nhau KHÔNG bao giờ ra cùng slug dù phần đọc được giống hệt', () => {
    expect(projectSlug('C:\\a\\b-c')).not.toBe(projectSlug('C:\\a\\b\\c'));
  });

  it('đường dẫn dài vẫn ra tên thư mục dùng được', () => {
    const slug = projectSlug(`C:\\${'x'.repeat(300)}`);
    expect(slug.length).toBeLessThan(80);
  });
});

describe('safeName', () => {
  it('không có đường nào đi ra khỏi thư mục lưu trữ', () => {
    expect(safeName('../../etc/passwd')).toBe('....etcpasswd');
    expect(safeName('a/b\\c')).toBe('abc');
    expect(safeName('///')).toBe('invalid');
  });
});

describe('credentials.json', () => {
  it('đọc lại đúng token vừa ghi', () => {
    expect(readAccessToken(writeAccessToken('jwt.abc.def'))).toBe('jwt.abc.def');
  });

  // Người dùng chép ~/.astra từ máy khác sang mà chưa chạy migrate: bắt họ đăng
  // nhập lại là một câu trả lời sai khi token vẫn còn dùng được.
  it('vẫn đọc được file `token` cũ chứa JWT trần', () => {
    expect(readAccessToken('  jwt.abc.def \n')).toBe('jwt.abc.def');
  });

  it('JSON hỏng hoặc thiếu trường ⇒ không có token, không ném', () => {
    expect(readAccessToken('{ hỏng')).toBeUndefined();
    expect(readAccessToken('{"astrawork":{}}')).toBeUndefined();
    expect(readAccessToken('')).toBeUndefined();
  });
});

describe('migrateHome', () => {
  const layout = astraLayout(HOME);

  it('config.json → settings.json, token → credentials.json', async () => {
    const fs = new MemoryFileSystem({
      files: {
        [layout.legacyConfig]: '{"gatewayBaseUrl":"https://gw.example"}',
        [layout.legacyToken]: 'jwt.abc.def',
      },
    });

    const report = await migrateHome({ fs, layout, logger: logger() });

    expect(report.settings).toBe(true);
    expect(report.credentials).toBe(true);
    expect(JSON.parse(await fs.readFile(layout.settings)).gatewayBaseUrl).toBe('https://gw.example');
    expect(readAccessToken(await fs.readFile(layout.credentials))).toBe('jwt.abc.def');
    expect(await fs.exists(layout.legacyConfig)).toBe(false);
    expect(await fs.exists(layout.legacyToken)).toBe(false);
  });

  // Cài song song bản cũ và bản mới là chuyện có thật. Bản cũ ghi config.json,
  // và nếu migrate ghi đè thì lần mở bản mới sau đó mất hết cấu hình đang dùng.
  it('KHÔNG ghi đè settings.json đã có bằng config.json cũ', async () => {
    const fs = new MemoryFileSystem({
      files: {
        [layout.legacyConfig]: '{"gatewayBaseUrl":"cũ"}',
        [layout.settings]: '{"gatewayBaseUrl":"mới"}',
      },
    });

    await migrateHome({ fs, layout, logger: logger() });

    expect(JSON.parse(await fs.readFile(layout.settings)).gatewayBaseUrl).toBe('mới');
    expect(await fs.exists(layout.legacyConfig)).toBe(true);
  });

  it('config.json hỏng thì để nguyên chỗ cũ cho người dùng tự xem', async () => {
    const fs = new MemoryFileSystem({ files: { [layout.legacyConfig]: '{ hỏng' } });

    const report = await migrateHome({ fs, layout, logger: logger() });

    expect(report.settings).toBe(false);
    expect(await fs.exists(layout.legacyConfig)).toBe(true);
    expect(await fs.exists(layout.settings)).toBe(false);
  });

  it('phiên phẳng chuyển vào đúng thư mục dự án của nó', async () => {
    const root = 'C:\\Work\\repo-a';
    const session = JSON.stringify({
      schemaVersion: 1,
      id: 'abc',
      title: 'cũ',
      workspaceRoot: root,
      createdAt: 1,
      updatedAt: 2,
      messages: [],
      turns: [],
      totalTokens: 0,
      compactions: 0,
    });
    const fs = new MemoryFileSystem({
      files: { [join(layout.legacySessions, 'session-abc.json')]: session },
    });

    const report = await migrateHome({ fs, layout, logger: logger() });

    expect(report.sessions).toBe(1);
    expect(await fs.exists(join(projectDir(layout, root), 'session-abc.json'))).toBe(true);
    expect(await fs.exists(join(layout.legacySessions, 'session-abc.json'))).toBe(false);
  });

  // Xoá dữ liệu mình không hiểu là cách tệ nhất để kết thúc một lần migrate.
  it('phiên không đọc được thì để nguyên, không xoá', async () => {
    const fs = new MemoryFileSystem({
      files: { [join(layout.legacySessions, 'session-x.json')]: 'không phải JSON' },
    });

    const report = await migrateHome({ fs, layout, logger: logger() });

    expect(report.sessions).toBe(0);
    expect(await fs.exists(join(layout.legacySessions, 'session-x.json'))).toBe(true);
  });

  it('chạy lại lần hai không làm gì thêm', async () => {
    const fs = new MemoryFileSystem({ files: { [layout.legacyConfig]: '{"logLevel":"debug"}' } });

    await migrateHome({ fs, layout, logger: logger() });
    const second = await migrateHome({ fs, layout, logger: logger() });

    expect(second).toEqual({ settings: false, credentials: false, sessions: 0 });
  });
});
