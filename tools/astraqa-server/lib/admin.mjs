/**
 * Trang admin CHỈ ĐỌC + bốn route JSON/file nuôi nó.
 *
 * Mục đích duy nhất: lúc demo, khán giả nhìn thấy AstraQA gửi request sang và
 * AstraCode xử lý. Nó KHÔNG có nút dừng, không huỷ job, không sửa gì — mọi
 * đường ở đây chỉ đọc `jobs` trong bộ nhớ và hai thư mục `logs/` `results/`.
 *
 * Bất biến giữ từ phần còn lại của server:
 *   - `run_id` từ URL đi qua `slugifyRunId` rồi mới thành tên file, và đường dẫn
 *     đã ghép còn bị kiểm lại là có nằm trong thư mục cho phép không.
 *   - Mọi chuỗi ra ngoài đều qua `redact`.
 *   - Trang HTML dựng DOM bằng `textContent`, không nội suy chuỗi vào HTML, nên
 *     tên repo hay message lỗi của người lạ không thành thẻ script được.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { slugifyRunId } from './observe.mjs';

/** Số file kết quả đọc từ đĩa mỗi lần gọi — đủ cho một buổi demo, không quét cả thư mục. */
const MAX_DISK_JOBS = 50;

/** Chỉ đọc file nằm THẬT SỰ trong thư mục cho phép. */
async function readInside(dir, name) {
  const abs = path.resolve(dir, name);
  const root = path.resolve(dir);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return null;
    return { abs, stat };
  } catch {
    return null;
  }
}

function jobFromMemory(job, redact) {
  const stats = job.stats ?? job.result?.stats ?? null;
  const finished =
    job.result?.generated_at ??
    (job.status === 'failed' || job.status === 'succeeded' ? null : null);
  return {
    run_id: job.run_id ?? null,
    slug: job.runLog?.slug ?? slugifyRunId(job.run_id, `job-${String(job.id).slice(0, 8)}`),
    job_id: job.id,
    repo: job.repo_url ? redact(job.repo_url) : null,
    backend: job.backend ?? null,
    tickets: job.progress?.total ?? null,
    status: job.status,
    progress: job.progress ?? { done: 0, total: 0 },
    current: job.current ?? null,
    started_at: job.createdAt ? new Date(job.createdAt).toISOString() : null,
    finished_at: finished,
    error: job.error ? redact(job.error) : null,
    stats,
    source: 'memory',
  };
}

function jobFromDisk(slug, parsed, mtimeMs, redact) {
  // Hai hình dạng file: `result` của job thành công, hoặc object failed do
  // `saveFailure()` ghi. Phân biệt bằng field `status`.
  if (parsed?.status === 'failed') {
    return {
      run_id: parsed.run_id ?? null,
      slug,
      job_id: parsed.job_id ?? null,
      repo: null,
      backend: null,
      tickets: null,
      status: 'failed',
      progress: { done: 0, total: 0 },
      current: null,
      started_at: null,
      finished_at: parsed.failed_at ?? new Date(mtimeMs).toISOString(),
      error: redact(String(parsed.error ?? '')),
      stats: null,
      source: 'disk',
    };
  }

  const stats = parsed?.stats ?? null;
  const finishedAt = parsed?.generated_at ?? new Date(mtimeMs).toISOString();
  const durationMs = Number(stats?.duration_ms ?? 0) || 0;
  const startedAt = durationMs ? new Date(new Date(finishedAt).getTime() - durationMs).toISOString() : null;
  const total = Array.isArray(parsed?.items) ? parsed.items.length : null;

  // Repo không nằm trong `result`; nó có trong dòng đầu của `report_md`.
  const repoLine = /^- repo: (.+)$/m.exec(String(parsed?.report_md ?? ''));

  return {
    run_id: parsed?.run_id ?? null,
    slug,
    job_id: null,
    repo: repoLine ? redact(repoLine[1].trim()) : null,
    backend: parsed?.backend ?? null,
    tickets: total,
    status: 'succeeded',
    progress: { done: total ?? 0, total: total ?? 0 },
    current: null,
    started_at: startedAt,
    finished_at: finishedAt,
    error: null,
    stats,
    source: 'disk',
  };
}

