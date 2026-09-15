/**
 * Dự án và task WBS của người đang đăng nhập — nguồn cho hai ô chọn ở panel chat.
 *
 * ## Vì sao AstraCode cần biết hai thứ này
 *
 * Board "Năng suất" của AstraWork quy số đo về TỪNG task WBS: bảng
 * `ai_telemetry_points` có cột `task_id`, và `GET /productivity/tasks` dựng bảng
 * từ đó. Số của AstraCode trước giờ đi lên mà không khai task nào, nên tất cả
 * rơi vào rổ "unassigned" — đúng nhưng vô dụng, vì không ai trả lời được "task
 * này tốn bao nhiêu token".
 *
 * ## Hai ràng buộc từ phía gateway, không phải lựa chọn của client
 *
 *   1. **Dự án nằm trong JWT, không phải trong request.** Mọi endpoint đọc
 *      `token.project_id`; không có tham số `project_id` nào để truyền. Đổi dự
 *      án nghĩa là XIN MỘT TOKEN KHÁC (`POST /auth/switch-project/{id}`) rồi
 *      thay token đang giữ. Kéo theo: danh sách task, quyền, và ingest token
 *      của telemetry đều đổi theo — xem `AstraSession.switchProject`.
 *
 *   2. **Chỉ task ở công đoạn `coding` được tính.** `claimed_task_id` trong
 *      `db/telemetry.py` bỏ qua mọi claim trỏ vào task không thuộc
 *      `MEASURED_STAGES`, và bỏ im lặng — số vẫn nhận nhưng rơi về rổ
 *      unassigned. Nên ô chọn ở đây LỌC SẴN, thay vì bày ra một danh sách mà
 *      quá nửa lựa chọn không có tác dụng gì.
 *
 *   3. **`GET /wbs/tasks` trả CẢ BẢNG của dự án, không có tham số lọc người
 *      nhận.** Đó là chủ ý của AstraWork: WBS là sổ chung của dự án chứ không
 *      phải to-do list riêng ai, nên ai cũng đọc được cả bảng (`routers/wbs.py`
 *      nói thẳng điều này). Nhưng ô chọn ở đây là "tôi đang làm việc gì" — bày
 *      task của người khác ra chỉ tạo cơ hội khai nhầm và ghi số vào công của
 *      đồng đội. Nên lọc ở client theo `assignee`, và `assignee` chính là
 *      username (`token.sub`) — xem `update_task` so sánh `task.assignee != user.sub`.
 *
 *   4. **Người được giao việc chỉ sửa được BỐN trường.** `PUT /wbs/tasks/{id}`
 *      cho một assignee thường đổi `status`, `progress`, `resolution`,
 *      `effort_actual` — mọi trường khác trả 403 kèm danh sách trường phạm
 *      luật. Ngày thực tế nằm ngoài bốn trường ấy: nó là quyền của reviewer
 *      (PM/BUL/Admin, người tạo task, hoặc cấp trên của assignee). Đổi lại,
 *      gateway TỰ đóng dấu ngày khi status sang `done`. Nên `reportDone` gửi
 *      ngày một cách lạc quan rồi lùi lại khi bị từ chối — xem ở đó.
 */
import { AuthRequiredError, GatewayUnreachableError, ProviderError } from '../errors.js';

export interface AstraProject {
  id: number;
  name: string;
}

export interface AstraTask {
  id: number;
  /** Mã hiển thị (`wbs_0007`). Rỗng với item cũ chưa có mã. */
  code: string;
  title: string;
  /** Một trong `WBS_STATUSES`: ở đây chỉ còn `todo` và `in_progress`. */
  status: string;
  assignee: string;
  /**
   * Lịch của dòng WBS, `YYYY-MM-DD` hoặc rỗng khi chưa đặt.
   *
   * Đi kèm task ngay từ lần đọc đầu chứ không phải một lời gọi riêng: gateway
   * trả sẵn bốn cột này trong `GET /wbs/tasks`, và khoảng cách giữa kế hoạch
   * với thực tế CHÍNH LÀ thứ làm một WBS có ích. Xin lại chúng bằng một
   * request thứ hai là trả tiền cho dữ liệu đã nằm sẵn trong tay.
   */
  planStart: string;
  planEnd: string;
  /** Gateway tự đóng dấu khi task chuyển sang `in_progress` / `done`. */
  actualStart: string;
  actualEnd: string;
}

