/**
 * Sổ mức dùng của máy này, và đường đẩy nó lên board Năng suất (M10, phần 1).
 *
 * ## Việc của lớp này, sau khi mục "Usage" đổi nguồn
 *
 * Nó nuôi board "Năng suất" của AstraWork — bảng `ai_telemetry_points`, đường
 * OTLP, cùng chỗ Claude Code đang đẩy vào. Nó KHÔNG còn là thứ mục "Usage"
 * hiển thị: ba con số ở đó giờ đọc thẳng từ `GET /auth/me/usage` (xem
 * `AccountUsage.ts`), tức là từ sổ audit của gateway.
 *
 * Ranh giới ấy có chủ ý. Sổ dưới đây đếm mọi lượt kể cả lúc mất mạng, còn sổ
 * audit chỉ có những lượt gateway thật sự chạy. Bày cả hai cạnh nhau là bày hai
 * con số không bao giờ bằng nhau cho cùng một câu hỏi, và người dùng không có
 * cách nào biết cái nào đúng.
 *
 * Lớp này giữ hai con số:
 *
 *   · `totals`  — mọi thứ đã đếm được trên máy này, sống qua mọi lần khởi động.
 *   · `pending` — phần CHƯA đẩy lên AstraWork thành công.
 *
 * `pending` chỉ về 0 khi đầu nhận đã nhận thật (`OtlpExporter` trả `true`). Nhờ
 * vậy mất mạng hay gateway lỗi không làm mất số: lần sau gộp lại gửi tiếp.
 *
 * ## Cái KHÔNG bao giờ rời khỏi máy
 *
 * Prompt, nội dung file, tên file, đường dẫn. Ở đây chỉ có bộ đếm và tên model.
 * Xem documents/SECURITY.md §9.2 — ranh giới đó là ràng buộc, không phải thói quen.
 */
import * as vscode from 'vscode';
import { OtlpExporter, mintIngestToken, type Logger } from '@astra/core';
import type { AstraSession } from '../session.js';

/** Khoá trong `globalState`. Đổi tên khoá = mất sổ, nên đừng đổi. */
const STATE_KEY = 'astra.usageLedger';

export interface UsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /**
   * Dòng agent thêm/xoá, đếm từ sổ thay đổi của lượt.
   *
   * Đây là `lines_of_code.count` mà board Năng suất đọc — cùng metric Claude
   * Code đẩy, nên hai công cụ so được với nhau. Đếm mọi thay đổi agent tạo ra
   * trong lượt, kể cả file người dùng chưa bấm duyệt: `/undo` sau đó là một
   * hành động khác, và board đo công agent bỏ ra chứ không đo tỉ lệ được nhận.
   */
  linesAdded: number;
  linesRemoved: number;
  /**
   * Chi phí, USD — `cost.usage` của board Năng suất.
   *
   * Số thực, KHÔNG làm tròn như token: một lượt thường tốn vài phần nghìn đô,
   * nên làm tròn về số nguyên là biến toàn bộ chi phí thành 0.
   */
  costUsd: number;
}

interface Ledger {
  totals: UsageTotals;
  pending: UsageTotals;
  /** Lần cuối AstraWork nhận được số, epoch ms. */
  syncedAt?: number;
  /** Vì sao lần đẩy gần nhất hỏng. Rỗng = lần gần nhất trót lọt. */
  lastError?: string;
}

/**
 * Phần trạng thái mà UI thật sự vẽ — CHỈ chuyện đẩy có trót lọt không.
 *
 * Cố ý không còn `totals`/`pending` đầy đủ: bộ đếm tích luỹ trên máy đã rời
 * khỏi UI từ lâu (mục "Usage" đọc số của gateway), nên trả chúng ra đây chỉ tạo
 * một cách đếm thứ hai để đi lệch với cách thứ nhất.
 *
 * Từ 0.0.29 việc đẩy số không còn công tắc, nên trạng thái DUY NHẤT còn đáng
 * hiện là "nó đang hỏng". Xem `renderUsage` trong webview/settingsPanel.ts.
 */
export interface UsageSyncState {
  /** Đang có một lần đẩy chạy dở. */
  syncing: boolean;
  /** Lần AstraWork nhận được số gần nhất, epoch ms. Không có = chưa lần nào. */
  syncedAt?: number;
  /** Vì sao lần đẩy gần nhất hỏng. Không có = lần gần nhất trót lọt. */
  lastError?: string;
  /** Số lượt đang nằm chờ gửi. 0 = không tồn đọng gì. */
  pendingTurns: number;
}

function add(a: UsageTotals, b: Partial<UsageTotals>): UsageTotals {
  return {
    turns: a.turns + (b.turns ?? 0),
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    totalTokens: a.totalTokens + (b.totalTokens ?? 0),
    linesAdded: a.linesAdded + (b.linesAdded ?? 0),
    linesRemoved: a.linesRemoved + (b.linesRemoved ?? 0),
    costUsd: a.costUsd + (b.costUsd ?? 0),
  };
}

