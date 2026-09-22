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
| `ASTRACODE_SERVICE_TOKEN` | **nên có** | rỗng | Token AstraQA phải gửi, và `/admin` cũng đòi nó (kể cả từ loopback). **Rỗng = chế độ dev, bỏ kiểm xác thực**, có một dòng cảnh báo lúc khởi động |
| `ASTRACODE_JUDGE` | không | `fci` | `fci` \| `cli` \| `none` — xem "Ba backend" bên dưới |
| `FPT_BASE_URL` | khi `fci` | — | Gốc endpoint OpenAI-compatible, **kèm `/v1`** |
| `FPT_API_KEY` | khi `fci` | — | Gửi trong `Authorization: Bearer`. **Không bao giờ được in ra log** — log chỉ nói "có/KHÔNG" |
| `FPT_MODEL` | khi `fci` | — | Ví dụ `Qwen3.8-27B` |
| `ASTRACODE_JUDGE_CONCURRENCY` | không | `2` | Trần lượt gọi model chạy cùng lúc trên **cả server**. `POST /api/v1/judge` chạy song song tới đúng con số này; hạn mức tính theo API key mà key thì cả server dùng chung, nên trần ở đây chứ không ở từng job. **Với endpoint FPT nên đặt `8`** — nó chịu được, và 190 ticket ở mức 2 thì chạy lâu gấp bốn mà không đổi được gì ở phía nhà cung cấp. Gặp `429` thì server tự lùi theo `Retry-After`, nên đặt cao không phải là đánh cược. Banner lúc khởi động nhắc lại nếu đang để thấp hơn 8 |
| `ASTRACODE_CLI_PATH` | khi `cli` | `<repo>/packages/cli/dist/main.js` | Trỏ vào `test/fakeCli.mjs` để chạy thử không tốn LLM |
| `ASTRAWORK_JWT` | khi `cli` | rỗng | JWT AstraWork. Request có `astrawork_token` thì dùng cái đó, không thì rơi về biến này |

Ngoài các biến này server không đọc biến cấu hình nào khác. Các biến OS (`PATH`, `HOME`,
`TEMP`…) chỉ được *chuyển tiếp* cho `git` và cho tiến trình CLI con để chúng chạy được.

## Ba backend, cùng một schema

| | `fci` (mặc định) | `cli` | `none` |
|---|---|---|---|
| Cách chạy | một request HTTP tới `FPT_BASE_URL/chat/completions`, `temperature: 0` | spawn CLI của AstraCode, agent tự duyệt repo | quét từ khoá tất định, không gọi model |
| Model thấy gì | ngữ cảnh gom sẵn: cây file đã quét + các dòng khớp từ khoá ticket, kèm số dòng thật | cả repo, qua tool đọc file/grep/tra symbol | — |
| Bản ghi quét (`item.scan`) | có — cùng corpus và cùng từ khoá với `none` | `null` (agent tự duyệt, server không có bản ghi) | có |
| Cần | `FPT_BASE_URL`, `FPT_API_KEY`, `FPT_MODEL` | `ASTRACODE_CLI_PATH`, JWT AstraWork | không cần gì |
| Đổi lại | rẻ, nhanh, đoán được thời gian | sâu hơn, chậm hơn | không phán được "đã xong", chỉ "có nhắc tới" |

**`none` hiện trả `done` khi tìm thấy evidence path.** Trong backend này, `done` chỉ
có nghĩa scanner tìm được candidate theo từ khoá; nó chưa chứng minh code đạt ticket
hay acceptance criteria. Baseline 190 ticket ở `BASELINE_TRANSPORT.md` có 185 item
`done` từ `none`. Việc đổi vocabulary/trạng thái thuộc bước tiếp theo của kế hoạch.

`fci` và `none` dùng **chung một bộ tách từ khoá** — `queryTerms`/`normalizedKey` của
`CANDIDATE_MATCHING_SPEC` (`lib/candidates.mjs`), và **chung một index toàn repo** dựng
đúng một lần cho cả job. Trước đây `fci` có bộ tách riêng cắt ticket key thành mảnh
(`GEN-R123` → `gen`) và không bỏ dấu tiếng Việt, nên ngữ cảnh gửi cho model gần như
rỗng trên ticket tiếng Việt — mà `fci` lại là backend mặc định. Khác biệt duy nhất còn
lại: chỗ này thiên về thu hồi (một từ khớp cũng thành ứng viên, rồi xếp hạng theo §4.2 và
lấy 8 file đầu bảng) vì model mới là tầng lọc chính xác phía sau, còn `shortlistFor` của
`none` phải tự chặt vì không có ai dọn sau. `TIGHTEN_MODE` vẫn chỉ nói về `none`.

