# ASTRACODE_INTEGRATION_MEMO

Recon cho việc nối **AstraQA → AstraCode**. Không sửa gì trong repo này.
Ngày khảo sát: 2026-09-15, nhánh `feature/agentloop`, `packages/vscode` version `0.0.44`.

---

## Kết luận 1 dòng

**KHÔNG có HTTP API. Nối bằng CLI một lượt (`astracode -p "..."`, in ra stdout dạng text)
— và phải bọc thêm một lớp mỏng ở phía AstraQA để có report file có cấu trúc, vì AstraCode
không tự sinh artifact nào cho bên thứ ba đọc.**

Có ba mức để chọn, xếp theo công sức:

| Mức | Cách nối | LLM | Auth gateway | Kết quả |
|---|---|---|---|---|
| A | spawn CLI `-p` mỗi ticket, đọc stdout | có | **cần** | text tự do (markdown) |
| B | import `@astra/core`, gọi `AgentLoop.run()` | có | **cần** | `AgentRunResult` (object JS) |
| C | import `@astra/core`, gọi `GraphBuilder.build()` | **không** | **không** | `GraphSnapshot` (JSON, có `file`+`line`) |

Mức C là thứ duy nhất trả ra **JSON có sẵn schema và có `path:line`** mà không cần model,
không cần đăng nhập — nhưng nó chỉ là symbol table, không phán được "ticket đã xong chưa".
Mức A/B mới là "phân tích" theo nghĩa hiểu ngữ nghĩa.
Với deadline 2 ngày: **C để lấy evidence path:line chắc chắn, A để lấy nhận định.**

---

## Cách gọi

### Mức A — CLI một lượt (chạy được ngay, `dist/` đã build sẵn trong repo)

```powershell
# 1. Đăng nhập một lần (JWT của AstraWork; lấy nhanh trong VS Code bằng lệnh
#    "AstraCode: Sao chép token AstraWork")
node C:\A\FPT\Astra\astracode\packages\cli\dist\main.js login --token <JWT>

# 2. cwd CHÍNH LÀ workspace root của agent → phải cd vào repo cần phân tích
cd C:\duong\dan\repo-can-phan-tich
node C:\A\FPT\Astra\astracode\packages\cli\dist\main.js --mode=plan --raw -p "PROJ-123: yeu cau la <mo ta tu Jira>. Kiem tra code da implement chua. Voi moi ket luan, trich dan duong dan file va so dong."

# hoặc qua pipe
echo "cau hoi" | node C:\A\FPT\Astra\astracode\packages\cli\dist\main.js --mode=plan --raw
```

Cờ có thật (`packages/cli/src/main.ts`, `packages/cli/src/chat.ts`):

- `-p "..."` / `--print "..."` / `-p=...` / stdin bị pipe → chế độ một lượt rồi thoát.
- `--mode=plan` | `ask` | `acceptEdits` — `plan` = chỉ đọc, đúng cho AstraQA.
- `--raw` — tắt tô markdown/ANSI, **bắt buộc** khi parse stdout bằng máy.
- `login --token <JWT>` | `login --code <MÃ>`, `logout`, `whoami`, `models`, `measure`, `help`.
- Biến môi trường `ASTRA_HOME` đổi được vị trí `~/.astra` (mỗi job CI một home riêng).

Nếu cần build lại: `pnpm --filter @astra/core build; pnpm --filter @astra/cli build`.
**Đừng dùng `pnpm --filter @astra/cli dev`** để chạy trên repo khác — nó chạy với
cwd = `packages/cli`, nên agent sẽ soi nhầm chính AstraCode.

### Mức B/C — gọi thư viện từ Node của AstraQA

`@astra/core` là package **private** trong workspace pnpm (`packages/core`,
`main: ./dist/index.js`), không publish lên registry. AstraQA phải link `file:` tới thư mục
đó hoặc copy `dist/`.

