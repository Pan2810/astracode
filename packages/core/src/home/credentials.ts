/**
 * `~/.astra/credentials.json` — chỉ đọc/ghi định dạng, không đụng đĩa.
 *
 * Bí mật nằm ở FILE RIÊNG chứ không trong settings, và đó là toàn bộ lý do file
 * này tồn tại: `settings.json` phải chép sang máy khác được, dán vào issue được,
 * commit vào dotfiles được. Trộn token vào đó thì mọi thao tác ấy thành một lần
 * rò rỉ.
 *
 * Việc đặt quyền 0600 thuộc về nơi ghi (CLI), không thuộc về đây — core không
 * có `node:fs`.
 */
export interface AstraCredentials {
  astrawork?: {
    accessToken: string;
    savedAt: number;
  };
}

/**
 * Lấy access token từ nội dung file.
 *
 * Nhận cả định dạng cũ: file `token` chứa JWT trần. Không phải để chiều bản cũ
 * mà vì migrate có thể chưa chạy (người dùng lùi bản, hoặc chép tay `~/.astra`
 * từ máy khác sang), và lúc đó "đăng nhập lại đi" là một câu trả lời sai.
 */
export function readAccessToken(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  if (!trimmed.startsWith('{')) return trimmed;

  try {
    const data: unknown = JSON.parse(trimmed);
    if (typeof data !== 'object' || data === null) return undefined;
    const astrawork = (data as Record<string, unknown>).astrawork;
    if (typeof astrawork !== 'object' || astrawork === null) return undefined;
    const token = (astrawork as Record<string, unknown>).accessToken;
    return typeof token === 'string' && token ? token : undefined;
  } catch {
    return undefined;
  }
}

export function writeAccessToken(token: string, now = Date.now()): string {
  const payload: AstraCredentials = { astrawork: { accessToken: token, savedAt: now } };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