/**
 * Một task đọc đầy đủ, cho hộp "Report Done".
 *
 * Khác `AstraTask` đúng ở `resolution`: nó là ô chữ tự do duy nhất mà NGƯỜI
 * ĐƯỢC GIAO việc được phép ghi (xem `update_task`), nên nó là chỗ duy nhất số
 * token/chi phí có thể đậu lại trên dòng WBS — bảng `wbs_tasks` không có cột
 * nào cho hai số ấy. Phải đọc bản đang có trước khi ghi, nếu không mỗi lần báo
 * done là một lần xoá trắng phần người ta đã viết tay.
 */
export interface AstraTaskDetail extends AstraTask {
  resolution: string;
  progress: number;
}

/** Số đo Claude Code đã quy về một task, từ board Năng suất. */
export interface AstraTaskUsage {
  tokens: number;
  costUsd: number;
}

/** Nội dung một lần báo done — đúng những gì hộp thoại cho sửa. */
export interface TaskDoneReport {
  taskId: number;
  planStart: string;
  planEnd: string;
  actualStart: string;
  actualEnd: string;
  tokens: number;
  costUsd: number;
}

export interface TaskDoneResult {
  /**
   * Gateway đã từ chối phần NGÀY vì người khai không phải reviewer của task.
   *
   * Không phải một lỗi: phần còn lại (status, tiến độ, số token) đã ghi xong,
   * và AstraWork tự đóng dấu ngày thực tế. Nhưng người dùng vừa gõ tay một
   * ngày khác, nên im lặng ở đây là để họ tin rằng ngày mình gõ đã lên bảng.
   */
  datesRejected: boolean;
  /** Ngày thực tế SAU khi ghi — đọc từ đáp án, không phải từ ô nhập. */
  actualStart: string;
  actualEnd: string;
}

/** Kết quả đọc task: phần chọn được, và vì sao phần còn lại không có mặt. */
export interface AstraTaskList {
  items: AstraTask[];
  /**
   * Số task ĐANG MỞ của chính người này bị loại vì công đoạn khác `coding`.
   *
   * Có mặt ở đây để UI giải thích được một ô rỗng. Đây là nhầm lẫn tốn thời
   * gian nhất của tính năng này: người dùng thấy task của mình trên board
   * AstraWork nhưng không thấy trong IDE, rồi đi tìm lỗi ở extension — trong
   * khi việc phải làm là đặt công đoạn 製造 cho dòng WBS đó trên web.
   */
  otherStages: number;
}

export interface WorkItemsClientOptions {
  /** Gốc gateway, KHÔNG kèm `/v1`. */
  baseURL: string;
  getToken: () => Promise<string>;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Công đoạn duy nhất mà telemetry được quy về task. Khớp `MEASURED_STAGES`. */
const MEASURED_STAGE = 'coding';

/**
 * Trạng thái được coi là VIỆC CÒN PHẢI LÀM: chưa bắt đầu, và đang làm.
 *
 * `WBS_STATUSES` của AstraWork có năm giá trị — `todo`, `in_progress`,
 * `review`, `done`, `cancel`. Ba giá trị sau là việc đã rời tay người viết
 * code, nên bày ra ô chọn chỉ tạo cơ hội khai vào một dòng đã đóng sổ. Chuỗi
 * rỗng tính là `todo`: cột này mặc định `todo` ở DB, nên rỗng chỉ xảy ra khi
 * đáp án thiếu trường, và "thiếu" gần với "chưa bắt đầu" hơn là "đã xong".
 *
 * Danh sách CHO PHÉP chứ không phải danh sách loại trừ: thêm một trạng thái
 * mới ở AstraWork thì nó vắng mặt ở đây cho tới khi có người quyết định, chứ
 * không tự xuất hiện trong ô chọn của mọi người.
 */
const OPEN_STATUSES = new Set(['todo', 'in_progress', '']);

/**
 * `YYYY-MM-DD`, cùng khuôn với `WbsTaskUpdate` ở gateway.
 *
 * Lọc ở CẢ HAI chiều. Đọc: một chuỗi rác trong cột ngày sẽ hiện ra thành một
 * dòng "Plan … → …" vô nghĩa. Ghi: pydantic từ chối cả request bằng 422, và
 * lúc ấy phần status/token cũng không lên được — một ký tự thừa trong ô ngày
 * làm hỏng cả lần báo done.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Một dòng `WbsTaskEntry` thô thành `AstraTaskDetail`.
 *
 * Ở một chỗ vì hai đường dùng chung nó: danh sách để chọn, và lần đọc lại
 * trước khi báo done. Hai bản sao của phép đọc này là cách chắc chắn để hộp
 * thoại hiện một ngày còn bảng chọn hiện một ngày khác.
 */
function toTask(raw: unknown): AstraTaskDetail {
  const o = (raw ?? {}) as Record<string, unknown>;
  const date = (v: unknown): string => {
    const s = String(v ?? '').trim();
    return ISO_DATE.test(s) ? s : '';
  };
  return {
    id: Number(o.id),
    code: String(o.code ?? ''),
    title: String(o.title ?? ''),
    status: String(o.status ?? ''),
    assignee: String(o.assignee ?? ''),
    planStart: date(o.plan_start),
    planEnd: date(o.plan_end),
    actualStart: date(o.actual_start),
    actualEnd: date(o.actual_end),
    resolution: String(o.resolution ?? ''),
    progress: Number(o.progress ?? 0) || 0,
  };
}

/** Dấu nhận biết dòng do AstraCode viết ra trong `resolution`. */
const USAGE_MARK = 'AI usage (AstraCode):';

/** `resolution` dài quá `WbsTaskUpdate` cho phép sẽ bị từ chối bằng 422. */
const RESOLUTION_MAX = 8_000;

/**
 * Ghi số token/chi phí vào `resolution`, GIỮ phần chữ đang có.
 *
 * Vì sao lại là `resolution`: `wbs_tasks` không có cột nào cho token hay tiền,
 * và trong bốn trường một assignee được phép sửa thì đây là trường duy nhất
 * chứa được chữ. Số thật vẫn nằm ở telemetry — dòng này là bản chụp mà người
 * đọc bảng WBS thấy được mà không phải mở board Năng suất.
 *
 * THAY dòng cũ chứ không nối thêm: báo done hai lần (sửa lại một con số, mở
 * lại task rồi đóng lần nữa) không được để lại hai con số mâu thuẫn nhau trên
 * cùng một dòng WBS, vì lúc ấy không ai biết cái nào mới.
 */
export function withUsageLine(resolution: string, tokens: number, costUsd: number): string {
  const kept = resolution
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith(USAGE_MARK))
    .join('\n')
    .replace(/\s+$/, '');
  const line = `${USAGE_MARK} ${formatTokens(tokens)} tokens · ${formatCost(costUsd)}`;