```ts
// Mức C — index repo, KHÔNG cần model, KHÔNG cần token, KHÔNG cần mạng
import {
  GraphBuilder, TreeSitterParser, NodeFileSystem, createToolContext, Logger, MemorySink,
} from '@astra/core';

const logger = new Logger({ sink: new MemorySink() });
const ctx = createToolContext({
  workspaceRoot: '/duong/dan/repo', logger, fs: new NodeFileSystem(),
});
const graph = await new GraphBuilder({
  workspaceRoot: ctx.workspaceRoot, fs: ctx.fs, pathGuard: ctx.pathGuard,
  denylist: ctx.denylist, logger: ctx.logger, parser: new TreeSitterParser({ logger }),
}).build();
const snapshot = graph.toSnapshot(1);   // ← JSON, xem mục "Đầu ra"
```

Mức B ghép thêm `GatewayProvider` + `createRegistry` + `createToolContext` + `AgentLoop`;
khuôn lắp ráp đầy đủ nằm ở `packages/cli/src/chat.ts` (997 dòng — chép phần dựng, bỏ phần
UI terminal).

---

## Đầu vào

- **Repo truyền vào bằng `process.cwd()`** — không có cờ `--repo`, `--path`, `--url`.
  Repo **phải đã clone sẵn trên đĩa**; AstraCode không clone, không fetch, không đụng git.
  Mức B/C thì repo là tham số `workspaceRoot` của `createToolContext`/`GraphBuilder`.
- **Chỉ nhận MỘT chuỗi prompt.** Không có tham số nhận danh sách ticket, không có file
  input, không có query DSL. Muốn chạy 50 ticket = gọi 50 lượt, AstraQA tự lặp.
- Agent tự quyết quét cái gì: nó có `list_dir`, `glob`, `grep`, `read_file`,
  `find_references`, `impact_of`. Không có chế độ "quét toàn repo" kiểu scanner — nó là
  agent, đi theo prompt.
- Chặn cứng bởi `pathGuard` + `denylist` + `.astraignore` của repo đích: không ra ngoài
  workspace, không đọc `.env`, không đọc thư mục bị ignore.
- Không nhận ảnh ở chế độ một lượt; `@file` mention chỉ có trong phiên tương tác.

---

## Đầu ra

### Mức A — stdout, KHÔNG có file report

Một lượt `-p` chỉ **in text ra stdout** (câu trả lời cuối của model, xen dòng tiến trình
kiểu `· read_file src/app.ts` / `✓ read_file 4ms`). **Không có `--json`, không có
`--output`, không ghi file report nào.** `process.exitCode` = 1 nếu lượt lỗi, 2 nếu prompt
rỗng hoặc không có TTY.

`AgentLoop` trả về (mức B lấy được trực tiếp, mức A **không** lấy được):

```ts
// packages/core/src/agent/AgentLoop.ts:345
interface AgentRunResult {
  text: string;                 // câu trả lời cuối
  messages: ChatMessage[];
  iterations: number;
  toolCalls: number;
  stoppedBy: 'answer' | 'iteration_limit' | 'aborted' | 'error';
  error?: { code: string; message: string };
  injectionWarnings: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}
```

### Mức C — file JSON thật, tự ghi ra đĩa

Phiên CLI **tự ghi mỗi lượt**: `~/.astra/graph/<slug>/snapshot.json`
(`slug` = đường dẫn repo đã chuẩn hoá + hash 32-bit, xem `projectSlug()`; `~` đổi được bằng
`ASTRA_HOME`).

Schema (`packages/core/src/graph/types.ts:47`, `GRAPH_SCHEMA_VERSION = 1`, ghi bằng
`JSON.stringify` không xuống dòng):

```json
{
  "schemaVersion": 1,
  "fileHashes": { "src/app.ts": "9f2b…sha256 nội dung lúc index" },
  "files": {
    "src/app.ts": { "imports": ["src/db.ts"], "importedBy": ["src/server.ts"] }
  },
  "definitions": {
    "createUser": [
      { "file": "src/user.ts", "line": 42, "column": 9, "name": "createUser", "kind": "function" }
    ]
  },
  "references": {
    "createUser": [
      { "file": "src/api/signup.ts", "line": 17, "column": 4, "name": "createUser" }
    ]
  },
  "truncated": false
}
```

- `file` luôn **tương đối workspace**, dùng `/`. `line` **1-based**, khớp cách `grep` và
  `read_file` báo số dòng. `column` 0-based.
