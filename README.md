# AstraCode

Coding agent cho VS Code, chạy trên model FPT Cloud qua gateway [AstraWork](../AstraCowork/AstraWork).

**Trạng thái: MVP xong.** 1264 test xanh. Chat, sửa file có duyệt quyền, chạy lệnh trong sandbox Docker, bộ nhớ `ASTRA.md`, nén ngữ cảnh, `/undo`, server MCP nạp từ catalog, skill, agent con, hooks, và CodeGraph (`find_references` / `impact_of`). Chưa chạy với model thật (chờ gateway deploy) và chưa chạy server MCP thật (cần Docker + digest thật).

## Cài extension để test

```powershell
pnpm install
pnpm package                                        # -> packages/vscode/astracode.vsix (~160 KB)
code --install-extension packages/vscode/astracode.vsix --force
```

Rồi mở lại VS Code → biểu tượng **AstraCode** ở activity bar.

Gỡ ra: `code --uninstall-extension astracode.astracode`

## Hoặc chạy trong Extension Host

Nhấn **F5** (cấu hình sẵn ở [.vscode/launch.json](.vscode/launch.json)) — nhanh hơn khi đang sửa code, có debugger. Kèm `pnpm --filter astracode watch` để esbuild tự build lại.

Có hai panel:

**Chat** — hỏi về codebase. Agent tự dùng `grep`/`glob`/`read_file`/`list_dir` để tìm câu trả lời.
- Stream từng chữ, nút **Dừng** hủy giữa chừng
- Mỗi lời gọi công cụ là một khối thu gọn được: tên, tham số, kết quả
- `@` để chèn đường dẫn file; tick **Kèm vùng đang chọn** để gửi đoạn code đang bôi đen
- Cảnh báo ngay trong luồng hội thoại khi nội dung file có dấu hiệu prompt injection
- Model không có native tool calling tự chuyển sang đường XML, có báo trên banner

**Cài đặt** — kết nối và model.
- Nguồn model: **Gateway AstraWork** (chuẩn) hoặc **FPT trực tiếp** (tạm, có cảnh báo thường trực)
- Nhập endpoint, kiểm tra kết nối
- Đăng nhập AstraWork, hoặc nhập FPT API key — cả hai lưu trong SecretStorage
- Chọn model cho từng vai trò editor / planner / fast, kèm bảng năng lực từng model

- Kiến trúc và bản đồ code: [documents/Architecture.md](documents/Architecture.md)
- Đường đi tiếp theo: [documents/ROADMAP.md](documents/ROADMAP.md)
- Sổ nợ kỹ thuật: [documents/OPEN-ISSUES.md](documents/OPEN-ISSUES.md)
- Threat model + checklist bảo mật: [documents/SECURITY.md](documents/SECURITY.md)
- Test plan thủ công: [documents/TEST_PLAN.md](documents/TEST_PLAN.md)
- Quyết định kiến trúc: [documents/adr/](documents/adr/README.md)
- Sandbox Docker cho bash và MCP: [sandbox/README.md](sandbox/README.md)

## Bắt đầu

```powershell
pnpm install
cp .env.example .env    # rồi điền
pnpm test               # 1239 test, không gọi mạng
```

## Cấu trúc

| Thư mục | Nội dung |
|---|---|
| `packages/core/` | Lõi agent. **Không import `vscode`** |
| `packages/vscode/` | Extension host + webview |
| `packages/cli/` | `astracode` — cùng agent loop, chạy trong terminal. Có panel gợi ý `/` và `@` |
| `sandbox/` | Docker compose cho bash và MCP |
| `packages/core/src/mcp/` | Client MCP, catalog, cổng workspace trust |
| `packages/core/src/skills/` | Skill, agent con |
| `packages/core/src/hooks/` | Hooks quanh lời gọi tool |
| `packages/core/src/graph/` | CodeGraph — symbol table + dependency graph (tree-sitter) |
| `evals/` | Eval harness — 16 task, 8 trong đó là task bảo mật |
| `documents/` | Kiến trúc, flow kỹ thuật, threat model, roadmap, ADR |

## Lệnh

