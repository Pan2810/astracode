/**
 * ChangeLedger — sổ ghi mọi thay đổi agent gây ra trong phiên (mốc M4).
 *
 * Đây là NGUỒN SỰ THẬT DUY NHẤT cho ba tầng UI theo dõi thay đổi: badge trong
 * Explorer, diff editor, và highlight trong editor. Nếu mỗi tầng tự nhớ lấy
 * trạng thái riêng thì sớm muộn chúng sẽ nói ba chuyện khác nhau về cùng một
 * file, và người dùng sẽ tin nhầm cái nào đó.
 *
 * Hai quy tắc gộp quan trọng, đều xuất phát từ việc agent hay sửa một file
 * nhiều lần trong một lượt:
 *
 *   1. `originalContent` luôn là bản GỐC ĐẦU TIÊN, không bao giờ bị ghi đè bởi
 *      lần sửa sau. Mất nó là mất khả năng revert.
 *   2. `created` rồi `modified` vẫn là `created`. `created` rồi `deleted` thì
 *      xoá khỏi sổ luôn — kết quả ròng là không có gì thay đổi, hiện badge cho
 *      một file không tồn tại chỉ làm người dùng bối rối.
 *
 * Sổ này KHÔNG tự đụng vào đĩa. Nó phát ra thao tác hoàn tác (`revertOps`) để
 * tầng trên áp dụng — trong VS Code là `WorkspaceEdit` để Ctrl+Z còn dùng được.
 */

export type ChangeStatus = 'created' | 'modified' | 'deleted';

export interface FileChange {
  /** Đường dẫn tuyệt đối — khoá định danh trong sổ. */
  uri: string;
  /** Đường dẫn tương đối so với workspace root, dùng `/`. Cho UI hiển thị. */
  relativePath: string;
  status: ChangeStatus;
  /** `null` = file mới, trước đó không tồn tại. */
  originalContent: string | null;
  /** `null` = file đã bị xoá. */
  currentContent: string | null;
  /** Lượt chat gây ra thay đổi — để rollback theo lượt. */
  turnId: string;
  /** Người dùng đã duyệt chưa. Chưa duyệt thì UI hiện nút Accept/Reject. */
  approved: boolean;
  updatedAt: number;
}

/** Thao tác đưa một file về trạng thái trước khi agent đụng vào. */
export interface RevertOp {
  uri: string;
  /** `null` = xoá file (vì trước đó nó không tồn tại). */
  content: string | null;
}

export interface RecordChangeInput {
  uri: string;
  relativePath: string;
  status: ChangeStatus;
  originalContent: string | null;
  currentContent: string | null;
  turnId: string;
  /** Bỏ qua bước duyệt (chế độ acceptEdits). Mặc định false. */
  approved?: boolean;
}

export type ChangeListener = (changes: FileChange[]) => void;

export interface ChangeLedgerOptions {
  caseInsensitive?: boolean;
  /**
   * Chạy TRƯỚC khi gộp, với đối số thô của lần ghi này (M6).
   *
   * Đây là chỗ CheckpointStore móc vào. Phải là input thô chứ không phải bản
   * đã gộp: bản gộp giữ nội dung gốc của lần đụng đầu tiên trong cả phiên, còn
   * checkpoint cần nội dung ngay trước lần ghi này.
   */
  onRecord?: (input: RecordChangeInput) => void;
}

export class ChangeLedger {
  private readonly changes = new Map<string, FileChange>();
  private readonly listeners = new Set<ChangeListener>();
  /** So sánh khoá không phân biệt hoa thường trên Windows. */
  private readonly caseInsensitive: boolean;
  private readonly onRecord: ChangeLedgerOptions['onRecord'];

  constructor(opts: ChangeLedgerOptions = {}) {
    this.caseInsensitive = opts.caseInsensitive ?? process.platform === 'win32';
    this.onRecord = opts.onRecord;
  }

  private key(uri: string): string {
    return this.caseInsensitive ? uri.toLowerCase() : uri;
  }

  /**
   * Ghi nhận một thay đổi, gộp với thay đổi trước đó của cùng file.
   * Trả về bản ghi sau khi gộp.
   */
  record(input: RecordChangeInput): FileChange {
    // Trước mọi thứ khác: một hook hỏng không được ngăn việc ghi sổ, nhưng sổ
    // ghi rồi mà hook chưa chạy thì checkpoint mất bản chụp.
    try {
      this.onRecord?.(input);
    } catch {
      /* bỏ qua có chủ ý — xem chú thích trên */
    }

    const k = this.key(input.uri);
    const previous = this.changes.get(k);

    // File mới tạo trong phiên rồi lại bị xoá: không còn gì để kể.
    if (previous?.status === 'created' && input.status === 'deleted') {
      this.changes.delete(k);
      this.notify();
      return { ...previous, status: 'deleted', currentContent: null, updatedAt: Date.now() };
    }