- `kind` ∈ `function | class | method | variable | interface | type`.
- `truncated: true` = repo vượt trần `DEFAULT_MAX_GRAPH_FILES = 8000` file → graph thiếu.
- Ngôn ngữ parse được: **TypeScript/TSX, JavaScript, Python, Go** (chỉ có 4 grammar wasm).

*(Mẫu trên dựng theo đúng type trong code — máy này chưa từng chạy AstraCode nên `~/.astra`
chưa tồn tại, không có file thật để dán.)*

### Các file khác AstraCode ghi ra (không phải report, nhưng đọc được)

| Đường dẫn | Nội dung |
|---|---|
| `~/.astra/projects/<slug>/` | phiên chat đã lưu (`SessionStore`, `PersistedTurn`) |
| `~/.astra/history.jsonl` | mọi prompt đã gõ, mỗi dòng một JSON |
| `~/.astra/file-history/<sessionId>/` | bản chụp file trước mỗi lượt (cho `/undo`) |
| `~/.astra/{models,policy,state,credentials}.json` | cấu hình + máy tự ghi |
| `evals/results/<ngày>-<model>.json` | báo cáo của eval harness — **không liên quan repo đích** |

---

## Thiếu gì so với nhu cầu của tôi

**1. Có trả được evidence `path:line` không? → CÓ, nhưng phải tự rút.**

- Mức C cho `path:line` **có cấu trúc, tin cậy tuyệt đối** (`definitions` / `references`)
  — nhưng chỉ ở mức symbol, không biết ticket đã xong hay chưa.
- Mức A/B: model *có* dữ liệu để trích dẫn — `grep` trả số dòng, `read_file` đánh số dòng,
  `find_references` trả `Định nghĩa: src/user.ts:42` kèm danh sách `src/api/signup.ts:17`,
  `impact_of` trả danh sách file bị ảnh hưởng. Nhưng tất cả nằm trong **văn xuôi**. Muốn
  chắc thì prompt phải ép định dạng, rồi AstraQA regex `([\w./-]+):(\d+)` và **đối chiếu
  ngược với `snapshot.json`** để loại trích dẫn bịa.

**2. Có nhận danh sách ticket không? → KHÔNG.** Một lượt = một chuỗi prompt. Vòng lặp theo
ticket, ghép prompt từ Excel Jira, gom kết quả — toàn bộ là việc của AstraQA.

**3. Có tự ghi report file không? → KHÔNG ở `--mode=plan`.**
Ở `plan`, `PermissionManager.check()` trả `allowed: false` cho mọi tool không `readOnly`, và
`createRegistry({ canWrite: false })` thậm chí không đăng ký `write_file`/`edit_file`. Ở chế
độ một lượt, `nonInteractiveAsker()` **từ chối** mọi thứ cần hỏi → `--mode=ask` cũng vô dụng.
Đường duy nhất để agent tự ghi file: `--mode=acceptEdits` **và** thư mục đã nằm trong
`~/.astra/trust.json` (không tương tác thì `workspaceTrusted = isTrusted(root)`, không hỏi
được nên không tự thêm được) — tức phải chạy tay một phiên tương tác trong repo đó **một lần**
để bấm đồng ý. Cách này đồng thời cho agent quyền ghi đè file trong repo đích;
**đừng dùng cho một job QA chỉ cần đọc.**

**4. Không có HTTP API, không có MCP server.** `packages/core/src/mcp/` là **client**
(AstraCode gọi MCP server khác), không phải server — và CLI còn chưa nối MCP/sandbox/hooks/
subagent. Không có cách nào gọi AstraCode qua mạng.

**5. Không có tool `bash`/`git` ở CLI.** README ghi rõ "Sandbox / tool `bash`: extension có;
CLI chưa nối". Agent **không đọc được `git log`/`git diff`** để biết ticket được code ở commit
nào. Cần liên kết ticket ↔ commit thì AstraQA phải tự chạy git.

### Ước lượng phần phải bọc (viết ở phía AstraQA, không sửa AstraCode)

