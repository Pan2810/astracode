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
import { runJudgeJob } from './lib/judge.mjs';
import { createRunLog, bannerLines } from './lib/observe.mjs';
import { createLimiter } from './lib/limit.mjs';
import { createAdminRoutes } from './lib/admin.mjs';
import { createDailyLog } from './lib/daily.mjs';
import { TIGHTEN_MODE } from './lib/candidates.mjs';
import { parseTickets } from './lib/tickets.mjs';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_JOBS_KEPT = 200;

export function readConfig(env = process.env) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return {
    port: Number(env.PORT || 8000),
    // LUÔN tuyệt đối. Một `WORKSPACE_DIR=./.workspace` làm `repoDir` trong
    // analyze.mjs thành đường dẫn tương đối, trong khi `keepRealEvidence` so nó
    // với `path.resolve(...)`: phép so không bao giờ đúng, nên 100% bằng chứng
    // bị loại với lý do "thoát khỏi repo" mà job vẫn báo succeeded.
    workspaceDir: path.resolve(env.WORKSPACE_DIR || path.join(os.tmpdir(), 'astracode-astraqa')),
    // Mặc định trỏ vào CLI của chính repo này — tính từ vị trí file, không phải
    // một đường dẫn cứng của máy ai.
    cliPath: env.ASTRACODE_CLI_PATH || path.resolve(here, '..', '..', 'packages', 'cli', 'dist', 'main.js'),
    astraworkJwt: env.ASTRAWORK_JWT || '',
    serviceToken: env.ASTRACODE_SERVICE_TOKEN || '',
    // Nơi để lại vết của mỗi run: `<runsDir>/logs/` và `<runsDir>/results/`.
    // Khác WORKSPACE_DIR ở chỗ nó KHÔNG bị xoá sau job — đó là cả mục đích.
    runsDir: env.ASTRACODE_RUNS_DIR || here,
    // Trần lượt judge chạy cùng lúc trên cả server. Hạn mức request/phút tính
    // theo API key, mà key thì cả server dùng chung — nên trần phải ở đây.
    judgeConcurrency: Math.max(1, Number(env.ASTRACODE_JUDGE_CONCURRENCY || 2) || 2),
    // Trần số ticket được chấm trong MỘT job. 0 = không giới hạn.
    // Dùng khi hạn mức của nhà cung cấp tính theo ngày và mỗi lượt gọi là quý.
    maxTickets: Math.max(0, Number(env.ASTRACODE_MAX_TICKETS || 0) || 0),

    // Judge: `fci` gọi thẳng endpoint OpenAI-compatible (mặc định), `cli` spawn
    // CLI của AstraCode. Hai đường trả về cùng một schema items[].
    judgeBackend: ['cli', 'none'].includes((env.ASTRACODE_JUDGE || '').trim().toLowerCase())
      ? (env.ASTRACODE_JUDGE || '').trim().toLowerCase()
      : 'fci',
    fciBaseUrl: env.FPT_BASE_URL || '',
    fciApiKey: env.FPT_API_KEY || '',
    fciModel: env.FPT_MODEL || '',
    fciExtraBody: parseExtraBody(env.ASTRACODE_JUDGE_EXTRA_BODY),
  };
}

/**
 * `ASTRACODE_JUDGE_EXTRA_BODY` — JSON object trộn thêm vào body gửi model.
 *
 * Có vì mỗi nhà cung cấp đòi một field riêng: Qwen3.6 phải tắt thinking bằng
 * `{"chat_template_kwargs":{"enable_thinking":false}}`, còn DeepSeek không cần.
 * Ðể ở env chứ KHÔNG hardcode trong code: `chat_template_kwargs` là field riêng
 * của một nhà cung cấp, gửi nó cho nhà cung cấp khác là gửi rác.
 *
 * JSON hỏng thì NÉM ngay lúc khởi động. Im lặng bỏ qua là kiểu hỏng tệ nhất ở
 * đây: model vẫn chạy, vẫn trả lời, chỉ là cái field bạn tưởng đã bật thì không
 * bao giờ được gửi — và không có gì trong log nói ra điều đó.
 */
