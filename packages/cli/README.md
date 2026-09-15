# astracode — CLI

AstraCode ngoài VS Code. Cùng agent loop, cùng gateway, cùng lớp quyền — chỉ
khác giao diện.

Chạy được là nhờ một ràng buộc có từ đầu: `packages/core` **không import
`vscode`** (eslint ép điều đó). Nhờ vậy CLI này gần như chỉ là lắp ráp.

## Cài

```bash
pnpm --filter @astra/cli build
npm link                     # trong packages/cli, để có lệnh `astracode`
```

Hoặc chạy thẳng không cài: `pnpm --filter @astra/cli dev -- <lệnh>`.

## Dùng

```bash
astracode login                 # địa chỉ AstraWork nằm sẵn trong bản build
astracode                       # mở phiên chat trong thư mục hiện tại
astracode --mode=plan           # phiên chỉ đọc
astracode -p "sửa hàm login"    # một lượt rồi thoát (script, CI)
echo "câu hỏi" | astracode      # tương tự, qua pipe

astracode models                # model nào dùng được, biết gì về chúng
astracode measure               # đo năng lực model → ~/.astra/models.json
                                # KHÔNG bắt buộc — xem "Đo model" bên dưới
astracode whoami / logout
```

Trong phiên chat: `/help`, `/model`, `/mode`, `/changes`, `/compact`, `/clear`, `/exit`.

## `/` và `@`

Ô nhập chạy raw mode, nên panel gợi ý lọc dần **theo từng ký tự**, trước khi
bạn nhấn Enter. `↑↓` chọn, `Tab`/`Enter` chèn, `Esc` đóng. Enter khi panel đang
mở là *chọn*, không phải *gửi* — muốn gửi thì Enter lần nữa.

**`/`** gộp ba nguồn vào một danh sách, ưu tiên **builtin > command > skill**:

| Nguồn | Ở đâu |
|---|---|
| Builtin | `/help`, `/model`, `/mode`, `/changes`, `/compact`, `/clear`, `/exit` |
| Command | `.claude/commands/**.md`, `.astra/commands/**.md` (repo và `~`) |
| Skill | `.claude/skills/*/SKILL.md`, `.astra/skills/*/SKILL.md` (repo và `~`) |

Thư mục con thành namespace: `commands/speckit/plan.md` → `/speckit:plan`. Tên
giữ nguyên dấu chấm, nên `speckit.plan.md` là `/speckit.plan`. Gõ sai tên thì
CLI gợi ý tên gần đúng thay vì chỉ báo không có.

Frontmatter được đọc: `name`, `description`, `argument-hint`, `triggers`,
`user-invocable`, `disable-model-invocation`. `$ARGUMENTS` và `$1`…`$9` trong
thân được thay bằng phần bạn gõ sau tên lệnh.

**`@`** mở danh sách file + thư mục của workspace (đã lọc `.astraignore`,
denylist và `node_modules`/`.git`). Chọn thư mục thì panel mở tiếp vào trong.
Lúc gửi, nội dung file được đính xuống cuối tin nhắn trong khối
`<file untrusted="true">`, tối đa 10 file mỗi lượt.

`@` **không hỏi duyệt** — bạn tự gõ tên file thì hỏi lại chỉ dạy người ta bấm y
theo phản xạ. Nhưng nó vẫn đi qua `pathGuard` và `denylist`: `@../../.ssh/id_rsa`
bị chặn, và `.env` cũng vậy.

### Tin cậy thư mục

Skill/command **của repo** là prompt chạy với quyền của phiên, nên lần đầu chạy
`astracode` trong một thư mục có `.claude/` hoặc `.astra/`, CLI hỏi một lần rồi
ghi nhớ vào `~/.astra/trust.json`. Chưa đồng ý thì chỉ nguồn ở `~` được nạp.
Đây là bản CLI của `workspace trust` trong VS Code. Rút lại: xoá file đó.

### spec-kit

`specify init --integration claude` cài **skill** vào `.claude/skills/speckit-*/`,
nên lệnh là `/speckit-plan` (gạch ngang), không phải `/speckit.plan` — bản
spec-kit đời trước sinh command với dấu chấm, cả hai dạng đều chạy được ở đây.

## Đăng nhập

Đường chính là SSO. CLI không nhận được deep-link `vscode://` nên nó nhận **mã
một lần** dán vào — cùng cái mã mà trang `/ide-auth` chuyển tiếp, dùng một lần
và hết hạn sau 90 giây.

Nhanh hơn nếu đang mở VS Code: lệnh **"AstraCode: Sao chép token AstraWork"**
rồi `astracode login --token <dán>`.

