#!/usr/bin/env node
/**
 * astraqa-server — lớp HTTP mỏng để AstraQA gọi AstraCode qua mạng.
 *
 * Nó KHÔNG phải một phần của AstraCode: không import gì từ `packages/`, không
 * sửa file nào có sẵn, không thêm dependency (chỉ `node:` builtin). Việc duy
 * nhất của nó là nhận request, clone repo, và spawn CLI của repo này đúng như
 * một người gõ tay:
 *
 *     node <ASTRACODE_CLI_PATH> --mode=plan --raw -p "<prompt>"
 *
 * Stateless theo nghĩa nghiêm: server không biết dự án nào tồn tại. Repo, ref,
 * danh sách ticket, định dạng ticket, glob loại trừ — tất cả đến từ request.
 * Năm biến môi trường dưới đây là toàn bộ cấu hình nó đọc.
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeRedactor, redactMessage } from './lib/redact.mjs';
import { loadDotEnv } from './lib/env.mjs';
import { runAnalyzeJob } from './lib/analyze.mjs';
import { createRunLog, bannerLines } from './lib/observe.mjs';
import { parseTickets } from './lib/tickets.mjs';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_JOBS_KEPT = 200;

export function readConfig(env = process.env) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return {
    port: Number(env.PORT || 8000),
    workspaceDir: env.WORKSPACE_DIR || path.join(os.tmpdir(), 'astracode-astraqa'),
    // Mặc định trỏ vào CLI của chính repo này — tính từ vị trí file, không phải
    // một đường dẫn cứng của máy ai.
    cliPath: env.ASTRACODE_CLI_PATH || path.resolve(here, '..', '..', 'packages', 'cli', 'dist', 'main.js'),
    astraworkJwt: env.ASTRAWORK_JWT || '',
    serviceToken: env.ASTRACODE_SERVICE_TOKEN || '',
    // Nơi để lại vết của mỗi run: `<runsDir>/logs/` và `<runsDir>/results/`.
    // Khác WORKSPACE_DIR ở chỗ nó KHÔNG bị xoá sau job — đó là cả mục đích.
    runsDir: env.ASTRACODE_RUNS_DIR || here,

    // Judge: `fci` gọi thẳng endpoint OpenAI-compatible (mặc định), `cli` spawn
    // CLI của AstraCode. Hai đường trả về cùng một schema items[].
    judgeBackend: ['cli', 'none'].includes((env.ASTRACODE_JUDGE || '').trim().toLowerCase())
      ? (env.ASTRACODE_JUDGE || '').trim().toLowerCase()
      : 'fci',
    fciBaseUrl: env.FPT_BASE_URL || '',
    fciApiKey: env.FPT_API_KEY || '',
    fciModel: env.FPT_MODEL || '',
  };
}

function sendJson(res, code, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** So sánh token theo thời gian hằng — độ dài lệch thì thôi khỏi so. */
function tokenOk(given, expected) {
  const a = Buffer.from(given ?? '', 'utf8');
  const b = Buffer.from(expected ?? '', 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** IP của bên gọi. `::ffff:127.0.0.1` rút về `127.0.0.1` cho dễ đọc. */
function clientIp(req) {
  const raw = req.socket?.remoteAddress ?? '?';
  return String(raw).replace(/^::ffff:/, '');
}

function bearerOf(req) {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1].trim() : '';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Body vượt ${MAX_BODY_BYTES} byte.`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createServer(config, { log = console.log, persist = true } = {}) {
  /** @type {Map<string, any>} */
  const jobs = new Map();
  const devMode = !config.serviceToken;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const runsDir = config.runsDir || here;

  // Redactor cấp server: ba bí mật từ cấu hình, dùng cho mọi dòng log nằm
  // ngoài phạm vi một job (banner, dòng request, 401/404).
  const baseRedact = makeRedactor([config.serviceToken, config.astraworkJwt, config.fciApiKey]);
  const slog = (msg) => log(baseRedact(String(msg ?? '')));

  function start(job, body, runLog) {
    const redact = makeRedactor([
      config.serviceToken,
      config.astraworkJwt,
      config.fciApiKey,
      body.astrawork_token,
      body.repo_token,
    ]);

    job.status = 'running';
    runAnalyzeJob({ job, body, config, redact, log: (m) => runLog.line(m) })
      .then((result) => {
        job.status = 'succeeded';
        job.result = result;
        const s = result.stats ?? {};
        runLog.line(
          `job xong: succeeded | ${result.items.length} ticket | ` +
            `done ${result.items.filter((i) => i.code_status === 'done').length}, ` +
            `partial ${result.items.filter((i) => i.code_status === 'partial').length}, ` +
            `missing ${result.items.filter((i) => i.code_status === 'missing').length} | ` +
            `bằng chứng giữ ${s.evidence_kept}, loại ${s.evidence_dropped}, kẹp ${s.evidence_clamped} | ${s.duration_ms}ms`,
        );
        // Ghi trước khi ai đó kịp poll: kết quả còn trên đĩa kể cả khi AstraQA
        // rớt kết nối hoặc job rơi khỏi sổ 200 job trong bộ nhớ.
        runLog.saveResult(result);
        runLog.line(`đã ghi: ${runLog.jsonFile} | ${runLog.mdFile}`);
      })
      .catch((err) => {
        job.status = 'failed';
        // Bất biến: message lỗi không bao giờ mang theo token.
        job.error = redactMessage(err, redact);
        runLog.line(`job xong: FAILED — ${job.error}`);
        runLog.saveFailure(job.error);
      });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/';

    // `/healthz` là cổng cho liveness probe nên không bắt buộc token; gửi kèm
    // token vẫn 200, nên client cầm hợp đồng không phải phân biệt hai đường.
    if (route === '/healthz') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      // Khai rõ backend đang chạy — KHÔNG bao giờ khai key.
      return sendJson(res, 200, {
        status: 'ok',
        backend: config.judgeBackend,
        ...(config.judgeBackend === 'fci'
          ? { model: config.fciModel || null, fci_configured: Boolean(config.fciBaseUrl && config.fciApiKey && config.fciModel) }
          : config.judgeBackend === 'cli'
            ? { cli_path: config.cliPath }
            : { model: null, note: 'quét tất định, không gọi model' }),
      });
    }

    if (!devMode && !tokenOk(bearerOf(req), config.serviceToken)) {
      // Ghi lại để biết có ai gõ cửa sai token — tuyệt đối không ghi token đã gửi.
      slog(`${new Date().toISOString()} 401 ${req.method} ${route} ← ${clientIp(req)}`);
      return sendJson(res, 401, { error: 'unauthorized: thiếu hoặc sai Authorization: Bearer <ASTRACODE_SERVICE_TOKEN>' });
    }

    if (route === '/api/v1/analyze' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (err) {
        return sendJson(res, 400, { error: `body không phải JSON hợp lệ: ${err instanceof Error ? err.message : ''}`.trim() });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, { error: 'body phải là một JSON object.' });
      }

      const missing = [];
      if (typeof body.repo_url !== 'string' || !body.repo_url.trim()) missing.push('repo_url');
      if (typeof body.tickets_md !== 'string' || !body.tickets_md.trim()) missing.push('tickets_md');
      if (missing.length) {
        return sendJson(res, 400, { error: `thiếu field bắt buộc: ${missing.join(', ')}` });
      }

      const job = {
        id: randomUUID(),
        run_id: body.run_id ?? null,
        status: 'queued',
        progress: { done: 0, total: 0 },
        current: undefined,
        result: undefined,
        error: undefined,
        abort: new AbortController(),
        createdAt: Date.now(),
      };
      jobs.set(job.id, job);
      // Giữ bộ nhớ có trần: job cũ nhất rơi ra khi vượt ngưỡng.
      while (jobs.size > MAX_JOBS_KEPT) jobs.delete(jobs.keys().next().value);

      const runLog = createRunLog({
        runsDir,
        runId: job.run_id,
        jobId: job.id,
        redact: makeRedactor([config.serviceToken, config.astraworkJwt, config.fciApiKey, body.astrawork_token, body.repo_token]),
        log,
        enabled: persist,
      });
      job.runLog = runLog;

      // Đếm ticket ngay tại đây chỉ để cho vào dòng log — job vẫn tự tách lại và
      // tự báo lỗi nếu `tickets_md` hỏng. Ở đây hỏng thì ghi `?`, không ném.
      let ticketCount = '?';
      try {
        ticketCount = String(parseTickets(body.tickets_md).length);
      } catch {
        ticketCount = '? (tickets_md chưa dò được)';
      }

      runLog.line(
        `POST /api/v1/analyze ← ${clientIp(req)} | run_id ${job.run_id ?? '(không có)'} | job ${job.id} | ` +
          `repo ${body.repo_url} | ref ${body.ref || '(mặc định)'} | ticket ${ticketCount} | ` +
          `backend ${['cli', 'fci', 'none'].includes(body.backend) ? `${body.backend} (ép theo request)` : config.judgeBackend}`,
      );

      sendJson(res, 202, { job_id: job.id, status: 'queued' });
      start(job, body, runLog);
      return;
    }

    const m = /^\/api\/v1\/analyze\/([^/]+)$/.exec(route);
    if (m && req.method === 'GET') {
      const job = jobs.get(decodeURIComponent(m[1]));
      if (!job) return sendJson(res, 404, { error: 'job_id không tồn tại' });
      if (job.status === 'succeeded') return sendJson(res, 200, { status: 'succeeded', result: job.result });
      if (job.status === 'failed') return sendJson(res, 200, { status: 'failed', error: job.error });
      return sendJson(res, 200, {
        status: job.status,
        progress: job.progress,
        ...(job.current ? { current: job.current } : {}),
      });
    }

    return sendJson(res, 404, { error: 'not found' });
  });

  server.on('listening', () => {
    const addr = server.address();
    const shown = { ...config, port: typeof addr === 'object' && addr ? addr.port : config.port };
    // Banner: khai TRẠNG THÁI của mỗi bí mật ("đã set"), không bao giờ giá trị.
    for (const row of bannerLines(shown, { runsDir, devMode })) slog(row);
  });

  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  // `.env` ở gốc repo, cùng quy ước với evals/run.ts: biến đã export thắng file.
  loadDotEnv();
  const config = readConfig();
  await fs.mkdir(config.workspaceDir, { recursive: true });
  createServer(config).listen(config.port, '127.0.0.1');
}
