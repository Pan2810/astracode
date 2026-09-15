# Changelog

## 0.0.44

Lượt chat không còn chết khi agent đọc một file có dòng như `password: string;`, câu trả lời không còn bị lặp khi kết nối rớt giữa chừng, và bạn đổi được model ngay trong khung chat mà không phải mở bảng cài đặt.

**Đọc source có chữ `password` không còn làm chết cả cuộc hội thoại**
- Bản 0.0.43 nói phần che secret đã cứu được lượt kế tiếp. Nó chưa: chính chuỗi thay thế
  `password: [REDACTED:secret-assignment]` vẫn khớp đúng cái luật khiến gateway chặn, nên che xong
  request vẫn bị từ chối y như trước — và vì mọi kết quả tool đều đi qua bước che đó, chỉ cần agent
  đọc một file có dòng `password: string;` là cuộc hội thoại vào đường chết không lối ra
- Chuỗi thay thế giờ không còn khớp luật đó, và phần che được mở rộng để bắt đủ những dạng gateway
  bắt (giá trị có dấu phẩy, dấu chấm phẩy, backtick, hoặc nháy lẻ đôi) — thứ trước đây lọt qua
- Khi gateway thật sự chặn, AstraCode giờ ĐỌC ĐƯỢC lý do thay vì phải đoán: nó che đúng chỗ bị chặn
  ngay trong hội thoại rồi gửi lại, không còn hạ giao thức xuống XML và không còn rút gọn transcript
  — hai việc chẳng liên quan tới nguyên nhân thật
- Vì việc che nay sửa vào chính hội thoại, những lượt SAU đó cũng sạch; trước đây mỗi lượt đều phải
  trả giá bằng một request hỏng cho tới hết phiên
- Nếu vẫn không che được gì mà gateway vẫn chặn, thông báo nêu đúng tên luật đã khớp thay vì một dòng
  `422 status code (no body)`

**Kết nối rớt giữa câu trả lời không còn làm lặp chữ**
- Trước đây một lần rớt mạng giữa lúc model đang viết sẽ khiến AstraCode gửi lại request và phát lại
  toàn bộ đoạn đã viết, nên câu trả lời có hai bản chắp vào nhau — và nếu request đầu đã gọi tool ghi
  file thì lần hai chạy lại hành động đó
- Giờ khi đã có chữ hiện ra thì không thử lại nữa: bạn nhận đúng phần đã viết, kèm một dòng nói rõ đó
  là bản dở và vì sao không tự thử lại

**Lỗi giữa lượt không còn xoá mất việc đã làm**
- Một lượt đã chạy năm tool và sửa hai file, gặp lỗi gateway ở bước thứ sáu, trước đây mất sạch dấu
  vết trong hội thoại dù file trên đĩa vẫn đã đổi — lượt sau agent không biết mình đã làm gì
- Giờ lượt đó kết thúc với trạng thái lỗi nhưng giữ nguyên phần đã làm, kèm thông báo nói rõ nguyên
  nhân; phần văn bản đã hiện ra màn hình cũng ở lại trong hội thoại
- Phiên đã lưu ghi đúng lý do dừng là "lỗi", không còn hiện thành một lượt trả lời bình thường

**Câu trả lời bị cắt giữa chừng nay được nói ra**
- Khi model hết token đầu ra (hoặc bị bộ lọc nội dung chặn), panel hiện một dòng cho biết câu trả lời
  chưa xong — trước đây một câu dở trông y hệt một câu hoàn chỉnh
- Lời gọi tool bị cắt giữa JSON nhận lời nhắc "rút ngắn đối số" thay vì "sai schema, gọi lại cho
  đúng"; lời nhắc cũ bảo model sửa thứ nó không làm sai, nên nó viết lại y nguyên rồi lại bị cắt

**Đổi model ngay trong khung chat**
- Thanh soạn có thêm ô chọn model, cạnh ô chế độ quyền: đổi model cho cuộc hội thoại đang mở mà không
  phải mở bảng cài đặt
- Mỗi model hiện kèm cửa sổ ngữ cảnh, đường gọi công cụ, có đọc được ảnh không, và đã được đo hay
  chưa — đủ để chọn mà không phải sang bảng khác tra
- Lựa chọn này chỉ áp cho cuộc hội thoại đang mở và KHÔNG ghi vào cài đặt; bảng chọn có một dòng
  riêng để đặt nó làm mặc định nếu bạn muốn, và một dòng để quay về mặc định
- Trong khi có lựa chọn đó, mọi lượt chạy bằng đúng model ấy — kể cả chế độ plan và lượt có ảnh
- Model tài khoản không được cấp vẫn hiện trong danh sách nhưng không bấm được, thay vì biến mất
- Không đổi được model giữa lúc một lượt đang chạy; nếu model đã chọn bị gỡ khỏi danh sách giữa phiên,
  AstraCode nói ra rồi quay về mặc định thay vì âm thầm chạy bằng model khác

**Tìm kiếm và đọc file không còn làm treo panel**
- Một mẫu tìm kiếm như `(a+)+` trước đây có thể làm cả panel đứng im vô thời hạn, và nút Stop không
  cắt được; giờ những mẫu dạng đó bị từ chối ngay kèm lời giải thích cách viết lại
- Cùng loại mẫu đó trong `hooks.json` của dự án cũng bị từ chối lúc nạp, thay vì làm treo mỗi lần
  gọi công cụ
- `grep` giờ dừng được thật khi bạn bấm Stop, có trần thời gian, và nói ra mọi lý do kết quả có thể
  thiếu (đạt trần kết quả, hết thời gian, dòng quá dài chỉ khớp phần đầu)
- `read_file` không còn có thể nạp một file vài trăm MB vào bộ nhớ chỉ để trả về một dòng

**Lệnh hết giờ thật sự bị dừng (macOS, Linux)**
- Một lệnh như `npm test` khi hết giờ trước đây chỉ chết tiến trình ngoài cùng, còn các tiến trình con
  vẫn chạy tiếp và tiếp tục giữ cổng hoặc file; giờ cả nhóm tiến trình bị dừng
- Trên Windows hành vi này vốn đã đúng. Đường chạy trong Docker vẫn còn hạn chế tương tự

**CLI hỏi mức tin cậy trước khi cho sửa file**
- `astracode` trong terminal giờ hỏi bạn có tin thư mục đang mở không trước khi cấp công cụ sửa file —
  cùng mức bảo vệ như extension vốn đã có; trước đây clone một repo lạ rồi chạy CLI trong đó là agent
  ghi file được ngay
- Trả lời một lần cho một thư mục, dùng chung với lời hỏi về việc nạp skill/command của repo
- Không có terminal tương tác (chạy trong script, CI) thì phiên chỉ đọc, trừ khi thư mục đã được tin
  cậy từ trước

**Sửa file có dòng bị che không còn bế tắc**
- Khi agent cố sửa đúng dòng mà AstraCode đã che (ví dụ `password: string;`), thông báo giờ nói rõ đó
  là chỗ bị che và chỉ cách neo vào dòng lân cận, thay vì "không tìm thấy, hãy đọc lại rồi thử lại" —
  đọc lại cũng ra bản đã che, nên lời nhắc cũ dẫn agent vào đúng vòng lặp đó

## 0.0.43

AstraCode không còn tự chuyển yêu cầu sửa code sang agent con chỉ đọc, phân biệt đúng lỗi gateway với lượt do người dùng hủy, và không còn dừng ở vòng kế tiếp chỉ vì source auth chứa chuỗi giống credential.

**Không dừng oan sau khi đọc source auth**
- Kết quả `read_file`, grep và các tool khác giờ được che AWS key, JWT, private key, connection string,
  bearer token và phép gán `password`/`token`/`secret` trước khi gửi lại model; gateway không còn chặn
  vòng kế tiếp bằng `422` chỉ vì code chứa chuỗi giống credential
- Nội dung gốc vẫn chỉ hiển thị cục bộ; request gửi model nhận placeholder `[REDACTED:…]`, đúng nguyên
  tắc secret không rời máy
- Nếu AstraWork vẫn trả `422 status code (no body)`, AgentLoop giờ giữ nguyên tiến độ, dựng lại context
  đã redact/rút gọn và retry có giới hạn; nếu cần sẽ thử thêm đường XML đúng một lần, không chạy lại tool
  đã hoàn tất và không thể lặp vô hạn

