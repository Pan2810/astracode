import { describe, it, expect } from 'vitest';
import { WorkItemsClient, withUsageLine } from './WorkItems.js';
import { AuthRequiredError, ProviderError } from '../errors.js';

function client(handler: (url: string, init?: RequestInit) => Response): WorkItemsClient {
  return new WorkItemsClient({
    baseURL: 'https://gw.example/',
    getToken: () => Promise.resolve('jwt'),
    fetchImpl: (url, init) => Promise.resolve(handler(url, init)),
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const task = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 1,
  code: 'wbs_0001',
  title: 'Việc',
  stage: 'coding',
  // Đúng chữ trong `WBS_STATUSES` của AstraWork — không phải `doing`.
  status: 'in_progress',
  assignee: 'quanglb',
  ...over,
});

describe('WorkItemsClient', () => {
  it('gọi /projects/mine và bỏ mục không có id dùng được', async () => {
    let seen = '';
    const c = client((url) => {
      seen = url;
      return json([
        { id: 3, name: 'FNS' },
        { id: 0, name: 'không hợp lệ' },
        { name: 'thiếu id' },
      ]);
    });

    expect(await c.projects()).toEqual([{ id: 3, name: 'FNS' }]);
    // Dấu / thừa ở cuối baseURL không được đẻ ra `//projects/mine`.
    expect(seen).toBe('https://gw.example/projects/mine');
  });

  /**
   * Ràng buộc của gateway, không phải sở thích của client: `claimed_task_id`
   * bỏ IM LẶNG mọi task ngoài công đoạn `coding`. Bày chúng ra ô chọn là mời
   * người dùng khai một task mà số đo sẽ không bao giờ được quy về.
   */
  it('chỉ giữ task ở công đoạn coding', async () => {
    const c = client(() =>
      json([
        task({ id: 1, stage: 'coding' }),
        task({ id: 2, stage: 'design' }),
        task({ id: 3, stage: '' }),
        task({ id: 4, stage: 'coding', code: '', title: 'Chưa có mã' }),
      ]),
    );

    const { items, otherStages } = await c.tasks('quanglb');
    expect(items.map((t) => t.id)).toEqual([1, 4]);
    // `stage` không đi tiếp: đã lọc xong thì nó không còn nói thêm điều gì.
    expect(items[0]).not.toHaveProperty('stage');
    // Hai dòng bị bỏ được ĐẾM, không bị nuốt: ô chọn rỗng phải giải thích được.
    expect(otherStages).toBe(2);
  });

  /**
   * Ô chọn trả lời "tôi đang làm việc gì" — việc đã xong, đã huỷ hoặc đang chờ
   * review đều đã rời tay người viết code. Bày chúng ra chỉ tạo cơ hội khai số
   * vào một dòng đã đóng sổ.
   */
  it('chỉ giữ việc chưa bắt đầu và đang làm', async () => {
    const c = client(() =>
      json([
        task({ id: 1, status: 'todo' }),
        task({ id: 2, status: 'in_progress' }),
        task({ id: 3, status: 'review' }),
        task({ id: 4, status: 'done' }),
        task({ id: 5, status: 'cancel' }),
        // Thiếu trường: cột này mặc định `todo` ở DB nên rỗng gần với "chưa bắt
        // đầu" hơn là "đã xong".
        task({ id: 6, status: '' }),
      ]),
    );

    expect((await c.tasks('quanglb')).items.map((t) => t.id)).toEqual([1, 2, 6]);
  });

  /**
   * Việc đã đóng ở công đoạn khác KHÔNG được tính vào `otherStages`: câu ghi
   * chú "3 việc của bạn nằm ngoài công đoạn coding" mà đếm cả task xong từ
   * tháng trước thì nó chỉ đường sai.
   */
  it('otherStages chỉ đếm việc còn mở', async () => {
    const c = client(() =>
      json([
        task({ id: 1, stage: 'ut', status: 'in_progress' }),
        task({ id: 2, stage: 'ut', status: 'done' }),
        task({ id: 3, stage: 'basic_design', status: 'todo', assignee: 'nguoikhac' }),
      ]),
    );

    const { items, otherStages } = await c.tasks('quanglb');
    expect(items).toEqual([]);
    expect(otherStages).toBe(1);
  });

  /**
   * `GET /wbs/tasks` trả CẢ BẢNG của dự án — AstraWork cố ý bỏ bộ lọc "của tôi"
   * ở server vì WBS là sổ chung. Ô chọn ở IDE thì hỏi "tôi đang làm gì", nên
   * task của người khác lọt vào đây là mời khai nhầm và ghi số vào công đồng đội.
   */
  it('chỉ giữ task được giao cho chính người đang đăng nhập', async () => {
    const c = client(() =>
      json([
        task({ id: 1, assignee: 'quanglb' }),
        task({ id: 2, assignee: 'nguyenvana' }),
        task({ id: 3, assignee: '' }),
        // Người khác gõ tên trên web; hoa thường và khoảng trắng không phải là
        // sự khác biệt về danh tính.
        task({ id: 4, assignee: ' QuangLB ' }),
      ]),
    );

    expect((await c.tasks('quanglb')).items.map((t) => t.id)).toEqual([1, 4]);
  });

  it('không biết mình là ai thì bày cả bảng, không bày danh sách rỗng', async () => {
    // Token thiếu `sub` là chuyện bất thường. Một ô rỗng lúc ấy nói sai rằng
    // người dùng không có việc nào; cả bảng thì ít nhất còn dùng được.
    const c = client(() => json([task({ id: 1, assignee: 'ai-do-khac' })]));
    expect((await c.tasks('')).items.map((t) => t.id)).toEqual([1]);
  });

  it('đổi dự án trả về token mới', async () => {
    let method = '';
    let url = '';
    const c = client((u, init) => {
      url = u;
      method = String(init?.method);
      return json({ access_token: 'jwt-moi' });
    });

    expect(await c.switchProject(7)).toBe('jwt-moi');
    expect(method).toBe('POST');
    expect(url).toBe('https://gw.example/auth/switch-project/7');
  });

  it('đổi dự án mà không có token trong đáp án là lỗi, không phải chuỗi rỗng', async () => {
    const c = client(() => json({ detail: 'gì đó' }));
    await expect(c.switchProject(7)).rejects.toBeInstanceOf(ProviderError);
  });

  it('401 thành AuthRequiredError, không phải lỗi mạng chung chung', async () => {
    const c = client(() => json({ detail: 'hết hạn' }, 401));
    await expect(c.projects()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  /**
   * 404 ở đây nghĩa là gateway CŨ hơn extension. Câu "HTTP 404" đẩy người dùng
   * đi tìm lỗi ở máy mình, trong khi việc cần làm nằm ở phía server.
   */
  it('404 nói rằng gateway cần cập nhật', async () => {
    const c = client(() => json({}, 404));
    await expect(c.tasks('quanglb')).rejects.toThrow(/needs an update/);
  });

  it('đáp án không phải mảng thì trả danh sách rỗng, không ném', async () => {
    const c = client(() => json({ detail: 'không phải mảng' }));
    expect(await c.tasks('quanglb')).toEqual({ items: [], otherStages: 0 });
  });

  /**
   * Lịch về CÙNG danh sách task, không phải một lời gọi thứ hai: gateway đã trả
   * sẵn bốn cột này. Ngày rác bị bỏ về rỗng — một chuỗi lạ trong cột ngày sẽ
   * hiện ra thành một dòng "Plan … → …" vô nghĩa dưới ô chọn.
   */
  it('task mang theo lịch kế hoạch, ngày sai khuôn thành rỗng', async () => {
    const c = client(() =>
      json([
        task({ id: 1, plan_start: '2026-08-10', plan_end: '2026-08-15', actual_start: '2026-08-11' }),
        task({ id: 2, plan_start: '15/08/2026', plan_end: null }),
      ]),
    );

    const { items } = await c.tasks('quanglb');
    expect(items[0]).toMatchObject({
      planStart: '2026-08-10',
      planEnd: '2026-08-15',
      actualStart: '2026-08-11',
      actualEnd: '',
    });
    expect(items[1]).toMatchObject({ planStart: '', planEnd: '' });
  });

  /**
   * `resolution` là tới 8000 ký tự văn xuôi cho MỖI dòng WBS, và danh sách này
   * chỉ để vẽ một ô chọn. Nó chỉ được đọc ở `taskDetail`, đúng một task.
   */
  it('danh sách chọn không mang theo resolution', async () => {
    const c = client(() => json([task({ id: 1, resolution: 'một đoạn dài' })]));
    expect(await c.tasks('quanglb').then((r) => r.items[0])).not.toHaveProperty('resolution');
  });

  /**
   * 403 KHÁC 401. Trước đây hai mã bị gộp thành "sign in again", đẩy người dùng
   * đi đăng nhập lại cho một việc mà đăng nhập lại không sửa được — thiếu quyền
   * thì đăng nhập bao nhiêu lần cũng thế.
   */
  it('403 giữ nguyên câu của gateway, không đòi đăng nhập lại', async () => {
    const c = client(() => json({ detail: 'Not your task' }, 403));
    await expect(c.projects()).rejects.not.toBeInstanceOf(AuthRequiredError);
    await expect(c.projects()).rejects.toThrow('Not your task');
  });
});

describe('withUsageLine', () => {
  it('giữ nguyên chữ đang có và nối dòng số đo xuống dưới', () => {
    expect(withUsageLine('Đã sửa ở PR #12.', 1_234_567, 12.3456)).toBe(
      'Đã sửa ở PR #12.\nAI usage (AstraCode): 1,234,567 tokens · $12.35',
    );
  });

  /**
   * Báo done hai lần (sửa lại một con số rồi gửi lại) không được để hai con số
   * mâu thuẫn nằm cạnh nhau trên cùng một dòng WBS — lúc ấy không ai biết cái
   * nào mới.
   */
  it('thay dòng cũ của chính nó thay vì nối thêm dòng thứ hai', () => {
    const before = 'Ghi chú.\nAI usage (AstraCode): 1,000 tokens · $0.5000';
    expect(withUsageLine(before, 2_000, 1.5)).toBe(
      'Ghi chú.\nAI usage (AstraCode): 2,000 tokens · $1.50',
    );
  });

  /** Hai số lẻ biến một task nhỏ thành `$0.00` — đọc ra thành "không tốn gì". */
  it('dưới một đô thì bốn số lẻ', () => {
    expect(withUsageLine('', 10, 0.0123)).toBe('AI usage (AstraCode): 10 tokens · $0.0123');
  });

  it('resolution rỗng thì không để lại dòng trống ở đầu', () => {
    expect(withUsageLine('', 0, 0)).toBe('AI usage (AstraCode): 0 tokens · $0.00');
  });

  /** Quá 8000 ký tự thì `WbsTaskUpdate` từ chối cả request bằng 422. */
  it('cắt phần cũ khi đụng trần, không cắt dòng vừa dựng', () => {
    const out = withUsageLine('x'.repeat(9_000), 5, 1);
    expect(out.length).toBeLessThanOrEqual(8_000);
    expect(out.endsWith('AI usage (AstraCode): 5 tokens · $1.00')).toBe(true);
  });
});

describe('WorkItemsClient.reportDone', () => {
  /** Đọc lại task, rồi PUT. Trả về [thân request của lần PUT, số lần PUT]. */
  function reportClient(
    stored: Record<string, unknown>,
    put: (body: Record<string, unknown>, attempt: number) => Response,
  ): { client: WorkItemsClient; bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = [];
    const c = client((url, init) => {
      if (init?.method !== 'PUT') return json([task(stored)]);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      return put(body, bodies.length);
    });
    return { client: c, bodies };
  }

  const report = {
    taskId: 1,
    planStart: '2026-08-10',
    planEnd: '2026-08-15',
    actualStart: '2026-08-11',
    actualEnd: '2026-08-16',
    tokens: 1_000,
    costUsd: 2,
  };

  it('đóng task và ghi số đo vào resolution, giữ chữ cũ', async () => {
    const { client: c, bodies } = reportClient(
      { id: 1, resolution: 'Xong phần A.', plan_start: '2026-08-10', plan_end: '2026-08-15' },
      (body) => json({ ...task({ id: 1 }), ...body, actual_start: '2026-08-11', actual_end: '2026-08-16' }),
    );

    const result = await c.reportDone(report);

    expect(bodies[0]).toMatchObject({
      status: 'done',
      progress: 100,
      resolution: 'Xong phần A.\nAI usage (AstraCode): 1,000 tokens · $2.00',
    });
    expect(result).toEqual({
      datesRejected: false,
      actualStart: '2026-08-11',
      actualEnd: '2026-08-16',
    });
  });

  /**
   * Ngày là quyền của reviewer. Không gửi ngày KHÔNG ĐỔI nghĩa là trường hợp
   * thường gặp nhất — người dùng không đụng vào bốn ô ngày — không bao giờ
   * chạm tới giới hạn quyền, nên không bao giờ tốn một lần gửi lại.
   */
  it('chỉ gửi cột ngày đã đổi so với bản đang lưu', async () => {
    const { client: c, bodies } = reportClient(
      {
        id: 1,
        plan_start: '2026-08-10',
        plan_end: '2026-08-15',
        actual_start: '2026-08-11',
        actual_end: '2026-08-16',
      },
      (body) => json({ ...task({ id: 1 }), ...body }),
    );

    await c.reportDone(report);

    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0]!).sort()).toEqual(['progress', 'resolution', 'status']);
  });

  it('gửi cột ngày người dùng vừa sửa', async () => {
    const { client: c, bodies } = reportClient(
      { id: 1, plan_end: '2026-08-01' },
      (body) => json({ ...task({ id: 1 }), ...body }),
    );

    await c.reportDone(report);

    expect(bodies[0]).toMatchObject({
      plan_start: '2026-08-10',
      plan_end: '2026-08-15',
      actual_start: '2026-08-11',
      actual_end: '2026-08-16',
    });
  });

  /**
   * Người được giao việc không phải reviewer: gateway trả 403 kèm danh sách
   * trường phạm luật. Phần status/tiến độ/số đo KHÔNG được hỏng theo — một lần
   * bấm "Report" mà task vẫn đứng ở `in_progress` là tệ hơn không có nút nào.
   */
  it('bị 403 vì cột ngày thì gửi lại phần được phép và nói ra', async () => {
    const { client: c, bodies } = reportClient(
      { id: 1, plan_end: '2026-08-01' },
      (body, attempt) =>
        attempt === 1
          ? json({ detail: "Assignees may only change status/progress (not ['plan_end'])" }, 403)
          : json({ ...task({ id: 1 }), ...body, actual_start: '2026-08-16', actual_end: '2026-08-16' }),
    );

    const result = await c.reportDone(report);

    expect(bodies).toHaveLength(2);
    expect(Object.keys(bodies[1]!).sort()).toEqual(['progress', 'resolution', 'status']);
    // Ngày TRẢ VỀ là ngày gateway tự đóng dấu, không phải ngày trong ô nhập.
    expect(result).toEqual({
      datesRejected: true,
      actualStart: '2026-08-16',
      actualEnd: '2026-08-16',
    });
  });

  /**
   * 422 là dữ liệu sai, 404 là task biến mất: gửi lại cùng một thứ sẽ hỏng y
   * hệt, và nuốt lỗi đi thì người dùng thấy "đã báo xong" trong khi bảng WBS
   * không đổi gì.
   */
  it('lỗi khác 403 thì ném ra, không thử lại', async () => {
    const { client: c, bodies } = reportClient({ id: 1 }, () => json({ detail: 'sai khuôn' }, 422));
    await expect(c.reportDone(report)).rejects.toBeInstanceOf(ProviderError);
    expect(bodies).toHaveLength(1);
  });

  it('task không còn trên bảng thì nói rõ, không PUT vào hư không', async () => {
    const { client: c, bodies } = reportClient({ id: 99 }, () => json({}));
    await expect(c.reportDone(report)).rejects.toThrow(/no longer on the WBS/);
    expect(bodies).toHaveLength(0);
  });
});

describe('WorkItemsClient.taskUsage', () => {
  /**
   * `days=365` chứ không phải mặc định 90 của gateway: con số này đi vào một
   * báo cáo KẾT THÚC, và một task dài hơn ba tháng bị cắt mất phần đầu sẽ báo
   * thiếu mà không có gì trong đáp án nói rằng cửa sổ đã cắt.
   */
  it('hỏi cả năm và đọc totals', async () => {
    let seen = '';
    const c = client((url) => {
      seen = url;
      return json({ task_id: 4, totals: { tokens: 12_345, cost_usd: 1.2345 } });
    });

    expect(await c.taskUsage(4)).toEqual({ tokens: 12_345, costUsd: 1.2345 });
    expect(seen).toBe('https://gw.example/productivity/tasks/4?days=365');
  });

  it('đáp án thiếu totals thành hai số 0, không ném', async () => {
    const c = client(() => json({ task_id: 4 }));
    expect(await c.taskUsage(4)).toEqual({ tokens: 0, costUsd: 0 });
  });
});