function isEmpty(t: UsageTotals): boolean {
  return (
    t.turns === 0 &&
    t.inputTokens === 0 &&
    t.outputTokens === 0 &&
    t.totalTokens === 0 &&
    t.linesAdded === 0 &&
    t.linesRemoved === 0 &&
    t.costUsd === 0
  );
}

/** Đọc sổ cũ một cách dè chừng: globalState là JSON của một bản cũ bất kỳ. */
function readLedger(raw: unknown): Ledger {
  const num = (v: unknown): number => (typeof v === 'number' && v >= 0 ? v : 0);
  const totals = (v: unknown): UsageTotals => {
    const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
    return {
      turns: num(o.turns),
      inputTokens: num(o.inputTokens),
      outputTokens: num(o.outputTokens),
      totalTokens: num(o.totalTokens),
      linesAdded: num(o.linesAdded),
      linesRemoved: num(o.linesRemoved),
      costUsd: num(o.costUsd),
    };
  };

  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    totals: totals(o.totals),
    pending: totals(o.pending),
    ...(typeof o.syncedAt === 'number' ? { syncedAt: o.syncedAt } : {}),
    ...(typeof o.lastError === 'string' ? { lastError: o.lastError } : {}),
  };
}

export interface UsageSyncOptions {
  context: vscode.ExtensionContext;
  session: AstraSession;
  logger: Logger;
  /** Cho test tiêm fetch giả. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export class UsageSync implements vscode.Disposable {
  private ledger: Ledger;
  private syncing = false;
  /**
   * Ingest token đã xin được, kèm hạn nếu server nói và DỰ ÁN nó thuộc về.
   *
   * Nhớ dự án vì token gắn với nó: `POST /telemetry/token` cấp theo
   * `user.project_id`, nên số gửi bằng token của dự án cũ sẽ vào bảng của dự án
   * cũ — im lặng và sai, đúng loại lỗi không ai phát hiện ra cho tới lúc đối
   * chiếu cuối tháng.
   */
  private ingest: { token: string; expiresAt?: number; projectId?: number } | undefined;
  private readonly sessionId = `astracode-${Date.now().toString(36)}`;
  private readonly emitter = new vscode.EventEmitter<void>();

  /** Bắn mỗi khi sổ đổi — bảng cài đặt nghe cái này để vẽ lại. */
  readonly onDidChange = this.emitter.event;

  constructor(private readonly opts: UsageSyncOptions) {
    this.ledger = readLedger(opts.context.globalState.get<unknown>(STATE_KEY));
  }

  dispose(): void {
    this.emitter.dispose();
  }

  state(): UsageSyncState {
    return {
      syncing: this.syncing,
      pendingTurns: this.ledger.pending.turns,
      ...(this.ledger.syncedAt ? { syncedAt: this.ledger.syncedAt } : {}),
      ...(this.ledger.lastError ? { lastError: this.ledger.lastError } : {}),
    };
  }

