/**
 * Mức dùng CỦA TÀI KHOẢN, đọc từ AstraWork (M10, phần 2).
 *
 * ## Vì sao lớp này thay chỗ cho sổ đếm cũ
 *
 * `UsageSync` giữ một sổ riêng trên máy và đẩy nó lên board Năng suất. Sổ đó
 * vẫn còn (xem file bên cạnh) nhưng KHÔNG còn là thứ mục "Usage" hiển thị: một
 * con số AstraCode tự đếm không bao giờ khớp với thẻ "AI 利用状況" trên trang cá
 * nhân AstraWork, vì hai bên đếm hai thứ khác nhau — sổ đếm mọi lượt kể cả lúc
 * mất mạng, thẻ đếm những dòng gateway thật sự ghi lại.
 *
 * Ở đây chỉ có MỘT con số, và nó là con số của AstraWork. Không có "bản của máy
 * này" để đi lệch.
 *
 * ## Vì sao không cần đẩy gì để chiều AstraCode -> AstraWork chạy
 *
 * Mỗi lượt chat của AstraCode đi qua `POST /v1/chat/completions` của gateway, và
 * chính gateway ghi dòng audit kèm token + chi phí (`routers/ide_chat.py`). Lượt
 * chat CHÍNH LÀ hành động cập nhật. Việc còn lại chỉ là đọc lại sau khi lượt
 * xong — `refresh()` dưới đây, gọi từ `chatView` khi một lượt kết thúc.
 *
 * ## Cache
 *
 * Bảng cài đặt được vẽ lại mỗi khi bất cứ thứ gì đổi (đổi model, đăng nhập,
 * lượt mới). Gọi mạng theo mỗi lần vẽ sẽ biến việc gõ vào ô địa chỉ thành một
 * tràng request. Nên: giữ bản gần nhất, chỉ gọi lại khi quá cũ hoặc khi có lý
 * do cụ thể (`force`).
 */
import * as vscode from 'vscode';
import { fetchAccountUsage, type AccountUsage, type Logger } from '@astra/core';
import type { AstraSession } from '../session.js';

/** Số cũ hơn chừng này thì đọc lại khi bảng cài đặt được vẽ. */
const STALE_MS = 60_000;

/**
 * Chờ chừng này sau khi một lượt kết thúc rồi mới đọc lại.
 *
 * Gateway ghi dòng audit SAU khi đã trả xong phản hồi (`_audit` của
 * `routers/ide_chat.py` mở session riêng cho đúng lý do đó). Đọc ngay lúc lượt
 * vừa dứt là đua với lần ghi ấy, và thua cuộc đua nghĩa là bảng hiện con số cũ
 * đúng vào lúc người dùng nhìn vào để kiểm chứng.
 */
const AFTER_TURN_MS = 1_500;

export interface AccountUsageState {
  /** Đọc được số hay không: cần có gateway VÀ đã đăng nhập. */
  available: boolean;
  /** Đang có một lần đọc chạy dở. */
  loading: boolean;
  /** Số gần nhất đọc được. Không có = chưa đọc lần nào thành công. */
  usage?: AccountUsage;
  /** Lần đọc thành công gần nhất, epoch ms. */
  fetchedAt?: number;
  /** Vì sao lần đọc gần nhất hỏng. Rỗng = lần gần nhất trót lọt. */
  error?: string;
}

export interface AccountUsageStoreOptions {
  session: AstraSession;
  logger: Logger;
  /** Cho test tiêm fetch giả. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export class AccountUsageStore implements vscode.Disposable {
  private usage: AccountUsage | undefined;
  private fetchedAt: number | undefined;
  private error: string | undefined;
  /** Lần đọc đang chạy — để nhiều lời gọi cùng lúc chỉ thành một request. */
  private inFlight: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Số đang giữ là của ai, ở gateway nào. Dạng `user@baseURL`, rỗng = chưa đăng
   * nhập. Đổi giá trị này nghĩa là số cũ không còn nói về ai cả — phải quên đi
   * chứ không phải để nó nằm lại trên bảng của người tiếp theo.
   */
  private owner = '';
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly subscription: vscode.Disposable;