```powershell
pnpm test          # vitest, toàn workspace
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint, gồm rule chặn 'vscode' và 'node:fs' trong core
pnpm build         # biên dịch core + bundle extension (có sourcemap)
pnpm package       # bundle minify + đóng gói astracode.vsix
pnpm eval:list     # xem 16 task eval
pnpm eval -- --model <id>   # chạy eval (cần model thật)

# M1 — demo lớp provider ngoài VS Code (cần ASTRAWORK_BASE_URL + token)
pnpm demo

# CLI — AstraCode trong terminal. Chi tiết: packages/cli/README.md
pnpm --filter @astra/cli dev -- login --gateway https://api.astrawork.example
pnpm --filter @astra/cli dev -- models     # model nào dùng được
pnpm --filter @astra/cli dev -- measure    # đo năng lực → ~/.astra/models.json
pnpm --filter @astra/cli dev               # mở phiên chat
pnpm --filter @astra/cli dev -- -p "câu hỏi"   # một lượt rồi thoát

# Extension
pnpm --filter astracode watch      # esbuild theo dõi thay đổi khi đang F5
```

## Server MCP (M7)

Tắt mặc định. Bật bằng `astra.mcp = on`, rồi `AstraCode: Quản lý server MCP` để duyệt từng server — hộp duyệt hiện image, digest, mount, profile mạng và danh sách tool nó cung cấp.

Ba ranh giới không được vượt:

- **Workspace chưa tin cậy → không MCP nào chạy**, và `.astra/mcp.json` của repo thậm chí không được đọc. Lúc đó extension cũng chỉ đọc: không sửa file, không chạy lệnh.
- **Repo chỉ được BẬT server có trong [catalog](sandbox/mcp/servers.json)**, không được khai báo image hay lệnh tùy ý. Server tùy chỉnh chỉ khai báo được ở `~/.astra/mcp.json`.
- **Image phải pin bằng digest sha256.** Catalog trong repo còn để chỗ giữ chỗ, nên hiện chưa server nào chạy được — điền digest thật vào `servers.json` trước.

Mô tả tool của server MCP được quét prompt injection; cái nào khả nghi thì mô tả bị ẩn khỏi model và chỉ hiện nguyên văn cho bạn đọc trên UI.

## Skill, agent con và hooks (M8)

**Skill** — hướng dẫn model tự nạp khi cần. Đặt ở `.astra/skills/<tên>/SKILL.md` (hoặc `~/.astra/skills/`), có frontmatter `name`, `description`, `triggers`. Gõ `/create-skill` để sinh khung.

- System prompt chỉ chứa **tên + mô tả**; thân về qua tool `load_skill` — nên 20 skill tốn khoảng 300 token chứ không phải 30 nghìn
- `triggers: [pdf, form]` lọc trước bằng từ khoá, tất định, không nhờ model
- Gõ `/tên-skill` để nạp thẳng, không qua phán đoán của model
- Đọc được cả `.claude/skills/` và `.claude/commands/` — skill và command viết
  cho Claude Code chạy được không sửa gì, kể cả `$ARGUMENTS`, `argument-hint`,
  `user-invocable` và `disable-model-invocation`
- spec-kit chạy thẳng: `specify init --integration claude` rồi gõ `/speckit-plan`

**Agent con** — khi người dùng yêu cầu rõ `delegate`, dùng subagent hoặc gọi đích danh một agent, tool `task` mới được đưa vào lượt để giao việc tra cứu nhiều bước trong ngữ cảnh riêng rồi nhận về bản tóm tắt. Yêu cầu sửa code thông thường ở lại agent chính. Agent con **chỉ đọc được**: không sửa file, không chạy lệnh, không gọi tiếp agent con. `/create-agent` sinh khung ở `.astra/agents/`.

**Hooks** — `.astra/hooks.json` chạy script quanh mỗi lời gọi tool. `preToolUse` thoát khác 0 thì **chặn tool** và output của nó thành lý do gửi lại cho model.

```jsonc
{
  "preToolUse": [
    { "match": "write_file|edit_file", "command": "node", "args": ["scripts/guard.js"] }
  ]
}
```

