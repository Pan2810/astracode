/**
 * Địa chỉ AstraWork — cố định trong code, MỘT nguồn duy nhất.
 *
 * ## Vì sao không còn ô cấu hình
 *
 * Trước đây hai địa chỉ này đọc được từ ba nơi: `astra.gateway.baseUrl` trong
 * settings.json của VS Code, `~/.astra/settings.json` (và biến môi trường) của
 * CLI, rồi mới rơi về hằng số ở đây. Cả tổ chức dùng đúng một hạ tầng, nên ba
 * đường ấy không phục vụ ai — chúng chỉ tạo ra ba cách để trỏ sai chỗ, và mỗi
 * lần trỏ sai lại hiện ra thành một lỗi mạng khó hiểu ở tận lời gọi HTTP. Tệ
 * hơn: `.vscode/settings.json` nằm trong repo, nên "địa chỉ gateway" từng là
 * thứ mà bất kỳ ai gửi PR cũng đặt lại được cho người khác.
 *
 * Bỏ hết. Đổi địa chỉ bây giờ là sửa file này rồi phát hành lại bản mới — một
 * việc của người vận hành, không phải một ô để ngỏ trên máy mỗi thành viên.
 *
 * ## Điều này KHÔNG giấu được gì
 *
 * Giá trị nằm trong bundle: ai tải `.vsix` về là `grep` ra. Trước đây để hằng
 * số ở đây thay vì `default` trong package.json là để bảng settings trên
 * Marketplace không đăng địa chỉ hạ tầng lên một trang công khai — lý do đó vẫn
 * đúng, và giờ thì bảng settings không còn ô nào để đăng. Thứ duy nhất thật sự
 * bảo vệ gateway vẫn là xác thực ở phía nó.
 */

/**
 * Gateway API. KHÔNG kèm `/v1` — provider tự thêm khi gọi chat completions.
 *
 * Có tiền tố đường dẫn `/wbs`: gateway đứng sau một reverse proxy phục vụ nhiều
 * ứng dụng trên cùng một host. Mọi lời gọi phải NỐI THÊM vào chuỗi này
 * (`${baseURL}/models`), không được thay cả path — `new URL('/models', baseURL)`
 * sẽ cho ra `https://api…/models` và mất `/wbs`, rồi hỏng thành 404 ở tận lời
 * gọi HTTP.
 */
export const GATEWAY_BASE_URL = 'https://api.astrawork.fptnearshore.com';

/** Trang web AstraWork, nơi đăng nhập. Khác endpoint API ở trên. */
export const ASTRAWORK_WEB_URL = 'https://astrawork.fptnearshore.com';

/**
 * Trang đăng nhập — thứ mở ra khi bấm "Sign in to AstraWork".
 *
 * Ghép sẵn ở đây thay vì để mỗi bề mặt tự nối chuỗi: extension và CLI phải mở
 * đúng một trang, và một dấu `/` lệch nhau là một trang 404 mà chỉ một bên gặp.
 */
export const ASTRAWORK_LOGIN_URL = `${ASTRAWORK_WEB_URL}/login`;
