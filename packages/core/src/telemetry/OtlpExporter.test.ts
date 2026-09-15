/**
 * Test cho việc đẩy số đo lên AstraWork (M10).
 *
 * Hai nhóm bất biến, và nhóm thứ hai là lý do file này tồn tại:
 *
 *   · shape đúng thứ đầu nhận chấp nhận (sai một chữ là dữ liệu bị vứt im lặng),
 *   · KHÔNG có nội dung nào của người dùng lọt ra ngoài máy họ.
 */
import { describe, it, expect } from 'vitest';
import { OtlpExporter } from './OtlpExporter.js';
import { Logger, MemorySink } from './logger.js';

function makeExporter() {
  const sent: { path: string; body: any }[] = [];
  const exporter = new OtlpExporter({
    baseURL: 'http://gw/',
    ingestToken: 'awtl_secret',
    sessionId: 'sess-1',
    logger: new Logger({ sink: new MemorySink(), level: 'warn' }),
    fetchImpl: (input, init) => {
      sent.push({
        path: String(input).replace('http://gw', ''),
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
  });
  return { exporter, sent };
}

/** Mọi chuỗi có trong payload — để soi xem có gì lọt ra không. */
function allStrings(node: unknown, acc: string[] = []): string[] {
  if (typeof node === 'string') acc.push(node);
  else if (Array.isArray(node)) for (const n of node) allStrings(n, acc);
  else if (node && typeof node === 'object')
    for (const v of Object.values(node)) allStrings(v, acc);
  return acc;
}

describe('shape đúng thứ đầu nhận chấp nhận', () => {
  it('tên metric mang tiền tố astracode., không giả danh claude_code', async () => {
    const { exporter, sent } = makeExporter();
    await exporter.recordUsage({ inputTokens: 100, outputTokens: 20 });

    const names = sent[0]!.body.resourceMetrics[0].scopeMetrics[0].metrics.map(
      (m: any) => m.name,
    );
    expect(names).toContain('astracode.token.usage');
    // Giả danh sẽ chạy được ngay hôm nay và làm hỏng mọi câu hỏi "đường nào
    // tạo ra con số này" về sau.
    expect(names.some((n: string) => n.startsWith('claude_code.'))).toBe(false);
  });

  it('khai DELTA, không phải luỹ kế', async () => {
    const { exporter, sent } = makeExporter();
    await exporter.recordUsage({ inputTokens: 5 });
    // Khai sai ở đây khiến đầu nhận cộng dồn số đã cộng — hoá đơn nhân đôi.
    expect(sent[0]!.body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum
      .aggregationTemporality).toBe(1);
  });

  it('tách token vào/ra bằng thuộc tính type', async () => {
    const { exporter, sent } = makeExporter();
    await exporter.recordUsage({ inputTokens: 7, outputTokens: 3 });
    const points = sent[0]!.body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints;
    const types = points.map((p: any) => p.attributes[0].value.stringValue);
    expect(types).toEqual(['input', 'output']);
    expect(points.map((p: any) => p.asDouble)).toEqual([7, 3]);
  });

  it('khai service.name để đầu nhận biết công cụ nào gửi', async () => {
    const { exporter, sent } = makeExporter();
    await exporter.recordToolDecision({ tool: 'edit_file', decision: 'accept' });
    const attrs = sent[0]!.body.resourceLogs[0].resource.attributes;
    const svc = attrs.find((a: any) => a.key === 'service.name');
    // Log record không có tiền tố trong tên, nên nguồn phải đến từ resource.
    expect(svc.value.stringValue).toBe('astracode');
  });

  it('không gửi gì khi không có số đo nào', async () => {
    const { exporter, sent } = makeExporter();
    await exporter.recordUsage({});
    expect(sent).toHaveLength(0);
  });

  it('dùng ingest token, không dùng JWT', async () => {
    const sentHeaders: string[] = [];
    const exporter = new OtlpExporter({
      baseURL: 'http://gw',
      ingestToken: 'awtl_abc',
      sessionId: 's',
      logger: new Logger({ sink: new MemorySink(), level: 'warn' }),
      fetchImpl: (_i, init) => {
        sentHeaders.push(String((init?.headers as Record<string, string>).Authorization));
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    });
    await exporter.recordSessionStart();
    expect(sentHeaders[0]).toBe('Bearer awtl_abc');
  });
});

describe('không có nội dung nào rời khỏi máy người dùng', () => {
  it('quyết định tool chỉ mang tên tool, không mang đối số', async () => {
    const { exporter, sent } = makeExporter();
    await exporter.recordToolDecision({ tool: 'edit_file', decision: 'reject' });

    const strings = allStrings(sent[0]!.body);
    expect(strings).toContain('edit_file');
    expect(strings).toContain('reject');
    // Đối số của lời gọi CHÍNH LÀ đường dẫn và nội dung file.
    for (const s of strings) {
      expect(s).not.toMatch(/\.ts$|\.env|\/src\//);
    }
  });

  it('số đo chỉ chứa số, tên metric và nhãn — không có chữ tự do', async () => {
    const { exporter, sent } = makeExporter();
    await exporter.recordUsage({
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.01,
      linesAdded: 30,
      linesRemoved: 4,
    });

    const allowed = new Set([
      'astracode.token.usage',
      'astracode.cost.usage',
      'astracode.lines_of_code.count',
      'input',
      'output',
      'added',
      'removed',
      'service.name',
      'astracode',
      'session.id',
      'sess-1',
      'type',
    ]);
    for (const s of allStrings(sent[0]!.body)) {
      // Chuỗi nanô giây là số, bỏ qua.
      if (/^\d+$/.test(s)) continue;
      expect(allowed.has(s), `chuỗi lạ lọt vào payload: ${s}`).toBe(true);
    }
  });
});

// Không ném, NHƯNG có nói ra. Hai vế phải đi cùng nhau: nuốt lỗi mà cũng nuốt
// luôn thông tin "đã hỏng" thì phía gọi xoá mất phần delta chưa gửi được, và
// con số biến mất khỏi cả hai đầu mà không ai biết.
describe('telemetry hỏng không làm hỏng lượt chat', () => {
  it('mạng chết thì nuốt lỗi và trả false', async () => {
    const exporter = new OtlpExporter({
      baseURL: 'http://gw',
      ingestToken: 't',
      sessionId: 's',
      logger: new Logger({ sink: new MemorySink(), level: 'warn' }),
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    // Người dùng đang chờ câu trả lời; bộ đếm hỏng không đáng làm hỏng nó.
    await expect(exporter.recordUsage({ inputTokens: 1 })).resolves.toBe(false);
  });

  it('đầu nhận trả 401 cũng không ném', async () => {
    const exporter = new OtlpExporter({
      baseURL: 'http://gw',
      ingestToken: 'sai',
      sessionId: 's',
      logger: new Logger({ sink: new MemorySink(), level: 'warn' }),
      fetchImpl: () => Promise.resolve(new Response('nope', { status: 401 })),
    });
    await expect(exporter.recordSessionStart()).resolves.toBe(false);
  });

  it('gửi trót lọt thì trả true', async () => {
    const { exporter } = makeExporter();
    await expect(exporter.recordUsage({ inputTokens: 1 })).resolves.toBe(true);
  });

  // Không có gì để gửi KHÁC với gửi hỏng: phía gọi không nên giữ lại một delta
  // rỗng rồi thử lại nó mãi.
  it('không có số nào thì coi như xong', async () => {
    const { exporter, sent } = makeExporter();
    await expect(exporter.recordUsage({})).resolves.toBe(true);
    expect(sent).toHaveLength(0);
  });
});
