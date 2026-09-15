/**
 * CatalogLoader — đọc `sandbox/mcp/servers.json` (mốc M7).
 *
 * Catalog là DANH SÁCH TRẮNG. Nó không phải gợi ý: cấu hình trong repo chỉ được
 * bật thứ có tên ở đây, không được thêm gì mới. Ranh giới đó là toàn bộ lý do
 * catalog tồn tại — bỏ nó đi thì `.astra/mcp.json` trở thành "chạy image bất kỳ
 * do repo chỉ định", tức là RCE chỉ bằng việc mở một thư mục lên.
 *
 * Digest được kiểm ở đây chứ không ở lúc chạy: server chưa pin digest vẫn hiện
 * trên UI (để người dùng biết nó tồn tại và vì sao chưa dùng được), nhưng mang
 * cờ `pinned: false` và bị chặn trước khi có bất kỳ tiến trình nào được sinh ra.
 */
import type { FileSystem } from '../fs/FileSystem.js';
import { DIGEST_RE, McpCatalogSchema, type McpCatalog, type McpRejection } from './types.js';

export interface LoadCatalogOptions {
  fs: FileSystem;
  /** Đường dẫn tới servers.json. Thường là `<sandboxDir>/mcp/servers.json`. */
  path: string;
}

export interface LoadedCatalog {
  catalog: McpCatalog;
  /** Đường dẫn đã đọc — UI hiện để người dùng biết catalog nào đang áp dụng. */
  path: string;
  rejections: McpRejection[];
}

/** Catalog rỗng: không có server nào, chính sách mặc định (siết nhất). */
const EMPTY: McpCatalog = McpCatalogSchema.parse({ schemaVersion: 1, servers: [] });

/**
 * Đọc và validate catalog. Không ném: file hỏng thì trả catalog rỗng kèm lý do.
 *
 * Cố ý không ném vì đây nằm trên đường khởi động extension. Một file JSON thiếu
 * dấu phẩy không được phép làm chết cả AstraCode — nó chỉ được làm mất tính
 * năng MCP, và phải nói rõ là vì sao.
 */
export async function loadCatalog(opts: LoadCatalogOptions): Promise<LoadedCatalog> {
  const rejections: McpRejection[] = [];

  let raw: string;
  try {
    if (!(await opts.fs.exists(opts.path))) {
      return {
        catalog: EMPTY,
        path: opts.path,
        rejections: [{ source: 'catalog', message: `Không tìm thấy catalog MCP: ${opts.path}` }],
      };
    }
    raw = await opts.fs.readFile(opts.path);
  } catch (err) {
    return {
      catalog: EMPTY,
      path: opts.path,
      rejections: [
        { source: 'catalog', message: `Không đọc được catalog MCP: ${messageOf(err)}` },
      ],
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      catalog: EMPTY,
      path: opts.path,
      rejections: [{ source: 'catalog', message: `Catalog MCP không phải JSON hợp lệ: ${messageOf(err)}` }],
    };
  }

  const parsed = McpCatalogSchema.safeParse(json);
  if (!parsed.success) {
    return {
      catalog: EMPTY,
      path: opts.path,
      rejections: [
        {
          source: 'catalog',
          message: `Catalog MCP sai schema: ${parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
        },
      ],
    };
  }

  // Trùng tên thì bản SAU bị loại, không phải bản trước bị ghi đè: hai server
  // cùng tên nghĩa là catalog sai, và chọn im lặng lấy cái nào cũng là đoán.
  const seen = new Set<string>();
  const servers = parsed.data.servers.filter((s) => {
    if (seen.has(s.name)) {
      rejections.push({ source: 'catalog', message: `Server trùng tên trong catalog: ${s.name}` });
      return false;
    }
    seen.add(s.name);
    return true;
  });

  return { catalog: { ...parsed.data, servers }, path: opts.path, rejections };
}

/** Digest đã pin thật chưa. Chỗ duy nhất quyết định điều này. */
export function isPinned(digest: string): boolean {
  return DIGEST_RE.test(digest.trim());
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