**Phân biệt lỗi thật với lượt bị hủy**
- Khi gateway từ chối request bằng HTTP 4xx như `422`, panel giờ giữ đúng trạng thái lỗi và không còn
  gắn thêm footer `cancelled` như thể bạn đã bấm Stop

**Không tự delegate yêu cầu sửa code**
- Tool `task` chỉ được gửi lên model khi chính người dùng yêu cầu delegate, dùng subagent hoặc gọi đích
  danh một agent; các yêu cầu `fix`, `implement`, `refactor` thông thường tiếp tục chạy ở agent chính
- Agent con vẫn giữ ranh giới chỉ đọc; mô tả tool nói rõ không dùng nó để sửa file hoặc chạy test

## 0.0.42

Tool result không còn có thể chiếm gần hết hoặc vượt cả cửa sổ context, và bạn thấy được bao nhiêu token đang được cache rẻ hơn ở lượt gần nhất.

**Trần cắt tool result tính theo context còn trống thật, không còn cố định**
- Trần cắt tool result (đọc file, grep...) giờ tính lại tại thời điểm gọi, dựa trên phần context
  THẬT SỰ còn trống của lượt hiện tại — đầu lượt còn nhiều chỗ thì gần như không cắt, cuối một lượt
  dài đã dùng nhiều context thì trần co lại đúng bằng phần còn trống
- Trước đây trần luôn cố định ~6.3k token cho mọi lượt: model cửa sổ nhỏ có thể bị cắt oan ngay từ
  tool call đầu tiên dù context lúc đó còn trống, hoặc ở trường hợp xấu nhất trần đó còn vượt quá cả
  cửa sổ (8k token trở xuống), khiến gateway từ chối cả lượt vì tràn ngữ cảnh

**Thấy được token đã được cache**
- Mục "Context breakdown" trong bảng cài đặt giờ hiện kèm số token được nhà cung cấp tính giá rẻ hơn
  nhờ cache prompt ở lượt gần nhất, ngay cạnh dòng Messages

**Bảo mật MCP nhất quán hơn**
- Tool của MCP server chạy không cách ly (không qua sandbox Docker) giờ luôn phải hỏi duyệt lại mỗi
  lần gọi, không còn bị chế độ "Accept edits" hay một lần "always allow" trước đó bỏ qua — cùng mức
  bảo vệ như tool bash/python

## 0.0.41

Model giờ tra được symbol và bán kính ảnh hưởng qua CodeGraph thay vì phải grep rồi đọc cả file — cùng một câu hỏi mà tốn ít token hơn hẳn.

**Tra symbol và bán kính ảnh hưởng không cần đọc file**
- Tool mới `find_references`: tìm nơi định nghĩa và mọi nơi dùng một symbol (hàm, class, biến,
  type), kể cả khi bị import với tên khác (alias) — điều grep không làm được
- Tool mới `impact_of`: cho biết sửa một file sẽ ảnh hưởng tới file nào khác (đi ngược theo
  import), để xem trước bán kính ảnh hưởng trước khi bắt tay sửa
- Cả hai chỉ trả về vị trí (đường dẫn + dòng), không trả nội dung file, nên tốn ít token hơn nhiều
  so với việc grep rồi phải đọc cả file để xác nhận
- Hỗ trợ TypeScript/TSX, JavaScript, Python, Go; ngôn ngữ khác hoặc symbol không tìm thấy thì model
  tự quay lại dùng grep

## 0.0.39

Bắt đầu đo được phần token được nhà cung cấp tính giá rẻ hơn nhờ cache prompt, và một lượt chat trên CLI giờ luôn dùng đúng một model từ đầu tới cuối.

**Đo chi phí token và chọn model ổn định hơn**
- AstraCode giờ ghi nhận số token được nhà cung cấp tính giá rẻ hơn nhờ cơ chế cache prompt phía họ (khi
  gateway trả về) — nền tảng để các bản sau đo và giảm chi phí token thật, hiện chưa hiển thị trên giao diện
- Trên CLI, một lượt chat giờ luôn dùng đúng một model từ đầu tới cuối, không còn khả năng model bị đổi
  giữa các bước xử lý trong cùng một lượt

## 0.0.38

Bấm "Sign in" khi bị đăng xuất giữa lượt chat giờ đăng nhập thật ngay, không còn phải bấm hai lần.

**Đăng nhập lại sau khi bị văng giữa lượt**
- Bấm nút "Sign in to AstraWork" trong thông báo lỗi giờ mở thẳng trình duyệt để đăng nhập lại, không
  còn chỉ mở bảng cài đặt rồi bắt bấm thêm một nút Sign in khác ở trong đó
- Bảng cài đặt không còn hiện một dòng đỏ "Sign in to AstraWork again" đứng cạnh nút Sign in thật mà
  không bấm được gì — dễ nhầm là nút, bấm vào thì không có gì xảy ra
- Panel nhận biết ngay khi phiên hết hạn giữa lượt chat, thay vì phải đợi bạn vô tình làm việc khác
  (đổi vùng chọn trong editor, mở bảng cài đặt) mới thấy đúng trạng thái hiện tại

## 0.0.37

Model hỏi bạn chọn giữa các phương án qua nút bấm, thay vì liệt kê "A. ... B. ..." rồi chờ bạn gõ lại chữ. Pin cũng đi kèm đúng câu hỏi thay vì dính sang lượt sau, và bôi đen trong editor hiện gợi ý ghim ngay trong panel.

**Hỏi người dùng chọn phương án**
- Một tool mới cho model hỏi qua nút bấm trong khung chat. Khi có vài nguyên nhân hoặc vài cách sửa cụ thể để
  chọn, bạn bấm một nút thay vì gõ lại câu chữ. Tool chỉ dùng cho câu hỏi có lựa chọn đếm được (2–4 phương
  án); câu hỏi mở vẫn hỏi bằng lời thường
- Mỗi hộp một câu, một lựa chọn thì bấm là gửi luôn. Nhiều câu hoặc chọn nhiều có nút Submit riêng để tránh
  gửi dở
- Bấm Dừng giữa chừng hoặc đóng panel không để lại hộp còn nút bấm sống — mọi đường chốt cũng gỡ hộp và mở
  khóa ô nhập. Model được báo rõ là không có câu trả lời, không suy diễn nhầm một câu trả lời vốn không có
- Nhãn webview gửi lên không được tin thẳng: lọc bỏ nhãn lạ không nằm trong đúng lựa chọn đã đưa ra, câu
  không chọn nhiều chỉ giữ lựa chọn đầu tiên bấm, và lệch số câu hỏi thì coi như không trả lời được thay vì
  ghép bừa vào câu hỏi sai
- Tóm tắt trên timeline nói rõ ba tình huống khác nhau — `đã trả lời` (và `2/3 đã trả lời` khi nhiều câu),
  `chưa trả lời — đã dừng`, `không hỗ trợ ở đây` — thay cho một chữ "lỗi" chung nuốt mất sự khác biệt giữa
  huỷ và không hỗ trợ

**Pin đi kèm đúng lượt, và gợi ý ghim ngay trong panel**
- Pin giờ là một-lần-mỗi-lượt, giống ảnh đính kèm: đi kèm đúng câu hỏi vừa gửi rồi biến mất khỏi composer, không còn dính sang câu hỏi sau như bản trước. Trước đó một pin đã ghim cứ nằm ở ô nhập cho tới khi bạn xoá nó, nên dễ quên và gửi cùng cả câu kế tiếp như thể đó cũng là phần muốn hỏi
- Nội dung pin chuyển từ system prompt (chỉ thị nền chung) sang gắn vào đầu câu hỏi của lượt đó (tin nhắn `user`) — rõ nó thuộc về câu hỏi hiện tại thay vì một chỉ thị nền lướt qua được. Bạn không còn cần nói thêm "đọc đoạn đã ghim" vì model đã thấy nó ngay trong chính tin nhắn đang trả lời
- Bôi đen một đoạn trong editor giờ hiện gợi ý "Pin …" ngay trên ô nhập trong panel chat, bấm là ghim — không cần mở menu chuột phải "AstraCode: Add to Chat" mỗi lần. Đổi tab hoặc bỏ chọn thì gợi ý cũng tự khép theo
- Pin đã gửi giờ hiện lại trong bong bóng của lượt — xem lại đúng cái gì đã đi kèm câu hỏi đó (chỉ đọc, không có nút bỏ: lượt đã gửi rồi thì không sửa lại được nữa)

