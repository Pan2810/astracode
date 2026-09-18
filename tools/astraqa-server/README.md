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
| `ASTRACODE_JUDGE_CONCURRENCY` | không | `2` | Trần lượt gọi model chạy cùng lúc trên **cả server**. `POST /api/v1/judge` chạy song song tới đúng con số này; hạn mức tính theo API key mà key thì cả server dùng chung, nên trần ở đây chứ không ở từng job |
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

**`none` không bao giờ trả `done`.** Một phép quét từ khoá chứng minh được "có chỗ nhắc tới
thứ này", không chứng minh được "đã làm xong" — trần của nó là `partial`. Dùng để dựng
đường ống, kiểm hợp đồng với AstraQA, và làm mức nền tất định để so khi model nói khác.

Chỗ duy nhất biết ba đường khác nhau là `judgeOnce()` trong `lib/analyze.mjs`; từ đó trở
đi cùng bộ bóc JSON, cùng bộ lọc evidence, cùng `report_md`. Backend đang chạy được khai ở
`GET /healthz`, ở `result.backend` và ở đầu `report_md`. Một request có thể ép backend cho
riêng nó bằng field `"backend": "fci" | "cli" | "none"`.

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

## Tầng judge — `POST /api/v1/judge`

Ðường thứ hai, và nó trả lời một câu hỏi khác. `analyze` đi tìm: nó tự dò cả repo để
đoán file nào liên quan tới ticket. `judge` soát lại: bên gọi **đã có bằng chứng** — từ
tầng khớp từ khoá của chính nó, hay từ một lần `analyze` trước — và gửi kèm `path` +
`lines`; việc của job này là ÐỌC đúng những dòng ấy rồi chọn kết luận.

Ba điểm khác `analyze`, và cả ba là lý do nó là một đường riêng:

| | `analyze` | `judge` |
|---|---|---|
| Model thấy gì | cây file đã lọc + các dòng khớp từ khoá | ÐÚNG các dòng bên gọi trích, kèm ngữ cảnh hai phía |
| Chạy | tuần tự (để `done/total` có nghĩa) | song song tới `ASTRACODE_JUDGE_CONCURRENCY` lượt |
| Ðọc kết quả | chờ cả job, rồi `result` | `results[]` **lớn dần**, đọc được giữa lúc chạy |

**Từ vựng kết luận đến từ request.** Server không có tên verdict nào của riêng nó và
không được có: `verdict_guide` là một object `{TÊN: "định nghĩa"}` do bên gọi cấp, nó đi
thẳng vào prompt bằng chính câu chữ ấy, và một câu trả lời nằm ngoài danh sách bị từ
chối. Ðổi cách gọi ở bên kia không phải sửa gì ở đây.

**`guidance_path` — quy ước riêng của codebase.** Một đường dẫn, không phải nội dung:
tệp nằm trong repo job này sắp clone, nên gửi nội dung xuống nghĩa là bên gọi giữ một
bản sao của một tệp nó không bao giờ đọc, và bản sao ấy sẽ lệch với nhánh mà judge
thật sự đọc. Ðường dẫn do bên gọi đưa chứ AstraCode không tự tìm, vì bộ rules đang áp
có thể ở cấp tenant chứ không nằm trong repo — chỉ bên kia biết bộ nào đang thắng.

Nội dung tệp được nối vào prompt SAU danh sách kết luận và TRƯỚC ticket: nó giải thích
cách đọc mã nguồn này, chứ không được thêm hay đổi nghĩa một kết luận nào. Một tệp bảo
model trả về tên khác vẫn bị chặn ở chỗ cũ. Ðường dẫn leo ra ngoài bản clone thì không
mở; đọc hỏng thì thôi, vì thiếu quy ước làm câu trả lời nghèo đi chứ không làm nó sai.