  // Cắt phần CŨ khi đụng trần, không cắt dòng vừa dựng: mất mấy dòng đầu của
  // một ghi chú cũ còn đỡ hơn gửi đi một con số bị cụt đuôi.
  const room = RESOLUTION_MAX - line.length - 1;
  if (!kept) return line;
  return `${room <= 0 ? '' : kept.slice(Math.max(0, kept.length - room))}\n${line}`;
}

function formatTokens(tokens: number): string {
  const n = Math.max(0, Math.round(Number.isFinite(tokens) ? tokens : 0));
  return n.toLocaleString('en-US');
}

/**
 * Chi phí thành chữ. Dưới 1 đô thì bốn số lẻ, không thì hai.
 *
 * Hai số lẻ cho mọi trường hợp sẽ biến một task nhỏ thành `$0.00` — đúng về
 * mặt làm tròn và vô dụng với người đọc, vì nó đọc ra thành "không tốn gì".
 */
function formatCost(costUsd: number): string {
  const n = Math.max(0, Number.isFinite(costUsd) ? costUsd : 0);
  return `$${n.toFixed(n > 0 && n < 1 ? 4 : 2)}`;
}

export class WorkItemsClient {
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly baseURL: string;

  constructor(private readonly opts: WorkItemsClientOptions) {
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  }

  /** Dự án người này được phép chuyển vào ngay bây giờ. */
  async projects(): Promise<AstraProject[]> {
    const body = await this.get('/projects/mine');
    if (!Array.isArray(body)) return [];
    return body
      .map((raw) => {
        const o = raw as Record<string, unknown>;
        return { id: Number(o.id), name: String(o.name ?? '') };
      })
      .filter((p) => Number.isInteger(p.id) && p.id > 0);
  }

