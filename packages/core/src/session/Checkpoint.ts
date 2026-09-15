/**
 * Checkpoint theo lượt — nền cho `/undo` (mốc M6).
 *
 * ## Vì sao không dùng thẳng ChangeLedger
 *
 * Sổ thay đổi (M4) giữ bản gốc ở lần đụng ĐẦU TIÊN trong cả phiên. Đó đúng cho
 * "Hoàn tác tất cả", nhưng sai cho "hoàn tác lượt vừa rồi":
 *
 *   lượt 1: A → B    lượt 2: B → C
 *   ledger.revertTurn('t2')  ⇒ đưa file về A — hoàn tác nhầm cả lượt 1.
 *
 * Checkpoint chụp trạng thái file NGAY TRƯỚC lượt hiện tại, nên `/undo` đưa về
 * B như người dùng chờ đợi.
 *
 * ## Vì sao không dùng shadow git repo (ADR-003)
 *
 * Shadow repo bắt được cả thay đổi ngoài tool, nhưng kéo theo một tiến trình
 * git thứ hai chạy trên repo của người dùng, phải xử lý index lock, `.gitignore`,
 * submodule, và file lớn. Đổi lại ta chỉ cần một việc: hoàn tác thứ AGENT vừa
 * làm. Cái giá đó không xứng.
 *
 * **Giới hạn phải nói thẳng:** chỉ bắt được thay đổi đi qua tool ghi file. Một
 * lệnh `bash` ghi file thì checkpoint không biết, và `/undo` không khôi phục
 * được nó. UI phải nói rõ điều này chứ không được hứa suông.
 */
import type { RecordChangeInput, RevertOp } from '../changes/ChangeLedger.js';

export interface CheckpointEntry {
  uri: string;
  relativePath: string;
  /** Nội dung TRƯỚC lượt. `null` = lúc đó file chưa tồn tại. */
  content: string | null;
}

export interface Checkpoint {
  turnId: string;
  createdAt: number;
  entries: CheckpointEntry[];
}

export interface CheckpointStoreOptions {
  /** Số lượt giữ lại. Mặc định 20 — đủ xa cho mọi thao tác undo thực tế. */
  maxTurns?: number;
  /** Trần ký tự cho một file được chụp. File to hơn thì không hoàn tác được. */
  maxFileChars?: number;
  caseInsensitive?: boolean;
}

/** Trần mặc định: 2 MB. Trên mức này gần như chắc chắn không phải file nguồn. */
const DEFAULT_MAX_FILE_CHARS = 2_000_000;

export class CheckpointStore {
  private readonly turns: Checkpoint[] = [];
  private readonly maxTurns: number;
  private readonly maxFileChars: number;
  private readonly caseInsensitive: boolean;
  /** File đã chụp trong lượt hiện tại — chỉ chụp lần đụng đầu. */
  private readonly seen = new Map<string, Set<string>>();
  private readonly skipped = new Set<string>();

  constructor(opts: CheckpointStoreOptions = {}) {
    this.maxTurns = opts.maxTurns ?? 20;
    this.maxFileChars = opts.maxFileChars ?? DEFAULT_MAX_FILE_CHARS;
    this.caseInsensitive = opts.caseInsensitive ?? process.platform === 'win32';
  }

  /**
   * Ghi nhận một lần ghi file. Gắn vào `ChangeLedger` qua `onRecord` để không
   * có đường nào ghi file mà quên chụp.
   */
  capture(input: RecordChangeInput): void {
    const turn = this.turnOf(input.turnId);
    const seen = this.seen.get(input.turnId)!;
    const k = this.key(input.uri);
    if (seen.has(k)) return;
    seen.add(k);

    // File khổng lồ: ghi nhận là đã đụng nhưng không giữ nội dung. Giữ 200 MB
    // trong RAM để phòng một lần undo là cái giá sai.
    if (input.originalContent !== null && input.originalContent.length > this.maxFileChars) {
      this.skipped.add(k);
      return;
    }

    turn.entries.push({
      uri: input.uri,
      relativePath: input.relativePath,
      content: input.originalContent,
    });
  }

