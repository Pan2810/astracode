/**
 * Tool `python` — hai chốt chặn quanh "script sinh ra rồi đem chạy".
 *
 * Đây là đường ngắn nhất từ "agent viết một file" tới "máy chạy mã tuỳ ý", nên
 * nó phải chặt bằng đúng cái hàng rào mà mọi tool đọc/ghi file đã đứng sau:
 * file phải nằm TRONG workspace. Và thứ chạy được thì phải được NHÌN — nội dung
 * script với tay ra ngoài workspace thì hộp duyệt nói ra, kèm bằng chứng.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pythonTool } from './python.js';
import { createToolContext } from './index.js';
import { MemoryFileSystem } from '../fs/FileSystem.js';
import { Logger, MemorySink } from '../telemetry/logger.js';
import type { ToolContext } from './Tool.js';

const ROOT = path.resolve('/repo');

function ctx(files: Record<string, string>): ToolContext {
  const withRoot: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) withRoot[path.join(ROOT, k)] = v;
  return createToolContext({
    workspaceRoot: ROOT,
    logger: new Logger({ sink: new MemorySink() }),
    fs: new MemoryFileSystem({ files: withRoot, caseInsensitive: false }),
  });
}

describe('python — script phải nằm trong workspace', () => {
  it('từ chối file ngoài workspace TRƯỚC khi chạm sandbox', async () => {
    // Không có sandbox trong ctx: nếu chốt chặn nằm sau, test này sẽ nhận lỗi
    // "chưa có sandbox" thay vì lời từ chối — và ngoài đời thì script đã chạy.
    const r = await pythonTool.execute({ script: '../ngoai/thu.py' }, ctx({ 'a.py': 'x' }));

    expect(r.isError).toBe(true);
    expect(r.content).toContain('workspace');
  });

  it('mã inline vẫn chạy được — nó nằm ngay trong hộp duyệt', async () => {
    // Không có sandbox nên nó dừng ở đó; điều cần khẳng định là nó KHÔNG bị
    // chặn bởi luật đường dẫn, vì mã inline không phải một file trên đĩa.
    const r = await pythonTool.execute({ script: 'print(1)' }, ctx({ 'a.py': 'x' }));

    expect(r.content).toContain('sandbox');
  });
});

describe('python — nội dung script đi vào hộp duyệt', () => {
  it('quét NỘI DUNG file, không chỉ dòng lệnh', async () => {
    // `python3 tools/clean.py` tự nó vô hại. Thứ chạy là mấy dòng bên trong.
    const c = ctx({ 'tools/clean.py': 'import shutil\nshutil.rmtree("/etc/nginx")\n' });
    const intent = await pythonTool.describe!({ script: 'tools/clean.py' }, c);

    expect(intent.warnings?.join(' ')).toContain('/etc/nginx');
  });

  it('quét cả đối số dòng lệnh', async () => {
    const c = ctx({ 'tools/copy.py': 'import sys\nprint(sys.argv)\n' });
    const intent = await pythonTool.describe!({ script: 'tools/copy.py', args: ['~/.ssh'] }, c);

    expect(intent.warnings?.join(' ')).toContain('~/.ssh');
  });

  it('script bình thường không kèm cảnh báo', async () => {
    const c = ctx({ 'tools/build.py': 'open("src/app.ts").read()\n' });
    const intent = await pythonTool.describe!({ script: 'tools/build.py' }, c);

    expect(intent.warnings).toBeUndefined();
  });

  it('mã inline cũng bị quét', async () => {
    const c = ctx({ 'a.py': 'x' });
    const intent = await pythonTool.describe!(
      { script: 'import os\nprint(os.path.expanduser("~/.aws"))' },
      c,
    );

    expect(intent.warnings?.length).toBeGreaterThan(0);
  });
});