  /**
   * Task **của người này** trong dự án đang mở, đã lọc còn phần đo được.
   *
   * Không có tham số dự án: gateway đọc dự án từ chính token (xem đầu file).
   *
   * `assignee` là username, so sánh không phân biệt hoa thường vì nó đi qua ô
   * nhập của người khác trên web. Truyền chuỗi rỗng thì KHÔNG lọc theo người —
   * chỉ xảy ra khi token không có `sub`, và lúc ấy thà bày cả bảng còn hơn bày
   * một danh sách rỗng không giải thích được.
   */
  async tasks(assignee: string): Promise<AstraTaskList> {
    const me = assignee.trim().toLowerCase();
    const body = await this.get('/wbs/tasks?item_type=wbs');
    if (!Array.isArray(body)) return { items: [], otherStages: 0 };

    // Ba bộ lọc, ba lý do khác nhau — tách ra để mỗi cái còn giải thích được:
    // của tôi (ô này hỏi "tôi đang làm gì"), còn mở (việc đã đóng thì khai vào
    // vô nghĩa), công đoạn coding (gateway lặng lẽ vứt claim ngoài công đoạn).
    const mine = body
      .map((raw) => ({ ...toTask(raw), stage: String((raw as Record<string, unknown>).stage ?? '') }))
      .filter(
        (t) =>
          Number.isInteger(t.id) &&
          t.id > 0 &&
          (!me || t.assignee.trim().toLowerCase() === me) &&
          OPEN_STATUSES.has(t.status),
      );

    return {
      // `resolution` bị bỏ lại ở đây, cố ý: nó là tới 8000 ký tự văn xuôi của
      // dự án cho MỖI dòng, mà danh sách này chỉ để vẽ một ô chọn. Đường duy
      // nhất cần tới nó là `taskDetail`, đọc đúng một task ngay trước khi ghi.
      items: mine
        .filter((t) => t.stage === MEASURED_STAGE)
        .map(({ stage: _stage, resolution: _resolution, progress: _progress, ...task }) => task),
      otherStages: mine.filter((t) => t.stage !== MEASURED_STAGE).length,
    };
  }

  /**
   * Đọc LẠI một task, đầy đủ, ngay trước khi hộp "Report Done" mở ra.
   *
   * Không dùng bản trong danh sách đang giữ vì hai lý do. Bản ấy thiếu
   * `resolution` (bị bỏ ở trên), và nó có thể đã cũ vài giờ — người khác vừa
   * đổi lịch trên web thì hộp thoại phải hiện lịch mới, không phải lịch lúc
   * mở IDE.
   *
   * Gateway KHÔNG có `GET /wbs/tasks/{id}`: cả bảng là endpoint duy nhất, nên
   * đây là một lần đọc cả bảng rồi nhặt một dòng. Chấp nhận được vì nó chỉ
   * chạy khi có người bấm nút, không phải mỗi lượt chat.
   */
  async taskDetail(taskId: number): Promise<AstraTaskDetail> {
    const body = await this.get('/wbs/tasks?item_type=wbs');
    const rows = Array.isArray(body) ? body : [];
    const found = rows.map(toTask).find((t) => t.id === taskId);
    if (!found) {
      throw new ProviderError(`Task #${taskId} is no longer on the WBS of this project.`, 404);
    }
    return found;
  }

  /**
   * Token và chi phí AstraWork đã quy về task này.
   *
   * `days=365` chứ không phải mặc định 90 của gateway: con số này đi vào một
   * BÁO CÁO KẾT THÚC, và một task kéo dài hơn ba tháng mà bị cắt mất phần đầu
   * sẽ báo thiếu — im lặng, vì không có gì trong đáp án nói rằng cửa sổ đã cắt.
   * 365 là trần gateway cho phép.
   *
   * Số này thuộc PHẠM VI của người gọi: gateway trả phần của chính họ, trừ
   * PM/BUL/Admin thì trả cả task. Đó là điều đúng cho một ô "tôi đã tiêu bao
   * nhiêu cho việc này", và người dùng sửa lại được trước khi gửi.
   */
  async taskUsage(taskId: number): Promise<AstraTaskUsage> {
    const body = await this.get(`/productivity/tasks/${taskId}?days=365`);
    const totals = ((body ?? {}) as Record<string, unknown>).totals as
      | Record<string, unknown>
      | undefined;
    return {
      tokens: Math.max(0, Math.round(Number(totals?.tokens ?? 0) || 0)),
      costUsd: Math.max(0, Number(totals?.cost_usd ?? 0) || 0),
    };
  }

