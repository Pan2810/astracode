/**
 * Quét "ra ngoài workspace".
 *
 * Hai loại lỗi ở đây tốn giá khác nhau, nên test cũng chia hai phía. BỎ SÓT là
 * một script đọc `~/.ssh` đi qua mà người dùng không được hỏi. BÁO NHẦM thì
 * không mất gì trong một lần, nhưng mất tất cả sau hai chục lần: cảnh báo nào
 * cũng kêu thì người ta bấm Allow mà không đọc, và lúc ấy cái đúng cũng vô ích.
 */
import { describe, it, expect } from 'vitest';
import * as nodePath from 'node:path';
import { isExecutablePath, scanEscapes } from './workspaceEscape.js';

const root = nodePath.resolve('/work/repo');
const scan = (text: string): string[] =>
  scanEscapes(text, { workspaceRoot: root }).map((f) => f.evidence);

describe('bắt được thứ với ra ngoài workspace', () => {
  it('thư mục nhà, cả kiểu Unix lẫn kiểu Windows', () => {
    expect(scan('cat ~/.ssh/id_rsa')).toContain('~/.ssh/id_rsa');
    expect(scan('copy %USERPROFILE%\\.aws\\credentials .')).toContain('%USERPROFILE%');
    expect(scan('echo $HOME')).toContain('$HOME');
    expect(scan('Get-Content $env:APPDATA\\token')).toContain('$env:APPDATA');
  });

  it('thư mục nhà giải ra lúc CHẠY, không nằm sẵn trong chuỗi', () => {
    // Đây là dạng hay gặp nhất trong script Python sinh tự động, và nó không
    // chứa ký tự `~` nào để mà bắt theo hình dạng đường dẫn.
    expect(scan("open(os.path.expanduser('~/.netrc'))").length).toBeGreaterThan(0);
    expect(scan('p = Path.home() / ".config"').length).toBeGreaterThan(0);
  });

  it('đường dẫn tuyệt đối ở ngoài, cả POSIX lẫn Windows lẫn UNC', () => {
    expect(scan('cat /etc/passwd')).toContain('/etc/passwd');
    expect(scan('type C:\\Windows\\System32\\drivers\\etc\\hosts')).toContain(
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
    );
    expect(scan('copy x \\\\fileserver\\share\\out')).toContain('\\\\fileserver\\share\\out');
  });

  it('leo lên quá gốc bằng ..', () => {
    expect(scan('cp secret.txt ../../elsewhere/').length).toBeGreaterThan(0);
  });

  it('GHI vào thư mục tra cứu vẫn bị báo, dù đọc ở đó thì không', () => {
    expect(scan('echo x > /usr/bin/fake')).toContain('/usr/bin/fake');
    expect(scan('sudo tee /usr/local/bin/tool < payload')).toContain('/usr/local/bin/tool');
  });

  it('ghi thẳng vào thiết bị khối vẫn bị báo — không nới NULL_DEVICES thành prefix', () => {
    expect(scan('dd if=image.iso of=/dev/sda')).toContain('/dev/sda');
  });

  it('đổi thư mục làm việc ra ngoài', () => {
    expect(scan('cd /tmp && ./run.sh').length).toBeGreaterThan(0);
    expect(scan("os.chdir('/var/log')").length).toBeGreaterThan(0);
  });

  it('cắt bớt khi quá nhiều — sáu dòng đã là nhiều', () => {
    const many = Array.from({ length: 20 }, (_, i) => `cat /etc/file${i}`).join('\n');
    expect(scanEscapes(many, { workspaceRoot: root })).toHaveLength(6);
  });
});

describe('im lặng với việc bình thường', () => {
  it('lệnh chạy trong workspace không sinh cảnh báo nào', () => {
    expect(scan('pnpm -r test')).toEqual([]);
    expect(scan('git commit -m "sửa lỗi"')).toEqual([]);
    expect(scan('python3 tools/build.py --out dist/')).toEqual([]);
  });

  it('đường dẫn tuyệt đối TRỎ VÀO workspace không phải là ra ngoài', () => {
    expect(scan(`python3 ${nodePath.join(root, 'tools', 'build.py')}`)).toEqual([]);
  });

  it('shebang không bị tính là đọc /usr', () => {
    // Có mặt ở đầu gần như mọi script Python. Tính nó là mỗi file sinh ra một
    // cảnh báo, và người dùng học được rằng cảnh báo này vô nghĩa.
    expect(scan('#!/usr/bin/env python3\nprint("hi")')).toEqual([]);
  });

  it('URL không bị đọc thành đường dẫn', () => {
    expect(scan('curl https://api.example.com/etc/config -o data.json')).toEqual([]);
  });

  it('`..` vẫn nằm trong workspace thì không kêu', () => {
    // `src/../lib` giải ra vẫn ở trong repo. Kêu ở đây là dạy người dùng bỏ qua.
    expect(scan('node src/../lib/build.js')).toEqual([]);
  });

  it('đường dẫn của URL và cờ dòng lệnh không phải đường dẫn hệ thống', () => {
    expect(scan('gh api /repos/acme/app/pulls')).toEqual([]);
  });

  it('chuyển hướng stderr/stdin ra thiết bị ảo không phải rời workspace', () => {
    expect(scan('python3 -c "pass" 2>/dev/null')).toEqual([]);
    expect(scan('cat file < /dev/null')).toEqual([]);
  });

  it('tra cứu chương trình hoặc thông tin hệ thống ở thư mục chuẩn thì im lặng', () => {
    expect(scan('which python3')).toEqual([]);
    expect(scan('ls /usr/bin/python*')).toEqual([]);
    expect(scan('cat /etc/os-release')).toEqual([]);
    expect(scan('ls /usr/bin/ | grep -iE "python|pdf"')).toEqual([]);
  });

  it('/tmp cố ý KHÔNG nằm trong danh sách miễn trừ tra cứu', () => {
    expect(scan('cd /tmp && ./run.sh').length).toBeGreaterThan(0);
  });
});

describe('nhận diện file sẽ được đem chạy', () => {
  it('script và file thực thi', () => {
    for (const p of ['tools/clean.py', 'run.sh', 'deploy.ps1', 'a\\b\\setup.bat', 'x.exe']) {
      expect(isExecutablePath(p)).toBe(true);
    }
  });

  it('tài liệu và dữ liệu thì không', () => {
    // Một file README nhắc tới C:\Windows là tài liệu, không phải hành vi.
    for (const p of ['README.md', 'data.json', 'notes.txt', 'Makefile', 'a.csv']) {
      expect(isExecutablePath(p)).toBe(false);
    }
  });
});