## 0.0.36

Ghim file/đoạn code vào chat, và đồng hồ context cập nhật ngay trong lúc model đang trả lời.

**Ghim file/đoạn code vào chat**
- Bôi đen một đoạn code (hoặc không chọn gì để lấy cả file) rồi bấm chuột phải → "AstraCode: Add to
  Chat" để ghim đúng phần đó vào hội thoại đang mở. Model dùng ngay nội dung đã ghim, không cần tự gọi
  lại `read_file` cho đúng phần đó nữa — tiết kiệm cả lời gọi tool lẫn token
- Pin hiện thành chip phía trên ô nhập, kèm tên file và khoảng dòng nếu chỉ ghim một đoạn. Bấm × trên
  chip để bỏ pin bất cứ lúc nào
- File không đọc được (bị chặn như `.env`, đã xoá khỏi đĩa...) hiện rõ lý do ngay trên chip thay vì âm
  thầm không có nội dung nào tới được model
- `/clear` hoặc mở lại một hội thoại cũ sẽ xoá hết pin đang gắn — pin thuộc về đúng hội thoại đang mở,
  không mang sang hội thoại khác

**Đồng hồ ngữ cảnh realtime**
- Thanh context giờ nhích dần ngay trong lúc model đang viết câu trả lời, thay vì đứng im rồi nhảy một
  phát khi cả lượt xong. Rõ nhất ở những câu trả lời dài mà không cần gọi tool nào — trước đó đúng
  trường hợp này khiến thanh context trông như bị treo

## 0.0.35

Lượt dài tự giải phóng ngữ cảnh ngay khi đang chạy, thay vì đợi bạn gửi thêm một câu mới.

**Tự nén trong lượt dài**
- Một lượt đọc nhiều file, tìm kiếm hoặc chạy nhiều tool liên tiếp giờ tự nén giữa các vòng khi sắp đầy
  context. Trước đó việc nén chỉ chạy trước lượt kế tiếp, nên lượt hiện tại vẫn có thể tràn và bạn phải gõ
  thêm “tiếp tục” mới kích hoạt được
- Ranh giới nén giữ nguyên các lời gọi tool cùng kết quả tương ứng, kể cả khi một lượt phải nén nhiều lần;
  lịch sử gửi lên model không còn bị cắt thành cặp thiếu
- Ngưỡng cảnh báo và ngưỡng nén riêng của từng model được dùng thống nhất trước lượt, trong lượt và trên
  đồng hồ context. Model chưa khai cửa sổ dùng mốc 32k thay cho 8k cũ để tránh nén quá sớm

**Đo ngữ cảnh chính xác hơn**
- Ước lượng context phân biệt code/ASCII với tiếng Việt, tính cả lời gọi tool và ảnh đính kèm. Đồng hồ giờ
  hiện phần đã dùng trên cửa sổ thật của model, nên phân số và phần trăm không còn lệch nhau
- Chỉ dẫn thêm cho `/compact` giữ được tối đa 1.000 ký tự, đủ để nhấn mạnh nhiều phần cần bảo toàn trong
  cùng một lần nén mà không làm mất các mục còn lại của bản tóm tắt

## 0.0.34

Lượt có nhiều tool đọc chạy nhanh hơn, và huỷ giữa lượt không còn làm hỏng lịch sử hội thoại.

**Chạy tool đọc song song**
- Một lượt gọi nhiều tool đọc cùng lúc (ví dụ `grep` + `read_file` + `list_dir`) giờ chạy đồng thời thay
  vì nối tiếp — phản hồi nhanh hơn rõ rệt khi agent cần dò nhiều file. Lượt trộn cả tool ghi vẫn chạy tuần
  tự như trước, không đổi
- Huỷ lượt (Ctrl+C) giữa hai lời gọi tool, hoặc ngay trong lúc một lời gọi đang chạy, không còn để sót
  lời gọi chưa được trả lời trong lịch sử — trước đó lịch sử thiếu câu trả lời có thể bị gateway từ chối
  ngay ở lượt kế tiếp, và đôi khi còn bị hiểu lầm thành "model không hỗ trợ native tools"

**Gợi ý file `@mention`**
- Gõ `@` giờ tìm đúng cả khi không khớp hoa thường (gõ `chat` không còn bỏ sót `ChatView.ts`), và chịu
  được gõ tắt rời rạc như ô gợi ý của CLI. Trước đó gợi ý ghép trực tiếp chữ gõ vào mẫu tìm file nên phân
  biệt hoa thường, và trong workspace lớn có thể bỏ sót file khớp vì kết quả bị cắt trước khi lọc gần đúng

## 0.0.33

Sửa: quy trình của dự án không hiện khi gõ `/`.

**Chuẩn agent theo dự án**
- Gõ `/` giờ thấy quy trình do dự án khai, kèm nhãn *project standard*. Trước đó model
  gọi được nó nhưng bạn thì không — hai đường nạp khác nhau, và một đường bị bỏ sót
- Gõ tay `/tên-quy-trình` cũng chạy được, không còn báo không tìm thấy
- Danh sách gợi ý tự dựng lại khi chuẩn dự án về sau lúc mở panel: đăng nhập xong, đổi
  dự án, hoặc lần tự làm mới. Trước đó phải mở lại cửa sổ mới thấy

## 0.0.32

Chuẩn dự án khai được cả **quy trình làm việc**, không chỉ agent khảo sát.

**Chuẩn agent theo dự án**
- Mỗi mục PM khai giờ chọn được một trong hai loại. *Quy trình* được nạp thẳng vào cuộc
  chat của bạn và **sửa được file** (vẫn qua hộp duyệt như mọi thay đổi khác); *khảo sát*
  vẫn chạy tách riêng, chỉ đọc, rồi báo lại kết luận
- Quy trình gọi bằng `/tên` trong ô nhập, hoặc cứ tả việc bằng lời — nó hiện trong danh
  sách gợi ý khi gõ `/`, kèm nhãn *project standard* để phân biệt với skill trong repo
- Bảng cài đặt tách hai danh sách thay vì gộp một rổ: điều bạn cần biết trước khi nhờ
  việc là mục nào sửa được file
- Mục khai từ trước bản này vẫn là *khảo sát*, không đổi hành vi

## 0.0.31

Agent chung của dự án được gọi ra đúng lúc, không cần bạn nhớ tên nó.

**Chuẩn agent theo dự án**
- Mô tả của từng agent giờ đến được model. Trước đó model chỉ thấy TÊN, nên một agent
  chỉ được dùng khi bạn gọi đích danh — nhờ "gỡ xung đột merge giúp" thì nó không biết
  là có `resolving-merge-conflicts` để dùng
- Nhờ vậy chỉ cần tả việc bằng lời thường: khớp mô tả agent nào thì agent đó được gọi

## 0.0.30

Việc đẩy số đo hỏng thì bạn biết ngay, thay vì chỉ có board bên kia thiếu số.

**Số đo lên AstraWork**
- Mục *Usage* hiện một dòng cảnh báo khi số đo không tới được board Năng suất: từ lúc
  nào, vì sao, và bao nhiêu lượt đang nằm chờ gửi lại. Chỉ hiện khi đang hỏng
- Bảng cài đặt không còn bị dựng lại sau mỗi lượt chat cho một nội dung y hệt

## 0.0.29

Số đo đi lên board Năng suất là mặc nhiên, không còn là một ô để bật.

**Bỏ công tắc Productivity board**
- Mục *Preferences* trong bảng cài đặt biến mất cùng với ô bật/tắt, và khoá
  `astra.telemetry` không còn trong settings.json
- Số lượt, token, chi phí và LOC ± của mỗi lượt đi lên AstraWork như một phần bình
  thường của việc dùng công cụ. Nhờ vậy số quy được về đúng task WBS thay vì rơi vào rổ
  "chưa gán"
- Ranh giới không đổi: **prompt, nội dung file và đường dẫn vẫn không rời khỏi máy bạn.**
  Thứ đi lên vẫn đúng những gì mục Usage đang hiện, và vẫn là những gì gateway đã ghi
  vào sổ audit của nó ở mỗi lượt

## 0.0.28

Bộ agent chung của dự án tự đồng bộ và hiện thẳng trong bảng cài đặt — không phải gõ lệnh nào để biết mình đang có gì.

