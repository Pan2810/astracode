/**
 * Chờ người dùng đăng nhập ở trình duyệt rồi tự nhận credential khi họ quay lại.
 *
 * Vì sao phải có lớp này thay vì một hộp nhập:
 *
 * `_safe_next()` của gateway ép `next` phải là path nội bộ trên frontend, nên
 * KHÔNG redirect thẳng về `vscode://` được, và extension thì không đọc được bộ
 * nhớ của trình duyệt. Đường tự động duy nhất còn lại đi qua clipboard: người
 * dùng copy thanh địa chỉ (đã có `?code=…`), alt-tab về, AstraCode nhặt lấy.
 *
 * Ba ràng buộc để việc đọc clipboard không thành một thứ chạy ngầm suốt ngày:
 *
 *   1. CHỈ đọc sau khi người dùng tự bấm "Đăng nhập", không lúc nào khác.
 *   2. Tự tắt sau `WINDOW_MS`, kể cả khi không tìm thấy gì.
 *   3. Nội dung không khớp thì bỏ qua IM LẶNG và không giữ lại — hàm bóc
 *      credential từ chối mọi thứ không phải URL có mã, JWT, hay mã trần.
 *
 * Khi frontend AstraWork có trang deep-link về `vscode://astracode.astracode/auth`
 * thì cả lớp này thành thừa: URI handler nhận thẳng và trình duyệt tự kéo VS Code
 * lên trước. Xem `handleAuthUri` trong extension.ts.
 */
import * as vscode from 'vscode';
import type { Logger } from '@astra/core';
import { extractCredential, type Credential } from './credential.js';

/** Hết thời gian này thì thôi chờ. Đủ dài cho một lần đăng nhập Microsoft. */
const WINDOW_MS = 5 * 60_000;
/**
 * Nhịp kiểm tra trong lúc chờ.
 *
 * Có nhịp CHỨ KHÔNG chỉ nghe sự kiện focus: người dùng hai màn hình copy xong
 * mà VS Code chưa bao giờ mất focus thì sự kiện đó không bao giờ bắn.
 */
const POLL_MS = 1500;

export class SignInFlow implements vscode.Disposable {
  private deadline = 0;
  private timer: NodeJS.Timeout | undefined;
  /** Nội dung đã thử rồi — không thử lại mỗi nhịp cho tới khi clipboard đổi. */
  private lastSeen = '';
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly opts: {
      /** Trả `true` nếu credential dùng được. `false` = thử tiếp. */
      accept: (credential: Credential) => Promise<boolean>;
      logger: Logger;
    },
  ) {
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) void this.check();
      }),
    );
  }

  dispose(): void {
    this.stop();
    for (const d of this.disposables) d.dispose();
  }

  get waiting(): boolean {
    return Date.now() < this.deadline;
  }

  /** Bắt đầu chờ. Gọi ngay sau khi đã mở trình duyệt. */
  begin(): void {
    this.deadline = Date.now() + WINDOW_MS;
    // Clipboard hiện tại là thứ có TỪ TRƯỚC khi bấm đăng nhập. Không đánh dấu
    // nó là "đã thử" — người dùng có thể đã copy sẵn mã từ lần trước.
    this.lastSeen = '';
    this.timer ??= setInterval(() => void this.check(), POLL_MS);
    this.opts.logger.info('waiting for the browser sign-in', { windowMs: WINDOW_MS });
  }

  /** Thôi chờ. Gọi khi đã nhận được credential, hoặc người dùng huỷ. */
  stop(): void {
    this.deadline = 0;
    this.lastSeen = '';
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async check(): Promise<void> {
    if (!this.waiting) {
      // Hết giờ: dừng hẳn để không còn nhịp nào chạm vào clipboard nữa.
      if (this.timer) this.stop();
      return;
    }

    let text: string;
    try {
      text = await vscode.env.clipboard.readText();
    } catch {
      return; // Clipboard bị chiếm bởi tiến trình khác — nhịp sau thử lại.
    }

    if (!text || text === this.lastSeen) return;
    this.lastSeen = text;

    const credential = extractCredential(text);
    if (!credential) return;

    // KHÔNG log giá trị, kể cả một phần: đây là token của phiên.
    this.opts.logger.info('found a credential in the clipboard', { kind: credential.kind });

    if (await this.opts.accept(credential)) this.stop();
  }
}
