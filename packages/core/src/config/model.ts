/**
 * Model mặc định của AstraCode — HAI model, chia theo loại việc.
 *
 * ## Vì sao hai chứ không phải một, và cũng không phải ba
 *
 * Trước đây có ba ô: `editor`, `planner`, `fast`. Ba ô ấy giả định người dùng
 * biết model nào giỏi việc nào trên gateway của đội, nên hầu như không ai đổi
 * chúng — và ai đổi thì đổi cả ba về cùng một giá trị. Chúng đã được gộp về
 * một.
 *
 * Bản này tách lại đúng MỘT đường chia, và là đường chia đo được chứ không phải
 * đường chia theo lý thuyết: việc đọc ảnh và việc lập kế hoạch đi tới một model
 * nhanh (`DEFAULT_PLAN_MODEL_ID`), việc sửa code đi tới model mạnh
 * (`DEFAULT_MODEL_ID`). Lập kế hoạch và mô tả ảnh là đọc rồi tóm tắt — làm
 * nhiều lượt, mỗi lượt ngắn; sửa code là thứ sai một ký tự thì hỏng cả file.
 *
 * `fast` (đặt tiêu đề, nén hội thoại) vẫn đi cùng model sửa code: nó chạy giữa
 * một lượt làm việc và phải hiểu đúng đoạn hội thoại nó đang nén.
 *
 * ## Vì sao giá trị nằm ở đây chứ không phải `default` trong package.json
 *
 * Cùng lẽ với `endpoints.ts`: extension và CLI phải rơi về CÙNG một giá trị, mà
 * CLI không đọc được manifest của extension. Manifest vẫn khai `default` đúng
 * hai chuỗi này để bảng settings hiện ra giá trị thật thay vì ô trống khó hiểu —
 * `configuration.test.ts` canh cho hai chỗ không lệch nhau.
 *
 * Ô để trống nghĩa là "dùng mặc định này", không phải "chưa cấu hình".
 */
import type { ModelRole } from '../provider/types.js';

/**
 * Model cho việc SỬA CODE — vai `editor` và `fast`.
 *
 * Chuỗi này phải khớp CHÍNH XÁC trường `name` trong `GET /models` của gateway —
 * registry ghép hai nguồn theo id, và ghép theo chuỗi thì "GLM-5.2" với
 * "glm5-2" là hai model khác nhau. Sai một ký tự thì mặc định không khớp model
 * nào, registry lặng lẽ rơi về model dùng được đầu tiên, và không ai biết vì
 * sao lượt chat lại chạy bằng một model khác.
 */
export const DEFAULT_MODEL_ID = 'GLM-5.2';

/**
 * Model cho việc ĐỌC ẢNH và LẬP KẾ HOẠCH — vai `vision` và `planner`.
 *
 * Cùng ràng buộc khớp chuỗi với `DEFAULT_MODEL_ID`: tên phải đúng nguyên văn
 * tên gateway trả về, không phải tên nhà cung cấp đặt trên trang chủ của họ.
 */
export const DEFAULT_PLAN_MODEL_ID = 'DeepSeek-V4-Flash';

/**
 * Model mặc định cho một vai.
 *
 * Một hàm chứ không phải một bảng tra rải rác: mọi nơi cần biết "vai này mặc
 * định chạy bằng gì" đều hỏi ở đây, nên thêm một vai mới là sửa đúng một chỗ.
 */
export function defaultModelForRole(role: ModelRole): string {
  return role === 'planner' || role === 'vision' ? DEFAULT_PLAN_MODEL_ID : DEFAULT_MODEL_ID;
}