**Chuẩn agent theo dự án**
- Bảng cài đặt có mục **Project agents**: tên từng agent, bản mấy, ai sửa lần cuối. Đây là
  chỗ trả lời câu "máy tôi đang có agent nào" mà không cần mở Command Palette
- Đăng nhập xong là có agent ngay. Trước đó, ai mở VS Code khi chưa đăng nhập rồi mới
  đăng nhập sẽ không thấy agent nào cho tới lần mở lại cửa sổ
- PM sửa chuẩn giữa lúc bạn đang làm thì lượt chat sau đó tự lấy bản mới, không phải
  reload. Việc lấy chạy nền nên không có lượt nào phải chờ thêm
- Nút *Sync now* cho lúc PM vừa báo "tôi sửa xong rồi" và bạn không muốn đợi
- Hai tình huống trước đây im lặng giờ nói rõ ngay tại mục ấy: đang dùng bản cũ vì không
  gọi được AstraWork, và đang đọc từ file thử nghiệm trên máy thay vì từ dự án

## 0.0.27

Dự án khai được bộ subagent dùng chung: cả đội gọi ra cùng một thứ mà không ai phải chép file.

**Chuẩn agent theo dự án**
- Agent do dự án quy định trên AstraWork tự về theo tài khoản đang đăng nhập. Mở VS Code
  lên là gọi được bằng `task`, không phải cài gì thêm, không phải chép `.astra/agents/`
- Đổi dự án là đổi luôn bộ agent — bộ của dự án cũ không ở lại
- Trùng tên với agent trong repo hay trong `~/.astra/agents/` thì **bản của dự án thắng**,
  và lệnh mới *"AstraCode: Show the project agent standard"* cho xem đang chạy bản nào,
  ai sửa lần cuối, và nội dung từng agent
- Mất mạng không làm biến mất bộ agent đang dùng: extension giữ bản lấy được lần cuối
- Nội dung từ dự án vẫn bị cắt theo trần ký tự và bị quét dấu hiệu chèn chỉ thị như mọi
  prompt do người khác viết; có dấu hiệu thì cảnh báo hiện ngay trong khung chat
- Agent con vẫn **chỉ đọc** như trước: nó không sửa file và không chạy lệnh, kể cả khi
  nội dung đến từ dự án

## 0.0.26

Việc đọc ảnh và lập kế hoạch chuyển sang một model riêng, nhanh hơn; việc sửa code vẫn ở model mạnh.

**Hai model, chia theo loại việc**
- Lượt có **ảnh đính kèm** và mọi lượt chạy khi **chế độ plan đang bật** giờ đi tới
  `DeepSeek-V4-Flash`. Sửa file, chạy lệnh, đặt tiêu đề và nén hội thoại vẫn đi tới
  `GLM-5.2`
- Bảng cài đặt có hai ô thay cho một: *Coding model* và *Planning model*. Cả hai vẫn
  chỉ liệt kê model mà tài khoản bạn được cấp. Khoá tương ứng trong settings.json là
  `astra.model` và `astra.planModel`
- Đúng hai tín hiệu quyết định lượt này chạy bằng model nào: bạn có đính ảnh không, và
  chế độ plan có đang bật không. Không có phần đoán ý từ câu chữ — cùng một câu hỏi
  luôn chạy bằng cùng một model, bất kể bạn gõ thế nào
- Lượt nào chạy bằng model lập kế hoạch sẽ nói ra một dòng ngay trong khung chat, để
  chi phí và giọng văn đổi giữa hai lượt liền nhau không thành chuyện khó hiểu
- Ngưỡng nén hội thoại và đường gọi công cụ được tính theo đúng model sắp chạy, không
  phải theo model đang hiện trên thanh trạng thái

## 0.0.25

Lệnh chạy lâu không còn giữ cả lượt chat đứng đợi.

**Tác vụ nền**
- `bash` và `python` nhận thêm lựa chọn chạy nền: một bộ test dài, một `npm run dev`
  hay một tiến trình theo dõi không còn chặn phần còn lại của lượt
- Hai công cụ mới cho agent xem tình trạng và dừng những tác vụ ấy, nên nó theo dõi
  được tiến độ thay vì bắn một lệnh rồi mất dấu
- Tóm tắt kết quả của tác vụ nền hiện gọn trong khung chat, không đổ nguyên output dài
  vào giữa cuộc hội thoại

## 0.0.24

Chọn dự án và task ngay trên ô nhập, và mọi số đo của lượt chat được quy về đúng task đó.

**Dự án và task đang làm**
- Hai ô chọn mới nằm ngay trên ô nhập: dự án AstraWork và task WBS bạn đang làm.
  Cả hai đọc thẳng từ tài khoản của bạn, không phải gõ tay
- Đổi dự án ở đây đổi luôn dự án của phiên AstraWork — danh sách task và danh
  sách model đọc lại theo, giống như bấm đổi dự án trên trang web
- Ô task chỉ liệt kê task ở công đoạn `coding`. Đây không phải cắt bớt cho gọn:
  AstraWork chỉ quy số đo về những task ấy, nên bày các task khác ra là mời bạn
  khai một thứ sẽ bị bỏ qua
- Task đã chọn được nhớ theo từng thư mục làm việc, nên mở lại repo là thấy đúng
  task hôm qua. Task biến mất khỏi danh sách (đã xong, đã đổi công đoạn) thì việc
  khai báo tự gỡ, thay vì im lặng gửi số vào một chỗ không còn tồn tại

**Số đo gửi lên AstraWork**
- Mỗi lượt giờ gửi thêm **số dòng code** agent thêm/xoá và **chi phí**, cạnh số
  token đã có. Board Năng suất đọc được ngay: cùng bộ metric Claude Code đẩy
- Số dòng đếm bằng diff thật, không phải hiệu số dòng — một lượt viết lại 10 dòng
  tại chỗ được tính là 10, không phải 0
- Tất cả đi kèm task đang khai, nên bảng theo task trên AstraWork nói được "task
  này tốn bao nhiêu". Không khai task thì số vẫn lên, chỉ nằm ở rổ chưa gán
- Đổi dự án sẽ xin lại vé gửi số đo. Thiếu bước này thì số của dự án mới lặng lẽ
  chảy vào bảng của dự án cũ

**Tiền tính bằng USD**
- Mục Usage và mọi con số chi phí chuyển sang USD, khớp đơn vị của board Năng
  suất bên AstraWork. Trước đây hiển thị VND, không so được với số bên kia
- Gateway chưa đổi xong thì AstraCode quy đổi bằng đúng tỉ giá gateway đang dùng,
  không phải một tỉ giá tự đặt

## 0.0.23

Không còn gì để cấu hình: cài xong là chạy đúng chỗ, bằng đúng model.

**Một model cho mọi việc**
- Ba ô chọn model (editor, planner, fast) gộp lại còn một. Mọi lượt — lập kế
  hoạch, sửa code, đặt tiêu đề, nén hội thoại — đều đi tới cùng một model
- Mặc định là `GLM-5.2`, không phải đi chọn mới dùng được. Đổi sang model khác
  trong bảng cài đặt vẫn được, danh sách vẫn lấy từ quyền của tài khoản bạn
- Bỏ mục "Automatic": ô này giờ luôn nói tên một model cụ thể, thay vì một lựa
  chọn mà không ai đoán được nó dẫn tới đâu. Model đã chọn mà tài khoản không
  được cấp thì bảng nói thẳng thay vì lặng lẽ nhảy về mặc định

**Địa chỉ AstraWork nằm trong bản cài**
- Hai ô `astra.gateway.baseUrl` và `astra.astrawork.webUrl` bị bỏ. Máy nào cài
  extension cũng nói chuyện với đúng gateway mà không cần ai đưa địa chỉ
- Đổi địa chỉ từ nay là việc của bản phát hành, không phải của từng máy. Đây là
  chủ ý: `.vscode/settings.json` nằm trong repo, nên một ô địa chỉ ở đó là chỗ
  để bất kỳ ai gửi PR trỏ máy người khác đi nơi khác
- Ai đang trỏ vào gateway chạy ở máy mình sẽ mất đường đó

**Nén hội thoại nói ra điều đang làm**
- Lúc nén, panel hiện ngay một dòng "đang nén" và dòng đó Ở LẠI trong hội thoại
  cho tới khi có kết quả. Trước đây chỉ có kết quả hiện ra sau một khoảng đứng
  im, và không có gì nói cho bạn biết vì sao nó đứng
