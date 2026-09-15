/**
 * Đẩy số đo công việc lên AstraWork qua OTLP (M10, phần 1).
 *
 * AstraWork đã nhận telemetry của Claude Code sẵn: `routers/telemetry.py` +
 * bảng `ai_telemetry_points`, board "Năng suất" đọc ra. AstraCode đẩy đúng bộ
 * metric ấy nên board hiện được số của nó mà không phải sửa gì — chỉ khác tiền
 * tố tên metric (`astracode.` thay vì `claude_code.`), để cột `source` tách
 * được hai công cụ. Giả danh `claude_code.` sẽ chạy được ngay hôm nay và làm
 * hỏng mọi câu hỏi "đường nào tạo ra con số này" về sau.
 *
 * ## Cái KHÔNG bao giờ rời khỏi máy
 *
 * Prompt, nội dung file, tên file, diff. Đây là bộ đếm, không phải nhật ký.
 * Đầu nhận cũng vứt chúng đi (`routers/telemetry.py` cố ý không đọc phần text
 * của log record), nhưng dựa vào đầu kia để giữ kỷ luật cho mình là sai thứ tự
 * trách nhiệm — phía gửi không gửi thì mới chắc.
 *
 * ## Vì sao tự viết thay vì dùng SDK OpenTelemetry
 *
 * Đầu nhận là OTLP/HTTP **JSON** và chỉ chấp nhận 8 tên metric. Kéo cả
 * `@opentelemetry/sdk-metrics` vào để sinh ra một body JSON cố định là thêm
 * hàng chục megabyte dependency vào một extension, cho một thứ dài 100 dòng.
 */
import type { Logger } from './logger.js';

/** Bộ metric đầu nhận chấp nhận (db/telemetry.py ACCEPTED_METRICS). */
export interface UsageSample {
  /** Token vào/ra của một lượt. */
  inputTokens?: number;
  outputTokens?: number;
  /** Chi phí quy đổi USD, nếu biết. */
  costUsd?: number;
  /** Dòng code agent thêm/xoá, sau khi người dùng chấp nhận. */
  linesAdded?: number;
  linesRemoved?: number;
  /** Model đã dùng — thành nhãn, không phải nội dung. */
  model?: string;
}

export interface ToolDecisionSample {
  tool: string;
  decision: 'accept' | 'reject';
}

export interface OtlpExporterOptions {
  /** Gốc gateway, KHÔNG kèm /v1. */
  baseURL: string;
  /**
   * Ingest token (`awtl_…`) từ `POST /telemetry/token`.
   *
   * KHÁC với JWT: đường OTLP xác thực bằng token tĩnh dài hạn vì một exporter
   * chỉ gửi được header cố định — nó không đăng nhập, không làm mới, không thử
   * lại khi bị thách thức.
   */
  ingestToken: string;
  /** Id phiên làm việc, để board gộp theo phiên. Không chứa gì của người dùng. */
  sessionId: string;
  logger: Logger;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Task WBS mà phiên này khai là đang làm, nếu có. */
  taskId?: string;
}

function nowNano(): string {
  // OTLP muốn nanô giây dạng chuỗi. Date.now() chỉ có mili — đủ, vì board gộp
  // theo phút chứ không theo nanô.
  return `${Date.now()}000000`;
}

function sum(name: string, points: { value: number; attrs?: Record<string, string> }[]) {
  return {
    name: `astracode.${name}`,
    sum: {
      // DELTA: mỗi lần gửi là phần TĂNG THÊM, không phải tổng luỹ kế. Gửi luỹ
      // kế mà khai delta sẽ khiến đầu nhận cộng dồn số đã cộng.
      aggregationTemporality: 1,
      isMonotonic: true,
      dataPoints: points.map((p) => ({
        asDouble: p.value,
        timeUnixNano: nowNano(),
        attributes: Object.entries(p.attrs ?? {}).map(([key, value]) => ({
          key,
          value: { stringValue: value },
        })),
      })),
    },
  };
}

export class OtlpExporter {
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;

  constructor(private readonly opts: OtlpExporterOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  }

