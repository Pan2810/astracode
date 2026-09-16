# Luật khớp ticket↔code — trước và sau khi port CANDIDATE_MATCHING_SPEC

Cập nhật 2026-09-16, sau khi cài `CANDIDATE_MATCHING_SPEC.md` của AstraQA
(`lib/candidates.mjs`). Cùng hằng số, cùng stopword, cùng ngưỡng — hai bên khác luật thì
bảng so sánh giữa hai engine vô nghĩa.

> **Bảng dưới đo trên bộ ticket TỔNG HỢP** (`fixtures/tickets-184-gen.md`), không phải 184
> ticket thật của AstraQA. Bảng nghiệm thu §7 (`MATCH 138 · CODE_AHEAD 44 · JIRA_AHEAD 2`)
> **chưa so được** — cần file `tickets_md` thật. Xem mục "Còn thiếu" ở cuối.

## Cách đo lại

```bash
cd tools/astraqa-server
# TRƯỚC: bản code ngay trước khi port spec
git archive 9b9f84f tools/astraqa-server | tar -x -C /tmp/before
cd /tmp/before/tools/astraqa-server
node scripts/measure-matching.mjs --tickets fixtures/tickets-184-gen.md \
  --repo https://github.com/Pan2810/pimathon_coworklocal.git \
  --label TRƯỚC --out /tmp/truoc.json --keep /tmp/repo-spec

# SAU: bản hiện tại, DÙNG LẠI đúng bản clone đó
node scripts/measure-matching.mjs --tickets fixtures/tickets-184-gen.md \
  --repo https://github.com/Pan2810/pimathon_coworklocal.git \
  --label SAU --out /tmp/sau.json --keep /tmp/repo-spec
node scripts/measure-matching.mjs --compare /tmp/truoc.json /tmp/sau.json
```

`--keep` dùng chung là bắt buộc: hai phép đo phải chạy trên đúng một bản clone ở đúng một
revision. Không gọi model, không tốn quota.

## Bảng TRƯỚC → SAU

Repo `Pan2810/pimathon_coworklocal` @ `ce9fc6c63cb8d1514564314344b2d3ca14dc2c67`, 184 ticket
key `GEN-R###` (đúng dạng gây lỗi `gen`), có dòng `PO:/BA:/Developer:` như export Jira thật.

| | TRƯỚC | SAU |
|---|---:|---:|
| Tổng evidence | 776 | **459** (−317) |
| Ticket không có evidence | 0 | **29** (+29) |
| File bị trích nhiều nhất | `__init__.py` **184× (100%)** | `i18n.py` 101× (55%) |
| File khác nhau được trích | 5 | 16 |
| `assets/d3.min.js` | **161×** | **0×** |
| Ticket có `gen` trong terms | **184** | **0** |

`code_status`: `done` 184 → 155, `missing` 0 → **29**.

`verdict` (luật [4]): `CODE_AHEAD` 123 → 104 · `MATCH` 61 → 51 · **`JIRA_AHEAD` 0 → 29**.

### Ticket đổi verdict: 29/184, tất cả đều theo một hướng

| Đổi | Số | Ví dụ |
|---|---:|---|
| `CODE_AHEAD → JIRA_AHEAD` | 19 | `Management`, `Hold Project KickOff Meeting`, `Sprint planning session`, `Quantum blockchain consensus sharding` |
| `MATCH → JIRA_AHEAD` | 10 | cùng nhóm trên |

Không ticket nào đi ngược (không có `JIRA_AHEAD → MATCH`). Nhóm lật sang `JIRA_AHEAD` đúng là
ticket quản trị và ticket vô nghĩa — gồm **cả hai ca thử B và C của spec**.

Số file khác nhau mỗi tiêu đề, bản SAU:

```
 5 file  Cấu hình xác thực người dùng bằng token
 5 file  Thêm bộ nhớ đệm cho kết quả tìm kiếm
 4 file  Chat panel hiển thị lịch sử hội thoại
 3 file  Structure graph view / Folder tab / Model Pricing
 1 file  Routing tự động / Attachment validator / Weekly status report
 0 file  Management · Sprint planning · KickOff Meeting · Quantum blockchain · (ticket tiếng Nhật)
```

## Chỉ báo §7

| Chỉ báo | TRƯỚC | SAU | Đích | |
|---|---:|---:|---|---|
| Ticket không có evidence | 0 | 29 | ≥ 2 | ✅ |
| File bị trích nhiều nhất | 100% | 55% | < 60% | ✅ |
| `.min.js` bị trích | 161× | 0 | 0 lần | ✅ |
| `gen` trong terms | 184 | 0 | không bao giờ | ✅ |
| File khác nhau được trích | 5 | 16 | ≫ 4 (AstraQA 138) | ⚠ |

⚠ **16 không phải giới hạn của engine mà của fixture:** bộ ticket tổng hợp chỉ có **15 tiêu
đề khác nhau** lặp lại 184 lần, nên trần trên của "số file khác nhau" bị chính nó chặn. 184
ticket thật với 184 nội dung khác nhau sẽ trích nhiều file hơn hẳn. Chỉ báo này chỉ đo được
trên dữ liệu thật.

## Ba ca thử §6 — chạy qua HTTP thật