```bash
curl -sS -X POST http://127.0.0.1:8000/api/v1/judge \
  -H "Authorization: Bearer $ASTRACODE_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "run_id": "RUN-1",
    "repo_url": "https://github.com/org/repo.git",
    "ref": "",
    "tickets": [
      {
        "key": "WEB-1001",
        "summary": "Ðăng nhập bằng mật khẩu",
        "status": "done",
        "grep_verdict": "CODE_AHEAD",
        "grep_reason": "matched_by_key",
        "evidence": [{ "path": "src/login.ts", "lines": "120-148" }]
      }
    ],
    "verdict_guide": {
      "MATCH": "kế hoạch và mã nguồn nói cùng một chuyện",
      "CODE_AHEAD": "mã đã có, ticket chưa đóng",
      "JIRA_AHEAD": "ticket đã đóng, mã chưa thấy",
      "NO_EVIDENCE": "không tìm được gì kiểm chứng được"
    }
  }'
```

→ `202 {"job_id","status":"queued","total":1}`. Thiếu `repo_url`, `tickets` (mảng rỗng
cũng tính là thiếu) hoặc `verdict_guide` → `400` kèm tên field thiếu.

## `.astraqa/rules.yml` — tệp rules của đội

`analyze` đọc `.astraqa/rules.yml` (hoặc `.yaml`) ở gốc bản clone và trả **nguyên văn**
trong `repo_rules`. AstraCode không hiểu nội dung tệp này và không được hiểu: luật
verdict nằm bên AstraQA, và một bộ luật thứ hai đọc cùng một tệp theo cách hơi khác là
cách nhanh nhất để hai bên nói hai điều khác nhau về cùng một dòng. Ở đây chỉ có ba
việc: tệp có không, nó bao nhiêu byte, nội dung là gì.

```json
"repo_rules": {
  "path": ".astraqa/rules.yml",
  "bytes": 312,
  "text": "done_means:\n  - done\n",
  "too_big": false,
  "guidance": { "path": ".astraqa/judge.md", "bytes": 91, "text": "…" }
}
```

`null` khi repo không có tệp, và **`null` khác một tệp rỗng**: tệp rỗng là đội đã nói
"dùng mặc định", không có tệp là đội chưa nói gì và bộ luật cấp tenant mới được lên
tiếng. Gộp hai cái làm một là âm thầm đổi bộ luật đang áp.

Trần 256 KB. Vượt trần thì `too_big: true` và `text` rỗng — không cắt bớt, vì một tệp
rules bị cắt giữa chừng vẫn parse được và sẽ quyết verdict bằng một nửa bộ luật.

`GET /api/v1/judge/{job_id}` → luôn cùng một hình dạng, ở mọi trạng thái:

```json
{
  "status": "running|succeeded|failed",
  "done": 12,
  "total": 40,
  "source_revision": "<sha đã clone>",
  "results": [
    { "key": "WEB-1001", "verdict": "MATCH", "confidence": 0.82, "reason": "…", "tier": "ai" },
    { "key": "WEB-1002", "tier": "grep", "error": "…" }
  ],
  "stats": { "judged": 11, "failed": 1, "no_snippet": 0, "hits_429": 0, "duration_ms": 41230 }
}
```

`results` trả về kể cả khi `status` là `failed`: một job chết ở ticket thứ 150 vẫn đã
chấm xong 149 ticket, và những kết luận ấy đúng như nhau dù cái thứ 150 có hỏng. Giấu
chúng đi vì trạng thái cuối xấu là bắt bên gọi tiêu lại 149 lượt model.

**`tier: "grep"` nghĩa là "giữ nguyên kết luận của tầng trước".** Một dòng như thế luôn
kèm `error` nói vì sao, và có đúng ba nguyên nhân: lượt gọi model hỏng (mạng, 4xx, hết
giờ), model trả về một verdict không có trong `verdict_guide`, hoặc không đọc được mảnh
code nào để đưa cho model. Nguyên nhân thứ ba là chỗ dễ sai nhất và nó **không** gọi
model: chấm mù rồi dán nhãn "AI" lên là kiểu hỏng tệ nhất của cả tầng này.

Judge **không có backend dự bị tất định**. `ASTRACODE_JUDGE=none` biết nói "có nhắc tới",
đúng thứ tầng khớp từ khoá đã làm — chạy nó ở đây là tiêu thời gian để ra lại kết luận
cũ dưới một cái nhãn sai. Thiếu `FPT_*` thì job `failed` ngay và nói ra.

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

```bash
cd tools/astraqa-server
node --test test/*.test.mjs
```

47 test, **không cần mạng, không cần gateway, không tốn token**: repo git thật được dựng
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