- Dòng ấy được thay bằng kết quả tại chỗ, nên không để lại một câu "đang nén…"
  chết trong hội thoại đọc lại sau này

**Panel chat trắng khi mở**
- VS Code thỉnh thoảng hỏng ở bước đăng ký service worker của webview
  (`Could not register service worker`), và panel nằm im ở một trang lỗi cho tới
  khi bạn tự reload cửa sổ. Giờ AstraCode phát hiện panel không sống dậy và tự
  nạp lại nó, tối đa hai lần

## 0.0.22

Phiên đăng nhập không còn chết sau đúng một giờ: mỗi tin nhắn bạn gửi đẩy hạn ra xa.

**Phiên tự gia hạn**
- Trước đây token hết hạn 60 phút sau lúc đăng nhập, tính từ LÚC ĐĂNG NHẬP —
  đang làm dở cũng bị đá ra. Giờ mỗi lượt chat gia hạn phiên, nên một giờ ấy tính
  từ lần cuối bạn thật sự dùng
- Bỏ AstraCode đấy quá hạn thì vẫn phải đăng nhập lại. Đây là chủ ý: chỉ lượt chat
  mới được tính là đang làm việc, còn các việc chạy nền (nạp danh sách model, tải
  policy, đồng bộ usage) thì không — nếu không, một cửa sổ VS Code bỏ quên sẽ giữ
  phiên sống mãi
- Một lượt agent dài không còn chết giữa chừng vì token hết hạn: phiên được gia
  hạn trước khi chạm hạn, không phải chờ tới lúc gateway trả lỗi
- Mất mạng đúng lúc gia hạn không làm hỏng lượt đang chạy — token cũ còn hạn thì
  vẫn dùng tiếp, lần sau thử lại
- Mất quyền (tài khoản bị vô hiệu hoá, bị gỡ khỏi dự án, đang bị khoá) có hiệu lực
  ở lần gia hạn kế tiếp, thay vì đi theo token cũ tới hết giờ
- Lệnh "Copy AstraWork token" gia hạn trước khi chép: token đó sang CLI, nơi không
  có gì gia hạn nó, nên đưa một token còn ba phút là đưa một thứ chết ngay

## 0.0.21

Cài xong là dùng được: không còn phải đi hỏi địa chỉ AstraWork rồi điền tay.

**Địa chỉ mặc định**
- Gateway API và trang web AstraWork có sẵn giá trị mặc định, nên bản cài mới
  chạy thẳng tới màn hình đăng nhập thay vì chặn ở "chưa điền địa chỉ"
- Hai ô trong bảng cài đặt vẫn còn, để trống nghĩa là "dùng mặc định". Điền vào
  vẫn thắng — chạy gateway ở `localhost:8000` hay trỏ sang môi trường khác đều
  như cũ. CLI dùng chung đúng hai giá trị đó
- Mặc định nằm trong code chứ không phải trường `default` của manifest: bảng
  settings được Marketplace render nguyên văn, nên một địa chỉ ở đó là đăng hạ
  tầng lên trang công khai. Ai tải file `.vsix` về vẫn đọc được địa chỉ trong
  bundle — đây là bớt phơi bày, không phải giấu

## 0.0.20

Hai chỗ thừa trên giao diện bị bỏ đi.

**Cửa đăng nhập**
- Bỏ nút "Open settings" khỏi cửa đăng nhập: khi chưa đăng nhập, cửa đó chỉ có
  đúng một việc để làm, và một nút thứ hai chỉ dẫn người dùng vào một bảng không
  giúp gì cho việc đăng nhập
- Bản cài mới chưa điền địa chỉ gateway VẪN giữ nút đó — ở đó bảng cài đặt đúng
  là việc phải làm tiếp, và cửa này che mất nút bánh răng ở thanh công cụ

**Thanh tiêu đề chat**
- Bỏ menu `...` cạnh nút "Chat history". Mở cài đặt đã có nút bánh răng ngay
  trong panel, xem log vẫn gọi được từ Command Palette
- Có test canh để một mục menu thêm vào sau này không làm nút `...` mọc lại

## 0.0.19

`~/.astra` được chia lại theo vòng đời của dữ liệu, và extension với CLI giờ dùng
chung đúng một thư mục — hệ quả lớn nhất: `/undo` sống qua lần khởi động lại, và
mũi tên lên tìm được câu đã gõ ở bề mặt kia.

**Một nơi cho phiên chat**
- Phiên chuyển từ storage riêng của extension sang `~/.astra/projects/<repo>/`,
  đúng chỗ CLI đọc. Chat trong VS Code xong mở terminal lên là thấy hội thoại đó
- Phiên cũ tự chuyển sang chỗ mới ở lần khởi động đầu tiên; đọc `workspaceRoot`
  ghi trong từng file nên phiên của mọi thư mục từng mở đều về đúng repo của nó
- Mỗi repo một thư mục nên trần "giữ 50 phiên" thành trần của TỪNG repo: làm
  nhiều ở dự án này không còn đẩy phiên của dự án khác ra khỏi đĩa
- Liệt kê hội thoại cũ không còn phải mở mọi file phiên trên máy để lọc

**`/undo` sống qua restart**
- Bản chụp file trước mỗi lượt được ghi vào `~/.astra/file-history/`, nên mở lại
  một hội thoại của tuần trước vẫn hoàn tác được lượt cuối của nó
- Lần hoàn tác đầu tiên trong một hội thoại vừa mở lại có hộp xác nhận: bản chụp
  có thể đã vài ngày tuổi, và ghi đè nó lên file bạn vừa sửa tay là mất việc
- Hoàn tác xong thì bản chụp trên đĩa biến mất theo, không hồi sinh ở lần mở sau

**Lịch sử prompt dùng chung**
- Mũi tên lên trong ô nhập gọi lại câu đã gõ, kể cả câu gõ trong `astracode` ở
  terminal — một lịch sử, hai bề mặt (`~/.astra/history.jsonl`)
- Lọc theo thư mục đang mở, để không phải bấm qua câu hỏi của dự án khác

**Thư mục nhà gọn lại**
- `config.json` → `settings.json` (chép sang máy khác được), thêm
  `settings.local.json` cho phần chỉ đúng trên máy này
- File `token` → `credentials.json`, tách hẳn khỏi settings. Bản cũ vẫn đọc
  được và tự dọn sau lần đăng nhập kế tiếp
- Thêm `state.json` (+ `backups/`): thứ máy tự ghi, tách khỏi thứ người viết
- Model không nhận native tool-calling giờ nhớ ở `state.json` nên CLI và
  extension không phải học lại của nhau bằng một request hỏng
- Dọn dẹp một ngày một lần: bản chụp của phiên đã xoá và cache cũ. Không bao giờ
  đụng settings, credentials, state hay phiên còn trong danh sách
- `ASTRA_HOME` đổi được cả thư mục, như trước

## 0.0.18

Nốt chữ tiếng Việt cuối cùng còn lọt ra chỗ người dùng đọc đã chuyển sang tiếng Anh: trang
mô tả trên Marketplace và các câu báo lỗi/cảnh báo do lớp lõi phát ra.

**Trang mô tả trên Marketplace**
- Tab DETAILS viết lại toàn bộ bằng tiếng Anh — trước đây nó là trang duy nhất còn tiếng
  Việt trong khi cả giao diện trong IDE đã là tiếng Anh
- Sửa vài chỗ mô tả sai thực tế: nút chuyển panel sang thanh bên phải không tồn tại (dùng
  "Move View" của chính VS Code), và tên lệnh trong bài giờ khớp đúng tên hiện ở Command
  Palette (*New chat*, *Chat history*, *Open chat*)
- Sửa đường dẫn ví dụ bị hỏng ở phần dịch đường dẫn sandbox

**Thông báo từ lớp lõi**
- Câu báo lỗi người dùng thấy trong chat và trong hộp thông báo giờ bằng tiếng Anh: hết
  hạn đăng nhập, vượt hạn mức, không kết nối được gateway, token sai định dạng
- Lý do khi một thao tác bị chặn: chế độ Plan, người dùng bấm từ chối, trần chính sách của
  tổ chức
- Cảnh báo hạ cấp quyền sau khi agent đọc phải nội dung nghi prompt injection
- Nhãn sandbox hiện trong chat (`Docker · no network`, `Runs directly on your machine — NO
  isolation`) và lý do khi Docker không khởi động được
