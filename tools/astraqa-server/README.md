# astraqa-server

Lớp HTTP mỏng để **AstraQA** gọi **AstraCode** qua mạng.

Không phải một phần của AstraCode: không import gì từ `packages/`, không sửa file nào có
sẵn, không thêm dependency (chỉ dùng `node:` builtin, nên `package.json` của repo không
phải đụng tới). Việc duy nhất của nó là nhận request rồi spawn CLI của repo này đúng như
một người gõ tay:

```
node <ASTRACODE_CLI_PATH> --mode=plan --raw -p "<prompt>"     # cwd = repo vừa clone
```

**Stateless theo nghĩa nghiêm:** server không biết dự án nào tồn tại. Repo, ref, danh sách
ticket, định dạng ticket, glob loại trừ — tất cả đến từ request. Bảng env dưới đây là toàn
bộ cấu hình nó đọc.

## a. Env cần set

Server tự nạp `.env` ở gốc repo (và `.env.local`) theo đúng quy ước của `evals/run.ts`:
**biến đã export thắng file**.

| Biến | Bắt buộc | Mặc định | Là gì |
|---|---|---|---|
| `PORT` | không | `8000` | Cổng nghe, bind `127.0.0.1` |
| `WORKSPACE_DIR` | không | `<tmp>/astracode-astraqa` | Nơi clone repo tạm. Mỗi job một thư mục con, **xoá khi job kết thúc** (kể cả khi lỗi). Đường dẫn tương đối được resolve về tuyệt đối theo cwd lúc khởi động; tạo/ghi không được thì server DỪNG |
| `ASTRACODE_SERVICE_TOKEN` | **nên có** | rỗng | Token AstraQA phải gửi. **Rỗng = chế độ dev, bỏ kiểm xác thực**, có một dòng cảnh báo lúc khởi động |
| `ASTRACODE_JUDGE` | không | `fci` | `fci` \| `cli` \| `none` — xem "Ba backend" bên dưới |
| `FPT_BASE_URL` | khi `fci` | — | Gốc endpoint OpenAI-compatible, **kèm `/v1`** |
| `FPT_API_KEY` | khi `fci` | — | Gửi trong `Authorization: Bearer`. **Không bao giờ được in ra log** — log chỉ nói "có/KHÔNG" |
| `FPT_MODEL` | khi `fci` | — | Ví dụ `Qwen3.8-27B` |
| `ASTRACODE_CLI_PATH` | khi `cli` | `<repo>/packages/cli/dist/main.js` | Trỏ vào `test/fakeCli.mjs` để chạy thử không tốn LLM |
| `ASTRAWORK_JWT` | khi `cli` | rỗng | JWT AstraWork. Request có `astrawork_token` thì dùng cái đó, không thì rơi về biến này |

Ngoài các biến này server không đọc biến cấu hình nào khác. Các biến OS (`PATH`, `HOME`,
`TEMP`…) chỉ được *chuyển tiếp* cho `git` và cho tiến trình CLI con để chúng chạy được.

## Ba backend, cùng một schema

| | `fci` (mặc định) | `cli` | `none` |
|---|---|---|---|
| Cách chạy | một request HTTP tới `FPT_BASE_URL/chat/completions`, `temperature: 0` | spawn CLI của AstraCode, agent tự duyệt repo | quét từ khoá tất định, không gọi model |
| Model thấy gì | ngữ cảnh gom sẵn: cây file đã lọc + các dòng khớp từ khoá ticket, kèm số dòng thật | cả repo, qua tool đọc file/grep/tra symbol | — |
| Cần | `FPT_BASE_URL`, `FPT_API_KEY`, `FPT_MODEL` | `ASTRACODE_CLI_PATH`, JWT AstraWork | không cần gì |
| Đổi lại | rẻ, nhanh, đoán được thời gian | sâu hơn, chậm hơn | không phán được "đã xong", chỉ "có nhắc tới" |

**`none` hiện trả `done` khi tìm thấy evidence path.** Trong backend này, `done` chỉ
có nghĩa scanner tìm được candidate theo từ khoá; nó chưa chứng minh code đạt ticket
hay acceptance criteria. Baseline 190 ticket ở `BASELINE_TRANSPORT.md` có 185 item
`done` từ `none`. Việc đổi vocabulary/trạng thái thuộc bước tiếp theo của kế hoạch.

