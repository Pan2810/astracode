/**
 * Ghép catalog + cấu hình người dùng + cấu hình repo thành danh sách server
 * thực sự được chạy (mốc M7).
 *
 * Hai nguồn cấu hình, KHÔNG trộn:
 *
 *   `~/.astra/mcp.json`      — người dùng viết. Tin cậy. Được bật server trong
 *                              catalog VÀ khai báo server tuỳ chỉnh của riêng họ.
 *   `<repo>/.astra/mcp.json` — đến từ repo, tức là từ bất kỳ ai gửi PR. CHỈ
 *                              được bật thứ đã có trong catalog, và chỉ khi
 *                              workspace được tin cậy.
 *
 * Điểm dễ làm sai nhất ở đây là `defaultEnabled` trong catalog. Nó KHÔNG tự bật
 * server. Chính sách `requireExplicitEnablePerServer` nói rằng mỗi server phải
 * do người dùng bật tường minh — nên `defaultEnabled` chỉ còn nghĩa "gợi ý nên
 * bật cái này trước", và UI dùng nó để xếp thứ tự, không phải để chạy.
 */
import type { FileSystem } from '../fs/FileSystem.js';
import { isPinned } from './catalog.js';
import {
  DEFAULT_POLICY,
  RepoConfigSchema,
  UserConfigSchema,
  type McpCatalog,
  type McpRejection,
  type McpResolution,
  type ResolvedServer,
} from './types.js';

export interface ResolveMcpOptions {
  fs: FileSystem;
  catalog: McpCatalog;
  /** Gốc repo — để tìm `.astra/mcp.json`. Không có thì bỏ qua nguồn repo. */
  workspaceRoot?: string;
  /** Thư mục home — để tìm `~/.astra/mcp.json`. */
  homeDir?: string;
  /**
   * `workspace.isTrusted` của VS Code. Mặc định FALSE.
   *
   * Mặc định an toàn phải là mặc định: người gọi quên truyền cờ này thì kết quả
   * là "không chạy MCP nào", chứ không phải "chạy tất".
   */
  workspaceTrusted?: boolean;
}

export async function resolveMcpServers(opts: ResolveMcpOptions): Promise<McpResolution> {
  const policy = opts.catalog.policy ?? DEFAULT_POLICY;
  const trusted = opts.workspaceTrusted ?? false;
  const rejections: McpRejection[] = [];

  const user = opts.homeDir
    ? await readUserConfig(opts.fs, join(opts.homeDir, '.astra', 'mcp.json'), rejections)
    : undefined;

  // Workspace chưa tin cậy → KHÔNG ĐỌC file cấu hình của repo. Không phải đọc
  // rồi lọc: đọc rồi lọc có nghĩa là nội dung đó đã đi vào tiến trình và chỉ
  // còn một lớp if chặn lại.
  const repoEnable: string[] = [];
  if (opts.workspaceRoot) {
    if (trusted) {
      const repoPath = join(opts.workspaceRoot, '.astra', 'mcp.json');
      const repo = await readRepoConfig(opts.fs, repoPath, opts.catalog, rejections);
      repoEnable.push(...repo);
    } else if (await opts.fs.exists(join(opts.workspaceRoot, '.astra', 'mcp.json'))) {
      rejections.push({
        source: 'repo',
        message:
          'The workspace is not trusted, so the repo .astra/mcp.json was not read. ' +
          'Use "Workspaces: Manage Workspace Trust" if you trust this folder.',
      });
    }
  }

  const enabled = new Set<string>([...(user?.enable ?? []), ...repoEnable].map((n) => n.trim()));

  const servers: ResolvedServer[] = [];

  for (const s of opts.catalog.servers) {
    const pinned = isPinned(s.digest);
    const wantEnabled = enabled.has(s.name);
    servers.push({
      name: s.name,
      description: s.description,
      risk: s.risk,
      network: s.network,
      trustLevel: s.trustLevel,
      mounts: s.mounts,
      source: 'catalog',
      launch: { kind: 'compose', service: s.name, image: s.image, digest: s.digest.trim() },
      enabled: wantEnabled,
      pinned,
      isolated: true,
      ...(s.notes ? { notes: s.notes } : {}),
      ...blockReason({ trusted, requireTrust: policy.requireWorkspaceTrust, pinned, pinRequired: policy.pinByDigest }),
    });
  }

  const catalogNames = new Set(opts.catalog.servers.map((s) => s.name));

  for (const s of user?.servers ?? []) {
    if (catalogNames.has(s.name)) {
      rejections.push({
        source: 'user',
        message: `Server "${s.name}" has the same name as a catalog server — the custom one is ignored.`,
      });
      continue;
    }
    if (!policy.allowCustomServersFromUserConfig) {
      rejections.push({
        source: 'user',
        message: `Catalog policy does not allow custom servers — ignoring "${s.name}".`,
      });
      continue;
    }
    servers.push({
      name: s.name,
      description: s.description,
      risk: s.risk,
      // Tiến trình chạy thẳng trên máy thì không có profile mạng nào áp được.
      network: 'full',
      trustLevel: s.trustLevel,
      mounts: [],
      source: 'user',
      launch: { kind: 'process', command: s.command, args: s.args, env: s.env },
      enabled: enabled.has(s.name),
      pinned: false,
      isolated: false,
      notes:
        'A custom server runs DIRECTLY ON YOUR MACHINE, with no container around it. ' +
        'It can see every file you can see.',
      ...blockReason({ trusted, requireTrust: policy.requireWorkspaceTrust, pinned: true, pinRequired: false }),
    });
  }

  // Tên được bật nhưng không khớp server nào — nói ra, đừng nuốt. Người dùng gõ
  // sai tên mà im lặng thì họ sẽ tưởng MCP hỏng.
  for (const name of enabled) {
    if (!servers.some((s) => s.name === name)) {
      rejections.push({
        source: 'user',
        message: `Enabled a server that is not in the catalog: "${name}" — ignored.`,
      });
    }
  }

  return { servers, rejections, policy, workspaceTrusted: trusted };
}

