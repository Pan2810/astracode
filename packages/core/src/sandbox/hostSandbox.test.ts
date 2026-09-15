/**
 * Hai thứ ở `HostSandbox` hỏng theo kiểu không ai nhìn thấy.
 *
 * `info().shell` sai → prompt không cảnh báo → model viết `&&` trên PowerShell.
 * Prologue UTF-8 mất → thông báo lỗi về tới nơi dưới dạng `�����ꏊ`, và MODEL
 * cũng đọc đúng chuỗi đó nên nó đoán mò rồi thử lại.
 *
 * Cả hai đều không làm test nào đỏ, không sinh exception, không vào log. Chúng
 * chỉ làm agent gõ sai vài lần liên tiếp trước mặt người dùng.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import * as nodePath from 'node:path';
import { HostSandbox } from './HostSandbox.js';
import { detachOption, inheritedEnv } from './process.js';
import { Logger, MemorySink } from '../telemetry/logger.js';

const ROOT = '/work/app';

function sandbox(): HostSandbox {
  return new HostSandbox({
    workspaceRoot: ROOT,
    logger: new Logger({ sink: new MemorySink() }),
  });
}

/** Đổi `process.platform` — nó là thuộc tính chỉ đọc nên phải định nghĩa lại. */
function onPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

const REAL_PLATFORM = process.platform;
afterEach(() => {
  onPlatform(REAL_PLATFORM);
  vi.restoreAllMocks();
});

describe('HostSandbox.info().shell', () => {
  it('Windows khai là powershell, không phải bash', () => {
    onPlatform('win32');
    // Tool tên `bash`, nhưng thứ chạy là powershell.exe. Khai sai ở đây thì
    // system prompt im lặng và model không có cách nào biết.
    expect(sandbox().info().shell).toBe('powershell');
  });

  it('Linux và macOS khai là bash', () => {
    onPlatform('linux');
    expect(sandbox().info().shell).toBe('bash');
    onPlatform('darwin');
    expect(sandbox().info().shell).toBe('bash');
  });

  it('vẫn khai là không cách ly', () => {
    // Nếu cờ này trôi thì UI mất cảnh báo đỏ, và đó là thứ duy nhất nói cho
    // người dùng biết lệnh đang chạy thẳng trên máy họ.
    expect(sandbox().info().isolated).toBe(false);
  });
});

/**
 * Đọc lệnh thật sự được spawn. `exec` gọi `runProcess`, nên mock ở đó là chỗ
 * duy nhất thấy được đối số cuối cùng mà không thật sự chạy gì.
 */
async function spawnedArgs(command: string): Promise<{ file: string; args: string[] }> {
  const process_ = await import('./process.js');
  let captured: { file: string; args: string[] } | undefined;

  vi.spyOn(process_, 'runProcess').mockImplementation((file, args) => {
    captured = { file, args };
    const empty = {
      async *[Symbol.asyncIterator]() {
        /* không phát gì */
      },
    };
    return Object.assign(empty, {
      result: Promise.resolve({ exitCode: 0, timedOut: false, aborted: false, durationMs: 0 }),
    });
  });

  sandbox().exec(command);
  if (!captured) throw new Error('runProcess không được gọi');
  return captured;
}

describe('HostSandbox — encoding trên Windows', () => {
  it('ép PowerShell in ra UTF-8 trước khi lệnh chạy', async () => {
    onPlatform('win32');
    const { file, args } = await spawnedArgs('git status');

    expect(file).toBe('powershell.exe');
    const script = args.at(-1)!;
    expect(script).toContain('[Console]::OutputEncoding=[Text.Encoding]::UTF8');
    expect(script).toContain('$OutputEncoding=[Text.Encoding]::UTF8');
    // Prologue phải đứng TRƯỚC: đặt sau thì lệnh đã in xong bằng codepage cũ.
    expect(script.indexOf('OutputEncoding')).toBeLessThan(script.indexOf('git status'));
  });

  it('lệnh của model đi vào nguyên văn, không bị sửa', async () => {
    onPlatform('win32');
    const { args } = await spawnedArgs('pnpm test -- --run "a b"');
    expect(args.at(-1)).toContain('pnpm test -- --run "a b"');
  });

  it('lệnh vẫn là MỘT đối số, không nối vào chuỗi shell', async () => {
    onPlatform('win32');
    const { args } = await spawnedArgs('echo hi');
    // `-Command <lệnh>`: shell:false + một argv riêng là thứ chặn injection.
    expect(args.filter((a) => a.includes('echo hi'))).toHaveLength(1);
    expect(args).toContain('-NoProfile');
    expect(args).toContain('-NonInteractive');
  });

  it('POSIX chỉ thêm đúng câu cd, không động vào lệnh', async () => {
    onPlatform('linux');
    const { file, args } = await spawnedArgs('git status');

    expect(file).toBe('/bin/bash');
    expect(args).toEqual(['-lc', `cd '${nodePath.resolve(ROOT)}' && git status`]);
  });
});

/**
 * Neo lệnh vào workspace.
 *
 * `runProcess` đã nhận `cwd`, nên câu `cd` này thừa về mặt kỹ thuật. Nó có mặt vì
 * chuỗi này là thứ NGƯỜI DÙNG ĐỌC trong hộp duyệt quyền: đọc `cd C:\Workepo;
 * pytest` thì biết ngay lệnh chạy ở đâu, còn một tham số `cwd` vô hình thì không.
 */