  /** Bắn mỗi khi số đổi — bảng cài đặt nghe cái này để vẽ lại. */
  readonly onDidChange = this.emitter.event;

  constructor(private readonly opts: AccountUsageStoreOptions) {
    // Đăng nhập, đăng xuất, đổi địa chỉ gateway đều đi qua đây.
    this.subscription = opts.session.onDidChange(() => void this.syncOwner());
    // Và một lần lúc dựng: mở lại VS Code khi đã đăng nhập sẵn thì không có
    // thay đổi nào để nghe, mà số thì vẫn phải có.
    void this.syncOwner();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.subscription.dispose();
    this.emitter.dispose();
  }

  state(): AccountUsageState {
    return {
      available: this.canRead(),
      loading: this.inFlight !== undefined,
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.fetchedAt ? { fetchedAt: this.fetchedAt } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /**
   * Quên số đang giữ. Gọi khi đăng xuất: số của người vừa rời đi không được
   * nằm lại trên bảng của người đăng nhập tiếp theo.
   */
  clear(): void {
    if (!this.usage && this.fetchedAt === undefined && !this.error) return;
    this.usage = undefined;
    this.fetchedAt = undefined;
    this.error = undefined;
    this.emitter.fire();
  }

  /**
   * Ai đang đăng nhập đổi thì số đang giữ hết giá trị.
   *
   * Chạy sau MỌI thay đổi của session (kể cả đổi model), nên nó phải rẻ khi
   * không có gì đổi: so một chuỗi rồi thôi. Chỉ khi chủ sở hữu đổi mới quên số
   * và đọc lại — nếu không, gõ vào ô địa chỉ sẽ thành một tràng request.
   */
  private async syncOwner(): Promise<void> {
    const baseURL = this.opts.session.getConfig().gatewayBaseUrl;
    const auth = this.opts.session.getAuth();
    let owner = '';
    if (baseURL && auth) {
      const state = await auth.state();
      if (state.authenticated) owner = `${state.username ?? '?'}@${baseURL}`;
    }
    if (owner === this.owner) return;

    this.owner = owner;
    this.clear();
    if (owner) void this.refresh(true);
  }

  /** Đọc lại sau khi một lượt vừa xong. Xem `AFTER_TURN_MS`. */
  scheduleAfterTurn(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh(true);
    }, AFTER_TURN_MS);
  }

  /**
   * Đọc số từ AstraWork.
   *
   * `force = false` là đường của việc vẽ lại bảng: chỉ thật sự gọi mạng khi số
   * đang giữ đã cũ. `force = true` là đường của người dùng bấm "Refresh" và của
   * lượt vừa kết thúc — hai lúc con số cũ là câu trả lời sai.
   */
  async refresh(force = false): Promise<void> {
    if (!this.canRead()) return;
    if (this.inFlight) return this.inFlight;
    if (!force && this.fetchedAt !== undefined && Date.now() - this.fetchedAt < STALE_MS) return;

    this.inFlight = this.read();
    this.emitter.fire();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
      this.emitter.fire();
    }
  }

  /**
   * `owner` rỗng nghĩa là chưa có gateway hoặc chưa đăng nhập — hai thứ này
   * không phải lỗi, chúng là trạng thái khởi đầu của mọi bản cài mới. UI nói ra
   * ô nào còn thiếu; ở đây chỉ là không gọi mạng.
   */
  private canRead(): boolean {
    return this.owner !== '';
  }

  private async read(): Promise<void> {
    const baseURL = this.opts.session.getConfig().gatewayBaseUrl;
    const auth = this.opts.session.getAuth();
    if (!baseURL || !auth) return;

    try {
      this.usage = await fetchAccountUsage({
        baseURL,
        getToken: () => auth.requireToken(),
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      });
      this.fetchedAt = Date.now();
      this.error = undefined;
    } catch (err) {
      // Không ném: mục Usage hỏng không đáng làm hỏng cả bảng cài đặt. Nhưng
      // phải NÓI RA — một mục Usage trống mà không có lý do là thứ người dùng
      // không có cách nào tự gỡ.
      const reason = err instanceof Error ? err.message : String(err);
      this.opts.logger.debug('reading account usage failed', { reason });
      this.error = reason;
    }
  }
}