export function parseExtraBody(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch (err) {
    throw new Error(
      `ASTRACODE_JUDGE_EXTRA_BODY không phải JSON hợp lệ: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`ASTRACODE_JUDGE_EXTRA_BODY phải là một JSON object, nhận được ${Array.isArray(parsed) ? 'mảng' : typeof parsed}.`);
  }
  return parsed;
}

/**
 * WORKSPACE_DIR phải tạo được VÀ ghi được — kiểm ngay lúc khởi động.
 *
 * Kiểm bằng cách ghi thật một file rồi xoá, không dùng `fs.access(W_OK)`: trên
 * Windows nó chỉ nhìn cờ read-only của thư mục và trả "được" ở cả những chỗ mà
 * lần ghi đầu tiên sẽ ném. Thà chết lúc khởi động còn hơn để job đầu tiên chết
 * sau khi AstraQA đã chờ xong 184 ticket.
 */
export async function ensureWorkspaceWritable(dir) {
  await fs.mkdir(dir, { recursive: true });
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  await fs.writeFile(probe, 'ok', 'utf8');
  await fs.rm(probe, { force: true });
  return dir;
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
  // Một limiter cho cả server, chia chung giữa mọi job đang chạy.
  const limiter = createLimiter(config.judgeConcurrency ?? 2);
  // Bộ đếm của PHIÊN này: bao nhiêu lượt gọi model đã tiêu từ lúc server khởi
  // động. Đếm nội bộ — không hỏi nhà cung cấp, nên nó KHÔNG phải hạn mức còn
  // lại, chỉ là "phiên này đã bắn bao nhiêu viên".
  const usage = { model_calls: 0, jobs: 0 };

  // Trang theo dõi chỉ đọc. Toàn bộ logic nằm ở lib/admin.mjs; ở đây chỉ nối dây.
  const handleAdmin = createAdminRoutes({
    jobs,
    config,
    // Một lần bị từ chối ở đây là dòng đáng xem nhất trong cả file log: trang
    // này liệt kê mọi job, mọi repo, mọi ticket. Trước đây nó không để lại gì
    // — route admin tự kiểm quyền và tự trả 401, không đi qua cổng bên dưới.
    denied: (req, route) => slog(`401 ${req.method} ${route} ← ${clientIp(req)}`),
    usage,
    runsDir,
    redact: baseRedact,
    /*
     * `/admin` đòi token y như mọi route khác.
     *
     * Trước đây loopback được miễn, với lý do thật: trình duyệt KHÔNG gắn
     * `Authorization` vào một lần điều hướng thường, nên bắt token là biến trang
     * theo dõi thành thứ không mở được bằng cách mở nó. Nhưng "đến được cổng
     * này" chỉ đồng nghĩa với "đang ngồi trước máy này" khi không có gì khác
     * trên máy — mà một trang liệt kê mọi job, mọi repo và mọi ticket thì bất
     * kỳ thứ gì chạy trên localhost cũng đọc được, kể cả một tab đang mở một
     * trang web lạ.
     *
     * Hệ quả nói thẳng: khi SERVICE_TOKEN đã đặt, mở `/admin` bằng thanh địa
     * chỉ sẽ nhận 401. Cách xem là gửi kèm header — `curl -H "Authorization:
     * Bearer $ASTRACODE_SERVICE_TOKEN" .../admin` — hoặc chạy không token trên
     * máy của mình, khi đó `devMode` bên dưới mở nó ra.
     *
     * `devMode` là khi CHƯA đặt token: không có gì để đòi, và một server không
     * token thì mọi route của nó đã mở sẵn rồi.
     */
    isAuthorized: (req) => devMode || tokenOk(bearerOf(req), config.serviceToken),
  });
  // Dòng nào không thuộc job nào — banner, dòng request, 401, 404 — vừa ra
  // console vừa xuống `logs/server-<ngày>.log`, và bảy ngày là hạn. Xem
  // lib/daily.mjs; `persist: false` (test) thì không đụng đĩa.
  const serverLog = createDailyLog({
    dir: path.join(runsDir, 'logs'),
    redact: baseRedact,
    log,
    enabled: persist,
  });
  const slog = (msg) => serverLog.line(msg);

  function redactorFor(body) {
    return makeRedactor([
      config.serviceToken,
      config.astraworkJwt,
      config.fciApiKey,
      body.astrawork_token,
      body.repo_token,
    ]);
  }

  /**
   * Chạy một job judge.
   *
   * Không dùng chung `start` với analyze: kết quả của judge đọc được TỪNG PHẦN
   * trong lúc chạy (`job.results` lớn dần), nên trạng thái cuối chỉ đóng sổ chứ
   * không phải là lúc dữ liệu xuất hiện. Nhập hai đường này vào một hàm sẽ làm
   * mờ đúng điểm khác nhau ấy.
   */
  function startJudge(job, body, runLog) {
    const redact = redactorFor(body);
    job.status = 'running';
    usage.jobs += 1;
    runJudgeJob({ job, body, config, redact, log: (m) => runLog.line(m), limiter, usage })
      .then((result) => {
        // Một job đã bị gọi dừng thì kết thúc là `cancelled`, không phải
        // `succeeded`: nó làm đúng thứ được bảo, nhưng nói "xong" sẽ khiến bên
        // gọi tưởng cả danh sách đã được xét.
        job.status = job.abort?.signal?.aborted ? 'cancelled' : 'succeeded';
        job.result = result;
        runLog.saveResult(result);
        runLog.line(`đã ghi: ${runLog.jsonFile} | ${runLog.mdFile}`);
      })
      .catch((err) => {
        job.status = 'failed';
        job.error = redactMessage(err, redact);
        runLog.line(`job judge xong: FAILED — ${job.error}`);
        runLog.saveFailure(job.error);
      });
  }

  function start(job, body, runLog) {
    const redact = redactorFor(body);

    job.status = 'running';
    usage.jobs += 1;
    runAnalyzeJob({ job, body, config, redact, log: (m) => runLog.line(m), limiter, usage })
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
        model: config.judgeBackend === 'fci' ? config.fciModel || null : null,
        max_tickets: config.maxTickets ?? 0,
        judge_concurrency: config.judgeConcurrency ?? 2,
        // Chế độ siết của matcher (§5). Ðã đóng băng; khai ra để nhìn một cái là
        // biết bản đang chạy dùng luật nào, không phải đi đọc source.
        tighten_mode: TIGHTEN_MODE,
        // Đường nào server này có. Bên gọi dò bằng đây thay vì POST thử rồi
        // đọc 404 — một 404 còn có thể là sai đường dẫn hay sai proxy.
        routes: ['/api/v1/analyze', '/api/v1/judge'],
        // Ðếm nội bộ từ lúc khởi động — KHÔNG hỏi nhà cung cấp, nên đây không
        // phải hạn mức còn lại. Lượt thử lại cũng tính, vì nó cũng là request thật.
        model_calls_this_session: usage.model_calls,
        jobs_this_session: usage.jobs,
        ...(config.judgeBackend === 'fci'
          ? { fci_configured: Boolean(config.fciBaseUrl && config.fciApiKey && config.fciModel) }
          : config.judgeBackend === 'cli'
            ? { cli_path: config.cliPath }
            : { note: 'quét tất định, không gọi model' }),
      });
    }

    // Route admin tự kiểm quyền (loopback hoặc token) nên nó đứng trước cổng
    // dưới đây. Nó chỉ nhận đúng `/admin` và `/api/v1/jobs*`; mọi route khác
    // rơi tiếp xuống y như cũ.
    if (await handleAdmin(req, res, route)) return;

    if (!devMode && !tokenOk(bearerOf(req), config.serviceToken)) {
      // Ghi lại để biết có ai gõ cửa sai token — tuyệt đối không ghi token đã gửi.
      slog(`401 ${req.method} ${route} ← ${clientIp(req)}`);
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
        // Hai field chỉ để trang /admin hiển thị. Không nhánh logic nào đọc chúng.
        repo_url: typeof body.repo_url === 'string' ? body.repo_url : null,
        backend: ['cli', 'fci', 'none'].includes(body.backend) ? body.backend : config.judgeBackend,
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

    if (route === '/api/v1/judge' && req.method === 'POST') {
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
      if (!Array.isArray(body.tickets) || body.tickets.length === 0) missing.push('tickets');
      if (!body.verdict_guide || typeof body.verdict_guide !== 'object') missing.push('verdict_guide');
      if (missing.length) {
        return sendJson(res, 400, { error: `thiếu field bắt buộc: ${missing.join(', ')}` });
      }

      const job = {
        id: randomUUID(),
        kind: 'judge',
        run_id: body.run_id ?? null,
        repo_url: typeof body.repo_url === 'string' ? body.repo_url : null,
        backend: config.judgeBackend,
        status: 'queued',
        progress: { done: 0, total: body.tickets.length },
        // Mảng bên gọi đọc dần. Có mặt ngay từ lúc queued để một lần GET sớm
        // nhận `results: []` chứ không phải `undefined` — "chưa có kết quả nào"
        // và "field này không tồn tại" là hai câu trả lời khác nhau.
        results: [],
        result: undefined,
        error: undefined,
        abort: new AbortController(),
        createdAt: Date.now(),
      };
      jobs.set(job.id, job);
      while (jobs.size > MAX_JOBS_KEPT) jobs.delete(jobs.keys().next().value);

      const runLog = createRunLog({
        runsDir,
        runId: body.run_id ? `${body.run_id}-judge` : null,
        jobId: job.id,
        redact: redactorFor(body),
        log,
        enabled: persist,
      });
      job.runLog = runLog;

      runLog.line(
        `POST /api/v1/judge ← ${clientIp(req)} | run_id ${job.run_id ?? '(không có)'} | job ${job.id} | ` +
          `repo ${body.repo_url} | ref ${body.ref || '(mặc định)'} | ticket ${body.tickets.length} | ` +
          `model ${config.fciModel || '(chưa cấu hình)'}`,
      );

      sendJson(res, 202, { job_id: job.id, status: 'queued', total: body.tickets.length });
      startJudge(job, body, runLog);
      return;
    }

    const j = /^\/api\/v1\/judge\/([^/]+)$/.exec(route);
    if (j && req.method === 'DELETE') {
      const job = jobs.get(decodeURIComponent(j[1]));
      if (!job || job.kind !== 'judge') return sendJson(res, 404, { error: 'job_id không tồn tại' });
      /*
       * Gọi dừng, không phải xoá.
       *
       * Một lượt judge là một lượt gọi model, và bên gọi bấm dừng vì không muốn
       * tiêu tiếp — nên việc đầu tiên là `abort`, để lượt đang bay bị cắt và
       * những lượt còn xếp hàng không bao giờ được gửi. Kết quả đã có ở lại
       * nguyên vẹn: chúng đã được trả tiền rồi.
       */
      job.abort?.abort();
      if (job.status === 'queued' || job.status === 'running') job.status = 'cancelled';
      job.runLog?.line(`DELETE /api/v1/judge/${job.id} ← ${clientIp(req)} | dừng ở ${job.results.length}/${job.progress?.total ?? '?'}`);
      return sendJson(res, 200, {
        status: job.status,
        done: job.results.length,
        total: job.progress?.total ?? job.results.length,
        results: job.results,
      });
    }

    if (j && req.method === 'GET') {
      const job = jobs.get(decodeURIComponent(j[1]));
      if (!job || job.kind !== 'judge') return sendJson(res, 404, { error: 'job_id không tồn tại' });
      /*
       * `results` trả về ở MỌI trạng thái, kể cả `failed`.
       *
       * Một job chết ở ticket thứ 150 vẫn đã chấm xong 149 ticket, và những
       * kết luận ấy đúng như nhau dù cái thứ 150 có hỏng. Giấu chúng đi vì
       * trạng thái cuối là xấu sẽ bắt bên gọi chạy lại cả 150 lượt model.
       */
      return sendJson(res, 200, {
        status: job.status,
        done: job.results.length,
        total: job.progress?.total ?? job.results.length,
        results: job.results,
        ...(job.revision ? { source_revision: job.revision } : {}),
        ...(job.stats ? { stats: job.stats } : {}),
        ...(job.error ? { error: job.error } : {}),
      });
    }

    const m = /^\/api\/v1\/analyze\/([^/]+)$/.exec(route);
    if (m && req.method === 'GET') {
      const job = jobs.get(decodeURIComponent(m[1]));
      if (!job || job.kind === 'judge') return sendJson(res, 404, { error: 'job_id không tồn tại' });
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
    for (const row of bannerLines({ ...shown, tightenMode: TIGHTEN_MODE }, { runsDir, devMode })) slog(row);
  });

  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  // `.env` ở gốc repo, cùng quy ước với evals/run.ts: biến đã export thắng file.
  loadDotEnv();
  let config;
  try {
    config = readConfig();
  } catch (err) {
    // Cấu hình sai thì DỪNG HẲN, đừng khởi động rồi chạy sai âm thầm.
    console.error(`astraqa-server KHÔNG khởi động được: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  try {
    await ensureWorkspaceWritable(config.workspaceDir);
  } catch (err) {
    // Cùng luật với readConfig: hỏng thì hiện lỗi ngay ở banner, đừng khởi động
    // rồi để mỗi job tự chết một kiểu.
    console.error(
      `astraqa-server KHÔNG khởi động được: WORKSPACE_DIR "${config.workspaceDir}" không tạo/ghi được — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
  createServer(config).listen(config.port, '127.0.0.1');
}
