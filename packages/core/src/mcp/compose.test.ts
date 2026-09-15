/**
 * Kiểm tra file compose bằng TEST, không bằng review.
 *
 * "Không service nào được mount /var/run/docker.sock" là một câu dễ đồng ý và
 * dễ quên. Mount được socket Docker nghĩa là container đó tạo được container
 * khác với `--privileged -v /:/host` — tức là thoát sandbox hoàn toàn, và đó
 * đúng là một dòng YAML thêm vào lúc đang vội. Nên nó phải có test canh.
 *
 * Đọc file bằng node:fs trực tiếp là cố ý: đây kiểm tra HIỆN TRẠNG REPO, không
 * phải hành vi của core. Test được miễn rule "một cửa filesystem".
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpCatalogSchema } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const SANDBOX = path.join(REPO_ROOT, 'sandbox');

const COMPOSE_FILES = [
  path.join(SANDBOX, 'docker-compose.yml'),
  path.join(SANDBOX, 'mcp', 'docker-compose.mcp.yml'),
];

/** Ảnh dựng tại chỗ bằng `build:` — tag chỉ là nhãn cục bộ. */
const LOCAL_BUILT = new Set(['astracode/runner:local']);

/**
 * Ngoại lệ ĐANG NỢ, không phải ngoại lệ được phép.
 *
 * `monokal/tinyproxy:latest` là egress proxy của sandbox — đúng cái thành
 * phần quyết định lệnh trong container gọi ra được đâu, nên nó là thứ đáng pin
 * nhất chứ không phải ít nhất. Chưa pin được vì lấy digest thật cần một máy có
 * Docker, mà máy phát triển hiện chưa có.
 *
 * Danh sách này được assert là KHÔNG ĐỔI ở test dưới: thêm một ảnh chưa pin nữa
 * thì test đỏ, và người thêm phải quyết định tường minh chứ không trôi qua.
 */
const UNPINNED_TODO = new Set(['monokal/tinyproxy:latest']);

describe('file compose của sandbox', () => {
  for (const file of COMPOSE_FILES) {
    const name = path.relative(REPO_ROOT, file);

    it(`${name}: tồn tại`, () => {
      expect(fs.existsSync(file)).toBe(true);
    });

    it(`${name}: KHÔNG mount docker socket`, () => {
      const text = fs.readFileSync(file, 'utf8');
      // Bỏ dòng chú thích: "KHÔNG BAO GIỜ mount /var/run/docker.sock" là chú
      // thích hợp lệ và không được làm test đỏ.
      const code = withoutComments(text);
      expect(code).not.toMatch(/docker\.sock/);
      expect(code).not.toMatch(/docker_engine/);
    });

    it(`${name}: không service nào chạy privileged hay xin thêm capability`, () => {
      const code = withoutComments(fs.readFileSync(file, 'utf8'));
      expect(code).not.toMatch(/privileged:\s*true/);
      expect(code).not.toMatch(/^\s*cap_add:/m);
      expect(code).not.toMatch(/security_opt:.*seccomp[:=]unconfined/);
    });

    it(`${name}: image kéo từ registry đều pin bằng digest`, () => {
      const text = fs.readFileSync(file, 'utf8');
      const code = withoutComments(text);
      for (const line of code.split('\n')) {
        const m = /^\s*image:\s*(\S+)/.exec(line);
        if (!m) continue;
        const image = m[1]!;
        // Ảnh dựng tại chỗ (`build:` trong cùng file) không kéo từ registry nên
        // tag của nó chỉ là nhãn cục bộ — không có gì để bị đẩy đè.
        if (LOCAL_BUILT.has(image)) continue;
        if (UNPINNED_TODO.has(image)) continue;
        expect(image, `image không pin digest: ${image}`).toMatch(/@\$\{|@sha256:/);
      }
    });
  }
});

describe('nợ kỹ thuật về pin digest', () => {
  it('danh sách ảnh chưa pin không được dài thêm', () => {
    // Nếu test này đỏ vì bạn vừa thêm một ảnh: hoặc pin digest cho nó, hoặc
    // thêm vào UNPINNED_TODO kèm lý do và một mục trong documents/ROADMAP.md.
    // Đừng sửa im lặng — chỗ này tồn tại để việc nới lỏng phải có người ký tên.
    expect([...UNPINNED_TODO]).toEqual(['monokal/tinyproxy:latest']);
  });

  it('mọi ảnh trong compose MCP đều đã pin — không có ngoại lệ nào ở đây', () => {
    const code = withoutComments(
      fs.readFileSync(path.join(SANDBOX, 'mcp', 'docker-compose.mcp.yml'), 'utf8'),
    );
    const images = [...code.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1]!);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) expect(image).toMatch(/@\$\{|@sha256:/);
  });
});

describe('catalog MCP trong repo', () => {
  const catalogPath = path.join(SANDBOX, 'mcp', 'servers.json');

  it('khớp schema hiện hành', () => {
    const raw = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const parsed = McpCatalogSchema.safeParse(raw);
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
  });

  it('mọi server trong catalog đều có service tương ứng trong compose', () => {
    const catalog = McpCatalogSchema.parse(
      JSON.parse(fs.readFileSync(catalogPath, 'utf8')),
    );
    const compose = fs.readFileSync(path.join(SANDBOX, 'mcp', 'docker-compose.mcp.yml'), 'utf8');

    for (const s of catalog.servers) {
      // Tên server = tên service = tên profile. Lệch nhau thì launcher gọi
      // `compose run <tên>` vào hư không và người dùng chỉ thấy "server chết".
      expect(compose, `thiếu service cho "${s.name}"`).toMatch(
        new RegExp(`^\\s{2}${s.name}:`, 'm'),
      );
      expect(compose).toMatch(new RegExp(`profiles:\\s*\\["${s.name}"\\]`));
    }
  });

  it('chính sách của catalog không bị nới lỏng ngoài ý muốn', () => {
    const catalog = McpCatalogSchema.parse(
      JSON.parse(fs.readFileSync(catalogPath, 'utf8')),
    );
    expect(catalog.policy.requireWorkspaceTrust).toBe(true);
    expect(catalog.policy.pinByDigest).toBe(true);
    expect(catalog.policy.allowCustomServersFromRepo).toBe(false);
    expect(catalog.policy.defaultPermissionMode).toBe('ask');
  });
});

function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}