  private resource() {
    const attrs: { key: string; value: { stringValue: string } }[] = [
      // Đầu nhận đọc cái này để biết công cụ nào gửi (log record không có tiền tố).
      { key: 'service.name', value: { stringValue: 'astracode' } },
      { key: 'session.id', value: { stringValue: this.opts.sessionId } },
    ];
    if (this.opts.taskId) {
      attrs.push({ key: 'astrawork.task', value: { stringValue: this.opts.taskId } });
    }
    return { attributes: attrs };
  }

  /**
   * Gửi số đo của một lượt. Trả `true` khi đầu nhận đã nhận.
   *
   * **Không bao giờ ném.** Telemetry hỏng không đáng làm hỏng lượt chat mà
   * người dùng đang chờ — nó được ghi vào log rồi thôi.
   *
   * Nhưng nó phải NÓI RA là hỏng: phía gọi giữ phần delta chưa gửi được và chỉ
   * xoá khi biết chắc nó đã tới nơi. Một hàm `void` ở đây nghĩa là mọi con số
   * rơi giữa đường đều biến mất không dấu vết, và người dùng nhìn bảng "đã đồng
   * bộ" mà không có gì trên board bên kia.
   */
  async recordUsage(sample: UsageSample): Promise<boolean> {
    const metrics: unknown[] = [];

    const tokenPoints: { value: number; attrs: Record<string, string> }[] = [];
    if (sample.inputTokens) tokenPoints.push({ value: sample.inputTokens, attrs: { type: 'input' } });
    if (sample.outputTokens)
      tokenPoints.push({ value: sample.outputTokens, attrs: { type: 'output' } });
    if (tokenPoints.length > 0) metrics.push(sum('token.usage', tokenPoints));

    if (sample.costUsd) metrics.push(sum('cost.usage', [{ value: sample.costUsd }]));

    const locPoints: { value: number; attrs: Record<string, string> }[] = [];
    if (sample.linesAdded) locPoints.push({ value: sample.linesAdded, attrs: { type: 'added' } });
    if (sample.linesRemoved)
      locPoints.push({ value: sample.linesRemoved, attrs: { type: 'removed' } });
    if (locPoints.length > 0) metrics.push(sum('lines_of_code.count', locPoints));

    // Không có gì để gửi = coi như đã xong: phía gọi không nên giữ lại một
    // delta rỗng để thử lại mãi.
    if (metrics.length === 0) return true;

    return this.post('/telemetry/otlp/v1/metrics', {
      resourceMetrics: [
        {
          resource: this.resource(),
          scopeMetrics: [{ metrics }],
        },
      ],
    });
  }

  /** Đánh dấu bắt đầu một phiên — board đếm số phiên từ đây. */
  async recordSessionStart(): Promise<boolean> {
    return this.post('/telemetry/otlp/v1/metrics', {
      resourceMetrics: [
        { resource: this.resource(), scopeMetrics: [{ metrics: [sum('session.count', [{ value: 1 }])] }] },
      ],
    });
  }

  /**
   * Người dùng duyệt hay từ chối một lời gọi tool.
   *
   * Đây là tín hiệu "AI đề xuất có dùng được không" — thứ duy nhất trong bộ này
   * đo CHẤT LƯỢNG chứ không đo khối lượng. Chỉ có tên tool và quyết định; đối
   * số của lời gọi thì không, vì đối số chính là đường dẫn và nội dung.
   */
  async recordToolDecision(sample: ToolDecisionSample): Promise<boolean> {
    return this.post('/telemetry/otlp/v1/logs', {
      resourceLogs: [
        {
          resource: this.resource(),
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: nowNano(),
                  attributes: [
                    { key: 'event.name', value: { stringValue: 'tool_decision' } },
                    { key: 'tool_name', value: { stringValue: sample.tool } },
                    { key: 'decision', value: { stringValue: sample.decision } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  }

  private async post(path: string, body: unknown): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.opts.baseURL.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.ingestToken}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        this.opts.logger.debug('đẩy telemetry thất bại', { path, status: res.status });
        return false;
      }
      return true;
    } catch (e) {
      // Nuốt có chủ ý — xem chú thích của recordUsage.
      this.opts.logger.debug('đẩy telemetry lỗi', { path, error: (e as Error).message });
      return false;
    }
  }
}
