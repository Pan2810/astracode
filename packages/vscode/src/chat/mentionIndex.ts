/**
 * Chỉ mục file cho ô gợi ý `@mention` trong VS Code.
 *
 * Bản sao tinh thần của `FileIndex` ở `packages/cli/src/mentions.ts`: quét TOÀN
 * BỘ workspace một lần rồi giữ trong bộ nhớ, để mỗi phím gõ chỉ còn việc
 * `fuzzyRank` trên danh sách đã có sẵn — không quét lại đĩa mỗi ký tự, và không
 * cắt bớt ứng viên trước khi lọc gần đúng.
 *
 * Vì sao "cắt trước khi lọc" là sai (bug của bản trước): `vscode.workspace.findFiles`
 * với `maxResults` thấp trả về N kết quả ĐẦU TIÊN theo thứ tự duyệt của VS Code,
 * không theo độ liên quan với query. Trong workspace có hơn N file, file người
 * dùng đang gõ tắt để tìm có thể nằm ngoài N kết quả ấy — và không bao giờ được
 * `fuzzyRank` xét tới, dù nó khớp tuyệt đối. Sửa đúng là quét đủ (chỉ chặn ở một
 * trần rất cao để tránh workspace bệnh lý) rồi để `fuzzyRank` lọc trên toàn bộ.
 */
import * as vscode from 'vscode';
import type { MentionItem } from './protocol.js';

/** Thư mục luôn loại khỏi chỉ mục: build output và phụ thuộc, không phải mã nguồn. */
const EXCLUDED_DIRS = ['node_modules', '.git', 'dist', 'out', 'build', 'coverage'];
const EXCLUDE_GLOB = `**/{${EXCLUDED_DIRS.join(',')}}/**`;

/**
 * Trần số file trong CHỈ MỤC — chặn workspace bệnh lý (repo triệu file), không
 * phải cắt kết quả của một truy vấn. Cùng bậc với `INDEX_MAX_FILES` của CLI.
 */
const MAX_INDEXED_FILES = 20_000;

function isExcluded(relative: string): boolean {
  const segments = relative.split(/[/\\]/);
  return segments.some((s) => EXCLUDED_DIRS.includes(s));
}

/**
 * Quét MỘT lần cho mỗi workspace root rồi giữ trong bộ nhớ.
 *
 * Watcher trên đĩa chỉ ĐÁNH DẤU chỉ mục cũ khi có file mới/xoá; quét lại xảy ra
 * lười ở lần `all()` kế tiếp chứ không ngay lúc watcher bắn — tạo/xoá hàng loạt
 * (git checkout, cài lại dependency) không nện đĩa liên tục.
 */
export class MentionIndex implements vscode.Disposable {
  private entries: MentionItem[] | undefined;
  private loading: Promise<MentionItem[]> | undefined;
  private rootKey: string | undefined;
  private readonly watcher: vscode.FileSystemWatcher;

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const invalidate = (uri: vscode.Uri): void => {
      if (isExcluded(vscode.workspace.asRelativePath(uri, false))) return;
      this.entries = undefined;
      this.loading = undefined;
    };
    this.watcher.onDidCreate(invalidate);
    this.watcher.onDidDelete(invalidate);
  }

  dispose(): void {
    this.watcher.dispose();
  }

  /** Toàn bộ file đã lập chỉ mục cho `root`. Quét lại nếu chưa có hoặc root vừa đổi. */
  all(root: vscode.WorkspaceFolder): Promise<MentionItem[]> {
    const key = root.uri.toString();
    if (this.rootKey !== key) {
      this.rootKey = key;
      this.entries = undefined;
      this.loading = undefined;
    }
    if (this.entries) return Promise.resolve(this.entries);
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(root, '**/*'),
        EXCLUDE_GLOB,
        MAX_INDEXED_FILES,
      );
      const entries = uris.map((uri) => {
        const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
        return { path: relative, name: relative.split('/').pop() ?? relative };
      });
      this.entries = entries;
      this.loading = undefined;
      return entries;
    })();
    return this.loading;
  }
}