  /** Lượt gần nhất có thay đổi file, nếu có. */
  lastTurnId(): string | undefined {
    return this.turns.at(-1)?.turnId;
  }

  get(turnId: string): Checkpoint | undefined {
    return this.turns.find((t) => t.turnId === turnId);
  }

  size(): number {
    return this.turns.length;
  }

  /**
   * Thao tác đưa file về trạng thái trước lượt `turnId`, và mọi lượt sau nó.
   *
   * Phải gộp cả các lượt sau: hoàn tác lượt 3 mà bỏ qua lượt 4, 5 sẽ để lại
   * file ở một trạng thái chưa từng tồn tại. Khi một file xuất hiện ở nhiều
   * lượt, bản chụp của lượt SỚM NHẤT thắng.
   */
  restore(turnId: string): RevertOp[] {
    return this.restoreWithTurns(turnId).ops;
  }

  /**
   * Như `restore`, nhưng nói luôn những lượt nào vừa bị tiêu thụ.
   *
   * Người gọi cần danh sách đó để xoá đúng chừng ấy file trong `file-history/`.
   * Không có nó thì bản chụp trên đĩa sống lâu hơn bản trong RAM, và lần mở lại
   * phiên sau sẽ hồi sinh một lượt mà người dùng vừa hoàn tác.
   */
  restoreWithTurns(turnId: string): { ops: RevertOp[]; removedTurnIds: string[] } {
    const from = this.turns.findIndex((t) => t.turnId === turnId);
    if (from < 0) return { ops: [], removedTurnIds: [] };

    const ops = new Map<string, RevertOp>();
    for (const turn of this.turns.slice(from)) {
      for (const entry of turn.entries) {
        const k = this.key(entry.uri);
        if (!ops.has(k)) ops.set(k, { uri: entry.uri, content: entry.content });
      }
    }

    const removed = this.turns.splice(from).map((t) => t.turnId);
    for (const key of [...this.seen.keys()]) {
      if (!this.turns.some((t) => t.turnId === key)) this.seen.delete(key);
    }

    return { ops: [...ops.values()], removedTurnIds: removed };
  }

  /**
   * Nạp lại bản chụp đã đọc từ đĩa (mở lại phiên cũ).
   *
   * Thay thế toàn bộ chứ không gộp: store này chỉ nên mô tả MỘT phiên, và trộn
   * checkpoint của phiên vừa đóng với phiên vừa mở là cách hoàn tác nhầm file.
   * `seen` được dựng lại theo dữ liệu nạp vào, nên một lần ghi tiếp theo trong
   * cùng lượt vẫn không chụp đè lên bản gốc đã có.
   */
  hydrate(checkpoints: Checkpoint[]): void {
    this.clear();
    for (const cp of checkpoints.slice(-this.maxTurns)) {
      this.turns.push({ turnId: cp.turnId, createdAt: cp.createdAt, entries: [...cp.entries] });
      this.seen.set(cp.turnId, new Set(cp.entries.map((e) => this.key(e.uri))));
    }
  }

  /** File bị bỏ qua vì quá lớn — UI cảnh báo trước khi người dùng bấm undo. */
  skippedFiles(): number {
    return this.skipped.size;
  }

  clear(): void {
    this.turns.length = 0;
    this.seen.clear();
    this.skipped.clear();
  }

  private turnOf(turnId: string): Checkpoint {
    let turn = this.turns.find((t) => t.turnId === turnId);
    if (!turn) {
      turn = { turnId, createdAt: Date.now(), entries: [] };
      this.turns.push(turn);
      this.seen.set(turnId, new Set());
      if (this.turns.length > this.maxTurns) {
        const dropped = this.turns.shift();
        if (dropped) this.seen.delete(dropped.turnId);
      }
    }
    if (!this.seen.has(turnId)) this.seen.set(turnId, new Set());
    return turn;
  }

  private key(uri: string): string {
    return this.caseInsensitive ? uri.toLowerCase() : uri;
  }
}
