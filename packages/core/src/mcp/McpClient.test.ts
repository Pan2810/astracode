import { describe, expect, it } from 'vitest';
import { Logger, MemorySink } from '../telemetry/logger.js';
import { McpClient, McpClientError } from './McpClient.js';
import { createFakeServer } from './fakeServer.js';
import type { McpToolInfo } from './types.js';

const logger = (): Logger => new Logger({ sink: new MemorySink() });

const TOOL: McpToolInfo = {
  name: 'git_log',
  description: 'xem lịch sử commit',
  inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
};

describe('McpClient — handshake', () => {
  it('initialize rồi gửi notifications/initialized', async () => {
    const server = createFakeServer({ name: 'git-mcp', version: '2.1' });
    const client = new McpClient({ name: 'git', transport: server.transport, logger: logger() });

    const info = await client.initialize();

    expect(info.name).toBe('git-mcp');
    expect(info.version).toBe('2.1');
    expect(client.isInitialized()).toBe(true);
    const methods = server.sent.map((m) => (m as { method?: string }).method);
    expect(methods).toEqual(['initialize', 'notifications/initialized']);
  });

  it('server không trả lời → lỗi có tên server và có gợi ý, không treo mãi', async () => {
    const server = createFakeServer({ silentMethods: ['initialize'] });
    const client = new McpClient({
      name: 'treo',
      transport: server.transport,
      logger: logger(),
      timeoutMs: 30,
    });

    await expect(client.initialize()).rejects.toThrow(/did not answer initialize/);
  });
});

describe('McpClient — tools', () => {
  it('listTools đi hết phân trang', async () => {
    const tools = Array.from({ length: 5 }, (_, i) => ({ ...TOOL, name: `tool_${i}` }));
    const server = createFakeServer({ tools, pageSize: 2 });
    const client = new McpClient({ name: 'x', transport: server.transport, logger: logger() });

    await client.initialize();
    const list = await client.listTools();

    expect(list.map((t) => t.name)).toEqual(['tool_0', 'tool_1', 'tool_2', 'tool_3', 'tool_4']);
    expect(list[0]!.inputSchema).toEqual(TOOL.inputSchema);
  });

  it('listTools tôn trọng trần số tool', async () => {
    const tools = Array.from({ length: 100 }, (_, i) => ({ ...TOOL, name: `t${i}` }));
    const server = createFakeServer({ tools, pageSize: 10 });
    const client = new McpClient({ name: 'x', transport: server.transport, logger: logger() });

    await client.initialize();
    expect(await client.listTools(12)).toHaveLength(12);
  });

  it('tool không có description vẫn nhận được, không rơi mất', async () => {
    const server = createFakeServer({
      tools: [{ name: 'im_lang', description: '', inputSchema: { type: 'object' } }],
    });
    const client = new McpClient({ name: 'x', transport: server.transport, logger: logger() });
    await client.initialize();

    expect((await client.listTools())[0]).toMatchObject({ name: 'im_lang', description: '' });
  });

  it('callTool gom phần text, đếm phần không phải text', async () => {
    const server = createFakeServer({ results: { git_log: { text: 'commit abc' } } });
    const client = new McpClient({ name: 'x', transport: server.transport, logger: logger() });
    await client.initialize();

    const r = await client.callTool('git_log', { limit: 3 });
    expect(r.text).toBe('commit abc');
    expect(r.isError).toBe(false);
  });

  it('isError của server được giữ nguyên', async () => {
    const server = createFakeServer({ results: { boom: { text: 'hỏng rồi', isError: true } } });
    const client = new McpClient({ name: 'x', transport: server.transport, logger: logger() });
    await client.initialize();

    expect(await client.callTool('boom', {})).toMatchObject({ isError: true });
  });

  it('lỗi JSON-RPC trở thành kết quả lỗi, không phải exception', async () => {
    const server = createFakeServer({ errorMethods: { 'tools/call': 'thiếu quyền' } });
    const client = new McpClient({ name: 'x', transport: server.transport, logger: logger() });
    await client.initialize();

    const r = await client.callTool('git_log', {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain('thiếu quyền');
  });

  it('kết quả quá dài bị cắt và nói rõ đã cắt', async () => {
    const server = createFakeServer({ results: { big: { text: 'x'.repeat(500) } } });
    const client = new McpClient({
      name: 'x',
      transport: server.transport,
      logger: logger(),
      maxResultChars: 100,
    });
    await client.initialize();

    const r = await client.callTool('big', {});
    expect(r.text.length).toBeLessThan(200);
    expect(r.text).toContain('truncated');
  });
});

describe('McpClient — server chết', () => {
  it('request đang chờ bị từ chối kèm lý do', async () => {
    const server = createFakeServer({ silentMethods: ['tools/list'] });
    const client = new McpClient({
      name: 'chet',
      transport: server.transport,
      logger: logger(),
      timeoutMs: 5000,
    });
    await client.initialize();

    const p = client.listTools();
    server.crash('OOM');

    await expect(p).rejects.toThrow(/stopped mid-run/);
  });

  it('gọi tiếp sau khi chết → lỗi nói tên server, không im lặng treo', async () => {
    const server = createFakeServer();
    const client = new McpClient({ name: 'chet', transport: server.transport, logger: logger() });
    await client.initialize();
    server.crash();

    await expect(client.callTool('x', {})).rejects.toBeInstanceOf(McpClientError);
  });

  it('close() đóng transport và từ chối request sau đó', async () => {
    const server = createFakeServer();
    const client = new McpClient({ name: 'x', transport: server.transport, logger: logger() });
    await client.initialize();

    await client.close();
    expect(server.closed).toBe(true);
    await expect(client.listTools()).rejects.toThrow(/has stopped/);
  });

  it('rác trên stdout không làm hỏng phiên', async () => {
    const server = createFakeServer({ tools: [TOOL] });
    const client = new McpClient({ name: 'x', transport: server.transport, logger: logger() });
    await client.initialize();

    server.emitRaw('[info] đang khởi động\nkhông phải JSON\n');
    expect(await client.listTools()).toHaveLength(1);
  });

  it('server gọi ngược năng lực ta không có → trả lỗi đúng chuẩn thay vì im lặng', async () => {
    const server = createFakeServer();
    const client = new McpClient({ name: 'x', transport: server.transport, logger: logger() });
    await client.initialize();

    server.emitRaw(
      `${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'sampling/createMessage' })}\n`,
    );

    await new Promise((r) => setTimeout(r, 5));
    const reply = server.sent.find((m) => (m as { id?: number }).id === 99);
    expect(reply).toBeDefined();
    expect((reply as { error?: { code: number } }).error?.code).toBe(-32601);
  });
});