| Việc | Dòng |
|---|---:|
| Đọc Excel Jira → `{key, summary, status, acceptance}` | 40–60 |
| Sinh prompt mỗi ticket + ép định dạng trả lời (`VERDICT: DONE/PARTIAL/MISSING` + `EVIDENCE: path:line`) | 30–50 |
| `spawn` CLI `-p --raw --mode=plan` mỗi ticket: timeout, exit code, chạy song song có giới hạn | 60–90 |
| Parse stdout → object; regex path:line; verify path tồn tại + đối chiếu `snapshot.json` | 60–90 |
| Gộp + đối chiếu trạng thái Jira → report "Jira Done nhưng code chưa xong" | 50–80 |
| **Tổng** | **≈ 240–370 dòng** |

Bỏ mức A, chỉ dùng mức C (graph, không LLM): **≈ 80–120 dòng**, nhưng chỉ trả lời được
"symbol/file mà ticket nhắc tới có tồn tại và được dùng ở đâu".

---

## Chạy được chưa

**Gần như xong.** `packages/core/dist` và `packages/cli/dist` **đã build sẵn** trong repo,
Node v22.11.0 (yêu cầu `>=20`) — chạy được ngay sau khi đăng nhập.

Cần:

- **Token AstraWork (bắt buộc cho mức A/B).** Gateway là **hằng số biên dịch cứng**:
  `GATEWAY_BASE_URL = 'https://api.astrawork.fptnearshore.com'`
  (`packages/core/src/config/endpoints.ts`). **Không có** biến môi trường, **không có** khoá
  settings, **không có** cờ dòng lệnh để đổi — trỏ sang gateway khác = sửa file đó rồi build
  lại. Token lưu ở `~/.astra/credentials.json` (quyền 0600) sau `login --token <JWT>`.
- **Không cần** DB, **không cần** docker-compose, **không có** port nào phải mở, không có
  service nào phải khởi động. (Sandbox Docker chỉ phục vụ tool `bash` của extension — CLI
  không nối.)
- `.env.example` ở root (`ASTRAWORK_BASE_URL`, `ASTRAWORK_TOKEN`, …) **chỉ dành cho script
  demo/eval**; CLI và extension **không đọc** nó.
- `ASTRA_HOME` (tuỳ chọn) — trỏ `~/.astra` sang thư mục tạm; nên dùng trong CI để mỗi job
  sạch và không giẫm lên phiên đăng nhập thật.
- Mức C không cần token, không cần mạng — chỉ cần `tree-sitter-wasms` trong `node_modules`
  (đã có).

Lệnh khởi động tối thiểu:

```powershell
$env:ASTRA_HOME = "$env:TEMP\astra-qa"
node C:\A\FPT\Astra\astracode\packages\cli\dist\main.js login --token <JWT>
node C:\A\FPT\Astra\astracode\packages\cli\dist\main.js whoami
node C:\A\FPT\Astra\astracode\packages\cli\dist\main.js models
cd <repo-dich>
node C:\A\FPT\Astra\astracode\packages\cli\dist\main.js --mode=plan --raw -p "liet ke entry point"
```

---

### Phụ lục A — 2GB nằm ở đâu, source thật bao nhiêu file

| Thư mục | Dung lượng | Số file |
|---|---:|---:|
| `.venv` | **1046 MB** | 26 741 |
| `node_modules` | 203 MB | 17 875 |
| `.verify-baseline` | 156 MB | 18 102 |
| `packages` | 18 MB | 758 |
| `.git` | 7 MB | 952 |
| `.tmp` | 5 MB | 144 |
| `documents` + `evals` + `sandbox` | < 1 MB | 44 |

**Source thật: 456 file `.ts/.tsx/.js`** (đã trừ `node_modules`/`dist`/`out`) —
`packages/core` 168, `packages/vscode` 44, `packages/cli` 20, `evals` 11, còn lại là
config/test rải rác. `.venv` (Python virtualenv) chiếm ~70% dung lượng và **không thuộc
source AstraCode**.

### Phụ lục B — vì sao kết luận "không có HTTP API"