`fci` còn đọc thêm một **corpus phụ**: file hạ tầng/cấu hình nằm ngoài allowlist đuôi mã
nguồn — `.mjs`, `.cjs`, `.json`, `.yml`, `.toml`, `.ps1`, `.sh`, `Dockerfile`…  Ðo trên
`astraqa`: 396 file lọt allowlist, 187 file thì không, và trong 187 ấy có 44 file là nơi
ticket thật sự được hiện thực (dựng thêm 36ms, so với 896ms của index chính). Ba điều
ràng buộc nó:

- **Ðọc thật, không chỉ liệt kê tên.** Ðưa cho model một danh sách tên file mà nó chưa
  đọc nội dung là mời nó trích một đường dẫn nghe hợp lý, và bộ lọc bằng chứng chỉ kiểm
  đường dẫn có tồn tại — trích dẫn ảo ấy sẽ lọt. Chỉ file có dòng khớp mới xuất hiện, kèm
  số dòng thật.
- **Không có `.md`/`.rst`/`.txt`.** Tài liệu hay viết ở thì tương lai ("sẽ bổ sung
  endpoint X"); một câu như thế là đúng đường để model kết luận đã xong dựa trên một lời hứa.
- **Không vào `scan.files_scanned`.** Bản ghi quét nói về phép quét tất định của spec, và
  giữ cho nó đúng một nghĩa quan trọng hơn là gộp cho to. Trần riêng (3 file, 10 dòng) để
  nó không lấn chỗ mã nguồn trong prompt.

`none` **không** dùng corpus phụ: bằng chứng của nó phải đến từ đúng phép quét đã đóng băng.

Vì phạm vi tìm của hai backend giờ là một, `fci` **trả bản ghi quét thật** thay vì
`scan: null` như trước. `complete: false` (đụng trần, lỗi đọc, file quá lớn) vẫn là cái
chốt: AstraQA không được suy ra `JIRA_AHEAD` từ một phép quét chưa đi hết repo.

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

`POST /api/v1/analyze` → `202 {"job_id","status":"queued"}`. Thiếu `repo_url`, hoặc
thiếu cả `tickets_md` lẫn `tickets` → `400` kèm tên field thiếu. Sai/thiếu token → `401`.

### Hai cách gửi ticket: `tickets` (JSON) hoặc `tickets_md`

```json
"tickets_schema_version": 1,
"tickets": [
  { "key": "WEB-1001", "summary": "Thêm màn hình đăng nhập (SSO)", "status": "Done",
    "description": "chi tiết…",
    "acceptance_criteria": ["Ðăng nhập được bằng mật khẩu", "Sai ba lần thì khoá 15 phút"] }
]
```

`tickets_schema_version` thiếu → coi là **1** (client bản cũ không gửi field này, và bộ
ticket của nó đúng là v1). Khác 1 → **400** kèm con số nhận được: đọc một schema chưa
biết bằng luật của v1 là cách để một field đổi nghĩa lặng lẽ đi thẳng vào prompt.

**Có cả hai thì JSON thắng** — và "thắng" chứ không phải "gộp": gộp nghĩa là phải quyết
bản nào đúng khi hai nguồn nói khác nhau về cùng một key, và không có câu trả lời đúng
cho việc ấy. `/healthz` khai `accepts_json_tickets: true` để bên gọi dò được thay vì thử
rồi đoán theo mã lỗi. `result.stats.tickets_source` nói job vừa rồi đã dùng đường nào.

Dùng JSON khi bên gọi đã có từng trường tách bạch — tức là gần như mọi lúc. `tickets_md`
là một phép **đoán**: nó phải dò ngược cấu trúc từ markdown, và chỗ nó đoán hụt là những
tiêu đề viết hoàn toàn bình thường. Ví dụ đo được, cùng năm ticket:

| Tiêu đề | qua `tickets_md` | qua `tickets` |
|---|---|---|
| `Thêm (SSO) cho web` | giữ nguyên | giữ nguyên |
| `Sửa lỗi #500 khi upload` | giữ nguyên | giữ nguyên |
| `Bảng \| cột \| mới` | giữ nguyên | giữ nguyên |
| `ログイン画面を追加する` | giữ nguyên | giữ nguyên |
| `Tiêu đề có` + xuống dòng + `phần sau` | **mất phần sau** | giữ nguyên |

Ðếm vẫn đủ năm ticket trong cả hai đường — cái mất là nửa câu tiêu đề, và mất ở chỗ không
ai nhìn thấy: `queryTerms` quét một tiêu đề cụt rồi ra một verdict nghèo hơn.

`description` vào thẳng `body` của ticket, tức đúng hai trường (`summary` + `description`)
mà §1.1 cho phép quét — không có khung markdown nào phải bóc.

Sai kiểu ở `tickets` (không phải mảng, mảng rỗng, phần tử thiếu `key`, key trùng) → `400`
kèm **chỉ số phần tử**. Còn `tickets_md` hỏng vẫn là job `failed` kèm message, đúng hợp
đồng cũ — đổi nó là đổi hành vi dưới chân một client đang chạy.

### `acceptance_criteria` → `assessment`: chấm từng tiêu chí

Danh sách chứ không phải một khối chữ, vì "code thoả mấy trong năm tiêu chí" là câu hỏi
cần năm thứ. Mỗi tiêu chí vào prompt thành **một dòng đánh số**, và số ấy chính là `id`
trong kết quả — nên thứ tự trong mảng là hợp đồng, không phải trình bày.

`acceptance_hint` là đường lui cho bên gọi chỉ có một chuỗi: AstraQA dựng nó bằng cách
nối các tiêu chí bằng dấu xuống dòng, nên ở đây nó được tách lại theo dòng. Trần 200
tiêu chí, bằng đúng `max_length` của schema bên kia.

Ticket có tiêu chí thì item trả về mang thêm `assessment` — **hình dạng này là của
AstraQA**, đọc ra từ `management-core/src/astraqa_management/code_reconcile.py`
(`_assessment`), không phải do bên này đặt:

```json
"assessment": {
  "criteria": [
    { "id": 1, "text": "<chữ của bên gọi>", "status": "satisfied | partial | not_satisfied | unknown",
      "evidence": [{ "path": "src/login.py", "lines": "40-58", "note": "…" }],
      "reason": "<một câu>" }
  ]
}
```

Ba điều bên này tự áp, và cả ba là để bên kia không phải dọn:

- **`id` và `text` do server đặt lại theo danh sách đã gửi đi**, không lấy của model. Bên
  kia gộp kết quả nhiều repo theo `id`, nên một `id` model tự đánh là hai kết luận về hai
  tiêu chí khác nhau chồng lên nhau. Model chỉ được nói `status`, `evidence`, `reason`.
- **Tiêu chí model không nhắc tới → `unknown`**, bằng chứng rỗng. Một mục cho một tiêu chí
  đã gửi, không hơn không kém.
- **`status` khác `unknown` mà không chỉ được dòng nào → tụt về `unknown`.** Bằng chứng của
  từng tiêu chí đi qua đúng bộ lọc path/line của bằng chứng chung, nên một đường dẫn bịa
  bị loại và trạng thái dựa trên nó không trụ lại. Ðây cũng là luật `_assessment` áp ở đầu
  bên kia — áp sẵn ở đây để hai bên không nói khác nhau về cùng một tiêu chí.

Model trả `met`/`unmet`/`fail`… thì được quy về bốn chữ trên. Khoan dung ở đầu vào,
nghiêm ngặt ở đầu ra — bảng dịch nằm trong `lib/jsonBlock.mjs`, một chỗ duy nhất.

Ticket không có tiêu chí → `assessment: null`. `null` là "không có tiêu chí nào", khác hẳn
một danh sách toàn `unknown` ("có tiêu chí mà chưa chấm được").

### Mô tả dài: cắt ở 12 000 ký tự, và nói ra

`description` là nguyên văn mô tả Jira — có ticket mang cả bảng, cả log. Trần là **12 000
ký tự**; dài hơn thì phần đuôi bị cắt và kèm `…(đã cắt N ký tự)` ngay trong prompt.

Cắt thì **phải nói ra**: item mang `truncated: true`, `stats.tickets_truncated` đếm, một
dòng trong `warnings` gọi đúng tên những ticket bị cắt, và `report_md` ghi **MÔ TẢ ÐÃ CẮT**
ở ticket ấy. Cắt im lặng nghĩa là model kết luận trên một nửa đề bài mà không ai biết.

### Key trùng: vẫn là lỗi, và lỗi phải chỉ được chỗ

Hai ticket đụng nhau sau khi chuẩn hoá (bỏ hoa/thường, gộp khoảng trắng), nên hai key
**gốc** có thể trông khác nhau. Thông báo vì thế nói cả hai chữ gốc lẫn hai số dòng:

```
tickets_md: key bị trùng — "WEB-1001" (dòng 3) và "web-1001" (dòng 8) cùng là key
"web-1001". Mỗi ticket phải có key riêng.
```

Với `tickets` JSON thì chỗ được chỉ là chỉ số mảng: `"WEB-1" (tickets[0]) và "web-1"
(tickets[1])`. Còn `tickets_md` không dò ra cấu trúc nào thì lỗi nói luôn nó đã đọc tới
đâu: `Ðọc từ dòng 3: "chỉ là một đoạn văn xuôi…"`.

`503` khi sổ 200 job đã đầy **và tất cả đều đang chạy**. Sổ chỉ đẩy job đã đóng sổ
(`succeeded`/`failed`/`cancelled`) ra; một job đang chạy không bao giờ bị đẩy đi. Trước
đây nó xoá theo thứ tự chèn mà không nhìn trạng thái, nên job dài rơi khỏi sổ khi job thứ
201 vào: `GET` trả 404 dù job vẫn sống và vẫn tiêu hạn mức, mà không còn đường nào gọi
dừng nó. Một `503` thử lại được rẻ hơn một job vô hình.

### Gọi dừng: `DELETE /api/v1/analyze/{job_id}`

Cùng nghĩa với `DELETE /api/v1/judge/{job_id}`: **dừng, không phải xoá**. Ticket đã chấm
xong ở lại nguyên vẹn — chúng đã được trả tiền rồi. Ticket chưa tới lượt, và cả ticket
đang bay lúc bấm dừng, về với `reason: "cancelled"`, `code_status: "missing"`,
`scan: null` — tức **chưa xét**, không phải "đã kiểm tra và thấy thiếu". Job đóng sổ với
`status: "cancelled"`, không bao giờ là `succeeded`, và cũng không phải `failed`: hai
cái chốt "không lượt nào chấm được" và "bộ lọc loại sạch bằng chứng" không áp cho một job
được bảo dừng. `stats.tickets_cancelled` đếm phần chưa xét, tách khỏi `tickets_skipped`
(vượt trần) và khỏi `judge_failed` (đã thử và hỏng).

`GET` trong lúc job đang dọn trả `{"status":"cancelled","progress":{…}}` chưa kèm
`result`; có `result` nghĩa là đã đóng sổ xong.

Hai field tuỳ chọn làm mỏng một job:

| Field | Là gì |
|---|---|
| `tickets_subset` | Mảng ticket key. **Chỉ quét evidence cho những key này**; repo vẫn clone đủ |
| `options.max_files_per_ticket` | Trần bằng chứng, và là **sàn** số file ứng viên model được đọc (tối thiểu 8) |
| `base_revision` | Mốc so sánh. Có thì kết quả mang thêm `changed_files[]` = `git diff --name-only base..HEAD` |

### `tickets_subset` — quét ít, vẫn trả đủ bảng

Thứ đắt trong một job không phải bản clone mà là những lượt quét và những lượt gọi
model. Bên gọi đã biết 184 ticket kia không đổi gì từ lần chạy trước thì không có lý do
bắt server chấm lại chúng.

Ticket ngoài tập **không biến mất khỏi `items`** — chúng về với `reason: "not_in_subset"`,
`code_status: "missing"`, `confidence: 0`, `scan: null`. Cùng một luật với
`skipped_quota_limit`: một ticket vắng mặt trông y như một ticket đã xét và không thấy
gì, và bỏ hẳn nó đi sẽ khiến AstraQA đọc bảng thành "`tickets_md` chỉ có bấy nhiêu".
`report_md` gọi những dòng ấy là **KHÔNG QUÉT**, khác chữ **BỎ QUA** của trần hạn mức.

Thứ tự hai phép lọc là có chủ ý: **tập con của bên gọi áp trước**, `ASTRACODE_MAX_TICKETS`
áp sau. Ðảo lại thì bên gọi xin 6 ticket cuối bảng sẽ nhận về không ticket nào mà không
có gì nói vì sao.

Mảng rỗng → `400` (gửi mảng rỗng nghĩa là không quét gì; bỏ hẳn field nếu muốn quét tất
cả). Key không có trong `tickets_md` → chỉ là **cảnh báo**: nó thường là ticket vừa bị
xoá bên kế hoạch.

### `base_revision` — những tệp đã đổi từ mốc ấy

Bản clone là `--depth 1` nên `base` gần như chắc chắn chưa có mặt. Server đào thêm lịch
sử theo đúng thứ tự từ rẻ tới đắt, kiểm lại sau mỗi lần và dừng ngay khi đủ: `fetch
origin <base>` → `--deepen 100` → `--deepen 500` → `--unshallow`.

Ba trạng thái, phân biệt bằng đúng hai field:

| | `base_revision` (trả về) | `changed_files` | cảnh báo |
|---|---|---|---|
| Không hỏi | `null` | `null` | không |
| Hỏi, lấy được | `<sha đầy đủ>` | `["src/a.py", …]` | không |
| Hỏi, không thấy | `null` | `null` | **có** |

`changed_files` là `null` chứ không phải `[]` khi không biết: một mảng rỗng là câu trả
lời "không tệp nào đổi", và hai chuyện ấy khác nhau.

**Base không tìm thấy KHÔNG phải lỗi.** Nó là thứ bên gọi nhớ từ lần chạy trước — có thể
đã bị force-push đè, có thể thuộc một fork, có thể gõ nhầm. Ðánh hỏng cả job vì chuyện ấy
là vứt đi 184 lượt phân tích đã chạy xong để đổi lấy một danh sách tệp phụ trợ. Sai
**kiểu** (`tickets_subset` không phải mảng, `base_revision` không phải chuỗi) thì vẫn là
`400` ngay, vì đó là sai ở phía người gửi.

Kết quả job mang thêm `warnings: []` — luôn có mặt, mảng rỗng khi không có gì, để bên gọi
không phải phân biệt "không có cảnh báo" với "bản server này chưa biết field ấy". Cảnh
báo cũng hiện thành một khối `> **Cảnh báo:**` ở đầu `report_md`.

`GET /api/v1/analyze/{job_id}` → một trong:

```json
{"status":"running",   "progress":{"done":3,"total":10}, "current":"WEB-1001"}
{"status":"succeeded", "result":{ "run_id":…, "generated_at":…, "source_revision":…,
                                  "base_revision":…, "changed_files":…, "warnings":[],
                                  "items":[…], "report_md":… }}
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

Judge dùng backend `fci` hoặc `cli` theo `ASTRACODE_JUDGE`. Cả hai giữ bộ lọc,
cache, tiến độ và kết quả từng phần. `tickets[].acceptance_criteria` được đưa vào
prompt; `ref` là SHA đầy đủ thì judge đọc đúng commit đó. Backend `cli` tiếp tục
nhận guide có một verdict; backend `fci` yêu cầu ít nhất hai verdict.

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

### Chọn lọc và cache — bốn field làm mỏng hoá đơn

Một lượt judge là một lượt gọi model. Bốn field dưới đây quyết định lượt nào thật sự
được gửi đi; tất cả đều tuỳ chọn, và tất cả đều được kiểm ngay ở request (`400` kèm tên
field) chứ không để job tự chết giữa chừng.

| Field | Mặc định | Là gì |
|---|---|---|
| `mode` | `"full"` | `"full"` xét mọi ticket; `"selected"` bỏ qua ticket mà tầng grep đã đủ chắc |
| `skip_above` | — | Ngưỡng trong `(0, 1]`. Ticket có `grep_confidence >= skip_above` thì **không** gọi model |
| `cache` | `true` | Dùng lại kết luận đã lưu cho đúng câu hỏi ấy |
| `rules_version` | `""` | Phiên bản bộ rules đang áp. Nằm trong khoá cache: đổi rules là câu hỏi khác |
| `tenant` | `"default"` | Tách tệp cache theo đội |

Hai tổ hợp bị từ chối bằng `400`, và đó là chủ ý: `mode: "selected"` thiếu `skip_above`
(không có ngưỡng thì không biết thế nào là "đã chắc"), và `skip_above` gửi kèm
`mode: "full"` — bị lờ đi im lặng nghĩa là bên gọi tưởng mình đang tiết kiệm trong khi
hoá đơn vẫn đầy đủ.

Ticket bị bỏ qua **vẫn có mặt trong `results`**, dạng:

```json
{ "key": "WEB-1001", "tier": "grep", "verdict": "CODE_AHEAD", "confidence": 0.95,
  "reason": "đã chắc ở tầng grep", "skipped": true }
```

Chú ý nó **không** có `error`. `tier: "grep"` kèm `error` là "đã thử và không kết luận
được"; `tier: "grep"` kèm `skipped: true` là "không cần thử". Hai chuyện khác nhau, và
đọc lẫn nhau thì một bảng 190 dòng trông như 190 lượt hỏng.

### Cache judge — khoá đã bao nội dung code, nên không có TTL

Khoá của một entry gồm:

```
rules_version + model + dấu vân tay của prompt + ticket key
              + hash(summary + description + status)
              + vân tay nội dung những tệp ticket dẫn ra
```

"Dấu vân tay của prompt" là quy ước codebase đang áp (`guidance_path`) cộng ba tham số
`context_lines` / `max_snippets` / `max_snippet_lines`, backend, verdict guide,
acceptance criteria và kết luận sơ bộ của tầng grep. Nó có mặt vì cùng một ticket trên
cùng một đoạn code vẫn là hai câu hỏi khác nhau nếu prompt khác: bên gọi nới
`max_snippets` đúng lúc họ muốn một câu trả lời tốt hơn, và trả lại kết luận rẻ tiền của
lần trước là kiểu hỏng không ai nhìn thấy.

"Vân tay nội dung" là `sha256` của danh sách `<đường dẫn>` + blob id của tệp ấy tại
revision đang xét, sắp theo đường dẫn và bỏ trùng. Blob id lấy từ
`git cat-file --batch-check` — một tiến trình cho cả job, không phải một lần gọi `git`
cho mỗi đường dẫn. Tệp không tồn tại ở revision ấy vẫn vào vân tay dưới dạng
`<missing>`: một dẫn chứng trỏ vào tệp vừa bị xoá là thay đổi thật, và bỏ qua nó thì
"đã xoá" với "chưa từng có" cho cùng một khoá. `lines` và `note` **không** vào khoá —
sửa một dòng ở đầu tệp đẩy mọi số dòng phía dưới đi một bậc, trong khi nội dung tệp đã
nằm sẵn trong vân tay.

Ðánh đổi của chỗ ấy, nói thẳng ra: với cùng một tệp không đổi, hai `lines` khác nhau
trích ra hai đoạn code khác nhau nhưng cho cùng một khoá. Chuyện này không xảy ra khi
tầng grep của bên gọi giữ nguyên — cùng nội dung tệp thì nó chỉ ra cùng chỗ. Nếu bên
gọi **đổi cách chọn cửa sổ dòng**, hãy bump `rules_version`: đó là cần gạt để nói "từ
đây là một câu hỏi khác", và nó nằm trong khoá.

Ðổi bất kỳ thành phần nào là một khoá khác, nên **cache không bao giờ trả lời thay cho
code đã đổi**. Ðiều KHÔNG còn đúng nữa là chiều ngược lại: một commit mới không còn tự
động là miss. Commit chỉ chạm ba tệp thì chỉ những ticket dẫn ra ba tệp ấy phải hỏi lại
model — 164 ticket trên một board thật trước đây tốn 12 phút và ~700k token cho mỗi
commit, gần hết trong số đó để nhận lại đúng kết luận cũ.

Cũng vì thế không có TTL: một entry sáu tháng vẫn trả lời đúng câu hỏi của nó, vì đoạn
code ấy vẫn là đoạn code ấy. Hết hạn theo thời gian ở đây chỉ tạo ra những lượt gọi lại
không đổi kết quả.

**Cache đời đầu vẫn sống.** Khoá cũ có `repo_url` + `revision` trong đó. Job tra khoá mới
trước, trượt thì tra khoá cũ; một lần trúng khoá cũ được trả về ngay **và** chép sang
khoá mới bằng một dòng append, nên lần sau nó là hit v2. Không dòng nào bị xoá, không
tệp cache nào bị viết lại, và không dòng nào được ghi dưới khoá cũ nữa. Mỗi kết quả nói
ra nó đến từ đâu: `"cache_hit": "v2" | "legacy"`.

Chỗ lưu: `<WORKSPACE_DIR>/judge-cache/<tenant>.jsonl` (tên tenant được lọc về ký tự an
toàn; nếu phép lọc làm mất ký tự nào thì tên tệp mang thêm tám ký tự băm, để `"Đội A"` và
`"Nội A"` không dùng chung một tệp), mỗi entry một dòng JSON, append
thêm chứ không sửa. Một job bị giết giữa lúc ghi chỉ làm dở dòng cuối, và dòng hỏng bị
bỏ qua lúc nạp. **Chỉ lượt thành công được lưu**: một lỗi mạng mười giây mà vào cache sẽ
thành kết luận vĩnh viễn cho ticket ấy trên đoạn code ấy.

Dòng trúng cache trả về đúng kết luận cũ, kèm `"cached": true` và `"cache_hit"` —
cùng một kết luận, nhưng không cùng một lần xét, và bên gọi có quyền biết điều đó.

Dọn đĩa (việc duy nhất phải làm tay):

```bash
curl -sS -X DELETE "http://127.0.0.1:8000/api/v1/judge/cache?older_than=30d"   -H "Authorization: Bearer $ASTRACODE_SERVICE_TOKEN"
# → {"older_than":"30d","files":2,"kept":412,"removed":88}
```

`older_than` nhận `<số><s|m|h|d>` và **bắt buộc**: dọn mù cả cache là vứt đi tiền đã
trả, nên nó phải được nói ra. Dung lượng đang chiếm khai ở `/healthz`:

```json
"judge_cache": { "tenants": 2, "entries": 500, "entries_v2": 340, "entries_legacy": 160,
                 "bytes": 184320 }
```

(`entries: null` nghĩa là có tệp quá lớn nên không đếm dòng — một liveness probe không
được phép đọc 50 MB mỗi lần gọi. `entries_v2` / `entries_legacy` chia số ấy theo phiên
bản khoá, và cũng là `null` khi tệp lớn tới mức không đáng `JSON.parse` từng dòng trong
một probe.)

### Prompt: gọn có chủ ý

Mặc định gửi cho model là **3 mảnh code, mỗi mảnh ±20 dòng quanh dòng khớp** (trần 41
dòng), và phần mô tả ticket cắt ở **600 ký tự** kèm ghi chú đã cắt. Bản đầu (12 dòng ngữ
cảnh, 6 mảnh, 120 dòng mỗi mảnh) cho một ticket mang tới 720 dòng vào prompt, trong khi
thứ quyết định verdict gần như luôn nằm ở vài chục dòng quanh chỗ khớp.

Ðo trên một ticket 6 dẫn chứng, mỗi dẫn chứng trích 160 dòng: **9 695 → 2 046 token
(giảm 78.9%)**. `test/promptBudget.test.mjs` canh ngưỡng 40%; xuống dưới ngưỡng thì ca
ấy rơi để có người xem lại. Bên gọi vẫn nới lại được cho một job riêng bằng `options`
(`context_lines`, `max_snippets`, `max_snippet_lines`) — nhưng mặc định phải là bản rẻ,
vì mặc định mới là thứ chạy 190 lần mỗi đêm.

### Lỗi gateway: thử lại đúng nhóm, và có ngân sách thời gian

Danh sách thử lại là `429, 502, 503, 504, 522, 524` — hạn mức, cộng nhóm 5xx nghĩa là
"proxy không nói chuyện được với origin lúc này". **Không có 4xx** (một `400` thử lại bốn
lần là 15 giây mất trắng cho mỗi ticket của cả một đêm), không có `500` (có thể là lỗi tất
định do chính payload) và không có `525`/`526` (sai cấu hình TLS, thử lại không bao giờ thành).

`524` vào danh sách vì một sự cố thật: một ticket chết với `FCI trả 524: <!DOCTYPE html>`
sau 125 giây, và vì mã ấy chưa được nhận nên cả lượt mất trắng. Hai thứ đi kèm bản sửa:

- **Ngân sách thời gian (`deadlineAt`).** 15 giây trong bảng chờ là tổng thời gian NẰM CHỜ.
  Một `429` trả về tức thì nên hai con số gần bằng nhau; một `524` thì mất 125 giây mới
  biết là hỏng, nên bốn lần thử là hơn tám phút cho một ticket. Hết `timeout_sec` thì thôi
  không thử tiếp, dù còn lượt.
- **Thân lỗi HTML được gọi đúng tên.** Gateway hỏng giữa đường trả về một trang HTML; cắt
  300 ký tự đầu của nó cho ra `<!DOCTYPE html>`, một dòng không nói gì. Giờ log ghi
  `gateway trả trang HTML — "524: A timeout occurred" (không phải câu trả lời của model)`.

### 429: chờ theo `Retry-After`, không đoán

Gặp `429` (hoặc `503`), server chờ rồi thử lại tối đa 4 lần — tức **tối đa 5 lượt gọi**
cho một ticket. Thời gian chờ lấy từ header `Retry-After` nếu nhà cung cấp gửi (số giây
hoặc một mốc thời gian); không có thì rơi về bảng **1s/2s/4s/8s**. `Retry-After` đòi chờ
quá 60 giây thì bỏ, vì chờ chừng ấy là treo cả job còn AstraQA chạy lại rẻ hơn.

Mỗi lần phải chờ vì `429` được đếm vào `progress.throttled` — thứ trả lời câu "chạy chậm
vì server hay vì nhà cung cấp đang chặn".

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
  "progress": {
    "done": 12, "total": 40, "skipped": 150,
    "cached": 30, "cached_v2": 26, "cached_legacy": 4,
    "model_calls": 13, "token_in": 24180, "token_out": 5210, "throttled": 1
  },
  "source_revision": "<sha đã clone>",
  "results": [
    { "key": "WEB-1001", "verdict": "MATCH", "confidence": 0.82, "reason": "…", "tier": "ai" },
    { "key": "WEB-1002", "verdict": "CODE_AHEAD", "reason": "đã chắc ở tầng grep", "tier": "grep", "skipped": true },
    { "key": "WEB-1003", "verdict": "MATCH", "confidence": 0.82, "tier": "ai", "cached": true, "cache_hit": "v2" },
    { "key": "WEB-1004", "tier": "grep", "error": "…" }
  ],
  "stats": { "judged": 11, "failed": 1, "no_snippet": 0, "hits_429": 0, "duration_ms": 41230,
             "cache_hits": 30, "cache_hits_v2": 26, "cache_hits_legacy": 4, "cache_upgrades": 4 }
}
```

`cached` giữ nguyên nghĩa cũ — **tổng** số lượt lấy từ cache, đúng tên trường AstraQA
đang đọc. `cached_v2` và `cached_legacy` chia tổng ấy theo phiên bản khoá đã đọc được,
và cộng lại đúng bằng `cached`. `cache_upgrades` là số dòng khoá cũ vừa được chép sang
khoá mới trong lần chạy này; lần chạy kế tiếp trên cùng dữ liệu, con số ấy phải là 0 và
`cached_legacy` chuyển hết sang `cached_v2`.

**`total` là số lượt THẬT SỰ gọi model**, không phải số ticket gửi lên. Một job 190
ticket mà 150 đã chắc ở tầng grep và 30 trúng cache thì chỉ còn 10 lượt phải chờ — một
thanh tiến độ chạy tới 190 ở đó là thanh sai, và nó sai theo hướng làm người ngồi xem
tưởng còn lâu mới xong. Số dòng đã có nằm ở `results.length`; `202` lúc tạo job vẫn trả
`total` bằng số ticket gửi lên, vì lúc ấy chưa clone nên chưa đọc được nội dung tệp để
biết cái nào trúng cache.

`token_in`/`token_out` là số nhà cung cấp trả về (`usage`), không phải ước lượng của
server. `model_calls` đếm cả lượt thử lại, vì mỗi lần thử lại cũng là một request thật.

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
cũ dưới một cái nhãn sai. Với backend `fci`, thiếu `FPT_*` thì job `failed` ngay
và nói ra; backend `cli` dùng `ASTRACODE_CLI_PATH` và JWT AstraWork.

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
- **`progress` đếm việc PHẢI LÀM, không phải số dòng trong bảng.** `total` là số lượt thật
  sự phải quét; bốn ô `tickets` / `not_in_subset` / `skipped_quota_limit` / `cancelled` nói
  vì sao nó nhỏ hơn số ticket gửi lên, để bên gọi không phải tự trừ. Bản trước đặt `total`
  bằng số ticket, nên một request 184 ticket kèm `tickets_subset` 8 key báo về
  `{"done":1,"total":184}` — người ngồi xem tưởng còn 183 lượt nữa.
- **Kết quả cũ không bị xoá trong im lặng.** `run_id` do bên gọi đặt mà tên file lấy từ nó,
  nên hai job khác nhau có thể trỏ vào cùng `results/<run_id>.json`. Bản mới vẫn giữ nguyên
  tên (bên gọi lấy bằng `/api/v1/jobs/<run_id>/result`), nhưng bản cũ được chuyển sang
  `.prev` và log ghi một dòng cảnh báo. Cả lý do tồn tại của thư mục này là "kết quả còn
  trên đĩa kể cả khi AstraQA rớt kết nối".
- **Job nằm trong bộ nhớ**, tối đa 200 job. Không DB, không trạng thái trên đĩa. Chỉ job
  **đã đóng sổ** mới bị đẩy ra khi hết chỗ; hết chỗ mà toàn job đang chạy thì `503`. Luật
  này nằm ở `lib/jobs.mjs`, có test riêng ở `test/jobs.test.mjs`.
- **Mỗi request nhận đúng một hồi âm.** Handler trước đây là một `async` truyền thẳng cho
  `createServer`, nên một route ném là một promise bị bỏ rơi: client không nhận gì và treo
  tới khi hết giờ, còn Node coi đó là unhandled rejection và mặc định giết tiến trình. Giờ
  mọi đường ném đều ra `500`, và job đã vào sổ mà chưa kịp chạy thì được bỏ ra — nếu không
  thì cái chỗ ấy mất vĩnh viễn, vì sổ chỉ đẩy job đã đóng sổ. Xem `test/resilience.test.mjs`.
- **`/admin` đòi token, kể cả từ chính máy này.** Loopback từng được miễn, vì trình duyệt
  không gắn `Authorization` vào một lần điều hướng thường — nhưng "chạy trên localhost"
  gồm cả mọi tab đang mở một trang lạ, và trang này liệt kê mọi job, mọi repo, mọi ticket.
  Hệ quả: khi `ASTRACODE_SERVICE_TOKEN` đã đặt, mở `/admin` bằng thanh địa chỉ nhận 401.
  Cách xem:

  ```bash
  curl -s -H "Authorization: Bearer $ASTRACODE_SERVICE_TOKEN" http://127.0.0.1:8000/admin
  ```

  Một lần Bearer đúng thì server đặt cookie `astracode_admin` — HttpOnly, SameSite=Strict,
  **15 phút**, **chỉ cho GET**, và giá trị là chuỗi ngẫu nhiên chứ không phải service token —
  nên sau lần curl đó, mở `/admin` bằng thanh địa chỉ trong 15 phút là được. Hết hạn thì
  curl lại một lần. Xem `lib/adminAuth.mjs`.

  Chưa đặt token thì server ở chế độ dev và mọi route của nó đã mở sẵn, `/admin` cũng vậy.
  `/healthz` luôn mở: nó là cổng cho liveness probe.
- **Log của server xuống đĩa theo ngày, giữ 7 ngày.** Dòng nào không thuộc job nào — banner,
  dòng request, 401, 404 — vào `logs/server-<ngày>.log` thay vì chỉ ra console, vì console
  của một tiến trình chạy nền là nơi không xem lại được. Mọi `.log` trong thư mục đó cũ hơn
  bảy ngày bị xoá, kể cả `logs/<run_id>.log` — nên sau bảy ngày
  `GET /api/v1/jobs/<id>/log` trả 404 cho run đó. `results/` không bị đụng tới.

## Chạy test

`items[].assessment` đánh giá từng acceptance criterion riêng với verdict Jira/source.
Hai chiều khẳng định chịu hai luật khác nhau: `satisfied`/`partial` phải có dẫn chứng
file/dòng còn tồn tại, còn `not_satisfied` thì **không** — một tiêu chí chưa làm tự
nhiên không có dẫn chứng, nên điều kiện của nó là PHẠM VI QUÉT (`scan.complete`, hoặc
một phiên agent đã tự duyệt repo và để lại trace). Thiếu cả hai thì hạ về `unknown`:
"không thấy" chỉ là "chưa nhìn". Bản trước đòi dẫn chứng cho cả chiều âm, nên mọi
`not_satisfied` đều thành `unknown` và `state: "not_implemented"` gần như không bao giờ
đạt tới. Không có bản ghi chạy test thì `test_status: not_run` và tối đa
`implemented_unverified`. `mapping_state`
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