`POST /api/v1/analyze`, `backend=none`, `ref=ce9fc6c…`. `files_scanned = 154` ở cả ba,
khớp đúng con số spec nêu.

| Ca | Kỳ vọng | Kết quả |
|---|---|---|
| **A** `GEN-R169` | khớp, `core/model_pricing.py` đứng đầu | ✅ `done` — `core/model_pricing.py:1`, `core/usage_tracker.py:68`, `config.py:96` |
| **B** `GEN-R999` | shortlist **rỗng** | ✅ `missing`, `evidence: []`, terms `[implement, zero, knowledge, validator]` |
| **C** `COWORKLOCAL-1` | shortlist **rỗng** | ✅ `missing`, `evidence: []`, terms `[management]` |

Tách từ khớp **nguyên văn** kỳ vọng của spec: ca A 10 term thô → 9 sau lọc (bỏ đúng `model`);
ca B 10 → 4 đúng `implement knowledge validator zero`; ca C 1 `management`.

## §5 — đã chọn `rare_term`, và vì sao

Spec đưa ba cách siết chặt cho `backend=none` (vì nó không có judge dọn sau) và bảo dùng ca B
để chọn. Đo cả bốn trên đúng repo/commit spec nêu:

| Chế độ | Ca A | Ca B | Ca C | Recall khi ticket khớp vừa đúng 2 term |
|---|---|---|---|---|
| `none` (y hệt AstraQA) | ✅ | ❌ lọt `ui/cowork_tab.py` | ✅ | 40/40 |
| `min_terms_3` | ✅ | ✅ | ✅ | **0/40** ← vực thẳm |
| **`rare_term`** ← chọn | ✅ | ✅ | ✅ | **40/40** |
| `coverage` | ✅ | ❌ lọt `ui/cowork_tab.py` | ✅ | 40/40 |

Hai chế độ `none` và `coverage` **trượt ca B** — đúng cái false positive mà spec §5 nói
AstraQA được judge cứu còn `none` thì không.

Còn lại hai chế độ đều 3/3 trên ca thử. Phân định bằng recall: mỗi ticket giả lập dựng từ các
định danh đặc trưng nhất của một file có thật, đo ở đúng ranh giới 2/3/4 term khớp.

- `min_terms_3`: ticket khớp **vừa đúng 2** term đặc trưng → **0/40**. Một vực thẳm: mọi
  ticket ngắn mà khớp đúng hai từ hiếm đều mất trắng.
- `rare_term`: **40/40** ở cả ba mức 2, 3 và 4 term. Nó chỉ giết match mà term tốt nhất vẫn
  là từ phổ biến — đúng trường hợp `zero` + `knowledge` của ca B.

Nên `rare_term`: đạt cả ba ca thử mà không đánh đổi recall ở bất kỳ mức nào. Ngưỡng tính theo
`N` (`weight(floor(0.05·N))`) chứ không hardcode 3.14, đúng như spec dặn.

Giá trị nằm ở `TIGHTEN_MODE` cuối `lib/candidates.mjs`, có test khoá.

## Hai chỗ LỆCH spec — cần AstraQA xác nhận

**1. Regex ticket key của spec loại chính ví dụ của spec.** §1.3 viết
`^[A-Za-z][A-Za-z0-9]*-\d+$` nhưng liệt kê `GEN-R169` là hợp lệ. `R169` không phải `\d+`:

```
GEN-R169         regex khớp? KHÔNG  ← mâu thuẫn
COWORKLOCAL-14   regex khớp? CÓ
PRE-001          regex khớp? CÓ
```

`GEN-R###` là dạng key thật của dữ liệu và là ca thử A lẫn B, nên cài theo **ví dụ**: phần sau
dấu `-` phải có ít nhất một chữ số (`^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]*\d[A-Za-z0-9]*$`).
Không nới thành `[A-Za-z0-9]+` vì khi đó mọi từ ghép có gạch nối (`auto-routing`) sẽ thành
"ticket key".

**2. 154 file — suy ra từ việc bỏ file rỗng.** Index thô cho 155; repo có đúng 155 file `.py`
và đúng một file rỗng (`tests/routing/__init__.py`). Bỏ file không có token nào cho **đúng
154**. File rỗng không bao giờ khớp được nên đếm nó vào `files_scanned` là khai khống. Nếu
AstraQA loại nó bằng luật khác (ví dụ bỏ cả `tests/`) thì sửa ở `buildIndex`.

## Một quan sát, chưa sửa

Với ticket tiếng Việt, âm tiết 3 ký tự thành từ khoá và nhiễu nặng: `thu`, `muc`, `qua`,
`cau`, `dung`, `ket`, `thi`, `hien` là tám term sinh ra nhiều evidence nhất ở bản SAU.
Stopword tiếng Việt của spec (§2.1) có 10 từ và không phủ nhóm này. **Chưa thêm gì** — thêm
stopword là lệch spec, và phải do AstraQA quyết để hai bên còn so được.

## Còn thiếu

**File `tickets_md` thật + repo/ref thật của AstraQA.** Có nó là chạy lại đúng hai lệnh ở trên
rồi ra thẳng bảng §7. Không có nó thì mọi con số ở đây chỉ chứng minh engine hành xử đúng
luật, không chứng minh được nó khớp engine nội bộ.
