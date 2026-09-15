/**
 * `~/.astra/` — thư mục dùng chung giữa CLI và extension.
 *
 * Chung có chủ đích: đo năng lực model một lần bằng CLI thì extension thấy ngay,
 * và ngược lại. Hai công cụ, một sự thật. Nếu tách ra thì người dùng phải đo hai
 * lần và sẽ có lúc hai bên nói khác nhau về cùng một model.
 *
 * KHÔNG chứa gì thuộc về một repo cụ thể — cấu hình của dự án nằm ở `.astra/`
 * trong chính repo đó.
 *
 * **Layout nằm ở core (`home/layout.ts`), không ở đây.** File này chỉ là lớp
 * mỏng gọi sang đó cộng với phần chỉ CLI mới cần (`node:fs`, quyền 0700). Trước
 * đây mỗi bề mặt tự ghép đường dẫn và hệ quả là extension ghi phiên vào
 * `globalStorageUri` còn CLI trỏ vào `~/.astra/sessions` — hai chỗ khác nhau,
 * không bên nào thấy phiên của bên kia.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmodSync, mkdirSync } from 'node:fs';
import {
  astraHome as resolveHome,
  astraLayout,
  projectDir,
  sessionHistoryDir,
  type AstraLayout,
} from '@astra/core';

/**
 * Hàm chứ không phải hằng số ở top level.
 *
 * Một `const` đọc `process.env` lúc nạp module thì đóng băng giá trị ở lần
 * import đầu tiên — không đổi được lúc chạy, và test không đặt được `ASTRA_HOME`
 * cho từng ca (đúng lỗi mà bộ test này bắt được lần chạy đầu). Tính lại mỗi lần
 * gọi rẻ hơn nhiều so với một biến toàn cục nói dối.
 */
export function astraHome(): string {
  return resolveHome({ homeDir: homedir(), override: process.env.ASTRA_HOME });
}

export function layout(): AstraLayout {
  return astraLayout(astraHome());
}

/** Cấu hình người dùng viết tay: địa chỉ gateway, model, mức log. */
export function settingsPath(): string {
  return layout().settings;
}

/** Ghi đè settings cho riêng máy này. Không chép sang máy khác. */
export function settingsLocalPath(): string {
  return layout().settingsLocal;
}

/** Bản cũ của settings.json. Chỉ còn dùng để migrate. */
export function legacyConfigPath(): string {
  return layout().legacyConfig;
}

/** JWT AstraWork. Tách khỏi settings, quyền 0600 — xem `ensureHome`. */
export function credentialsPath(): string {
  return layout().credentials;
}

/** Bản cũ của credentials.json: một file chứa JWT trần. */
export function legacyTokenPath(): string {
  return layout().legacyToken;
}

/**
 * Capability profile do `astracode measure` sinh ra.
 *
 * Đây là thứ thay cho `probe/models.json` cũ. Đặt ở HOME chứ không trong repo
 * vì nó mô tả MODEL, không mô tả dự án: đo một lần dùng cho mọi repo.
 */
export function modelsPath(): string {
  return layout().models;
}

/**
 * Bản policy tổ chức lấy được lần cuối (M9).
 *
 * Cache trên đĩa để mất mạng vẫn giữ nguyên mức siết — không rơi về mặc định
 * lỏng hơn. Xem IdePolicyClient bên core.
 */
export function policyPath(): string {
  return layout().policy;
}

/** Trạng thái do máy ghi: số lần khởi động, repo đụng lần cuối lúc nào. */
export function statePath(): string {
  return layout().state;
}

/** Lịch sử prompt, dùng chung mọi repo. */
export function historyLogPath(): string {
  return layout().historyLog;
}

/**
 * Thư mục phiên của MỘT dự án.
 *
 * Tách theo thư mục chứ không lọc theo trường trong file: liệt kê phiên của repo
 * này là đọc một thư mục, và trần "giữ 50 phiên" trở thành trần của từng repo
 * thay vì trần chung — trước đây làm nhiều ở repo này sẽ đẩy phiên của repo khác
 * ra khỏi đĩa.
 */
export function projectSessionsDir(workspaceRoot: string): string {
  return projectDir(layout(), workspaceRoot);
}

/** Thư mục bản chụp file của một phiên, để `/undo` sống qua restart. */
export function fileHistoryDir(sessionId: string): string {
  return sessionHistoryDir(layout(), sessionId);
}

/**
 * Những thư mục người dùng đã đồng ý cho nạp skill/command của repo.
 *
 * Ở HOME chứ không trong repo, và đó là toàn bộ ý nghĩa của nó: một file trong
 * repo không được tự tuyên bố rằng repo đó đáng tin. Đây là bản CLI của
 * `vscode.workspace.isTrusted`.
 */
export function trustPath(): string {
  return join(astraHome(), 'trust.json');
}

/**
 * Tạo `~/.astra/` nếu chưa có, và siết quyền về chỉ chủ sở hữu đọc được.
 *
 * `0700` là vì thư mục này chứa token. Trên Windows `chmod` gần như không có
 * tác dụng thật — ACL mới là thứ quyết định — nên đây là biện pháp đúng trên
 * POSIX và vô hại ở nơi khác. Lỗi được nuốt: không đặt được quyền thì vẫn chạy
 * tiếp, chứ không chặn người dùng khỏi công cụ của chính họ.
 */
export function ensureHome(): void {
  const dir = astraHome();
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* Windows / filesystem không hỗ trợ — bỏ qua. */
  }
}