describe('HostSandbox — neo vào workspace', () => {
  it('Windows dùng Set-Location, đứng sau prologue UTF-8', async () => {
    onPlatform('win32');
    const script = (await spawnedArgs('pytest')).args.at(-1)!;

    expect(script).toContain(`Set-Location -LiteralPath '${nodePath.resolve(ROOT)}'`);
    // Prologue trước, rồi cd, rồi mới tới lệnh của model.
    expect(script.indexOf('OutputEncoding')).toBeLessThan(script.indexOf('Set-Location'));
    expect(script.indexOf('Set-Location')).toBeLessThan(script.indexOf('pytest'));
  });

  it('từ chối thư mục làm việc nằm ngoài workspace', () => {
    onPlatform('linux');
    // Không phải phòng cho hôm nay — hôm nay mọi tool đều truyền workspaceRoot.
    // Là phòng cho cái tool ngày mai nhận `cwd` từ model rồi chuyển thẳng xuống.
    expect(() => sandbox().exec('ls', { cwd: nodePath.resolve('/etc') })).toThrow(/ngoài workspace/);
  });

  it('thư mục con của workspace vẫn chạy được', async () => {
    onPlatform('linux');
    const process_ = await import('./process.js');
    const spy = vi.spyOn(process_, 'runProcess').mockImplementation(() => {
      const empty = {
        async *[Symbol.asyncIterator]() {
          /* không phát gì */
        },
      };
      return Object.assign(empty, {
        result: Promise.resolve({ exitCode: 0, timedOut: false, aborted: false, durationMs: 0 }),
      });
    });

    const sub = nodePath.join(nodePath.resolve(ROOT), 'packages');
    sandbox().exec('ls', { cwd: sub });

    expect(spy.mock.calls[0]![2]).toMatchObject({ cwd: sub });
    expect(spy.mock.calls[0]![1]!.at(-1)).toContain(`cd '${sub}'`);
  });
});

/**
 * Danh sách trắng env — chỗ này vừa là bảo mật vừa là "lệnh có chạy được
 * không", và hai thứ đó kéo ngược chiều nhau.
 *
 * Bỏ quên `PATHEXT` từng làm `git --version` hỏng NGAY CẢ KHI git nằm trong
 * PATH, vì Windows không biết `git` nghĩa là `git.exe`. Người dùng thêm git vào
 * PATH xong vẫn thấy y nguyên lỗi cũ, và không có gì trên màn hình chỉ về phía
 * env — nên họ kết luận là sản phẩm hỏng.
 */
describe('inheritedEnv', () => {
  const win = { PATH: 'C:\\bin', PATHEXT: '.COM;.EXE', SystemRoot: 'C:\\Windows' };

  it('cho PATHEXT đi qua trên Windows', () => {
    expect(inheritedEnv('win32', win).PATHEXT).toBe('.COM;.EXE');
  });

  it('cho HOME đi qua trên POSIX', () => {
    expect(inheritedEnv('linux', { PATH: '/bin', HOME: '/home/q' }).HOME).toBe('/home/q');
  });

  /**
   * Chủ ý ban đầu vẫn giữ: env của extension host chứa token và biến CI. Danh
   * sách trắng chỉ được nới cho thứ mà THIẾU NÓ thì công cụ chạy sai.
   */
  it('KHÔNG cho token hay biến lạ đi qua', () => {
    const env = inheritedEnv('win32', {
      ...win,
      ASTRA_TOKEN: 'bí-mật',
      GITHUB_TOKEN: 'bí-mật',
      npm_config_registry: 'http://nội-bộ',
    });

    expect(Object.keys(env)).not.toContain('ASTRA_TOKEN');
    expect(Object.keys(env)).not.toContain('GITHUB_TOKEN');
    expect(Object.keys(env)).not.toContain('npm_config_registry');
    expect(JSON.stringify(env)).not.toContain('bí-mật');
  });

  it('biến không có trong nguồn thì không sinh khoá rỗng', () => {
    // `undefined` lọt vào env của spawn sẽ thành chuỗi "undefined" — một PATHEXT
    // như thế còn tệ hơn không có, vì nó ghi đè mặc định bằng rác.
    const env = inheritedEnv('win32', { PATH: 'C:\\bin' });
    expect('PATHEXT' in env).toBe(false);
  });

  it('PATH luôn có, kể cả khi nguồn không khai', () => {
    expect(inheritedEnv('linux', {}).PATH).toBe('');
  });

  /** Danh sách dài ra là dấu hiệu nó đang trôi dần về `...process.env`. */
  it('danh sách vẫn ngắn', () => {
    const all = { ...process.env, PATH: 'x' } as NodeJS.ProcessEnv;
    expect(Object.keys(inheritedEnv('win32', all)).length).toBeLessThan(25);
    expect(Object.keys(inheritedEnv('linux', all)).length).toBeLessThan(15);
  });
});

describe('detachOption — điều kiện để giết được cả cây tiến trình (sổ nợ #8)', () => {
  it('POSIX: bật detached để tiến trình con thành trưởng nhóm', () => {
    // Không có nhóm thì `kill(-pid)` trong `killTree` không có gì để giết, và
    // `bash -lc "sleep 999 &"` hết giờ vẫn để lại `sleep` chạy tiếp.
    expect(detachOption('linux')).toEqual({ detached: true });
    expect(detachOption('darwin')).toEqual({ detached: true });
  });

  it('Windows: KHÔNG bật — taskkill /T đã đi theo quan hệ cha-con', () => {
    expect(detachOption('win32')).toEqual({});
  });
});