function blockReason(input: {
  trusted: boolean;
  requireTrust: boolean;
  pinned: boolean;
  pinRequired: boolean;
}): { blockedReason?: string } {
  if (input.requireTrust && !input.trusted) {
    return {
      blockedReason:
        'The workspace is not trusted. MCP does not run in an untrusted folder — ' +
        'an MCP server can read your source and, depending on the server, reach the internet.',
    };
  }
  if (input.pinRequired && !input.pinned) {
    return {
      blockedReason:
        'The image has no pinned sha256 digest. A tag can be overwritten, so it cannot ' +
        'identify what is actually running — put the real digest in servers.json.',
    };
  }
  return {};
}

/** Server thực sự khởi chạy được: đã bật và không có lý do bị chặn. */
export function runnableServers(servers: ResolvedServer[]): ResolvedServer[] {
  return servers.filter((s) => s.enabled && s.blockedReason === undefined);
}

async function readUserConfig(
  fs: FileSystem,
  path: string,
  rejections: McpRejection[],
): Promise<{ enable: string[]; servers: import('./types.js').UserServer[] } | undefined> {
  const json = await readJson(fs, path, 'user', rejections);
  if (json === undefined) return undefined;

  const parsed = UserConfigSchema.safeParse(json);
  if (!parsed.success) {
    rejections.push({
      source: 'user',
      message: `~/.astra/mcp.json sai schema: ${issues(parsed.error)}`,
    });
    return undefined;
  }
  return parsed.data;
}

async function readRepoConfig(
  fs: FileSystem,
  path: string,
  catalog: McpCatalog,
  rejections: McpRejection[],
): Promise<string[]> {
  const json = await readJson(fs, path, 'repo', rejections);
  if (json === undefined) return [];

  const parsed = RepoConfigSchema.safeParse(json);
  if (!parsed.success) {
    rejections.push({ source: 'repo', message: `.astra/mcp.json sai schema: ${issues(parsed.error)}` });
    return [];
  }

  // Repo cố khai báo server riêng — từ chối TƯỜNG MINH. Đây là ranh giới chống
  // supply chain, và người đọc log phải thấy được lần thử đó.
  if ('servers' in parsed.data) {
    rejections.push({
      source: 'repo',
      message:
        'The repo .astra/mcp.json declares "servers" — rejected. A repo may only enable ' +
        'servers already in the catalog; custom servers are declared in ~/.astra/mcp.json.',
    });
  }

  const names = new Set(catalog.servers.map((s) => s.name));
  const ok: string[] = [];
  for (const n of parsed.data.enable) {
    if (names.has(n)) ok.push(n);
    else
      rejections.push({
        source: 'repo',
        message: `.astra/mcp.json enables "${n}" but it is not in the catalog — ignored.`,
      });
  }
  return ok;
}

async function readJson(
  fs: FileSystem,
  path: string,
  source: McpRejection['source'],
  rejections: McpRejection[],
): Promise<unknown | undefined> {
  try {
    if (!(await fs.exists(path))) return undefined;
    return JSON.parse(await fs.readFile(path));
  } catch (err) {
    rejections.push({
      source,
      message: `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return undefined;
  }
}

function issues(err: { issues: { path: (string | number)[]; message: string }[] }): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
}

/**
 * Nối đường dẫn — core không import node:path. Giống hệt bản trong
 * config/commands.ts: giữ separator của gốc để đường dẫn Windows không lẫn lộn
 * hai kiểu gạch trong cùng một chuỗi hiện ra trước mắt người dùng.
 */
function join(root: string, ...parts: string[]): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  return [base, ...parts].join(sep);
}