Không có đăng nhập bằng mật khẩu cho tài khoản thường — gateway chỉ cho admin
dùng đường đó, vì mật khẩu cục bộ không đi qua MFA của tenant.

## `~/.astra/` — dùng chung với extension

| File | Là gì |
|---|---|
| `settings.json` | model, chế độ quyền, mức log (KHÔNG có địa chỉ — xem dưới) |
| `token` | JWT, quyền 0600 |
| `models.json` | capability profile do `astracode measure` sinh ra — **không bắt buộc** |

`models.json` dùng chung có chủ ý: đo một lần, extension thấy ngay ở lần reload
kế tiếp. Nó mô tả MODEL chứ không mô tả dự án, nên để ở HOME chứ không trong repo.

Địa chỉ AstraWork KHÔNG nằm trong `~/.astra`. Nó là hằng số trong bản build
(`packages/core/src/config/endpoints.ts`), giống hệt extension — không có khoá
cấu hình, không có biến môi trường, không có cờ dòng lệnh. Trỏ CLI sang một
gateway khác nghĩa là sửa file đó rồi build lại.

## Đo model

**Không cần đo để bắt đầu dùng.** Model chưa có profile chạy bằng năng lực giả
định — native tool-calling, đọc được ảnh, cửa sổ ngữ cảnh lấy từ `GET /models`
của gateway. Nếu giả định đó sai, lượt đầu tiên sẽ vấp và AstraCode tự chuyển
sang đường XML rồi nhớ lại; bạn thấy một dòng thông báo, và hết.

Lý do bỏ bước đo bắt buộc: kết quả đo là thuộc tính của **model**, không phải
của máy. Bắt mỗi người tự đo là tìm lại cùng một đáp án bằng token của từng
người — trong khi tổ chức đã biết đáp án đó từ lúc thêm model vào gateway.

Chạy `astracode measure` khi:

- bạn là **người thêm model vào gateway** — đo một lần rồi chép kết quả vào
  `BUNDLED_MODELS_FILE` (`packages/core/src/registry/ModelRegistry.ts`) để nó đi
  kèm bản cài, và không ai khác phải đo nữa;
- cần biết **mức kháng prompt injection** trước khi giao vai `editor` (quyền ghi
  file) — đây là thứ duy nhất không dò được lúc chạy, nên chưa đo thì nó ở mức
  `unknown` chứ không phải `low`.

Profile của bạn ở `~/.astra/models.json` **chồng lên** bản ship sẵn theo từng
model, không thay cả file: đo lại một model không xoá hiểu biết về các model khác.

Đây cũng là thứ tắt banner *"Chưa đo năng lực của … nên đang dùng đường XML"*.
Không có file này thì mọi model rơi về mặc định an toàn: `toolCalling: none`
(đường XML) và `injectionResistance: low`.

## Quyền

Mặc định `ask`, giống extension. CLI **không** phải lý do để nới quyền — agent
chạy trong terminal đụng đúng những file mà bản trong VS Code đụng.

Ở chế độ một lượt (`-p`, pipe) mọi thứ cần hỏi đều bị **từ chối**: tự duyệt khi
không có ai ngồi xem là bỏ hẳn cổng quyền đúng vào lúc nó cần nhất. Muốn agent
sửa file thì chạy phiên tương tác.

## Kiểm thử

Ba mức, chọn theo thứ bạn đang nghi ngờ.

### 1. Test tự động — không cần mạng

```powershell
pnpm --filter @astra/cli test          # 13 test
```

Chỉ phủ phần logic thuần: ai được giao vai `editor`, token lấy từ đâu, khi nào
chạy một lượt, config hỏng có làm chết lệnh không. **Không** phủ đường mạng —
đó là việc của mức 2 và 3.

### 2. Chạy tay, không cần gateway

```powershell
$env:ASTRA_HOME = "$env:TEMP\astra-thu"   # đừng giẫm lên ~/.astra thật
pnpm --filter @astra/cli dev -- help
pnpm --filter @astra/cli dev -- whoami     # phải nói "chưa đăng nhập"
```

`ASTRA_HOME` là thứ khiến việc thử nghiệm an toàn: token, config và
`models.json` đều đi theo biến này, nên thử xong xoá thư mục là sạch, không ảnh
hưởng phiên đăng nhập thật hay bản đo model đã có.

**Lưu ý về `pnpm dev`:** nó chạy với thư mục hiện tại là `packages/cli`, mà CLI
lấy `process.cwd()` làm gốc workspace. Muốn thử agent trên một repo khác thì
phải build rồi gọi `dist/main.js` (hoặc `npm link`), xem mức 3.