/**
 * Gom job từ hai nguồn: sổ trong bộ nhớ (biết job đang chạy) và `results/` trên
 * đĩa (còn cả những job từ lần khởi động trước). Trùng `slug` thì bộ nhớ thắng
 * vì nó mới hơn và biết tiến độ.
 */
async function collectJobs({ jobs, runsDir, redact }) {
  const bySlug = new Map();

  const resultsDir = path.join(runsDir, 'results');
  let names = [];
  try {
    names = (await fs.readdir(resultsDir)).filter((n) => n.endsWith('.json'));
  } catch {
    names = [];
  }

  const stated = [];
  for (const name of names) {
    try {
      const st = await fs.stat(path.join(resultsDir, name));
      stated.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      /* file vừa bị xoá giữa chừng — bỏ qua */
    }
  }
  stated.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { name, mtimeMs } of stated.slice(0, MAX_DISK_JOBS)) {
    const slug = name.replace(/\.json$/, '');
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(resultsDir, name), 'utf8'));
      bySlug.set(slug, jobFromDisk(slug, parsed, mtimeMs, redact));
    } catch {
      /* JSON hỏng hoặc đang ghi dở — bỏ qua, lần refresh sau sẽ có */
    }
  }

  for (const job of jobs.values()) {
    const row = jobFromMemory(job, redact);
    const truoc = bySlug.get(row.slug);
    // Bộ nhớ biết tiến độ và thời điểm bắt đầu; đĩa biết `finished_at` chính xác.
    bySlug.set(row.slug, truoc ? { ...truoc, ...row, finished_at: row.finished_at ?? truoc.finished_at } : row);
  }

  const out = [...bySlug.values()];
  out.sort((a, b) => {
    const rank = (s) => (s === 'running' ? 0 : s === 'queued' ? 1 : 2);
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    return String(b.finished_at ?? b.started_at ?? '').localeCompare(String(a.finished_at ?? a.started_at ?? ''));
  });
  return out;
}