Chỗ duy nhất biết ba đường khác nhau là `judgeOnce()` trong `lib/analyze.mjs`; từ đó trở
đi cùng bộ bóc JSON, cùng bộ lọc evidence, cùng `report_md`. Backend đang chạy được khai ở
`GET /healthz`, ở `result.backend` và ở đầu `report_md`. Một request có thể ép backend cho
riêng nó bằng field `"backend": "fci" | "cli" | "none"`.

Với backend `cli`, mỗi ticket tạo trace JSONL từ **AgentLoop thật** ở
`<ASTRACODE_RUNS_DIR>/traces/<job-id>/<ordinal>.jsonl`; trường
`item.agent_trace.ref` trỏ tới artifact đó. Trace ghi từng loop, tool call,
thời lượng/kết quả tool (hash, metadata, error/trust-zone), recovery và
outcome. Mặc định không ghi nội dung source/tool/model; CLI chỉ ghi excerpt đã
redact khi chạy với `--trace-content`.

## b. Khởi động

```powershell
$env:PORT                    = "8000"
$env:WORKSPACE_DIR           = "$env:TEMP\astraqa-ws"
$env:ASTRACODE_CLI_PATH      = "C:\A\FPT\Astra\astracode\packages\cli\dist\main.js"
$env:ASTRAWORK_JWT           = "<JWT AstraWork>"
$env:ASTRACODE_SERVICE_TOKEN = "<token AstraQA se gui>"
node C:\A\FPT\Astra\astracode\tools\astraqa-server\server.mjs
```

Bash:

```bash
PORT=8000 \
WORKSPACE_DIR=/tmp/astraqa-ws \
ASTRACODE_CLI_PATH=/c/A/FPT/Astra/astracode/packages/cli/dist/main.js \
ASTRAWORK_JWT="<JWT AstraWork>" \
ASTRACODE_SERVICE_TOKEN="<token AstraQA se gui>" \
node /c/A/FPT/Astra/astracode/tools/astraqa-server/server.mjs
```

Muốn chạy thử toàn bộ đường ống mà **không tốn token LLM nào**: trỏ
`ASTRACODE_CLI_PATH` vào `tools/astraqa-server/test/fakeCli.mjs`.

## c. Gọi thử

`POST /api/v1/analyze` ưu tiên ticket JSON có schema rõ ràng:

```json
{
  "repo_url": "https://example.com/team/repo.git",
  "tickets_schema_version": 1,
  "tickets": [
    {
      "key": "ORDER-1",
      "summary": "Create order",
      "status": "done",
      "description": "POST /orders creates an order",
      "acceptance_criteria": ["Returns 201", "Writes exactly one order"]
    }
  ]
}
```

`tickets` và `tickets_md` loại trừ nhau. `tickets_md` vẫn được nhận cho client cũ;
JSON giữ description và từng AC thành field riêng, không cắt ngầm nội dung khi parse.

Tạo job:

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

Poll (thay `<job_id>` bằng giá trị vừa nhận):

```bash
curl -sS http://127.0.0.1:8000/api/v1/analyze/<job_id> \
  -H "Authorization: Bearer $ASTRACODE_SERVICE_TOKEN"
```

Liveness: `curl -sS http://127.0.0.1:8000/healthz` → `{"status":"ok","backend":"fci","model":"…"}` — không cần token.

## Hợp đồng

`POST /api/v1/analyze` → `202 {"job_id","status":"queued"}`. Thiếu `repo_url` hoặc
`tickets_md` → `400` kèm tên field thiếu. Sai/thiếu token → `401`.

`GET /api/v1/analyze/{job_id}` → một trong:

```json
{"status":"running",   "progress":{"done":3,"total":10}, "current":"WEB-1001"}
{"status":"succeeded", "result":{ "run_id":…, "generated_at":…, "items":[…], "report_md":… }}
{"status":"failed",    "error":"<message đã che token>"}
```

`job_id` lạ → `404`. `/healthz` là ngoại lệ xác thực duy nhất (gửi kèm token vẫn `200`),
để probe không cần cầm secret.

Một `item`:

```json
{
  "key": "WEB-1001",
  "code_status": "done|partial|missing",
  "confidence": 0.82,
  "evidence": [{ "path": "src/login.ts", "lines": "120-148", "note": "…" }],
  "reason": "matched_by_key"
}
```

## Những chỗ cố tình nghiêm

