# AstraCode — quy ước cho Claude Code

Monorepo pnpm: `packages/core` (agent loop, security, telemetry), `packages/cli`,
`packages/vscode` (extension), `evals`, `sandbox`.

## Ngôn ngữ: hai lớp, đừng trộn

- **Chữ người dùng đọc trong VS Code viết bằng TIẾNG ANH.** Manifest, webview,
  bảng cài đặt, thông báo, tooltip, hộp duyệt quyền, tóm tắt kết quả tool, nhãn
  chế độ quyền — kể cả những chuỗi ấy nằm ở `packages/core` (`summarizeToolResult`,
  `describeMode`, `summarizeChanges`, `intent().summary` của từng tool).
- **Chữ của người viết code vẫn viết TIẾNG VIỆT**: comment, documents/, CHANGELOG,
  commit message, và tên `describe`/`it` trong test.

Hai thứ ở giữa vẫn là tiếng Việt vì chúng không phải UI: `packages/core/src/prompts/`
(đầu vào của model, đổi nó là đổi hành vi agent) và `packages/cli` (bề mặt riêng,
chưa dịch). Thêm chuỗi mới thì hỏi "người dùng có đọc dòng này trong IDE không?" —
có thì tiếng Anh, không thì tiếng Việt.

## Phát hành bản extension mới

Chỉ có MỘT nơi giữ số phiên bản: trường `version` trong `packages/vscode/package.json`.
Các package khác cố ý đứng yên ở `0.0.x` vì chúng không được phát hành riêng.

Khi được yêu cầu "nâng version" / "build lại" / "publish", làm đủ các bước sau:

1. **Bump `version`** trong `packages/vscode/package.json`.
2. **Thêm mục mới vào `packages/vscode/CHANGELOG.md`**, đặt trên cùng, ngay dưới
   `# Changelog`. Theo đúng dạng đang có: `## x.y.z`, một câu tóm tắt, rồi các nhóm
   `**Tiêu đề**` với gạch đầu dòng. Mỗi gạch đầu dòng nói *hệ quả với người dùng*, không
   phải tên hàm đã sửa.
3. **Chạy `pnpm -r typecheck` và `pnpm -r test`.** Cả hai phải xanh trước khi đóng gói.
4. **Đóng gói bằng `pnpm --filter astracode package`** (sinh `astracode.vsix`). Không tự
   chạy `vsce publish` — việc phát hành là của người dùng.

### Không bao giờ viết số phiên bản vào văn xuôi

`packages/vscode/README.md` là nội dung tab DETAILS trên Marketplace, được render nguyên
văn. `vsce package` không quét prose để thay số, nên một câu kiểu "Bản 0.0.12 — …" sẽ đứng
im qua mọi lần bump và mô tả sai bản đang cài. Chuyện phiên bản nào có gì thuộc về
CHANGELOG. README chỉ mô tả extension làm gì.

Cũng đừng để ghi chú trạng thái tạm ("chưa chạy được với…", "đang chờ endpoint…") trong
README: nó đọc như tuyên bố chính thức rằng extension không dùng được.

## Manifest của extension (`packages/vscode/package.json`)

- **Không đặt chú thích trong `contributes.configuration.properties`.** VS Code validate
  mọi entry ở đó như một JSON-schema object; chuỗi sẽ báo `must be an object` ở Runtime
  Status mà không làm vỡ build. Cần ghi chú thì đặt ở cấp cao nhất của package.json, theo
  quy ước khoá `"// tên"` đang dùng.
- **Không thêm ô cấu hình nào cho địa chỉ AstraWork.** Gateway và trang web là hằng số
  trong `packages/core/src/config/endpoints.ts` — không đọc từ settings.json, không đọc từ
  biến môi trường, không có cờ dòng lệnh. Hai lý do: bảng settings hiện nguyên văn ở tab
  Feature Contributions trên Marketplace (một ô địa chỉ ở đó là đăng hạ tầng lên trang công
  khai), và `.vscode/settings.json` nằm trong repo nên một ô địa chỉ là chỗ để người gửi PR
  trỏ máy người khác đi nơi khác. Đổi địa chỉ = sửa file đó rồi phát hành bản mới. Thêm
  endpoint mới cũng vào file ấy. Địa chỉ vẫn nằm trong bundle — ai tải `.vsix` về là `grep`
  ra; đây là bớt phơi bày chứ không phải giấu, và thứ bảo vệ gateway vẫn là xác thực ở phía
  nó.
- Lệnh đăng ký trong `extension.ts` phải có mặt trong `contributes.commands`, nếu không nó
  vô hình trong Command Palette mà không báo lỗi gì.

Ba điều trên đều có test canh ở `src/configuration.test.ts` và `src/commands.test.ts`. Sửa
manifest thì chạy `pnpm --filter astracode test`.

## Đường khởi động extension

- **Activation không được ném.** Lỗi trong khối async ở cuối `activate()` phải có `catch`;
  không thì nó thành unhandled rejection, VS Code chỉ ghi một dòng ở Runtime Status còn
  người dùng thấy một extension im lặng không hoạt động.
- **Không còn trạng thái "chưa cấu hình".** Địa chỉ là hằng số nên `gatewayBaseUrl` không
  bao giờ rỗng, và các cổng chặn dựng cho tình huống đó đã bị gỡ. Nhánh phòng thủ trong
  `AstraSession.rebuild()` vẫn ở lại: nếu hằng số bị xoá thì extension im lặng chứ không
  ném giữa lúc activate.
- Thứ tự trong `activate()` là có chủ ý: trần chính sách tổ chức áp **trước** khi sandbox
  và MCP dựng. Đừng đảo, và đừng để bước nào phía trước có thể ném và cắt cả chuỗi.

## Bảo mật

- Không commit `.env` (chỉ `.env.example`). Không đưa địa chỉ hạ tầng nội bộ vào file được
  phát hành ra Marketplace, kể cả trường `repository`/`homepage`.
- Mọi thứ ghi ra log đi qua redactor. Đừng thêm đường log nào bỏ qua nó.
- `git3.fsoft.com.vn` là remote nội bộ; đừng đưa URL đó vào package.json.

## Test

`pnpm -r test` chạy 5 project song song và một vài ca CLI có thể timeout 5s vì tải máy.
Gặp một ca fail dạng timeout thì chạy lại riêng package đó (`pnpm --filter @astra/cli test`)
để phân biệt flaky với lỗi thật, đừng vội kết luận là do thay đổi vừa làm.
