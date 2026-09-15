/**
 * Cổng lưu token. Core không biết SecretStorage của VS Code là gì —
 * packages/vscode cài đặt interface này (nguyên tắc kiến trúc #1).
 */
export interface TokenStore {
  get(): Promise<string | undefined>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** Bản trong bộ nhớ — dùng cho test và cho script demo chạy ngoài VS Code. */
export class MemoryTokenStore implements TokenStore {
  private token: string | undefined;

  constructor(initial?: string) {
    this.token = initial;
  }

  get(): Promise<string | undefined> {
    return Promise.resolve(this.token);
  }

  set(token: string): Promise<void> {
    this.token = token;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.token = undefined;
    return Promise.resolve();
  }
}

export interface AuthState {
  authenticated: boolean;
  username?: string;
  role?: string;
  /** Thời điểm token hết hạn, lấy từ claim `exp`. */
  expiresAt?: Date;
  /**
   * Dự án AstraWork mà token này mở, lấy từ claim `project_id`.
   *
   * Đây là NƠI DUY NHẤT giữ "đang ở dự án nào": mọi endpoint của gateway đọc
   * dự án từ token chứ không từ tham số, và đổi dự án là xin một token khác
   * (`POST /auth/switch-project/{id}`). Chép nó ra một biến khác trong
   * extension sẽ tạo ra hai sự thật, lệch nhau ngay lần người dùng đổi dự án
   * ở trang web.
   */
  projectId?: number;
}