  /**
   * Báo task đã xong: đóng dòng WBS và ghi số đo lên nó.
   *
   * Chia làm hai nhóm vì gateway chia làm hai nhóm (xem ràng buộc 4 ở đầu file):
   *
   *   - **Luôn gửi được**: `status`, `progress`, `resolution`. Đây là phần
   *     KHÔNG được phép hỏng — một lần bấm "Report" mà task vẫn đứng ở
   *     `in_progress` là tệ hơn không có nút nào.
   *   - **Chỉ reviewer**: bốn cột ngày. Gửi kèm khi chúng KHÁC bản đang lưu,
   *     và chỉ khi ấy: người dùng không đụng vào ô ngày thì không có gì để
   *     gửi, nên trường hợp thường gặp nhất không bao giờ chạm tới giới hạn
   *     quyền. Bị 403 thì gửi lại nhóm đầu và nói ra — AstraWork tự đóng dấu
   *     ngày hôm nay, việc còn lại là đừng để người dùng tưởng ngày họ gõ đã
   *     lên bảng.
   */
  async reportDone(report: TaskDoneReport): Promise<TaskDoneResult> {
    const task = await this.taskDetail(report.taskId);

    const core: Record<string, unknown> = {
      status: 'done',
      progress: 100,
      resolution: withUsageLine(task.resolution, report.tokens, report.costUsd),
    };
    const dates: Record<string, string> = {};
    const put = (field: string, next: string, current: string): void => {
      if ((ISO_DATE.test(next) || next === '') && next !== current) dates[field] = next;
    };
    put('plan_start', report.planStart, task.planStart);
    put('plan_end', report.planEnd, task.planEnd);
    put('actual_start', report.actualStart, task.actualStart);
    put('actual_end', report.actualEnd, task.actualEnd);

    const path = `/wbs/tasks/${report.taskId}`;
    let datesRejected = false;
    let body: unknown;
    try {
      body = await this.request('PUT', path, { ...core, ...dates });
    } catch (err) {
      // Chỉ 403 mới lùi. 422 là dữ liệu sai và 404 là task biến mất — gửi lại
      // cùng một thứ sẽ hỏng y hệt, và nuốt lỗi đi thì người dùng thấy "đã
      // báo xong" trong khi bảng WBS không đổi gì.
      if (!(err instanceof ProviderError && err.status === 403) || Object.keys(dates).length === 0) {
        throw err;
      }
      datesRejected = true;
      body = await this.request('PUT', path, core);
    }

    const saved = toTask(body);
    return { datesRejected, actualStart: saved.actualStart, actualEnd: saved.actualEnd };
  }

  /**
   * Đổi dự án. Trả về JWT MỚI — phía gọi phải thay token đang giữ, nếu không
   * lần đọc tiếp theo vẫn thấy dự án cũ.
   */
  async switchProject(projectId: number): Promise<string> {
    const body = await this.request('POST', `/auth/switch-project/${projectId}`);
    const token = (body as Record<string, unknown>).access_token;
    if (typeof token !== 'string' || !token) {
      throw new ProviderError('AstraWork did not return a token when switching project.');
    }
    return token;
  }

  private get(path: string): Promise<unknown> {
    return this.request('GET', path);
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseURL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await this.opts.getToken()}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new GatewayUnreachableError(this.baseURL, err);
    }

    if (res.status === 401) {
      throw new AuthRequiredError('AstraWork rejected the session — sign in again.');
    }
    if (!res.ok) {
      // Ba mã, ba câu khác nhau, vì ba việc phải làm khác nhau:
      //
      //   403 — phiên vẫn tốt, quyền thì không. Trước đây nó bị gộp vào 401 và
      //         hiện ra thành "sign in again", đẩy người dùng đi đăng nhập lại
      //         cho một việc mà đăng nhập lại không sửa được. Câu của gateway
      //         (`detail`) nói đúng thiếu quyền gì, nên dùng chính nó.
      //   404 — gateway CŨ hơn extension; việc cần làm nằm ở phía server.
      //   còn lại — nói thẳng mã, không đoán.
      const detail = await readDetail(res);
      throw new ProviderError(
        res.status === 403
          ? (detail ?? `AstraWork did not allow ${path}.`)
          : res.status === 404
            ? (detail ?? `This AstraWork gateway has no ${path} endpoint — it needs an update.`)
            : `AstraWork refused ${path} (HTTP ${res.status})${detail ? `: ${detail}` : '.'}`,
        res.status,
      );
    }

    try {
      return await res.json();
    } catch (err) {
      throw new ProviderError(`AstraWork returned a malformed answer for ${path}.`, res.status, err);
    }
  }
}

/**
 * Câu giải thích của gateway trong `{"detail": "…"}`, nếu có.
 *
 * Không bao giờ ném: đây là đường đang xử lý MỘT lỗi rồi, và một lỗi thứ hai
 * ở đây sẽ thay câu thật bằng "res.json is not a function". Cắt ngắn vì
 * `detail` của FastAPI khi validate hỏng là một mảng JSON dài, và cả mảng đó
 * đổ vào một dòng thông báo trong IDE thì không ai đọc được gì.
 */
async function readDetail(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const detail = body?.detail;
    const text = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : '';
    return text ? text.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}