    const merged: FileChange = {
      uri: previous?.uri ?? input.uri,
      relativePath: previous?.relativePath ?? input.relativePath,
      // Sửa tiếp một file vừa tạo thì nó vẫn là file mới.
      status: previous?.status === 'created' ? 'created' : input.status,
      // Bản gốc chỉ được chốt MỘT lần, ở lần đụng đầu tiên.
      originalContent: previous ? previous.originalContent : input.originalContent,
      currentContent: input.currentContent,
      turnId: input.turnId,
      // Sửa lại thì phải duyệt lại — một lần duyệt không phủ cho nội dung mới.
      approved: input.approved ?? false,
      updatedAt: Date.now(),
    };

    this.changes.set(k, merged);
    this.notify();
    return merged;
  }

  get(uri: string): FileChange | undefined {
    return this.changes.get(this.key(uri));
  }

  list(): FileChange[] {
    return [...this.changes.values()].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    );
  }

  /** Thay đổi của một lượt chat cụ thể. */
  byTurn(turnId: string): FileChange[] {
    return this.list().filter((c) => c.turnId === turnId);
  }

  pending(): FileChange[] {
    return this.list().filter((c) => !c.approved);
  }

  get size(): number {
    return this.changes.size;
  }

  /**
   * Duyệt: giữ nguyên nội dung trên đĩa, chỉ bỏ file khỏi danh sách chờ.
   * Bản ghi vẫn nằm trong sổ để badge Explorer còn hiện "đã đụng vào file này".
   */
  accept(uri: string): boolean {
    const change = this.changes.get(this.key(uri));
    if (!change) return false;
    change.approved = true;
    change.updatedAt = Date.now();
    this.notify();
    return true;
  }

  acceptAll(): void {
    for (const c of this.changes.values()) {
      c.approved = true;
      c.updatedAt = Date.now();
    }
    this.notify();
  }

  /**
   * Từ chối: trả về thao tác cần làm để khôi phục, rồi gỡ khỏi sổ.
   * Người gọi PHẢI áp dụng thao tác này — sổ không tự ghi đĩa.
   */
  reject(uri: string): RevertOp | undefined {
    const k = this.key(uri);
    const change = this.changes.get(k);
    if (!change) return undefined;
    this.changes.delete(k);
    this.notify();
    return { uri: change.uri, content: change.originalContent };
  }

  /** Thao tác khôi phục cho TẤT CẢ, kể cả file đã duyệt. Không gỡ khỏi sổ. */
  revertOps(): RevertOp[] {
    return this.list().map((c) => ({ uri: c.uri, content: c.originalContent }));
  }

  /** Khôi phục toàn bộ: trả thao tác và dọn sổ. */
  revertAll(): RevertOp[] {
    const ops = this.revertOps();
    this.changes.clear();
    this.notify();
    return ops;
  }

  /** Khôi phục riêng một lượt — dùng khi người dùng huỷ lượt vừa chạy. */
  revertTurn(turnId: string): RevertOp[] {
    const ops: RevertOp[] = [];
    for (const [k, c] of [...this.changes]) {
      if (c.turnId !== turnId) continue;
      ops.push({ uri: c.uri, content: c.originalContent });
      this.changes.delete(k);
    }
    if (ops.length > 0) this.notify();
    return ops;
  }

  /**
   * Cập nhật sổ sau khi `/undo` đã ghi các file trở lại đĩa (M6).
   *
   * Không phải cứ undo là xoá bản ghi: một file có thể đã bị sửa từ lượt trước
   * nữa. So nội dung vừa khôi phục với bản gốc của phiên — bằng nhau thì file
   * đã sạch, gỡ khỏi sổ; khác nhau thì nó vẫn còn khác bản gốc, giữ bản ghi và
   * cập nhật nội dung hiện tại. Không làm bước này thì badge trong Explorer sẽ
   * nói sai về chính trạng thái trên đĩa.
   */
  applyUndo(ops: RevertOp[]): void {
    let changed = false;

    for (const op of ops) {
      const k = this.key(op.uri);
      const entry = this.changes.get(k);
      if (!entry) continue;

      if (entry.originalContent === op.content) {
        this.changes.delete(k);
      } else {
        entry.currentContent = op.content;
        entry.status = op.content === null ? 'deleted' : entry.status;
        entry.approved = false;
        entry.updatedAt = Date.now();
      }
      changed = true;
    }

    if (changed) this.notify();
  }

  clear(): void {
    if (this.changes.size === 0) return;
    this.changes.clear();
    this.notify();
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const snapshot = this.list();
    for (const l of this.listeners) {
      // Một listener hỏng không được làm chết các listener còn lại — mất một
      // badge còn hơn mất cả TreeView.
      try {
        l(snapshot);
      } catch {
        /* bỏ qua có chủ ý */
      }
    }
  }
}

/** Câu tóm tắt cho status bar / cuối lượt chat. */
export function summarizeChanges(changes: FileChange[]): string {
  if (changes.length === 0) return 'No files changed';
  const created = changes.filter((c) => c.status === 'created').length;
  const modified = changes.filter((c) => c.status === 'modified').length;
  const deleted = changes.filter((c) => c.status === 'deleted').length;
  const parts: string[] = [];
  if (created) parts.push(`${created} new`);
  if (modified) parts.push(`${modified} edited`);
  if (deleted) parts.push(`${deleted} deleted`);
  return parts.join(', ');
}
