/**
 * `~/.astra/history.jsonl` — mọi prompt người dùng đã gõ, một dòng JSON mỗi cái.
 *
 * Tách khỏi file phiên có chủ ý. Phiên là hội thoại (có cả câu trả lời, trích
 * đoạn file, kết quả tool) và bị dọn theo dự án; lịch sử gõ là thứ người dùng
 * muốn tìm lại bằng mũi tên lên, xuyên qua mọi repo, kể cả những phiên đã bị
 * dọn từ lâu. Gộp hai thứ nghĩa là mất cái này khi dọn cái kia.
 *
 * JSONL chứ không JSON: một dòng hỏng chỉ mất một dòng. Cả file là một mảng JSON
 * thì một lần ghi dở dang làm mất sạch lịch sử.
 *
 * **Ghi bằng đọc-nối-ghi, không phải append thật.** `FileSystem` (cổng duy nhất
 * ra đĩa của core) không có `append`, và thêm nó chỉ cho một chỗ dùng là mở rộng
 * bề mặt của cổng đó. Đổi lại phải có trần: file bị cắt về `maxEntries` dòng gần
 * nhất sau mỗi lần ghi, nên chi phí không lớn dần theo thời gian.
 */
import type { FileSystem } from '../fs/FileSystem.js';
import type { AstraLayout } from './layout.js';

export interface HistoryEntry {
  /** Nguyên văn người dùng gõ. */
  display: string;
  /** Workspace lúc gõ câu này. Rỗng nếu không mở thư mục nào. */
  project: string;
  sessionId: string;
  timestamp: number;
}

export interface HistoryLogOptions {
  fs: FileSystem;
  layout: AstraLayout;
  /** Số dòng giữ lại. Mặc định 1000. */
  maxEntries?: number;
  /** Trần độ dài một prompt được ghi. Dài hơn thì cắt. Mặc định 10k. */
  maxChars?: number;
}

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_CHARS = 10_000;

export class HistoryLog {
  private readonly maxEntries: number;
  private readonly maxChars: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: HistoryLogOptions) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  }

  /**
   * Thêm một prompt. Không bao giờ ném — lịch sử gõ mất một dòng không đáng làm
   * hỏng lượt chat.
   *
   * Bỏ qua khi trùng với dòng ngay trước: gửi lại cùng một câu hai lần là
   * chuyện thường, và một lịch sử đầy bản sao thì mũi tên lên trở nên vô dụng.
   */
  async append(entry: HistoryEntry): Promise<void> {
    const display = entry.display.trim();
    if (!display) return;

    const run = this.queue.then(async () => {
      const existing = await this.readAll();
      const last = existing.at(-1);
      if (last?.display === display && last.project === entry.project) return;

      existing.push({
        ...entry,
        display: display.length > this.maxChars ? display.slice(0, this.maxChars) : display,
      });
      const kept = existing.slice(-this.maxEntries);
      try {
        await this.opts.fs.writeFile(
          this.opts.layout.historyLog,
          kept.map((e) => JSON.stringify(e)).join('\n') + '\n',
        );
      } catch {
        /* đĩa đầy hoặc chỉ đọc — lịch sử gõ không đáng để ném lên trên */
      }
    });
    this.queue = run.catch(() => undefined);
    await run;
  }

  /** Prompt gần nhất trước, đã lọc trùng liên tiếp. */
  async recent(limit = 100, project?: string): Promise<HistoryEntry[]> {
    const all = await this.readAll();
    const out: HistoryEntry[] = [];
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const entry = all[i]!;
      if (project && entry.project && entry.project !== project) continue;
      if (out.at(-1)?.display === entry.display) continue;
      out.push(entry);
    }
    return out;
  }

  private async readAll(): Promise<HistoryEntry[]> {
    let raw: string;
    try {
      raw = await this.opts.fs.readFile(this.opts.layout.historyLog);
    } catch {
      return [];
    }

    const out: HistoryEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseEntry(trimmed);
      if (parsed) out.push(parsed);
    }
    return out;
  }
}

function parseEntry(line: string): HistoryEntry | undefined {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return undefined; // Một dòng hỏng chỉ mất một dòng — đúng lý do chọn JSONL.
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.display !== 'string' || !d.display) return undefined;

  return {
    display: d.display,
    project: typeof d.project === 'string' ? d.project : '',
    sessionId: typeof d.sessionId === 'string' ? d.sessionId : '',
    timestamp: typeof d.timestamp === 'number' ? d.timestamp : 0,
  };
}