Hook nguy hiểm hơn mọi thứ khác trong AstraCode nên có ba rào: workspace phải được tin cậy, người dùng duyệt **nội dung lệnh** (sửa lệnh là duyệt lại — duyệt ghi theo vân tay của `command + args + match + event`), và hook nhận ngữ cảnh qua **biến môi trường** chứ không qua dòng lệnh. `AstraCode: Quên mọi hook đã duyệt` rút lại toàn bộ.

## Quan hệ với AstraWork

AstraCode là **client thứ hai** của gateway AstraWork, chia vai như sau: AstraCode là *thân thể* (chạy trên máy bạn — file, lệnh, vòng lặp agent, sandbox), AstraWork là *trục* (danh tính, chính sách, đường ra model, sổ sách).

Ba tầng, làm dần:

| Tầng | Nội dung | Trạng thái |
|---|---|---|
| 1 | Đường model đi qua gateway, dùng lại nguyên chuỗi guard của AstraWork | Code xong hai phía, chờ deploy |
| 2 | Chính sách tổ chức chảy xuống extension (trần cấu hình, dev chỉ siết thêm) | Xong |
| 3 | Dữ liệu AstraCode chảy ngược lên AstraWork (telemetry, sổ thay đổi, phiên) | Số đo OTLP xong; sổ thay đổi và đồng bộ phiên chờ [ADR-014](documents/adr/README.md) |

Sau khi gateway lên, cái dùng chung là: login, danh sách model + RBAC, đường ra model, hạn mức, audit. Cái ở lại máy bạn là: vòng lặp agent, prompt, tool, quyền hạn, lịch sử hội thoại, sandbox, ChangeLedger, MCP. Chi tiết ở [ranh giới dữ liệu trong SECURITY.md §9](documents/SECURITY.md).

**Chế độ "FPT trực tiếp" đã gỡ ở v0.0.11.** Nó bỏ qua RBAC, audit, redaction và hạn mức, bắt mỗi dev giữ FPT key trên máy, và sự tồn tại của nó biến "chưa đăng nhập" thành một trạng thái vẫn chat được. Không có đường thay thế — xem [ADR-011](documents/adr/ADR-011-model-route.md).

## Hai ràng buộc không được vi phạm

**`packages/core` không import `vscode`.** Toàn bộ lõi phải test được bằng vitest thuần Node. Eslint ép điều này — thử import sẽ báo lỗi ngay.

**AstraCode không gọi thẳng FPT.** Mọi lượt đi qua gateway AstraWork để có RBAC, audit, redaction và budget. Gateway chết thì báo lỗi rõ ràng, không âm thầm đổi đích. Xem [ADR-011](documents/adr/ADR-011-model-route.md).

## Đang chặn

**Chỉ còn deploy.** Route passthrough đã implement xong ở repo AstraWork ngày 2026-08-12 — profile bảo mật cho IDE, 18 test mới, toàn bộ suite 493/493 xanh, và đã kiểm chứng end-to-end trên gateway chạy thật (`404 → 200`, SSE giữ nguyên `delta.tool_calls`, audit ghi đủ mỗi lượt). Nhưng gateway vẫn đang chạy bản cũ, nên extension vẫn báo `404 status code (no body)` cho tới khi bản mới lên.

Triệu chứng cũ, để đối chiếu khi deploy xong:

```
GET  /models              -> 401   (có, chỉ thiếu token)
POST /chat                -> 401   (có)
POST /chat/stream         -> 401   (có)
POST /v1/chat/completions -> 404   ← đã build, chờ deploy
```

`/chat` và `/chat/stream` **không thay thế được**: chúng nhận `message: str` chứ không phải `messages[]`, không có role `tool` để trả kết quả tool về, và tự chạy vòng AutoGen Developer/QA của server.

Phần đáng chú ý nhất không phải cái route, mà là **`SecurityProfile: ide-agent`**. Chuỗi guard của AstraWork được chỉnh cho nhịp người gõ chat; đo trên classifier thật thì `remove the auth middleware from the test config` bị chặn là `security_tamper`, và với ngưỡng khoá mặc định bằng 1 thì câu đó **khoá tài khoản dev 30 phút**. Đối ứng là cùng bộ rule, thêm qualifier "hệ thống của ai" — không tắt category nào. Xem [ADR-013](documents/adr/ADR-013-guard-on-code-path.md).