- Toàn bộ phần MCP người dùng đọc: danh sách cấu hình bị từ chối, lỗi khởi chạy server, lỗi
  server chết giữa chừng, và dòng mô tả trong hộp duyệt quyền
- Phiên mới trong danh sách hội thoại cũ giờ tên là "New session"

## 0.0.17

Mục Usage hiện đúng con số mà trang cá nhân AstraWork hiện — cùng một số, không phải hai
bản đếm song song.

**Usage lấy số từ AstraWork**
- Ba con số của mục Usage (Turns / Tokens / Cost) giờ đọc từ chính lời gọi mà thẻ
  "AI 利用状況" trên AstraWork dùng, nên chúng không thể lệch nhau: chúng là một
- Bỏ khỏi mục này mọi con số AstraCode tự đếm trên máy — mức dùng của phiên đang mở, tổng
  tích luỹ, phần chờ đẩy. Chúng đếm khác cách AstraWork đếm, nên đặt cạnh nhau chỉ tạo ra
  hai câu trả lời cho một câu hỏi
- Thêm chi phí (VND) — trước đây chỉ AstraWork biết con số này
- Số tự cập nhật sau mỗi lượt chat và khi mở lại bảng; nút "Refresh" cho lúc muốn hỏi ngay
- Dòng phụ nói rõ bao nhiêu lượt trong tổng đến từ AstraCode, để phân biệt được phần làm
  trong IDE với phần chat trên web
- Công tắc đẩy số đo lên board Năng suất tách ra mục riêng: tắt nó không làm mục Usage
  ngừng đếm, vì mục Usage vốn là sổ của gateway chứ không phải của máy này
- Chưa đăng nhập hoặc chưa điền địa chỉ gateway thì mục này nói thẳng còn thiếu gì, thay
  vì hiện số 0

**Cần bản gateway mới**
- Số lượt chạy trong IDE trước đây không được tính vào thẻ trên AstraWork: bộ lọc bên đó
  khớp theo tiền tố `/chat`, còn AstraCode gọi `/v1/chat/completions`. Ai làm cả ngày
  trong VS Code vẫn thấy mình gần như không dùng AI. Bản gateway kèm theo thay đổi này
  tính cả hai nguồn

## 0.0.16

Extension khởi động được khi chưa điền địa chỉ gateway — trước đây nó chết ngay lúc kích hoạt.

**Sửa lỗi kích hoạt**
- Bản cài mới chưa điền `astra.gateway.baseUrl` làm `AstraWorkAuth` ném `Thiếu
  ASTRAWORK_BASE_URL` giữa lúc activate. Đây là hệ quả sót lại của 0.0.14 khi bỏ giá trị
  mặc định: ô trống chuyển từ "không thể xảy ra" thành trạng thái khởi động bình thường,
  nhưng constructor vẫn coi đó là lỗi lập trình
- Hậu quả nặng hơn dòng đỏ ở Runtime Status: activation dừng giữa chừng nên trần chính
  sách tổ chức, sandbox và MCP **không được áp lần nào**. Thứ tự áp trần trước khi dựng
  sandbox vốn là có chủ ý, và lỗi này bỏ qua cả chuỗi đó
- Chưa có địa chỉ gateway giờ là một trạng thái session hợp lệ: không dựng auth/registry/
  provider, và khung chat báo đúng ô còn thiếu thay vì "chưa đăng nhập"
- Trần chính sách vẫn giữ bản cache cuối khi chưa cấu hình, không rơi về mặc định lỏng
  hơn — cùng nguyên tắc đang áp cho trường hợp mất mạng
- Khối khởi động bất đồng bộ có `catch`. Trước đây mọi lỗi trong đó thành unhandled
  rejection: người dùng thấy một extension im lặng không hoạt động, không kèm thông báo nào

**Sửa manifest**
- Gỡ `_comment_endpoints` khỏi `contributes.configuration.properties`. VS Code validate
  mọi entry trong bảng này như một JSON-schema object, nên một chú thích dạng chuỗi báo
  `must be an object` ở Runtime Status suốt hai bản. Nội dung chú thích chuyển lên cấp cao
  nhất của package.json
- Thêm test cho manifest: mọi entry trong `properties` phải là object, mọi khoá phải thuộc
  namespace `astra.`, và hai ô địa chỉ phải không có giá trị mặc định. Cả ba loại sai này
  đều không làm vỡ build, nên chúng chỉ lộ ra khi có người tình cờ mở Runtime Status

## 0.0.15

Trang giới thiệu extension không còn mô tả sai tình trạng bản cài.

**Sửa README**
- Gỡ dòng "Bản 0.0.12 — sửa được code thật" và khối cảnh báo "chưa chạy được với model
  thật". Cả hai đứng nguyên từ 0.0.12 qua hai lần phát hành, nên trang Marketplace mô tả
  một bản cũ hơn hai phiên bản so với thứ người dùng thực sự cài
- README là nội dung Marketplace render nguyên văn — một ghi chú trạng thái nội bộ ở đó
  đọc như tuyên bố chính thức rằng extension chưa dùng được

## 0.0.14

Địa chỉ máy chủ không còn nằm sẵn trong bản cài.

**Phải điền địa chỉ gateway ở lần chạy đầu**
- ⚠️ **Người đang dùng bản cũ cần điền lại.** `astra.gateway.baseUrl` và
  `astra.astrawork.webUrl` nay để trống. Ai chưa từng tự đặt hai ô này đang chạy nhờ giá
  trị mặc định, nên sau khi cập nhật sẽ bị chặn — mở cài đặt AstraCode và điền địa chỉ
  đội vận hành cấp
- Lý do bỏ mặc định: bảng cài đặt được Marketplace render nguyên văn kèm giá trị mặc
  định, nên một địa chỉ nội bộ ở đó là công bố hạ tầng ra Internet
- Khung chat nói rõ "chưa có địa chỉ gateway" thay vì báo "chưa đăng nhập". Trước đây
  thiếu địa chỉ sẽ đẩy người dùng đi bấm một nút không mở được trang nào

## 0.0.13

Dùng được ngay sau khi cài — không còn bước đo model bắt buộc.

**Bỏ yêu cầu đo model**
- Model chưa có capability profile chạy bằng năng lực giả định: native tool-calling, đọc
  được ảnh, cửa sổ ngữ cảnh lấy từ danh sách model của gateway
- Endpoint từ chối `tools` thì AstraCode tự chuyển sang đường XML ngay giữa lượt, ghi nhớ
  cho các lần sau, và nói một dòng trong hội thoại. Phép đo diễn ra trong lúc dùng bình
  thường thay vì trong một bước cài đặt mà ai cũng bỏ qua
- Tách `injectionResistance: unknown` khỏi `low`. "Chưa ai đo" không còn bị xếp cùng chỗ
  với "đã đo và model kém" — chỉ mức `low` đo được mới chặn quyền ghi
- Gỡ banner "chưa đo năng lực model". `astracode measure` giờ là công cụ của người quản
  model trên gateway, không phải bước onboarding của thành viên

**Nén ngữ cảnh nói ra việc mình đang làm**
- Hiện dòng trạng thái sống trong lúc nén. Nén là một lượt gọi model đầy đủ chen vào
  trước lượt của người dùng, và trước đây khoảng đó panel đứng im — trông hệt như treo
- Nén hỏng, bị dừng giữa chừng, hoặc không có gì để nén đều được báo thay vì im lặng
- Phân biệt hai lý do phải rút gọn cơ học: model tóm tắt lỗi, và bản tóm tắt bị chặn vì
  có dấu hiệu prompt injection. Trước đây cả hai hiện cùng một câu, và câu đó nói sai ở
  trường hợp thứ hai — chỗ đáng chú ý nhất lại bị mô tả như một trục trặc kỹ thuật vặt
- CLI có nén ngữ cảnh và lệnh `/compact`. Trước đây nó dồn lịch sử vô hạn rồi ăn lỗi từ
  gateway giữa chừng

**Diff trong hộp duyệt quyền có màu**
- Dòng thêm/xoá có nền theo màu diff của theme đang dùng, cột số dòng làm nhạt để mắt
  bám vào code
- Tool tự khai dạng bản xem trước, nên một script shell có dòng `-x` không còn bị vẽ
  thành dòng bị xoá trong diff