### 3. Chạy đủ đường, không cần tài khoản FPT

Đường đi thật là CLI → gateway `/v1/chat/completions` → model. Thiếu credential
FPT thì thay khúc cuối bằng **stub**: một endpoint OpenAI-compatible dựng sẵn ở
`AstraWork/scripts/stub_model_server.py`. Nó echo lại đúng những gì nhận được
(để biết passthrough có giữ `tools`, `seed` không) và stream một `tool_call`
**cắt ngang giữa arguments** như vLLM thật — ca hay làm vỡ phần ghép frame.

Ba cửa sổ:

```powershell
# 1 — stub model
cd <AstraWork>; .\backend\gateway\.venv\Scripts\python.exe scripts\stub_model_server.py

# 2 — gateway, trỏ vào stub
#     .env cần: MODELS=[{"name":"stub-model","base_url":"http://localhost:8000/v1",
#                        "api_key":"not-needed-for-selfhosted","context_limit":128000,
#                        "allowed_roles":["developer","tl","pm","bul","admin"]}]
cd <AstraWork>; .\scripts\run-gateway.ps1

# 3 — CLI
#     Địa chỉ gateway là hằng số trong build, nên trỏ vào gateway local là SỬA
#     packages/core/src/config/endpoints.ts (GATEWAY_BASE_URL =
#     'http://127.0.0.1:8080') rồi build lại. Nhớ hoàn nguyên trước khi commit.
pnpm --filter @astra/core build; pnpm --filter @astra/cli build
$env:ASTRA_HOME = "$env:TEMP\astra-thu"
$t = (Invoke-RestMethod http://127.0.0.1:8080/auth/login -Method Post `
        -ContentType application/json `
        -Body '{"username":"admin","password":"adminpass"}').access_token
node <AstraCode>\packages\cli\dist\main.js login --token $t
node <AstraCode>\packages\cli\dist\main.js models
cd <một repo bất kỳ>
node <AstraCode>\packages\cli\dist\main.js -p "đọc file app.ts"
```

`admin/adminpass` là tài khoản seed của gateway khi bảng `users` còn rỗng
(`db/users.py: ensure_seed_admin`) — chỉ tồn tại ở DB local.

**Đọc kết quả thế nào.** Stub trả về nội dung là chính body nó nhận, nên dòng in
ra cho biết passthrough giữ được gì:

```
{"model": "stub-model", "n_messages": 2, "tools": [], "tool_choice": null, "seed": null}
  · read_file src/app.ts
  ✓ read_file 4ms
```

- `tools: [...]` có tên tool nghĩa là đang đi đường native — mặc định cho mọi
  model, kể cả chưa đo. Nếu stub từ chối `tools`, bạn sẽ thấy một dòng cảnh báo
  và mảng đó biến mất ở request kế: AstraCode vừa tự phát hiện endpoint không
  hỗ trợ và chuyển sang đường XML, nơi tool nằm trong prompt.
- `· read_file` xuất hiện nghĩa là tool call đã qua gateway, được ghép lại từ
  hai frame và chạy thật.
- Stub trả **cùng một tool call mãi**, nên phiên sẽ chạm trần số vòng lặp và
  dừng. Đó là giới hạn của stub, không phải lỗi agent.

### Kiểm tra trần cấu hình của tổ chức

```powershell
$h = @{ Authorization = "Bearer $t" }
Invoke-RestMethod http://127.0.0.1:8080/ide/policy -Headers $h
Invoke-RestMethod http://127.0.0.1:8080/ide/policy -Headers $h -Method Put `
  -ContentType application/json -Body '{"min_permission_mode":"plan"}'
node <AstraCode>\packages\cli\dist\main.js --mode=acceptEdits
```

Phải thấy CLI **hạ xuống** `plan` chứ không phải nghe theo cờ:

```
  model: stub-model   quyền: plan   tool-calling: none
  ⚑ Tổ chức yêu cầu tối thiểu "plan". (bạn chọn "acceptEdits", đang chạy "plan")
```

Rồi tắt gateway và chạy lại: vẫn phải ra `plan`, lấy từ
`$ASTRA_HOME\policy.json`. **Mất mạng không được là cách nới quyền** — nếu chạy
lại mà thành `acceptEdits` thì đó là lỗi thật, báo ngay.

## Chưa có ở bản này

- Sandbox / tool `bash` (extension có; CLI chưa nối)
- MCP, subagent (`task`), hooks
- Lưu và mở lại phiên (`/resume`)
- Ảnh đính kèm
- `/undo` (extension có)
