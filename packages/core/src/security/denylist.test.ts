import { describe, expect, it } from 'vitest';
import { Denylist } from './denylist.js';

describe('Denylist — mẫu mặc định', () => {
  const d = new Denylist();

  it('chặn .env và các biến thể', () => {
    for (const p of ['.env', '.env.local', '.env.production', 'app/.env']) {
      expect(d.isDenied(p), p).toBe(true);
    }
  });

  it('CHO PHÉP .env.example — đó là tài liệu, không phải bí mật', () => {
    expect(d.isDenied('.env.example')).toBe(false);
    expect(d.isDenied('.env.sample')).toBe(false);
  });

  it('chặn khoá riêng và chứng chỉ', () => {
    for (const p of ['server.pem', 'tls.key', 'cert.pfx', 'keys/id_rsa', 'a/b/id_ed25519']) {
      expect(d.isDenied(p), p).toBe(true);
    }
  });

  it('chặn thư mục credential của công cụ', () => {
    for (const p of ['.ssh/id_rsa', '.aws/credentials', '.kube/config', '.npmrc']) {
      expect(d.isDenied(p), p).toBe(true);
    }
  });

  it('chặn tên file bí mật phổ biến', () => {
    for (const p of ['credentials.json', 'secrets.yaml', 'service-account-prod.json']) {
      expect(d.isDenied(p), p).toBe(true);
    }
  });

  it('KHÔNG chặn mã nguồn bình thường', () => {
    for (const p of [
      'src/index.ts',
      'src/auth/login.ts',
      'README.md',
      'package.json',
      'docs/SECURITY.md',
      'src/keyboard.ts',
      'src/monkey.ts',
    ]) {
      expect(d.isDenied(p), p).toBe(false);
    }
  });

  it('chuẩn hoá ./ và dấu / ở đầu', () => {
    expect(d.isDenied('./.env')).toBe(true);
    expect(d.isDenied('/.env')).toBe(true);
  });

  it('chuẩn hoá separator của Windows', () => {
    expect(d.isDenied('app\\.env')).toBe(true);
  });
});

describe('Denylist — .astraignore của project', () => {
  const d = new Denylist({
    astraignore: `
# Dữ liệu khách hàng, không được gửi lên model
data/customers/
*.dump
`,
  });

  it('áp mẫu của project', () => {
    expect(d.isDenied('data/customers/2026.csv')).toBe(true);
    expect(d.isDenied('backup.dump')).toBe(true);
  });

  it('vẫn giữ mẫu mặc định', () => {
    expect(d.isDenied('.env')).toBe(true);
  });

  it('nêu đúng nguồn để người dùng biết vì sao bị chặn', () => {
    expect(d.check('data/customers/x.csv').source).toBe('astraignore');
    expect(d.check('.env').source).toBe('default');
  });
});

describe('Denylist.filter và explain', () => {
  const d = new Denylist();

  it('lọc danh sách, dùng cho glob và readDir', () => {
    expect(d.filter(['src/a.ts', '.env', 'README.md', 'id_rsa'])).toEqual([
      'src/a.ts',
      'README.md',
    ]);
  });

  it('explain nói rõ đây là quy tắc tầng công cụ, không phải lựa chọn của model', () => {
    const msg = d.explain('.env');
    expect(msg).toContain('.env');
    expect(msg).toMatch(/tầng công cụ|đường vòng/);
  });

  it('explain rỗng khi không bị chặn', () => {
    expect(d.explain('src/a.ts')).toBe('');
  });
});