const PAGE = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AstraCode — bảng theo dõi</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #fff; --ink: #14171a; --muted: #5b6570;
    --line: #dfe3e8; --accent: #1f6feb; --ok: #1a7f37; --warn: #9a6700; --bad: #b42318;
    --bar: #e6eaf0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1216; --card: #171b21; --ink: #e7ebf0; --muted: #9aa5b1;
      --line: #2a313a; --accent: #4c8dff; --ok: #3fb950; --warn: #d29922; --bad: #f85149;
      --bar: #232a33;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
         font: 15px/1.5 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 20px 16px 48px; }
  header { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: baseline;
           padding-bottom: 14px; border-bottom: 1px solid var(--line); margin-bottom: 18px; }
  h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; }
  .chip { background: var(--card); border: 1px solid var(--line); border-radius: 999px;
          padding: 4px 11px; font-size: 13px; color: var(--muted); white-space: nowrap; }
  .chip b { color: var(--ink); font-weight: 600; }
  .job { background: var(--card); border: 1px solid var(--line); border-radius: 10px;
         padding: 14px 16px; margin-bottom: 12px; }
  .row1 { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: baseline; }
  .rid { font-weight: 650; font-size: 16px; }
  .badge { font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em;
           padding: 2px 8px; border-radius: 5px; border: 1px solid currentColor; }
  .s-running { color: var(--accent); } .s-queued { color: var(--warn); }
  .s-succeeded { color: var(--ok); }   .s-failed { color: var(--bad); }
  .meta { color: var(--muted); font-size: 13px; display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 6px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12.5px; }
  .barwrap { margin-top: 10px; }
  .bar { height: 8px; background: var(--bar); border-radius: 999px; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: var(--accent); border-radius: 999px;
             transition: width .3s ease; }
  .barlab { font-size: 13px; color: var(--muted); margin-top: 5px; }
  .links { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; }
  .links a { font-size: 13px; text-decoration: none; color: var(--accent);
             border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; background: var(--bg); }
  .links a:hover { border-color: var(--accent); }
  .err { margin-top: 10px; color: var(--bad); background: color-mix(in srgb, var(--bad) 8%, transparent);
         border: 1px solid color-mix(in srgb, var(--bad) 30%, transparent); border-radius: 7px;
         padding: 9px 11px; white-space: pre-wrap; word-break: break-word; }
  .empty { color: var(--muted); text-align: center; padding: 48px 0; }
  footer { margin-top: 20px; color: var(--muted); font-size: 12.5px; text-align: center; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%;
         background: var(--ok); margin-right: 6px; vertical-align: middle; }
  .stale .dot { background: var(--bad); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>AstraCode — bảng theo dõi</h1>
    <div class="chips" id="chips"></div>
  </header>
  <div id="jobs"></div>
  <footer id="foot"><span class="dot"></span>tự làm mới mỗi 2 giây · trang chỉ đọc, không có nút dừng job</footer>
</div>
<script>
(function () {
  var jobsEl = document.getElementById('jobs');
  var chipsEl = document.getElementById('chips');
  var footEl = document.getElementById('foot');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function chip(label, value) {
    var c = el('span', 'chip');
    c.appendChild(document.createTextNode(label + ' '));
    c.appendChild(el('b', null, value));
    return c;
  }
  function hhmmss(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleTimeString();
  }
  function secs(ms) {
    if (!ms && ms !== 0) return null;
    return (ms / 1000).toFixed(1) + 's';
  }

  function renderJob(j) {
    var card = el('div', 'job');

    var r1 = el('div', 'row1');
    r1.appendChild(el('span', 'rid', j.run_id || j.slug));
    r1.appendChild(el('span', 'badge s-' + j.status, j.status));
    if (j.backend) r1.appendChild(el('span', 'chip', 'backend ' + j.backend));
    card.appendChild(r1);

    var meta = el('div', 'meta');
    if (j.repo) meta.appendChild(el('span', 'mono', j.repo));
    if (j.tickets !== null && j.tickets !== undefined) meta.appendChild(el('span', null, j.tickets + ' ticket'));
    meta.appendChild(el('span', null, 'bắt đầu ' + hhmmss(j.started_at)));
    meta.appendChild(el('span', null, 'kết thúc ' + hhmmss(j.finished_at)));
    if (j.stats && j.stats.duration_ms) meta.appendChild(el('span', null, 'mất ' + secs(j.stats.duration_ms)));
    card.appendChild(meta);

    if (j.stats) {
      var s = j.stats, bits = [];
      if (s.judge_calls !== undefined) bits.push('parse ' + s.judge_parsed + '/' + s.judge_calls);
      if (s.judge_failed) bits.push(s.judge_failed + ' lượt hỏng');
      if (s.tickets_skipped) bits.push(s.tickets_skipped + ' bỏ qua');
      if (s.evidence_kept !== undefined)
        bits.push('bằng chứng ' + s.evidence_kept + '/' + (s.evidence_dropped || 0) + '/' + (s.evidence_clamped || 0));
      if (s.hits_429 || s.hits_503) bits.push((s.hits_429 || 0) + '×429, ' + (s.hits_503 || 0) + '×503');
      if (bits.length) {
        var m2 = el('div', 'meta');
        bits.forEach(function (b) { m2.appendChild(el('span', null, b)); });
        card.appendChild(m2);
      }
    }

    if (j.status === 'running' || j.status === 'queued') {
      var total = (j.progress && j.progress.total) || 0;
      var done = (j.progress && j.progress.done) || 0;
      var pct = total ? Math.round((done / total) * 100) : 0;
      var bw = el('div', 'barwrap');
      var bar = el('div', 'bar');
      var fill = el('i');
      fill.style.width = pct + '%';
      bar.appendChild(fill);
      bw.appendChild(bar);
      bw.appendChild(el('div', 'barlab', done + '/' + total + ' ticket (' + pct + '%)' +
        (j.current ? ' · đang xử lý: ' + j.current : '')));
      card.appendChild(bw);
    }

    if (j.error) card.appendChild(el('div', 'err', j.error));

    if (j.status === 'succeeded') {
      var links = el('div', 'links');
      var base = '/api/v1/jobs/' + encodeURIComponent(j.run_id || j.slug);
      [['tải result.json', '/result'], ['tải report.md', '/report'], ['xem log', '/log']].forEach(function (p) {
        var a = el('a', null, p[0]);
        a.href = base + p[1];
        if (p[1] === '/log') a.target = '_blank';
        links.appendChild(a);
      });
      card.appendChild(links);
    }
    return card;
  }

  function tick() {
    fetch('/api/v1/jobs', { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        footEl.classList.remove('stale');
        chipsEl.textContent = '';
        var s = data.server || {};
        chipsEl.appendChild(chip('backend', s.backend || '—'));
        chipsEl.appendChild(chip('model', s.model || '—'));
        chipsEl.appendChild(chip('lượt gọi model (phiên này)', s.model_calls_this_session));
        chipsEl.appendChild(chip('job (phiên này)', s.jobs_this_session));
        if (s.max_tickets) chipsEl.appendChild(chip('trần ticket', s.max_tickets));

        jobsEl.textContent = '';
        if (!data.jobs || !data.jobs.length) {
          jobsEl.appendChild(el('div', 'empty', 'Chưa có job nào. Trang sẽ tự hiện khi AstraQA gửi request sang.'));
          return;
        }
        data.jobs.forEach(function (j) { jobsEl.appendChild(renderJob(j)); });
      })
      .catch(function (e) {
        footEl.classList.add('stale');
        footEl.textContent = '';
        footEl.appendChild(el('span', 'dot'));
        footEl.appendChild(document.createTextNode('mất kết nối tới server — ' + e.message));
      });
  }

  tick();
  setInterval(tick, 2000);
})();
</script>
</body>
</html>
`;

/**
 * Bốn route đọc + trang HTML. Trả `true` nếu đã xử lý request, `false` để
 * server tiếp tục các route cũ của nó.
 *
 * `isAuthorized(req)` do server truyền vào — xem ghi chú ở `server.mjs` về việc
 * vì sao loopback được miễn token.
 */
export function createAdminRoutes({ jobs, config, usage, runsDir, redact = (s) => String(s), isAuthorized }) {
  const send = (res, code, type, body) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  };
  const sendJson = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

  /** `run_id` của người lạ → tên file an toàn, rồi đọc file trong đúng thư mục. */
  async function serveFile(res, rawRunId, kind) {
    const slug = slugifyRunId(rawRunId, '');
    if (!slug) return sendJson(res, 404, { error: 'run_id không hợp lệ' });

    const spec = {
      result: { dir: path.join(runsDir, 'results'), file: `${slug}.json`, type: 'application/json; charset=utf-8' },
      report: { dir: path.join(runsDir, 'results'), file: `${slug}.md`, type: 'text/markdown; charset=utf-8' },
      log: { dir: path.join(runsDir, 'logs'), file: `${slug}.log`, type: 'text/plain; charset=utf-8' },
    }[kind];

    const found = await readInside(spec.dir, spec.file);
    if (!found) return sendJson(res, 404, { error: `không có ${kind} cho run_id "${slug}"` });

    const body = await fs.readFile(found.abs, 'utf8');
    // Đã che lúc ghi, che lại lúc đọc: file có thể đến từ lần chạy trước.
    return send(res, 200, spec.type, redact(body));
  }

  return async function handleAdmin(req, res, route) {
    const isAdminRoute = route === '/admin' || route === '/api/v1/jobs' || /^\/api\/v1\/jobs\//.test(route);
    if (!isAdminRoute) return false;

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'trang admin chỉ đọc — chỉ nhận GET' });
      return true;
    }
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: 'unauthorized: cần Authorization: Bearer <ASTRACODE_SERVICE_TOKEN> khi gọi từ máy khác' });
      return true;
    }

    if (route === '/admin') {
      send(res, 200, 'text/html; charset=utf-8', PAGE);
      return true;
    }

    if (route === '/api/v1/jobs') {
      sendJson(res, 200, {
        server: {
          backend: config.judgeBackend,
          model: config.judgeBackend === 'fci' ? config.fciModel || null : null,
          max_tickets: config.maxTickets ?? 0,
          judge_concurrency: config.judgeConcurrency ?? 2,
          model_calls_this_session: usage.model_calls,
          jobs_this_session: usage.jobs,
        },
        jobs: await collectJobs({ jobs, runsDir, redact }),
      });
      return true;
    }

    const m = /^\/api\/v1\/jobs\/([^/]+)\/(result|report|log)$/.exec(route);
    if (m) {
      await serveFile(res, decodeURIComponent(m[1]), m[2]);
      return true;
    }

    sendJson(res, 404, { error: 'not found' });
    return true;
  };
}