  /**
   * Ghi số của một lượt vừa xong.
   *
   * Ghi vào sổ rồi đẩy luôn. Sổ vẫn là của người dùng và vẫn hiện trên máy họ;
   * `pending` chỉ là phần AstraWork chưa nhận được.
   */
  record(sample: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    model?: string;
    costUsd?: number;
    linesAdded?: number;
    linesRemoved?: number;
  }): void {
    const delta: UsageTotals = {
      turns: 1,
      inputTokens: Math.max(0, Math.round(sample.promptTokens)),
      outputTokens: Math.max(0, Math.round(sample.completionTokens)),
      totalTokens: Math.max(0, Math.round(sample.totalTokens)),
      linesAdded: Math.max(0, Math.round(sample.linesAdded ?? 0)),
      linesRemoved: Math.max(0, Math.round(sample.linesRemoved ?? 0)),
      costUsd: Math.max(0, sample.costUsd ?? 0),
    };

    this.ledger = {
      ...this.ledger,
      totals: add(this.ledger.totals, delta),
      pending: add(this.ledger.pending, delta),
    };
    void this.save();

    void this.flush(sample.model);
  }

  /**
   * Đẩy phần chưa gửi lên AstraWork. Gộp cả phần tồn đọng thành MỘT lần gửi.
   *
   * Gộp chứ không gửi lại từng lượt: metric ở đây là DELTA (aggregationTemporality
   * = 1), nên tổng của các delta bằng đúng delta của tổng — board bên kia cộng
   * ra cùng một con số, mà số request thì không phình theo thời gian offline.
   */
  async flush(model?: string): Promise<void> {
    if (this.syncing || isEmpty(this.ledger.pending)) return;

    this.syncing = true;
    this.emitter.fire();

    // Chụp lại phần đang gửi: lượt mới có thể xong giữa chừng và cộng thêm vào
    // `pending`. Trừ đi đúng phần đã gửi, không set về 0 — nếu không, con số
    // của lượt chen ngang biến mất mà không ai biết.
    const sending = this.ledger.pending;

    try {
      const exporter = await this.exporter();
      const accepted = await exporter.recordUsage({
        inputTokens: sending.inputTokens,
        outputTokens: sending.outputTokens,
        linesAdded: sending.linesAdded,
        linesRemoved: sending.linesRemoved,
        costUsd: sending.costUsd,
        ...(model ? { model } : {}),
      });

      if (accepted) {
        this.ledger = {
          ...this.ledger,
          pending: {
            turns: this.ledger.pending.turns - sending.turns,
            inputTokens: this.ledger.pending.inputTokens - sending.inputTokens,
            outputTokens: this.ledger.pending.outputTokens - sending.outputTokens,
            totalTokens: this.ledger.pending.totalTokens - sending.totalTokens,
            linesAdded: this.ledger.pending.linesAdded - sending.linesAdded,
            linesRemoved: this.ledger.pending.linesRemoved - sending.linesRemoved,
            costUsd: this.ledger.pending.costUsd - sending.costUsd,
          },
          syncedAt: Date.now(),
        };
        delete this.ledger.lastError;
      } else {
        this.ledger = {
          ...this.ledger,
          lastError: 'AstraWork did not accept the metrics — they will be resent next turn.',
        };
      }
    } catch (err) {
      // Ingest token có thể đã hết hạn hoặc bị thu hồi: bỏ bản đang giữ để lần
      // sau xin lại, thay vì thử mãi bằng một token đã chết.
      this.ingest = undefined;
      const reason = err instanceof Error ? err.message : String(err);
      this.opts.logger.debug('pushing usage failed', { reason });
      this.ledger = { ...this.ledger, lastError: reason };
    } finally {
      this.syncing = false;
      await this.save();
      // Bắn ở đây, không ở `save`: đây là lúc `syncing`, `syncedAt` và
      // `lastError` — ba thứ duy nhất UI đọc — vừa đổi xong.
      this.emitter.fire();
    }
  }

  /** Dựng exporter, xin ingest token nếu chưa có hoặc đã hết hạn. */
  private async exporter(): Promise<OtlpExporter> {
    const baseURL = this.opts.session.getConfig().gatewayBaseUrl;
    const auth = this.opts.session.getAuth();
    if (!baseURL || !auth) {
      throw new Error('No gateway configured, or not signed in to AstraWork.');
    }

    // Xin lại sớm 60s: một token hết hạn giữa lúc request đang bay sẽ hỏng cả
    // lần gửi, và lần gửi đó mang theo toàn bộ phần tồn đọng.
    const stale = this.ingest?.expiresAt !== undefined && this.ingest.expiresAt - 60_000 < Date.now();
    // Đổi dự án cũng phải xin lại: token cũ vẫn còn hạn nhưng nó thuộc dự án
    // trước đó, và gateway ghi số theo dự án của TOKEN chứ không theo dự án
    // đang mở trên màn hình.
    const projectId = (await auth.state()).projectId;
    const wrongProject = this.ingest !== undefined && this.ingest.projectId !== projectId;

    if (!this.ingest || stale || wrongProject) {
      const minted = await mintIngestToken({
        baseURL,
        getToken: () => auth.requireToken(),
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      });
      this.ingest = { ...minted, ...(projectId !== undefined ? { projectId } : {}) };
    }

    // Task đang khai đi kèm MỌI lần gửi, không phải chỉ lần đầu: người dùng đổi
    // task giữa buổi, và phần tồn đọng gửi sau đó phải mang task đang khai lúc
    // gửi chứ không phải task lúc dựng exporter.
    const taskId = this.opts.session.taskAttribute();

    return new OtlpExporter({
      baseURL,
      ingestToken: this.ingest.token,
      sessionId: this.sessionId,
      logger: this.opts.logger,
      ...(taskId ? { taskId } : {}),
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
    });
  }

  /**
   * Ghi sổ xuống đĩa. KHÔNG bắn `onDidChange`.
   *
   * Sổ đổi sau mỗi lượt, nhưng thứ UI vẽ từ nó chỉ là trạng thái đẩy — hiếm khi
   * đổi. Bắn ở đây nghĩa là dựng lại toàn bộ bảng cài đặt sau mỗi lượt chat cho
   * một nội dung y hệt. Nơi bắn nằm ở `flush`, đúng hai thời điểm phần nhìn
   * thấy được thật sự đổi: lúc bắt đầu gửi và lúc gửi xong.
   */
  private async save(): Promise<void> {
    await this.opts.context.globalState.update(STATE_KEY, this.ledger);
  }
}