## 0.0.12

Đăng nhập xong là tự quay về VS Code.

**Đường về tự động qua `/ide-auth`** *(cần deploy AstraWork kèm theo)*
- Đăng nhập mở `…/auth/sso/login?next=/ide-auth`. Trang `/ide-auth` mới của AstraWork nhận mã một lần rồi mở `vscode://astracode.astracode/auth?code=…` — hệ điều hành tự kéo VS Code lên trước, extension đổi mã lấy token và trạng thái đổi ngay. Không phải dán gì
- Trang đó cố ý KHÔNG đổi mã lấy token: mã đi qua scheme cục bộ nên chỉ tới được đúng máy đang chạy trình duyệt, và trình duyệt không giữ lại phiên nào cho một lần đăng nhập người dùng thực hiện thay cho IDE
- Không đổi gì ở gateway — `_safe_next()` vốn đã cho phép mọi path nội bộ khác `/login`

**Vẫn chạy khi chưa deploy**
- Chưa có `/ide-auth` thì trình duyệt dừng ở trang login với `?sso_code=` trên thanh địa chỉ. Copy nó, bấm sang VS Code — AstraCode tự nhặt từ clipboard, không cần mở hộp nhập
- Chỉ đọc clipboard trong 5 phút sau khi người dùng tự bấm đăng nhập, và bỏ qua im lặng mọi thứ không phải URL có mã, JWT, hay mã trần

## 0.0.11

Một nguồn model duy nhất, và timeline nói được đã làm gì.

**Gỡ hẳn đường gọi thẳng FPT**
- Mục **Kết nối** biến mất khỏi cài đặt. Model chỉ đến từ tài khoản AstraWork đã đăng nhập — danh sách, quyền dùng từng model và hạn mức đều theo tài khoản đó
- Bỏ `astra.connection` và `astra.fpt.baseUrl`, bỏ luôn FPT API key trong SecretStorage. Đường đó bỏ qua RBAC, audit, redaction và hạn mức; giữ nó lại nghĩa là "chưa đăng nhập" vẫn là một trạng thái chat được, và đó chính là chỗ hỏng
- Hai địa chỉ máy chủ gấp vào mục **Tài khoản** — hiếm khi cần đụng, nhưng xoá hẳn thì người chạy gateway trên máy mình vào ngõ cụt

**Timeline nói input/output như Claude Code**
- Mỗi lần gọi tool là một mốc riêng: `read_file · src/webview/chat.ts · ⌞ 20 dòng`, thay cho `đã chạy: read_file, read_file`
- Tham số lấy theo thứ tự ưu tiên (đường dẫn, mẫu tìm, lệnh); kết quả nhiều dòng thành "N dòng" — dòng đầu của một file hay một kết quả grep hầu như không nói được gì
- Kết quả tool ghép với đúng lời gọi ở cả hai đường: XML ghép theo thứ tự trong message kết quả, native ghép theo `toolCallId`

## 0.0.10

**Khu vực chat thành timeline**
- Mỗi mục là một mốc trên một đường dọc: chấm ở rail, gạch ngang ngắn dẫn vào nội dung. Câu hỏi, khối tool, hộp duyệt quyền, ghi chú và lỗi đều nằm trên cùng một mạch
- Màu chấm nói trạng thái: xanh dương nhấp nháy khi đang chạy, xanh lá khi xong, đỏ khi lỗi, đặc màu focus ở lượt của bạn. Ghi chú và dấu vết phiên cũ dùng chấm nhỏ hơn
- Bỏ viền trái riêng của khối tool và dòng "đã chạy" — rail đã là đường dọc duy nhất, để cả hai thì mắt phải chọn xem đường nào mới là mạch việc

## 0.0.9

**Mở lại phiên cũ hiện gọn**
- Lời gọi tool và kết quả của chúng gộp thành một dòng `đã chạy: read_file, grep` thay vì đổ nguyên văn XML và `<tool_result>` ra màn hình
- Kết quả tool không còn hiện thành bong bóng của người dùng. Ở đường XML chúng được AgentLoop chèn dưới vai `user`, nên khi vẽ lại chúng trông y như lời người dùng từng nói
- Định dạng của message đó giờ nằm trong hằng dùng chung ở core (`XML_TOOL_RESULT_*`), thay vì hai chuỗi rời phải khớp nhau bằng may mắn

**Cửa chắn nói đúng thứ đang thiếu**
- Ở chế độ FPT trực tiếp, cửa mời *Nhập FPT key* thay vì *Đăng nhập AstraWork* — nút cũ dẫn tới một hộp thoại nói "bạn đang ở chế độ khác"

## 0.0.8

**Chọn hội thoại cũ là xong ngay**
- Bấm một dòng trong bảng hội thoại cũ: bảng đóng ngay tại chỗ, chat hiện nội dung hội thoại đó. Không phải bấm Đóng nữa
- Trước đó bảng bật lại ngay sau khi đóng: `resumeSession` gửi lại danh sách ở cuối để cập nhật dấu "đang mở", mà webview coi mọi danh sách là lệnh mở bảng. Giờ payload có cờ `open` tách bạch "mở bảng" khỏi "làm mới dữ liệu"
- Đang chạy một lượt mà chọn hội thoại khác thì báo rõ phải bấm Dừng trước — trước đây nó im lặng không làm gì

## 0.0.7

Một panel duy nhất. Cài đặt vào trong chat, và chat đóng lại khi chưa đăng nhập.

**Bỏ view "Cài đặt" riêng**
- Cài đặt giờ là một lớp phủ trong panel chat, mở bằng nút bánh răng ngay cạnh nút đính kèm. Năm mục: Tài khoản, Mức dùng, Model, Kết nối, Capability profile
- Một bề mặt cài đặt duy nhất là có chủ ý — hai bảng song song sẽ lệch nhau ngay lần đầu ai đó thêm tuỳ chọn vào đúng một bên
- Mục **Mức dùng** hiện số lượt, số token và ngữ cảnh của phiên đang mở. Nó nói rõ đây KHÔNG phải tổng chi tiêu của tài khoản: hạn mức nằm ở gateway và chưa có endpoint để đọc

**Chưa đăng nhập thì không chat được**
- Panel hiện cửa đăng nhập chắn ngang thay vì một ô nhập gõ vào cũng không gửi đi được
- Cửa đó vẫn mở được bảng cài đặt — đó là chỗ đổi endpoint hoặc chuyển sang FPT key
- Đây là lớp UX, không phải lớp bảo mật: tầng lõi vẫn là chỗ chặn thật, không token thì mọi request đều 401

## 0.0.6

Đăng nhập bằng phiên AstraWork, và hai nút thay cho bốn.

**Thanh tiêu đề chat gọn lại**
- Chỉ còn **Hội thoại mới** và **Hội thoại cũ**. Dừng lượt đã có nút ngay cạnh ô nhập; mở tab và cài đặt vẫn gọi được từ Command Palette
- **Hội thoại cũ** mở bảng danh sách phủ lên panel: bấm một dòng để nạp lại, `Esc` để đóng. `/sessions` cũng mở đúng bảng đó thay vì chèn một danh sách chết vào giữa dòng chat

**Đăng nhập bằng phiên có sẵn trên trình duyệt**
- Bấm **Đăng nhập AstraWork** mở `<trang web AstraWork>/login`. Đã đăng nhập Microsoft ở đó rồi thì không phải nhập lại gì
- Nhận cả access token của phiên web lẫn mã SSO một lần — không bắt người dùng phân biệt hai thứ đó
- Có sẵn `vscode://astracode.astracode/auth?token=…` để bỏ hẳn bước dán ngay khi phía web thêm trang deep-link
- Tách địa chỉ gateway API khỏi `astra.astrawork.webUrl` cho trang web. Hai địa chỉ vì đó là hai thứ khác nhau — người dùng đăng nhập ở web, extension gọi API

## 0.0.5

Bộ nhớ, nén ngữ cảnh, hoàn tác (M6). Dùng được cho task dài.

**Nhớ được giữa các lượt**
- `ASTRA.md` ở gốc repo và `~/.astra/ASTRA.md` tự nạp vào prompt mỗi lượt. Sửa xong hỏi tiếp là có hiệu lực ngay, không cần mở lại VS Code
- Lệnh **AstraCode: Sửa ASTRA.md của project** tạo sẵn file mẫu
- File từ repo bị giới hạn 12k ký tự và bị quét injection — nó đi thẳng vào system prompt nên có sức nặng ngang lời của hệ thống, và bạn phải biết khi nó chứa thứ đáng ngờ

