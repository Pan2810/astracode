/**
 * Task đo khả năng hiểu và định vị trong codebase.
 *
 * Đây là việc agent làm nhiều nhất ở M2 (chưa có tool ghi). Tiêu chí chấm bám
 * vào hai thứ đo được: trả lời có đúng file/hàm không, và có dùng tool để tìm
 * hay chỉ đoán bừa. Đoán trúng mà không đọc gì vẫn tính là trượt — nó không
 * lặp lại được trên repo thật.
 */
import { tinyApi } from '../fixtures/tinyApi.js';
import {
  all,
  answered,
  atMostToolCalls,
  mentionsAll,
  mentionsAny,
  usedTool,
} from '../lib/graders.js';
import type { EvalTask } from '../lib/types.js';

export const codebaseTasks: EvalTask[] = [
  {
    id: 'codebase/find-auth-handler',
    group: 'codebase',
    fixture: tinyApi,
    intent: 'Định vị được hàm xử lý đăng nhập — nghiệm thu chính của M2',
    prompt: 'Hàm nào xử lý authentication trong repo này? Nêu rõ file và đường đi.',
    grade: all(
      answered,
      usedTool('grep', 'glob', 'list_dir'),
      mentionsAll('auth'),
      mentionsAny('routes/auth', 'auth.ts', 'login'),
    ),
  },
  {
    id: 'codebase/password-hashing',
    group: 'codebase',
    fixture: tinyApi,
    intent: 'Đọc được chi tiết cài đặt, không chỉ tên file',
    prompt: 'Mật khẩu được băm bằng thuật toán nào, và có dùng salt không?',
    grade: all(
      answered,
      usedTool('grep', 'read_file'),
      mentionsAny('hmac', 'sha256'),
      mentionsAny('salt', 'randombytes'),
    ),
  },
  {
    id: 'codebase/timing-safe-compare',
    group: 'codebase',
    fixture: tinyApi,
    intent: 'Nhận ra chi tiết bảo mật tinh tế trong code',
    prompt:
      'Trong hàm verifyPassword, việc so sánh được làm thế nào và vì sao lại làm như vậy?',
    grade: all(answered, mentionsAny('timingsafeequal', 'thời gian hằng', 'constant')),
  },
  {
    id: 'codebase/list-routes',
    group: 'codebase',
    fixture: tinyApi,
    intent: 'Tổng hợp thông tin từ nhiều file',
    prompt: 'Liệt kê tất cả HTTP route mà API này expose, kèm method.',
    grade: all(
      answered,
      mentionsAll('/login'),
      mentionsAny('/logout'),
      mentionsAny('/users'),
    ),
  },
  {
    id: 'codebase/entrypoint',
    group: 'codebase',
    fixture: tinyApi,
    intent: 'Tìm điểm khởi động — câu hỏi đầu tiên khi tiếp cận repo lạ',
    prompt: 'File nào là entrypoint của ứng dụng, và nó lắng nghe ở cổng nào?',
    grade: all(answered, mentionsAny('src/index.ts', 'index.ts'), mentionsAny('port', '3000')),
  },
  {
    id: 'codebase/test-coverage',
    group: 'codebase',
    fixture: tinyApi,
    intent: 'Tìm được test và nói đúng phạm vi của chúng',
    prompt: 'Repo này có test không? Test cái gì?',
    grade: all(
      answered,
      mentionsAny('tests/auth.test.ts', 'auth.test.ts'),
      mentionsAny('hashpassword', 'verifypassword', 'mật khẩu', 'password'),
    ),
  },
  {
    id: 'codebase/no-such-thing',
    group: 'codebase',
    fixture: tinyApi,
    intent: 'Nói KHÔNG khi thứ được hỏi không tồn tại, thay vì bịa ra',
    prompt: 'Repo này xử lý thanh toán Stripe ở đâu?',
    grade: all(
      answered,
      mentionsAny('không', 'no ', 'không có', 'không tìm thấy'),
      // Bịa ra một file không tồn tại là kiểu hỏng tệ nhất ở đây.
      (ctx) =>
        /src\/(payment|stripe|billing)/i.test(ctx.text)
          ? { pass: false, reason: 'bịa ra file không tồn tại trong repo' }
          : { pass: true, reason: 'đạt' },
    ),
  },
  {
    id: 'codebase/efficient-search',
    group: 'codebase',
    fixture: tinyApi,
    intent: 'Dùng grep để định vị thay vì đọc tuần tự cả repo — quan trọng với context 32k',
    prompt: 'Hàm listUsers trả về gì?',
    grade: all(
      answered,
      usedTool('grep'),
      atMostToolCalls(4),
      mentionsAny('passwordhash', 'omit', 'loại bỏ', 'không có mật khẩu'),
    ),
  },
];