Grep `express|fastify|http.createServer|listen(|FastAPI|APIRouter|@app.route` trên toàn bộ
`*.ts/js/json/py` ra đúng 7 file, **không file nào là server**:

- `packages/core/src/work/WorkItems.ts` — HTTP **client** gọi AstraWork
- `packages/core/src/provider/GatewayProvider.ts`, `provider/retry.ts` — client gọi
  `/v1/chat/completions`
- `packages/core/src/graph/parser/queries/{typescript,javascript}.ts` — chuỗi tree-sitter
  query trùng từ khoá
- `evals/fixtures/tinyApi.ts` — fixture giả cho eval

AstraCode **chỉ là client** của gateway AstraWork; không tự mở cổng nào.

---

## Đường dẫn file đã đọc

Để kiểm chứng lại mọi khẳng định ở trên:

- `package.json`, `packages/cli/package.json`, `packages/core/package.json`,
  `packages/vscode/package.json` (version 0.0.44)
- `packages/cli/README.md` — **tài liệu hữu ích nhất**, có cả quy trình chạy với stub model
- `packages/cli/src/main.ts` (86 dòng — toàn bộ bề mặt lệnh)
- `packages/cli/src/chat.ts:120-240` (dựng session, CodeGraph, quyền ghi), `:405-435`
  (chế độ một lượt), `:817-865` (in kết quả), `:870-890` (`readOneShotPrompt`)
- `packages/cli/src/ask.ts` (94 dòng — `nonInteractiveAsker` từ chối mọi thứ)
- `packages/core/src/index.ts` (toàn bộ export công khai)
- `packages/core/src/agent/AgentLoop.ts:219-367` (`AgentLoopOptions`, `AgentRunResult`),
  `:401` (`run()`), `:1068` (chỉ tool không `readOnly` mới qua cổng quyền)
- `packages/core/src/graph/types.ts` (69 dòng — `GraphSnapshot`, `SymbolLocation`),
  `graph/index.ts`, `graph/GraphBuilder.ts` (surface), `graph/GraphCache.ts:20-70`,
  `graph/CodeGraph.ts:142-179`
- `packages/core/src/tools/index.ts:34-110` (`READ_ONLY_TOOLS`, `createRegistry`),
  `tools/codeGraphTools.ts:1-110` (`find_references`, `impact_of`)
- `packages/core/src/permissions/PermissionManager.ts:33` (`ALWAYS_ASK`), `:200-250`
  (nhánh `plan` / `acceptEdits`), `:310-345`
- `packages/core/src/home/layout.ts` (layout `~/.astra`, `graphDir`, `projectSlug`)
- `packages/core/src/config/endpoints.ts` (gateway là hằng số)
- `packages/core/src/mcp/index.ts` + `ls packages/core/src/mcp/` (client, không phải server)
- `evals/lib/report.ts:93-102`, `evals/run.ts:36-49`
- `.env.example`, `.astraignore`, `CLAUDE.md`

---

# Bàn giao

Viết ngày 2026-09-15 để chuyển sang máy khác. Toàn bộ phần dưới nói về lớp HTTP mới thêm,
**không sửa file nào có sẵn của AstraCode và không thêm dependency nào**.

> Không có giá trị key/token nào trong file này. Chỗ nào cần bí mật thì ghi `<...>`.

## 1. File đã thêm

Tất cả nằm trong `tools/astraqa-server/` (chạy bằng `node`, ESM thuần, chỉ dùng `node:`
builtin — nên `package.json` của repo không phải đụng tới).

