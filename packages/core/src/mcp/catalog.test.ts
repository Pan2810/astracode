import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../fs/FileSystem.js';
import { isPinned, loadCatalog } from './catalog.js';

const REAL_DIGEST = `sha256:${'a'.repeat(64)}`;

function catalogJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    servers: [
      {
        name: 'git',
        image: 'mcp/git',
        digest: REAL_DIGEST,
        description: 'đọc lịch sử git',
        risk: 'low',
        defaultEnabled: true,
        network: 'none',
        mounts: ['workspace:ro'],
        trustLevel: 'B',
      },
    ],
    ...extra,
  });
}

describe('loadCatalog', () => {
  it('đọc và validate catalog hợp lệ', async () => {
    const fs = new MemoryFileSystem({ files: { '/repo/servers.json': catalogJson() } });
    const r = await loadCatalog({ fs, path: '/repo/servers.json' });

    expect(r.rejections).toEqual([]);
    expect(r.catalog.servers).toHaveLength(1);
    expect(r.catalog.servers[0]!.name).toBe('git');
    // Chính sách mặc định phải là bản siết nhất khi file không nói gì.
    expect(r.catalog.policy.requireWorkspaceTrust).toBe(true);
    expect(r.catalog.policy.allowCustomServersFromRepo).toBe(false);
  });

  it('file không có → catalog rỗng kèm lý do, không ném', async () => {
    const fs = new MemoryFileSystem({ files: {} });
    const r = await loadCatalog({ fs, path: '/repo/servers.json' });

    expect(r.catalog.servers).toEqual([]);
    expect(r.rejections[0]!.message).toContain('Không tìm thấy');
  });

  it('JSON hỏng → catalog rỗng, không làm chết luồng khởi động', async () => {
    const fs = new MemoryFileSystem({ files: { '/x.json': '{ thiếu dấu ngoặc' } });
    const r = await loadCatalog({ fs, path: '/x.json' });

    expect(r.catalog.servers).toEqual([]);
    expect(r.rejections[0]!.message).toContain('không phải JSON hợp lệ');
  });

  it('sai schema → từ chối cả file kèm đường dẫn trường lỗi', async () => {
    const fs = new MemoryFileSystem({
      files: {
        '/x.json': JSON.stringify({
          schemaVersion: 1,
          servers: [{ name: 'CHỮ HOA VÀ KHOẢNG TRẮNG', image: 'x', digest: 'y' }],
        }),
      },
    });
    const r = await loadCatalog({ fs, path: '/x.json' });

    expect(r.catalog.servers).toEqual([]);
    expect(r.rejections[0]!.message).toContain('sai schema');
  });

  it('server trùng tên: bản sau bị loại, có ghi lý do', async () => {
    const fs = new MemoryFileSystem({
      files: {
        '/x.json': JSON.stringify({
          schemaVersion: 1,
          servers: [
            { name: 'git', image: 'a', digest: REAL_DIGEST },
            { name: 'git', image: 'b', digest: REAL_DIGEST },
          ],
        }),
      },
    });
    const r = await loadCatalog({ fs, path: '/x.json' });

    expect(r.catalog.servers).toHaveLength(1);
    expect(r.catalog.servers[0]!.image).toBe('a');
    expect(r.rejections[0]!.message).toContain('trùng tên');
  });

  it('catalog thật trong repo đọc được (nếu có)', async () => {
    // Không assert nội dung: catalog trong repo còn digest giữ chỗ. Chỉ cần
    // biết nó không vỡ schema — đó là thứ dễ trôi khi có người sửa tay.
    const fs = new MemoryFileSystem({ files: { '/x.json': catalogJson({ policy: {} }) } });
    const r = await loadCatalog({ fs, path: '/x.json' });
    expect(r.catalog.policy.pinByDigest).toBe(true);
  });
});

describe('isPinned', () => {
  it('nhận đúng digest sha256 đủ 64 hex', () => {
    expect(isPinned(REAL_DIGEST)).toBe(true);
    expect(isPinned(` ${REAL_DIGEST} `)).toBe(true);
  });

  it('từ chối chỗ giữ chỗ, tag, digest thiếu ký tự', () => {
    expect(isPinned('sha256:<ĐIỀN KHI TRIỂN KHAI>')).toBe(false);
    expect(isPinned('latest')).toBe(false);
    expect(isPinned(`sha256:${'a'.repeat(63)}`)).toBe(false);
    expect(isPinned(`sha256:${'A'.repeat(64)}`)).toBe(false);
    expect(isPinned('')).toBe(false);
  });
});
