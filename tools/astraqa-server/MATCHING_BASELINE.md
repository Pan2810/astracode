# Mốc "TRƯỚC" của luật khớp ticket↔code

Chụp ngày 2026-09-16, **trước** khi cài `CANDIDATE_MATCHING_SPEC.md` của AstraQA.
Mục đích: có một con số cố định để so sau khi đổi luật. Chưa sửa dòng code nào.

> Bảng dưới đo trên **bộ ticket tổng hợp** (`fixtures/tickets-184-tonghop.md`), không phải
> 184 ticket thật của AstraQA. Khi có file ticket thật, chạy lại đúng lệnh ở cuối với
> `--tickets <file thật>` để có mốc so sánh đúng.

## Cách đo

```bash
cd tools/astraqa-server
node scripts/measure-matching.mjs \
  --tickets fixtures/tickets-184-tonghop.md \
  --repo https://github.com/psf/requests.git \
  --label "TRƯỚC" --out truoc.json --keep /tmp/repo-do

# sau khi sửa luật, chạy lại với --label "SAU" --out sau.json --keep /tmp/repo-do
node scripts/measure-matching.mjs --compare truoc.json sau.json
```

`--keep` bắt buộc dùng chung cho cả hai lần: hai phép đo phải chạy trên **đúng một bản clone
ở đúng một revision**, nếu không thì chênh lệch đọc được có thể đến từ repo chứ không từ luật.
Script gọi thẳng thư viện, **không gọi model, không tốn quota**.

## Số đo TRƯỚC

Repo `psf/requests` @ `dae7ef63b4df6eded86637f251fc4e3a06c3b479`, 184 ticket.

| | |
|---|---:|
| Tổng evidence | **920** |
| Ticket không có evidence | **0** |
| Số term trung bình mỗi ticket | 6.4 |

**File bị trích nhiều nhất** — đây là triệu chứng cùng loại với `d3.min.js` 89 lần mà AstraQA đo:

| Số lần | File |
|---:|---|
| **184×** | `.github/AI_POLICY.md` |
| **184×** | `.github/CODEOWNERS` |
| 158× | `.coveragerc` |
| 158× | `.git-blame-ignore-revs` |
| 158× | `.github/CODE_OF_CONDUCT.md` |
| 26× | `.github/CONTRIBUTING.md` |

184× nghĩa là **mọi ticket đều trích cùng một file**. Không file nào trong sáu file trên là
code; chúng là metadata kho.

**Từ khoá nào sinh ra evidence** — chỉ có hai, và cả hai đều là rác:

| Số lần | Term | Vì sao là rác |
|---:|---|---|
| 474× | `request` | từ chính tên repo/lĩnh vực, khớp mọi nơi |
| 446× | `pre` | **mảnh của ticket key** `PRE-001`, do `keyParts` tách ra |

| | |
|---|---:|
| `code_status` | `done` 184 |
| Verdict theo luật [4] | `CODE_AHEAD` 123 · `MATCH` 61 · **`JIRA_AHEAD` 0** · `NO_EVIDENCE` 0 |

**`JIRA_AHEAD` = 0.** Không ticket nào còn evidence rỗng, nên tín hiệu mà AstraQA cần không
bao giờ bắn. Đây là hỏng theo hướng ngược với 138 JIRA_AHEAD giả, cùng một gốc: từ khoá rác.

## Bốn chỗ sẽ sửa

Khoanh sẵn, **chưa đụng vào**. Luật/ngưỡng/stopword sẽ lấy nguyên từ `CANDIDATE_MATCHING_SPEC.md`.

| # | Vị trí | Sẽ đổi gì |
|---|---|---|
| 1 | `lib/repoContext.mjs` — `keywordsOf()` | Bỏ `keyParts` (chỉ giữ key nguyên văn). Lọc dòng metadata (`Status:` / `Trạng thái:` …) khỏi `body` trước khi tách token. Thay `STOPWORDS` theo spec. |
| 2 | `lib/repoContext.mjs` — `SKIP_DIRS` / `BINARY_EXT` | Thêm luật loại file minified/vendor (`*.min.js`, `*.min.css`, bundle …). |
| 3 | `lib/repoContext.mjs` — `walk()`, nhánh `e.isFile()` | Chỗ áp bộ lọc file ở trên. |
| 4 | `lib/noneJudge.mjs` — vòng chọn evidence | Ngưỡng độ phủ: một file chỉ thành evidence khi chia sẻ **nhiều hơn một** term. Hiện tại một term trùng là đủ. |

Ghi chú cho [1]: `ticket.body` hiện chứa **cả** dòng `Status: Done` (xem `lib/tickets.mjs`,
`fromHeadings()` — `body: bodyLines.join('\n')`), dù `ticket.status` đã được tách riêng. Đó là
đường mà `status` và `done` lọt vào từ khoá.

## Một điều lệch cần biết trước khi đọc bảng SAU

`code_status` do `judgeWithoutModel()` quyết **trước** khi `keepRealEvidence()` lọc bỏ đường
dẫn không có thật. Với backend `none` thì hai bước luôn khớp vì đường dẫn đến từ chính phép
quét. Nhưng với `fci`, một model chỉ trích đường dẫn bịa sẽ cho ra `code_status: "done"` kèm
`evidence: []`. Cặp đó vô lý khi đọc riêng. Luật [4] không bị ảnh hưởng (backend `fci` có
`scan: null` → `NO_EVIDENCE`, không bao giờ `JIRA_AHEAD`), nên chưa sửa — nhưng đừng đọc
`done` của backend `fci` mà bỏ qua `evidence`.