| File | Làm gì |
|---|---|
| `server.mjs` | Điểm vào. Đọc env, nạp `.env` ở gốc repo, dựng HTTP server, xác thực Bearer, sổ job trong bộ nhớ (trần 200 job), định tuyến 3 route |
| `lib/env.mjs` | Nạp `.env` / `.env.local` ở gốc repo. Biến đã export **thắng** file (đúng quy ước `evals/run.ts`) |
| `lib/analyze.mjs` | Ruột của một job: clone → tách ticket → mỗi ticket một lượt judge → lọc evidence → gộp `report_md`. `judgeOnce()` là chỗ DUY NHẤT biết ba backend khác nhau |
| `lib/git.mjs` | `git clone` nông, nhét token vào userinfo URL cho repo private, che secret trong mọi message lỗi |
| `lib/tickets.mjs` | Tách `tickets_md` thành danh sách ticket theo **cấu trúc** markdown (bảng / heading / danh sách), không theo hình dạng key |
| `lib/prompt.mjs` | Dựng prompt cho backend `cli` và `fci`; giữ câu chốt schema bắt buộc |
| `lib/jsonBlock.mjs` | Bóc khối ```json cuối cùng + kiểm schema. Mọi đường sai đều **ném**, không có giá trị mặc định |
| `lib/fciJudge.mjs` | Backend `fci`: POST `FPT_BASE_URL/chat/completions`, `temperature: 0` |
| `lib/noneJudge.mjs` | Backend `none`: quét từ khoá tất định, không gọi model. Trần của nó là `partial` |
| `lib/repoContext.mjs` | Gom ngữ cảnh repo (cây file đã lọc + dòng khớp từ khoá kèm số dòng thật) cho `fci` và `none` |
| `lib/globs.mjs` | Khớp `exclude_globs` (`**`, `*`, `?`) — tự viết để khỏi thêm dependency |
| `lib/redact.mjs` | Che bí mật bằng cả literal lẫn pattern, trước khi bất cứ chuỗi nào ra log/response |
| `fixtures/tickets-heading.md` | Mẫu ticket dạng heading (key `WEB-1001`, `1024`, `EXP_7`) |
| `fixtures/tickets-table.md` | Mẫu ticket dạng bảng tiếng Việt (key `#77`, `ABC_42`, `ops.deploy.v2`) |
| `test/fakeCli.mjs` | Đóng thế CLI của AstraCode để test/nghiệm thu chạy offline |
| `test/*.test.mjs` | 47 test (`node --test test/*.test.mjs`), không cần mạng/gateway/token |
| `README.md` | Bản đầy đủ của mọi thứ dưới đây |

## 2. Ba backend

Chọn bằng **`ASTRACODE_JUDGE`**; mặc định `fci`. Một request lẻ ép được backend riêng cho
nó bằng field `"backend"`. Cả ba trả **cùng một schema `items[]`** và đi qua **cùng một bộ
lọc evidence**.

| Backend | Cách chạy | Env cần thêm | Khi nào dùng |
|---|---|---|---|
| `fci` (mặc định) | 1 request HTTP tới endpoint OpenAI-compatible, `temperature: 0`. Model chỉ thấy ngữ cảnh gom sẵn | `FPT_BASE_URL` (**kèm `/v1`**), `FPT_API_KEY`, `FPT_MODEL` | Có key FCI còn tiền |
| `cli` | Spawn `node <ASTRACODE_CLI_PATH> --mode=plan --raw -p "<prompt>"`, cwd = repo đã clone; agent tự duyệt repo | `ASTRACODE_CLI_PATH`, `ASTRAWORK_JWT` (hoặc `astrawork_token` trong request) | Có JWT AstraWork; kết quả sâu nhất |
| `none` | Không gọi model. Quét từ khoá ticket trên cây file, trả dòng khớp kèm số dòng thật | *(không cần gì)* | Dựng đường ống, kiểm hợp đồng với AstraQA, mức nền tất định |

Env dùng chung cho cả ba: `PORT` (mặc định 8000), `WORKSPACE_DIR` (nơi clone tạm, **tự xoá
sau mỗi job**), `ASTRACODE_SERVICE_TOKEN` (rỗng = chế độ dev, bỏ kiểm xác thực + cảnh báo
một dòng lúc khởi động).

**`none` không bao giờ trả `done`.** Quét từ khoá chứng minh được "có chỗ nhắc tới", không
chứng minh được "đã làm xong"; trần của nó là `partial`. Đây là ranh giới giữa nó và hai
backend kia — đừng nới.

## 3. Hợp đồng HTTP

Bốn mục của hợp đồng = **3 route + 1 schema** (mục [3] là hình dạng `result`, không phải
endpoint riêng).

### [A] Xác thực