**Ngữ cảnh không còn tràn giữa chừng**
- Đồng hồ ngữ cảnh hiện từ 70%, tự nén ở 85%. Dưới ngưỡng thì im lặng — một con số nhấp nháy suốt phiên sẽ bị bỏ qua đúng lúc nó bắt đầu quan trọng
- Nén giữ nguyên vài lượt gần nhất, tóm tắt phần đầu thành mục tiêu / đã tìm hiểu / đã thay đổi / còn dở
- Model tóm tắt lỗi thì lùi về bản rút gọn cơ học, không làm hỏng lượt đang chạy
- Nhắc lại yêu cầu gốc sau mỗi 8 vòng lặp, chống model đi lạc trong task dài

**Hoàn tác và phiên**
- `/undo` đưa file về trạng thái **trước lượt vừa rồi** — không phải trước cả phiên
- Phiên tự lưu sau mỗi lượt; **AstraCode: Mở lại phiên cũ** hoặc `/sessions` để quay lại
- Phiên lưu ngoài repo, không có đường commit nhầm nội dung hội thoại

**Slash command**
- Gõ `/` để chọn lệnh. Dựng sẵn: `/undo`, `/compact`, `/clear`, `/sessions`, `/help`
- Lệnh tự viết ở `~/.astra/commands/*.md`, hỗ trợ `$ARGUMENTS` và `$1`…`$9`
- Lệnh trong repo (`.astra/commands/`) chỉ chạy khi workspace được tin cậy, và hiện nhãn "từ repo"

**Tự kiểm tra sau khi sửa**
- `astra.verifyCommand` (ví dụ `pnpm test`) chạy sau mỗi lượt agent có sửa file. Đỏ thì output được đưa vào hội thoại để agent tự sửa tiếp
- Chỉ nhận lệnh từ cài đặt **người dùng**. Giá trị đặt trong `.vscode/settings.json` của repo bị bỏ qua và có báo — nếu không thì mở một thư mục lạ lên là đủ để chạy lệnh tuỳ ý

**Giới hạn phải biết:** `/undo` không khôi phục được file do lệnh `bash` ghi ra — sandbox ghi thẳng vào workspace, không đi qua lớp theo dõi thay đổi. Xem `documents/adr/ADR-003-checkpoint.md`.

## 0.0.4

Streaming và luồng chạy hiện ra màn hình.

**Streaming ở đường XML**
- Câu trả lời chảy ra theo từng chữ **kể cả với model chưa probe**. Trước đây đường XML — đường mặc định cho mọi model chưa đo — gom cả lượt rồi mới hiện một lần, nhìn từ ngoài hệt như không có streaming
- Thẻ tool bị lọc khỏi dòng chữ ngay khi đang chảy, không nhấp nháy `<grep>` rồi biến mất; thẻ bị cắt ngang hai mẩu cũng không lộ

**Nhìn được agent đang làm gì**
- Dòng trạng thái sống: *Đang suy nghĩ… 4s*, *Đang chạy grep… 2s*, có đếm giây và số bước
- Mỗi bước hiện thành hai dòng: `● grep (pattern: …)` và dòng kết quả `⌞ 12 kết quả · 3 file`. Đóng khối vẫn đọc được cả mạch làm việc, mở ra để xem output thô
- Kết quả tóm tắt theo từng loại tool: số dòng đã đọc, số file khớp, `+3 −1` cho mỗi lần sửa, mã thoát và thời gian cho lệnh shell
- **Output lệnh shell chảy ra ngay trong lúc lệnh còn chạy**, không phải đợi tới khi xong
- Bước lỗi tự mở ra và đổi màu, không phải bấm tìm
- Cuộn lên đọc lại thì không bị giật xuống đáy mỗi khi có token mới

## 0.0.3

Sửa được code thật (M4 + M5). Đây là mốc "dùng được".

**Sửa file**
- `edit_file` — thay đoạn văn bản, ba tầng khớp: chính xác → bỏ qua khác biệt khoảng trắng → lỗi kèm **đoạn gần đúng nhất trong file** để model tự sửa
- `write_file` — tạo file mới. Từ chối ghi đè khi nội dung mới ngắn hơn nhiều so với bản cũ: đó gần như luôn là model xoá mất phần nó chưa đọc
- Ghi bằng `WorkspaceEdit`, không `fs.writeFile` → **Ctrl+Z hoàn tác được**, không ghi đè bản chưa lưu của bạn
- Giữ nguyên kiểu xuống dòng và thụt lề thật của file

**Duyệt quyền**
- Ba chế độ: kế hoạch (chỉ đọc) · hỏi trước khi sửa (mặc định) · tự duyệt sửa file
- Chế độ kế hoạch chặn **ở tầng lõi**, không phải ẩn nút — không có đường nào bấm qua được
- Hộp duyệt hiện diff đầy đủ, dựng bằng `textContent` chứ không markdown
- `bash` không bao giờ được tự duyệt, kể cả khi bật "tự duyệt sửa file"
- "Luôn cho phép" chỉ áp cho thư mục chứa file đó, không phải cả workspace
- **Hạ cấp quyền theo nguồn**: đọc phải nội dung có dấu hiệu injection → phiên tự về "hỏi trước khi sửa" và xoá mọi quyền đã nhớ

**Theo dõi thay đổi**
- Badge `A`/`M`/`D` trong Explorer
- Diff so với bản gốc trước khi agent đụng vào, qua scheme `astra-original:`
- Tô dòng thêm/xoá ngay trong editor
- View **Thay đổi trong phiên**: Xem diff / Nhận / Bỏ từng file, Hoàn tác tất cả

**Chạy lệnh** (tắt mặc định, bật bằng `astra.sandbox`)
- Container Docker: không mạng, rootfs chỉ đọc, bỏ hết capability, chỉ mount workspace
- Không bao giờ tự chuyển từ `docker` sang `host` — Docker hỏng thì tool bash biến mất kèm lý do
- Dịch đường dẫn host ↔ container hai chiều
- Giết cả cây tiến trình khi hết giờ, không chỉ shell
- Không kế thừa biến môi trường của máy bạn
- `todo_write` + checklist tiến độ trong chat

**Chưa có:** lưu phiên, nén context, MCP, skill/subagent.

**Chưa kiểm chứng:** các bảo đảm của container (mạng, rootfs read-only, volume) mới nằm ở `sandbox/docker-compose.yml`, chưa chạy thật lần nào vì máy phát triển chưa có Docker.

## 0.0.2

Chat hoạt động (M2 + M3).

- Panel **Chat**: agent trả lời câu hỏi về codebase bằng `grep` / `glob` / `read_file` / `list_dir`
- Stream từng chữ, nút Dừng hủy giữa chừng
- Khối công cụ thu gọn được: tên, tham số, kết quả
- `@` chèn đường dẫn file; tick để kèm vùng code đang chọn
- Cảnh báo prompt injection ngay trong luồng hội thoại
- Model không có native tool calling tự chuyển sang đường XML
- Đọc file đang mở mà chưa lưu, không đọc nhầm bản cũ trên đĩa
- Output model đi qua DOMPurify trước khi render
- File có thể chứa bí mật (`.env`, khoá riêng, credentials) bị chặn ở tầng công cụ

**Chưa có:** sửa file, chạy lệnh, lưu phiên.

## 0.0.1

Bản đầu tiên cài được. Phạm vi: cấu hình kết nối và chọn model.

- Panel cài đặt: chọn nguồn model (gateway AstraWork / FPT trực tiếp), endpoint, kiểm tra kết nối
- Đăng nhập AstraWork qua Microsoft Entra ID; FPT API key cho chế độ trực tiếp — cả hai lưu trong SecretStorage
- Chọn model theo vai trò editor / planner / fast, kèm bảng năng lực từng model
- Status bar hiện model đang dùng; cảnh báo thường trực khi ở chế độ FPT trực tiếp
- Output channel có log đã lọc secret
- Hai container với hai biểu tượng toggle độc lập (trái + phải), dùng chung provider nên luôn cùng trạng thái
- Nút bật/tắt thanh bên trái và thanh bên phải ngay trên title bar
- Mở được thành tab trong vùng editor để hiện cạnh extension khác