- **Ticket key đọc theo cấu trúc, không theo hình dạng.** Không có regex kiểu
  `[A-Z]+-\d+` ở đâu cả. Ba cấu trúc được nhận, xét theo thứ tự: bảng markdown có cột
  tên kiểu key/id/ticket/mã → heading (mỗi heading ở cấp có nhiều heading nhất là một
  ticket) → danh sách gạch đầu dòng. Trong cả ba, một dòng `Key:` / `Mã:` / `ID:` trong
  thân ticket luôn thắng phần suy từ tiêu đề. `#77`, `1024`, `ABC_42`, `ops.deploy.v2`,
  `feature/login` đều là key hợp lệ.
- **`evidence.path` phải có thật.** Sau mỗi lượt, server đối chiếu từng đường dẫn với repo
  đã clone. Bốn luật, theo đúng thứ tự:

  | Tình huống | Xử lý |
  |---|---|
  | path không tồn tại / không phải file / thoát khỏi repo / khớp `exclude_globs` | **loại** |
  | `start` > số dòng file | **loại** (trỏ vào hư không) |
  | `end` > số dòng file | **kẹp** `end` về số dòng file, giữ lại |
  | thiếu `lines` | **giữ**, `lines: null` |

  Kẹp thay vì loại là có lý do: model đoán hụt điểm kết thúc của một hàm vẫn đang chỉ đúng
  chỗ, còn `start` sai thì nó đang chỉ vào hư không. Mọi lần loại và mọi lần kẹp đều được
  ghi vào `report_md` (`đã kẹp … 1-99999 → 1-20`) và đếm trong `result.stats`. Đây là phần
  tất định duy nhất của cả pipeline.
- **Không có fallback im lặng.** Không thấy khối ```json, JSON hỏng, sai schema, key trả
  về không khớp ticket, CLI quá giờ → job `failed` với message chỉ đúng ticket và đúng
  field sai. Không bao giờ trả `items: []` một cách im lặng.
- **Token không rời tiến trình.** `astrawork_token`, `repo_token`,
  `ASTRACODE_SERVICE_TOKEN`, key LLM bị che ở mọi log và mọi message lỗi — bằng cả literal
  lẫn pattern (bắt được cả secret không khai trước). `test/redact.test.mjs` canh điều này.
- **Job nằm trong bộ nhớ**, tối đa 200 job gần nhất. Không DB, không trạng thái trên đĩa.

## Chạy test

`items[].assessment` đánh giá từng acceptance criterion riêng với verdict Jira/source.
Chỉ dẫn chứng file/dòng còn tồn tại được giữ; không có bản ghi chạy test thì
`test_status: not_run` và tối đa `implemented_unverified`. `mapping_state`
phân biệt key ticket xuất hiện trong dòng code dẫn chứng (`linked`), chỉ có
candidate (`weak_link`) và chưa liên kết (`unlinked`). Scan thiếu file vì cap,
file quá lớn hoặc lỗi đọc mang `complete: false`, không được suy ra JIRA_AHEAD.

```bash
cd tools/astraqa-server
node --test test/*.test.mjs
```

Các test **không cần mạng, không cần gateway, không tốn token**: repo git thật được dựng
trong thư mục tạm, backend `cli` đóng thế bằng `test/fakeCli.mjs`, backend `fci` đóng thế
bằng một endpoint OpenAI-compatible dựng tại chỗ — nhưng đi qua đúng mọi bước mà bản chạy
thật đi.

## Trước khi trỏ vào CLI thật

`packages/cli/dist/main.js` cần link workspace `@astra/core`. Trong cây hiện tại link đó
đang thiếu (`packages/cli/node_modules/@astra/` rỗng), nên CLI thật chết ngay với
`ERR_MODULE_NOT_FOUND: Cannot find package '@astra/core'`. Khôi phục bằng:

```bash
pnpm install
pnpm --filter @astra/core build
pnpm --filter @astra/cli build
```

Sau đó CLI còn cần một JWT AstraWork còn hạn (`ASTRAWORK_JWT` hoặc `astrawork_token` trong
request) thì lượt gọi model mới đi được.

## Vì sao không dùng GraphBuilder

`snapshot.json` của CodeGraph nằm ở `~/.astra/graph/<slug>/`, với `slug` tính từ đường dẫn
workspace. Mỗi job clone vào một thư mục mới nên slug luôn khác → cache luôn lạnh, dựng
graph trong tiến trình server tốn đúng bằng để agent tự tra. Phần tất định mà graph hứa —
"đường dẫn và số dòng có thật" — đã được bảo đảm bằng cách đối chiếu thẳng với file trên
đĩa ở trên, rẻ hơn và không phải import gì từ `packages/`.