Mọi request kèm `Authorization: Bearer <ASTRACODE_SERVICE_TOKEN>`; sai → `401`.
`ASTRACODE_SERVICE_TOKEN` rỗng → chế độ dev, bỏ kiểm.
Ngoại lệ duy nhất: `/healthz` luôn `200` (gửi kèm token cũng `200`), để liveness probe
không phải cầm secret.

### [1] `POST /api/v1/analyze`

```json
{
  "run_id":          "<AstraQA sinh>",
  "repo_url":        "<bắt buộc>",
  "ref":             "<optional, mặc định nhánh default>",
  "repo_token":      "<optional, cho repo private>",
  "tickets_md":      "<bắt buộc, markdown danh sách ticket>",
  "astrawork_token": "<optional; không có thì rơi về env ASTRAWORK_JWT>",
  "backend":         "<optional: fci | cli | none; không có thì theo ASTRACODE_JUDGE>",
  "options": {
    "max_files_per_ticket": 5,
    "exclude_globs": ["**/__pycache__/**", "**/node_modules/**", "**/.venv/**", "**/dist/**"],
    "timeout_sec": 600,
    "prompt_override": null
  }
}
```

→ `202 {"job_id": "<uuid>", "status": "queued"}`
→ `400 {"error": "thiếu field bắt buộc: repo_url, tickets_md"}` (nói rõ thiếu field nào)
→ `401` nếu token sai.

### [2] `GET /api/v1/analyze/{job_id}`

```json
{"status":"queued"  , "progress":{"done":0,"total":0}}
{"status":"running" , "progress":{"done":3,"total":10}, "current":"WEB-1001"}
{"status":"succeeded","result":{ … xem [3] … }}
{"status":"failed"  , "error":"<message rõ ràng, KHÔNG chứa token>"}
```

`job_id` lạ → `404`.

### [3] `result`

```json
{
  "run_id": "<echo>",
  "generated_at": "<ISO8601>",
  "backend": "fci | cli | none",
  "items": [
    {
      "key": "<ticket key đọc từ tickets_md>",
      "code_status": "done | partial | missing",
      "confidence": 0.0,
      "evidence": [
        { "path": "<đường dẫn tương đối, có thật trong repo>", "lines": "120-148", "note": "…" }
      ],
      "reason": "<matched_by_key | matched_by_summary | no_match | …>"
    }
  ],
  "report_md": "<markdown đầy đủ>",
  "stats": {
    "backend": "…", "model": "…",
    "judge_calls": 6, "judge_parsed": 6,
    "evidence_kept": 9, "evidence_dropped": 0, "evidence_clamped": 0,
    "duration_ms": 4061
  }
}
```

`evidence[].lines` là chuỗi `"120-148"` / `"42"`, **hoặc `null`** khi model không nêu số dòng.

### [4] `GET /healthz`

```json
{"status":"ok","backend":"fci","model":"<FPT_MODEL>","fci_configured":true}
```

Backend `cli` trả `cli_path`; backend `none` trả `model: null`. **Không bao giờ trả key.**

## 4. Bốn luật lọc evidence

Chạy sau mỗi lượt judge, đối chiếu với repo đã clone. Đây là phần tất định duy nhất của cả
pipeline — model nói gì cũng phải qua đây.

| Tình huống | Xử lý |
|---|---|
| `path` không tồn tại / không phải file / thoát khỏi repo / khớp `exclude_globs` | **loại** |
| `start` > số dòng file | **loại** (trỏ vào hư không) |
| `end` > số dòng file | **kẹp** `end` về số dòng file, giữ lại |
| thiếu `lines` | **giữ**, `lines: null` |

Kẹp thay vì loại là có lý do: model đoán hụt điểm kết thúc của một hàm vẫn đang chỉ đúng
chỗ, còn `start` sai thì nó đang chỉ vào hư không. Mọi lần loại và mọi lần kẹp đều ghi vào
`report_md` (`đã kẹp 1 khoảng dòng về cuối file: index.html 1-99999 → 1-20`) và đếm trong
`result.stats`.

Ngoài bốn luật trên còn hai luật phụ: trùng `path#lines` thì bỏ, và vượt
`max_files_per_ticket` (đếm theo **file**, không theo dòng) thì loại phần dư.

## 5. Trạng thái tính tới lúc bàn giao

- **Backend `fci`: CHƯA chạy được lượt model thật nào.** Key FCI trả `401 Invalid API Key`
  ở mọi lần thử (hết tiền / bị thu hồi). Đã thử đủ các quy ước header; server tự khai nó
  muốn đúng `Authorization: Bearer {api-key}` — tức là code đúng, key mới là thứ bị từ chối.
  **`GET /v1/models` của host đó là public**: không gửi key → `200`, gửi key → `401`. Đừng
  dùng nó để kiểm key; phép thử đúng là `POST /v1/chat/completions` với một model có thật.
  Hai job thật trên hai repo public đều `failed` sau ~4,5 s với đúng message `FCI trả 401`,
  không lộ token.
- **Backend `cli`: chưa chạy được trên máy cũ.** `packages/cli/node_modules/@astra/` rỗng —
  thiếu link workspace, nên `dist/main.js` chết ngay với
  `ERR_MODULE_NOT_FOUND: Cannot find package '@astra/core'`. Đây là trạng thái của cây, không
  phải lỗi của server. Xem mục 6.
- **Backend `none`: ĐÃ chạy thật, xanh.** Hai job liên tiếp, hai repo public khác nhau, hai
  định dạng `tickets_md` khác nhau, không dùng credential nào:

  | Job | Repo | tickets_md | Thời gian | Lượt parse | evidence giữ / loại / kẹp |
  |---|---|---|---:|---:|---|
  | NONE-A | `octocat/Spoon-Knife` | heading, 3 ticket | 2 235 ms | 3/3 | 1 / 0 / 0 |
  | NONE-B | `psf/requests` | bảng, 3 ticket | 4 174 ms | 3/3 | 9 / 0 / 0 |

- **Test: 47/47 xanh**, chạy offline (`cd tools/astraqa-server && node --test test/*.test.mjs`).
- Chưa commit gì. Toàn bộ nằm trong working tree.

## 6. Việc cần làm trên máy mới

```bash
corepack enable pnpm
pnpm install --frozen-lockfile          # khôi phục link workspace @astra/core
pnpm --filter @astra/core build
pnpm --filter @astra/cli build

# đăng nhập AstraWork (JWT lấy trong VS Code: lệnh "AstraCode: Sao chép token AstraWork")
node packages/cli/dist/main.js login --token <JWT>
node packages/cli/dist/main.js whoami   # phải ra đúng tài khoản

# chuyển server sang backend cli
#   .env:  ASTRACODE_JUDGE=cli
#          ASTRACODE_CLI_PATH=<đường dẫn tuyệt đối tới packages/cli/dist/main.js>
#          ASTRAWORK_JWT=<JWT>
```

Kiểm nhanh trước khi chạy job: `curl -sS http://127.0.0.1:8000/healthz` phải trả
`{"status":"ok","backend":"cli","cli_path":"…"}`.

Trong lúc chưa có JWT lẫn key, đặt `ASTRACODE_JUDGE=none` là đường ống vẫn chạy đủ — đủ để
AstraQA nối và test hợp đồng hai đầu.

## 7. Lệnh chạy

**Khởi động** (server tự đọc `.env` ở gốc repo):

```bash
node tools/astraqa-server/server.mjs
```

**Tạo job:**

```bash
curl -sS -X POST http://127.0.0.1:8000/api/v1/analyze \
  -H "Authorization: Bearer $ASTRACODE_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "run_id": "RUN-1",
    "repo_url": "https://github.com/octocat/Spoon-Knife.git",
    "tickets_md": "## WEB-1001 — Them man hinh dang nhap\n\nStatus: Done\n\n## 1024: Cache ket qua tim kiem\n\nStatus: In Progress",
    "options": { "max_files_per_ticket": 5, "timeout_sec": 600 }
  }'
```

**Poll** (thay `<job_id>` bằng giá trị vừa nhận):

```bash
curl -sS http://127.0.0.1:8000/api/v1/analyze/<job_id> \
  -H "Authorization: Bearer $ASTRACODE_SERVICE_TOKEN"
```
