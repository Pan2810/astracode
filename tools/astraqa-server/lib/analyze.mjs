/**
 * Chạy một job: clone → tách ticket → mỗi ticket một lượt judge → gộp kết quả.
 *
 * Hai backend, cùng một schema trả về:
 *   - `fci` (mặc định): một request HTTP tới endpoint OpenAI-compatible, ngữ
 *     cảnh repo gom sẵn, `temperature: 0`.
 *   - `cli`: spawn CLI của AstraCode, agent tự duyệt repo.
 * Chỗ duy nhất biết chúng khác nhau là `judgeOnce()`; từ đó trở đi đường đi
 * giống hệt — cùng bộ bóc JSON, cùng bộ lọc evidence, cùng report.
 *
 * Tuần tự, cố ý: tiến độ `done/total` chỉ có nghĩa khi các lượt không chồng nhau.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cloneRepo, diffSinceBase } from './git.mjs';
import { readRepoRules } from './repoRules.mjs';
import { MAX_BODY_CHARS, parseSchemaVersion, resolveTickets } from './tickets.mjs';
import { buildPrompt, buildJudgePrompt } from './prompt.mjs';
import { extractJsonBlock, pickItem } from './jsonBlock.mjs';
import { matchesAny } from './globs.mjs';
import { askFci, fciConfigured } from './fciJudge.mjs';
import { judgeWithoutModel } from './noneJudge.mjs';
import { buildRepoContext, renderContext } from './repoContext.mjs';
import { createLimiter } from './limit.mjs';
import { buildIndex } from './candidates.mjs';

/**
 * `tickets_subset` — chỉ quét đúng những ticket này.
 *
 * Repo vẫn được clone đủ: thứ đắt trong một job không phải bản clone mà là
 * những lượt quét và những lượt gọi model. Bên gọi đã biết 184 ticket kia không
 * đổi gì kể từ lần chạy trước thì không có lý do gì bắt server chấm lại chúng.
 *
 * Ticket nằm ngoài tập KHÔNG biến mất khỏi báo cáo — chúng về với
 * `reason: "not_in_subset"`, cùng một luật với `skipped_quota_limit`: bỏ hẳn
 * một ticket khỏi `items` sẽ khiến AstraQA đọc bảng thành "`tickets_md` chỉ có
 * bấy nhiêu", và một ticket vắng mặt trông y như một ticket đã xét và không
 * thấy gì.
 *
 * Key lạ (có trong tập, không có trong `tickets_md`) chỉ là một cảnh báo: nó
 * thường là ticket vừa bị xoá bên kế hoạch, không phải lý do để hỏng cả job.
 *
 * @returns {{keys: Set<string>|null, unknown: string[]}}
 */
export function parseSubset(raw, tickets = []) {
  if (raw === undefined || raw === null) return { keys: null, unknown: [] };
  if (!Array.isArray(raw)) throw new Error('"tickets_subset" phải là một mảng key.');
  const keys = new Set();
  for (const k of raw) {
    const s = String(k ?? '').trim();
    if (s) keys.add(s);
  }
  if (keys.size === 0) {
    throw new Error('"tickets_subset" rỗng — gửi mảng rỗng nghĩa là không quét gì; bỏ hẳn field nếu muốn quét tất cả.');
  }
  const have = new Set(tickets.map((t) => t.key));
  return { keys, unknown: [...keys].filter((k) => !have.has(k)) };
}

export const DEFAULT_OPTIONS = {
  max_files_per_ticket: 5,
  exclude_globs: ['**/__pycache__/**', '**/node_modules/**', '**/.venv/**', '**/dist/**'],
  timeout_sec: 600,
  prompt_override: null,
};

/** Biến môi trường cho tiến trình con: chỉ những gì OS cần, cộng token AstraWork. */
function childEnv(astraworkToken) {
  const pass = [
    'PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'COMSPEC', 'ComSpec',
    'PATHEXT', 'LANG', 'LC_ALL',
  ];
  const env = {};
  for (const k of pass) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.NO_COLOR = '1';
  env.ASTRA_MARKDOWN = '0';
  // CLI đọc token ở đây (packages/cli/src/tokenStore.ts) trước khi rơi về ~/.astra.
  if (astraworkToken) env.ASTRAWORK_TOKEN = astraworkToken;
  return env;
}

function runCli({ cliPath, cwd, prompt, astraworkToken, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, '--mode=plan', '--raw', '-p', prompt], {
      cwd,
      env: childEnv(astraworkToken),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Một lượt judge cho một ticket. Trả về văn bản thô của model — phần bóc JSON
 * nằm ngoài, dùng chung cho cả hai backend.
 */
async function judgeOnce({ backend, ticket, options, repoDir, config, timeoutMs, redact, job, log, stats, limiter, usage, index }) {
  if (backend === 'none') {
    // Không có model nên không có gì để bóc: trả thẳng object đã dựng, nhưng nó
    // vẫn đi qua `pickItem` như hai backend kia để không có đường nào lách được
    // phần kiểm schema.
    const r = await judgeWithoutModel({ ticket, options, index });
    return { parsed: r, scan: r.scan, note: 'quét tất định (backend none)', stderr: '' };
  }

  if (backend === 'cli') {
    const prompt = buildPrompt({ ticket, options, promptOverride: options.prompt_override });
    usage.model_calls += 1;
    const res = await runCli({
      cliPath: config.cliPath,
      cwd: repoDir,
      prompt,
      astraworkToken: job.astraworkToken,
      timeoutMs,
      signal: job.abort?.signal,
    });
    if (res.timedOut) throw new Error(`Ticket "${ticket.key}": CLI quá ${Math.round(timeoutMs / 1000)}s, đã bị dừng.`);
    // Agent tự quyết đọc file nào bằng tool của nó; server không có bản ghi phép
    // quét ấy. Bịa một con số ở đây là tệ hơn nói không biết.
    return { text: res.stdout, scan: null, note: `CLI thoát với mã ${res.code}`, stderr: res.stderr };
  }

  if (!fciConfigured(config)) {
    throw new Error('Backend "fci" chưa cấu hình: cần FPT_BASE_URL, FPT_API_KEY và FPT_MODEL.');
  }
  const ctx = await buildRepoContext({ repoDir, ticket, excludeGlobs: options.exclude_globs });
  const prompt = buildJudgePrompt({
    ticket,
    options,
    context: renderContext(ctx),
    promptOverride: options.prompt_override,
  });
  // Ðổi tên khi bóc: `usage` trả về từ askFci là số token, còn tham số `usage`
  // của hàm này là bộ đếm lượt gọi. Trùng tên sẽ che mất bộ đếm trong cả thân hàm.
  const { text, usage: tokenUsage } = await limiter.run(() =>
    askFci({
      config,
      prompt,
      timeoutMs,
      redact,
      signal: job.abort?.signal,
      // Mỗi request HTTP là một lượt gọi model, kể cả lần thử lại.
      onAttempt: () => {
        usage.model_calls += 1;
      },
      onRetry: ({ status, attempt, of, waitMs, message }) => {
        // Hạn mức của nhà cung cấp là chuyện hạ tầng, không phải lỗi code — nên
        // nó phải hiện trong log chứ không im lặng trôi qua.
        stats[status === 429 ? 'hits_429' : 'hits_503'] += 1;
        log(`${ticket.key}: ${status} — chờ ${waitMs / 1000}s rồi thử lại (lần ${attempt}/${of}). ${message.slice(0, 160)}`);
      },
    }),
  );
  // `buildRepoContext` có đi hết corpus, nhưng thứ MODEL nhìn thấy chỉ là cây
  // file đã cắt còn `maxTreeFiles` và tối đa `maxSnippets` dòng khớp. Verdict
  // do model ra, không do phép quét ấy ra — nên báo `files_scanned` ở đây sẽ
  // khiến AstraQA đọc một ticket evidence rỗng thành JIRA_AHEAD chỉ vì model
  // chưa được cho xem đúng file. Đó chính là kiểu dương tính giả cần tránh.
  return { text, scan: null, note: `FCI ${config.fciModel}`, usage: tokenUsage, stderr: '' };
}

/** `src/a.ts:120-148` → {path, lines}. Model hay gộp như vậy dù schema tách hai field. */
function splitPathLine(raw) {
  const m = /^(.*?):(\d+(?:\s*-\s*\d+)?)$/.exec(raw);
  return m ? { path: m[1], lines: m[2] } : { path: raw, lines: '' };
}

function normalizeRel(raw, repoDir) {
  let p = String(raw).replace(/\\/g, '/').trim();
  if (!p) return '';
  if (path.isAbsolute(p) || /^[A-Za-z]:\//.test(p)) {
    const rel = path.relative(repoDir, path.resolve(p));
    if (rel.startsWith('..')) return '';
    p = rel.replace(/\\/g, '/');
  }
  return p.replace(/^\.\//, '').replace(/^\/+/, '');
}

async function countLines(file) {
  const buf = await fs.readFile(file);
  if (!buf.length) return 0;
  let n = 1;
  for (const b of buf) if (b === 10) n++;
  return buf[buf.length - 1] === 10 ? n - 1 : n;
}

/**
 * Giữ lại bằng chứng có thật. Luật, theo đúng thứ tự:
 *
 *   - path không tồn tại (hoặc không phải file, hoặc thoát khỏi repo, hoặc khớp
 *     exclude_globs)            → LOẠI
 *   - start > số dòng file      → LOẠI (trỏ vào chỗ không có gì)
 *   - end   > số dòng file      → KẸP end về số dòng file, giữ lại
 *   - thiếu `lines`             → GIỮ, `lines: null`
 *
 * Kẹp thay vì loại là có lý do: model đoán hụt điểm kết thúc của một hàm vẫn
 * đang chỉ đúng chỗ, còn `start` sai thì nó đang chỉ vào hư không.
 */
export async function keepRealEvidence(evidence, repoDir, options) {
  const kept = [];
  const dropped = [];
  const clamped = [];
  const seen = new Set();
  const paths = new Set();

  for (const ev of evidence) {
    const merged = ev.lines ? ev : { ...ev, ...splitPathLine(ev.path) };
    const rel = normalizeRel(merged.path, repoDir);
    const drop = (why) => dropped.push({ path: ev.path, why });

    if (!rel) {
      drop('đường dẫn rỗng hoặc nằm ngoài repo');
      continue;
    }
    if (matchesAny(rel, options.exclude_globs)) {
      drop('khớp exclude_globs');
      continue;
    }
    const abs = path.resolve(repoDir, rel);
    if (abs !== repoDir && !abs.startsWith(repoDir + path.sep)) {
      drop('đường dẫn thoát khỏi repo');
      continue;
    }
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      drop('không tồn tại trong repo');
      continue;
    }
    if (!stat.isFile()) {
      drop('không phải file');
      continue;
    }

    const rawLines = String(merged.lines ?? '').replace(/\s+/g, '');
    let lines = null;
    if (rawLines) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(rawLines);
      if (!m) {
        drop(`khoảng dòng "${merged.lines}" không đúng dạng "120-148" hoặc "42"`);
        continue;
      }
      const start = Number(m[1]);
      let end = m[2] ? Number(m[2]) : start;
      const total = await countLines(abs);
      if (start < 1 || start > total) {
        drop(`dòng bắt đầu ${start} nằm ngoài file (${total} dòng)`);
        continue;
      }
      if (end < start) {
        drop(`khoảng dòng ${rawLines} có điểm kết thúc nhỏ hơn điểm bắt đầu`);
        continue;
      }
      if (end > total) {
        clamped.push({ path: rel, from: rawLines, to: start === total ? `${start}` : `${start}-${total}` });
        end = total;
      }
      lines = start === end ? `${start}` : `${start}-${end}`;
    }

    const sig = `${rel}#${lines ?? 'null'}`;
    if (seen.has(sig)) continue;
    if (!paths.has(rel) && paths.size >= options.max_files_per_ticket) {
      drop(`vượt max_files_per_ticket=${options.max_files_per_ticket}`);
      continue;
    }
    seen.add(sig);
    paths.add(rel);
    kept.push({ path: rel, lines, note: merged.note ?? '' });
  }

  return { evidence: kept, dropped, clamped };
}

function buildReportMd({ runId, generatedAt, backend, repoUrl, ref, head, items, tickets, droppedByKey, clampedByKey, failedByKey, stats, diff, warnings = [] }) {
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const count = (s) => items.filter((i) => i.code_status === s).length;

  const out = [];
  out.push('# AstraCode — báo cáo đối chiếu code');
  out.push('');
  out.push(`- run_id: \`${runId}\``);
  out.push(`- generated_at: ${generatedAt}`);
  out.push(`- backend: \`${backend}\`${stats.model ? ` (model \`${stats.model}\`)` : ''}`);
  out.push(`- repo: ${repoUrl}${ref ? ` (ref: ${ref})` : ''}`);
  if (head) out.push(`- commit (source_revision): \`${head}\``);
  if (diff?.base) {
    out.push(`- base_revision: \`${diff.base}\` — ${diff.files ? `${diff.files.length} tệp đổi tới HEAD` : 'không lấy được danh sách tệp'}`);
  }
  if (stats.tickets_subset !== null && stats.tickets_subset !== undefined) {
    out.push(
      `- tickets_subset: xin ${stats.tickets_subset} key, quét ${stats.tickets_total - stats.tickets_out_of_subset}` +
        `, để nguyên ${stats.tickets_out_of_subset} ticket (\`not_in_subset\`)`,
    );
  }
  out.push(`- tickets: ${items.length} — done ${count('done')}, partial ${count('partial')}, missing ${count('missing')}`);
  out.push(`- bằng chứng: giữ ${stats.evidence_kept}, loại ${stats.evidence_dropped}, kẹp ${stats.evidence_clamped}`);
  out.push(`- lượt judge: ${stats.judge_parsed}/${stats.judge_calls} parse được${stats.judge_failed ? `, **${stats.judge_failed} lượt hỏng**` : ''}`);
  if (stats.tickets_skipped) {
    out.push(
      `- **bỏ qua ${stats.tickets_skipped}/${stats.tickets_total} ticket** vì \`ASTRACODE_MAX_TICKETS=${stats.max_tickets}\` ` +
        '— chưa xét, không phải đã xét rồi thấy thiếu',
    );
  }
  if (stats.hits_429 || stats.hits_503) {
    out.push(`- hạn mức nhà cung cấp: ${stats.hits_429} lần 429, ${stats.hits_503} lần 503 (đã tự thử lại)`);
  }
  if (stats.judge_failed) {
    out.push('');
    out.push(
      `> **Cảnh báo:** ${stats.judge_failed} ticket KHÔNG chấm được. Chúng nằm trong bảng dưới với ` +
        '`code_status: missing` và `reason: judge_failed: …` — đó là "chưa biết", KHÔNG phải "đã kiểm tra và thấy thiếu".',
    );
  }
  if (warnings.length) {
    out.push('');
    out.push('> **Cảnh báo:**');
    for (const w of warnings) out.push(`> - ${w}`);
  }

  out.push('');
  out.push('| Ticket | Trạng thái ngoài | Code | Confidence | Bằng chứng |');
  out.push('|---|---|---|---:|---:|');
  for (const it of items) {
    const t = byKey.get(it.key);
    out.push(
      `| \`${it.key}\` | ${t?.status || '—'} | **${it.code_status}** | ${it.confidence.toFixed(2)} | ${it.evidence.length} |`,
    );
  }
  out.push('');

  for (const it of items) {
    const t = byKey.get(it.key);
    out.push(`## ${it.key}${t?.title ? ` — ${t.title}` : ''}`);
    out.push('');
    if (it.reason === 'not_in_subset') {
      // Khác `skipped_quota_limit` ở chỗ: đây là bên gọi tự chọn không quét,
      // không phải server cắt vì hạn mức. Cùng một chữ `missing`, hai câu chuyện.
      out.push('- **KHÔNG QUÉT** — ticket này không nằm trong `tickets_subset` của request.');
      if (t?.status) out.push(`- trạng thái do nguồn ngoài báo: ${t.status}`);
      out.push('');
      out.push('- _`missing` ở đây nghĩa là "không được xét lần này", không phải "đã kiểm tra và thấy thiếu"._');
      out.push('');
      continue;
    }
    if (it.reason === 'skipped_quota_limit') {
      out.push(`- **BỎ QUA** — vượt \`ASTRACODE_MAX_TICKETS=${stats.max_tickets}\`, ticket này chưa được xét lần nào.`);
      if (t?.status) out.push(`- trạng thái do nguồn ngoài báo: ${t.status}`);
      out.push('');
      out.push('- _`missing` ở đây nghĩa là "chưa xét", không phải "đã kiểm tra và thấy thiếu"._');
      out.push('');
      continue;
    }
    if (it.truncated) {
      out.push('- **MÔ TẢ ÐÃ CẮT** — kết luận dưới đây dựa trên phần mô tả đã bị cắt bớt.');
    }
    const failed = failedByKey.get(it.key);
    if (failed) {
      out.push(`- **KHÔNG chấm được** — ${failed}`);
      if (t?.status) out.push(`- trạng thái do nguồn ngoài báo: ${t.status}`);
      out.push('');
      out.push('- _`missing` ở đây nghĩa là "chưa biết", không phải "đã kiểm tra và thấy thiếu"._');
      out.push('');
      continue;
    }
    out.push(`- code_status: **${it.code_status}** (confidence ${it.confidence.toFixed(2)}, reason: ${it.reason})`);
    if (t?.status) out.push(`- trạng thái do nguồn ngoài báo: ${t.status}`);
    // Bản ghi quét: chỗ phân biệt "đã quét, không thấy" với "chưa quét lần nào".
    if (it.scan) {
      out.push(
        `- đã quét **${it.scan.files_scanned} file** @ \`${String(it.scan.revision ?? '(không rõ)').slice(0, 12)}\` — ` +
          `từ khoá: ${it.scan.terms.map((k) => `\`${k}\``).join(', ') || '(không có)'}`,
      );
    } else {
      out.push('- _không có bản ghi quét (`scan: null`) — backend này không quét toàn bộ corpus._');
    }
    out.push('');
    if (it.evidence.length) {
      for (const ev of it.evidence) {
        out.push(`- \`${ev.path}${ev.lines ? `:${ev.lines}` : ''}\`${ev.lines ? '' : ' _(không nêu số dòng)_'}${ev.note ? ` — ${ev.note}` : ''}`);
      }
    } else {
      out.push('- _không có bằng chứng nào trụ lại sau khi đối chiếu với repo._');
    }
    // Bảng chấm từng tiêu chí chấp nhận. Ðọc được bằng mắt ở đây, và là cùng
    // dữ liệu mà AstraQA gộp theo `id` ở đầu bên kia.
    if (it.assessment?.criteria?.length) {
      out.push('');
      out.push('Tiêu chí chấp nhận:');
      for (const c of it.assessment.criteria) {
        const cite = c.evidence.map((ev) => `\`${ev.path}${ev.lines ? `:${ev.lines}` : ''}\``).join(', ');
        out.push(`- ${c.id}. **${c.status}** — ${c.text}${cite ? ` (${cite})` : ''}${c.reason ? ` — ${c.reason}` : ''}`);
      }
    }
    const clamped = clampedByKey.get(it.key) ?? [];
    if (clamped.length) {
      out.push('');
      out.push(
        `<sub>đã kẹp ${clamped.length} khoảng dòng về cuối file: ${clamped
          .map((c) => `\`${c.path}\` ${c.from} → ${c.to}`)
          .join(', ')}</sub>`,
      );
    }
    const dropped = droppedByKey.get(it.key) ?? [];
    if (dropped.length) {
      out.push('');
      out.push(`<sub>đã loại ${dropped.length} bằng chứng: ${dropped.map((d) => `\`${d.path}\` (${d.why})`).join(', ')}</sub>`);
    }
    out.push('');
  }

  return out.join('\n');
}

/**
 * Chạy job. Cập nhật `job.progress` / `job.current` tại chỗ để endpoint poll
 * đọc được ngay, trả về `result` đúng hợp đồng.
 */
export async function runAnalyzeJob({ job, body, config, redact, log, limiter = createLimiter(1), usage = { model_calls: 0 } }) {
  const options = { ...DEFAULT_OPTIONS, ...(body.options ?? {}) };
  const timeoutMs = Math.max(1, Number(options.timeout_sec) || DEFAULT_OPTIONS.timeout_sec) * 1000;
  const maxFiles = Math.max(1, Number(options.max_files_per_ticket) || DEFAULT_OPTIONS.max_files_per_ticket);
  const excludes = Array.isArray(options.exclude_globs) ? options.exclude_globs : DEFAULT_OPTIONS.exclude_globs;
  const effective = { ...options, max_files_per_ticket: maxFiles, exclude_globs: excludes };

  const backend = ['cli', 'fci', 'none'].includes(body.backend) ? body.backend : config.judgeBackend;

  // Tách ticket TRƯỚC khi clone: tickets_md hỏng thì không việc gì phải kéo cả
  // một repo về rồi mới báo lỗi.
  const { tickets, source: ticketSource } = resolveTickets(body);
  // Thiếu thì là 1; khác 1 thì `parseSchemaVersion` ném — và route đã chặn
  // trước đó, nên tới đây ném là chuyện của một client gọi thẳng hàm này.
  const schemaVersion = parseSchemaVersion(body.tickets_schema_version);

  /**
   * Trần số ticket được chấm trong MỘT job. `0` = không giới hạn.
   *
   * Lý do tồn tại: hạn mức của nhà cung cấp tính theo NGÀY (free tier của Google
   * cho 20 lượt/ngày/model), mà một ticket là một lượt. Một buổi demo chỉ cần
   * vài ticket đầu để cho thấy đường ống chạy — nếu để nguyên 184 ticket thì
   * hết sạch hạn mức ngay lượt đầu và không còn gì cho hôm sau.
   *
   * Các ticket vượt trần KHÔNG bị bỏ khỏi báo cáo: chúng vẫn là item hợp lệ với
   * `reason: "skipped_quota_limit"`, để AstraQA thấy rõ chúng chưa được xét chứ
   * không phải đã xét rồi thấy thiếu.
   */
  const maxTickets = Math.max(0, Number(config.maxTickets ?? 0) || 0);

  /*
   * Hai phép lọc, và thứ tự giữa chúng là có chủ ý: tập con của BÊN GỌI áp
   * trước, trần của server áp sau. Ðảo lại thì trần cắt vào danh sách đầy đủ
   * rồi tập con mới lọc phần còn sót — bên gọi xin 6 ticket cuối bảng sẽ nhận
   * về không ticket nào, mà không có gì nói vì sao.
   */
  const subset = parseSubset(body.tickets_subset, tickets);
  const wanted = subset.keys ? tickets.filter((t) => subset.keys.has(t.key)) : tickets;
  const outOfSubset = subset.keys ? tickets.filter((t) => !subset.keys.has(t.key)) : [];

  const toJudge = maxTickets > 0 ? wanted.slice(0, maxTickets) : wanted;
  const skipped = maxTickets > 0 ? wanted.slice(maxTickets) : [];

  /** Chuyện đáng nói nhưng không đáng hỏng job. Ði thẳng vào kết quả trả về. */
  const warnings = [];
  if (subset.keys) {
    log(
      `tickets_subset: ${subset.keys.size} key được xin, khớp ${wanted.length}/${tickets.length} ticket — ` +
        `${outOfSubset.length} ticket còn lại về với reason "not_in_subset" (repo vẫn clone đủ).`,
    );
    if (subset.unknown.length) {
      warnings.push(
        `tickets_subset có ${subset.unknown.length} key không có trong tickets_md: ` +
          `${subset.unknown.slice(0, 10).join(', ')}${subset.unknown.length > 10 ? '…' : ''}`,
      );
    }
    if (wanted.length === 0) {
      warnings.push('tickets_subset không khớp ticket nào trong tickets_md — không lượt quét nào chạy.');
    }
  }
  if (skipped.length) {
    log(`ASTRACODE_MAX_TICKETS=${maxTickets} — chỉ chấm ${toJudge.length}/${wanted.length} ticket, bỏ qua ${skipped.length} ticket còn lại.`);
  }

  const repoDir = path.join(config.workspaceDir, job.id, 'repo');
  await fs.mkdir(repoDir, { recursive: true });

  job.progress = { done: 0, total: tickets.length };
  job.astraworkToken = body.astrawork_token || config.astraworkJwt || '';
  const startedAt = Date.now();
  const stats = {
    backend,
    model: backend === 'fci' ? config.fciModel : undefined,
    judge_calls: 0,
    judge_parsed: 0,
    judge_failed: 0,
    tickets_total: tickets.length,
    // Ticket đến từ đâu: mảng JSON đã có cấu trúc, hay phép dò trên tickets_md.
    tickets_source: ticketSource,
    tickets_schema_version: schemaVersion,
    // Ticket có mô tả bị cắt, và bao nhiêu item mang được bảng chấm từng tiêu chí.
    tickets_truncated: 0,
    items_with_assessment: 0,
    ac_evidence_dropped: 0,
    tickets_skipped: skipped.length,
    max_tickets: maxTickets,
    // Bên gọi xin bao nhiêu, khớp bao nhiêu, còn lại bao nhiêu không quét.
    // `null` = không gửi `tickets_subset`, khác với "gửi nhưng không khớp ai".
    tickets_subset: subset.keys ? subset.keys.size : null,
    tickets_out_of_subset: outOfSubset.length,
    hits_429: 0,
    hits_503: 0,
    // Bao nhiêu item mang được bản ghi quét thật. `items_without_scan` là số
    // item mà AstraQA KHÔNG được phép kết luận JIRA_AHEAD.
    items_with_scan: 0,
    items_without_scan: 0,
    evidence_kept: 0,
    evidence_dropped: 0,
    evidence_clamped: 0,
    duration_ms: 0,
  };
  job.stats = stats;

  try {
    const { head } = await cloneRepo({
      repoUrl: body.repo_url,
      ref: body.ref,
      repoToken: body.repo_token,
      destDir: repoDir,
      redact,
      timeoutMs,
    });

    const items = [];
    /** Ticket nào có mô tả bị cắt — để một dòng cảnh báo gọi đúng tên chúng. */
    const truncatedKeys = [];
    const droppedByKey = new Map();
    const clampedByKey = new Map();
    const failedByKey = new Map();

    log(
      `clone xong: ${tickets.length} ticket, commit ${head || '(không rõ)'} — ` +
        `chấm ${toJudge.length} bằng backend ${backend}${skipped.length ? `, bỏ qua ${skipped.length} vì ASTRACODE_MAX_TICKETS` : ''}`,
    );

    /*
     * Tệp rules của đội, nguyên văn, nếu repo có.
     *
     * Đọc ở đây vì đây là chỗ duy nhất có bản clone. AstraCode không hiểu nội
     * dung — luật verdict nằm bên AstraQA — nên nó chỉ chuyển tệp đi. Đọc hỏng
     * không làm hỏng job: một repo không có rules là chuyện bình thường, và
     * bên kia đã có sẵn đường lui về bộ luật cấp tenant.
     */
    const repoRules = await readRepoRules({ repoDir, log });

    /*
     * `base_revision` — những tệp đã đổi từ mốc ấy tới HEAD.
     *
     * Chạy ngay sau clone và TRƯỚC vòng quét: nó có thể phải đào sâu thêm lịch
     * sử, và một lần đào hỏng giữa chừng thì thà biết sớm hơn là sau 184 lượt.
     * Không tìm được `base` chỉ là cảnh báo — xem `diffSinceBase`.
     */
    const diff = await diffSinceBase({ repoDir, base: body.base_revision, redact, timeoutMs, log });
    if (diff.warning) {
      warnings.push(diff.warning);
      log(`CẢNH BÁO: ${diff.warning}`);
    } else if (diff.files) {
      log(`base_revision ${diff.base}: ${diff.files.length} tệp đổi tới HEAD`);
    }

    /**
     * Index toàn repo, dựng ÐÚNG MỘT LẦN cho cả job.
     *
     * Bắt buộc một lần vì `document_frequency` là đại lượng toàn repo: nó không
     * tính được từ một lượt quét riêng của một ticket. (Bản cũ quét lại cả repo
     * cho từng ticket — 184 ticket là 184 lần đi cây thư mục.)
     *
     * Chỉ backend `none` cần; `fci` và `cli` để model/agent tự tìm.
     */
    let index = null;
    if (backend === 'none') {
      const tIndex = Date.now();
      index = await buildIndex({ repoDir, fs, path, excludeGlobs: effective.exclude_globs, matchesAny });
      log(`index: ${index.N} file, ${index.df.size} term khác nhau, dựng trong ${Date.now() - tIndex}ms`);
    }

    for (const ticket of toJudge) {
      job.current = ticket.key;
      const ticketStartedAt = Date.now();

      stats.judge_calls += 1;

      /**
       * Một ticket hỏng không được kéo cả job xuống: 49 ticket đã chấm xong mà
       * mất trắng vì ticket thứ 50 là kiểu hỏng đắt nhất của hệ này. Ticket hỏng
       * thành một item `missing` với `reason` nói rõ vì sao, và `stats` đếm
       * riêng — nên tỉ lệ parse vẫn đọc được từ `judge_parsed / judge_calls`.
       */
      let item;
      try {
        const res = await judgeOnce({
          backend, ticket, options: effective, repoDir, config, timeoutMs, redact, job, log, stats, limiter, usage, index,
        });

        let parsed;
        try {
          parsed = res.parsed ?? extractJsonBlock(res.text);
        } catch (err) {
          const tail = redact(res.stderr ?? '').trim().split('\n').slice(-3).join(' ');
          throw new Error(
            `${err instanceof Error ? err.message : String(err)} (${res.note}${tail ? `, stderr: ${tail}` : ''})`,
          );
        }

        item = pickItem(parsed, ticket.key, { acceptanceCriteria: ticket.acceptance_criteria });
        // `pickItem` chỉ trả về đúng năm field cũ, nên `scan` gắn vào ở đây.
        // Bắt buộc có mặt ở MỌI item — `null` là một câu trả lời hợp lệ ("không
        // biết"), còn thiếu field thì client không phân biệt được với `null`.
        item.scan = res.scan ? { ...res.scan, revision: head || null } : null;
        stats.judge_parsed += 1;
      } catch (err) {
        const why = redact(err instanceof Error ? err.message : String(err));
        stats.judge_failed += 1;
        failedByKey.set(ticket.key, why);
        log(
          `[${items.length + 1}/${toJudge.length}] ${ticket.key} | ${Date.now() - ticketStartedAt}ms | ` +
            `LƯỢT HỎNG — ${why}`,
        );
        // `missing` + confidence 0 là cách trung thực nhất để nói "không chấm
        // được": không bịa kết luận, mà cũng không im lặng bỏ ticket khỏi báo cáo.
        items.push({
          key: ticket.key,
          code_status: 'missing',
          confidence: 0,
          evidence: [],
          reason: `judge_failed: ${why}`,
          // Lượt hỏng nghĩa là chưa quét được gì — `null`, không phải 0.
          scan: null,
        });
        stats.items_without_scan += 1;
        droppedByKey.set(ticket.key, []);
        clampedByKey.set(ticket.key, []);
        job.progress = { done: items.length, total: tickets.length };
        continue;
      }

      const { evidence, dropped, clamped } = await keepRealEvidence(item.evidence, repoDir, effective);
      item.evidence = evidence;
      droppedByKey.set(item.key, dropped);
      clampedByKey.set(item.key, clamped);
      stats.evidence_kept += evidence.length;
      stats.evidence_dropped += dropped.length;
      stats.evidence_clamped += clamped.length;

      // Mô tả bị cắt thì item nói ra, không chỉ log: bên nhận đang đọc một kết
      // luận rút ra từ một nửa đề bài và có quyền biết điều đó.
      item.truncated = Boolean(ticket.truncated);
      if (item.truncated) truncatedKeys.push(ticket.key);

      /*
       * Bằng chứng của TỪNG tiêu chí đi qua đúng bộ lọc của bằng chứng chung.
       *
       * Không lọc ở đây thì một đường dẫn bịa vẫn nằm trong `assessment` và
       * AstraQA hiển thị nó như một trích dẫn kiểm được. Lọc xong mà không còn
       * dòng nào để chỉ thì trạng thái tụt về `unknown` — cùng luật AstraQA áp
       * ở đầu bên kia, áp sẵn ở đây để hai bên không nói khác nhau về cùng một
       * tiêu chí.
       */
      if (item.assessment) {
        for (const c of item.assessment.criteria) {
          if (!c.evidence.length) continue;
          const kept = await keepRealEvidence(c.evidence, repoDir, effective);
          c.evidence = kept.evidence;
          stats.ac_evidence_dropped += kept.dropped.length;
          if (c.status !== 'unknown' && !c.evidence.some((ev) => ev.lines)) c.status = 'unknown';
        }
        stats.items_with_assessment += 1;
      }
      // Một dòng cho MỌI ticket, không chỉ ticket có evidence bị loại: đọc log
      // ban đêm cần thấy cả những lượt trôi chảy, nếu không thì im lặng là nhập
      // nhằng giữa "chạy tốt" và "chưa chạy tới".
      log(
        `[${items.length + 1}/${toJudge.length}] ${ticket.key} | ${Date.now() - ticketStartedAt}ms | ` +
          `${item.code_status} (confidence ${item.confidence.toFixed(2)}, ${item.reason}) | ` +
          `bằng chứng giữ ${evidence.length}, loại ${dropped.length}, kẹp ${clamped.length}` +
          (dropped.length ? ` — loại: ${dropped.map((d) => `${d.path} (${d.why})`).join('; ')}` : '') +
          (clamped.length ? ` — kẹp: ${clamped.map((c) => `${c.path} ${c.from}→${c.to}`).join('; ')}` : ''),
      );

      stats[item.scan ? 'items_with_scan' : 'items_without_scan'] += 1;
      items.push(item);
      job.progress = { done: items.length, total: tickets.length };
    }

    // Ticket vượt trần vẫn có mặt trong báo cáo, chỉ nói rõ là chưa xét. Bỏ hẳn
    // chúng khỏi `items` sẽ khiến AstraQA tưởng `tickets_md` chỉ có bấy nhiêu.
    // Ticket ngoài `tickets_subset` cũng vậy, chỉ khác lý do.
    for (const ticket of [...skipped, ...outOfSubset]) {
      items.push({
        key: ticket.key,
        code_status: 'missing',
        confidence: 0,
        evidence: [],
        reason: skipped.includes(ticket) ? 'skipped_quota_limit' : 'not_in_subset',
        // Chưa xét lần nào thì cũng chưa quét lần nào.
        scan: null,
      });
      stats.items_without_scan += 1;
      droppedByKey.set(ticket.key, []);
      clampedByKey.set(ticket.key, []);
      job.progress = { done: items.length, total: tickets.length };
    }

    // Không lượt nào chấm được thì đừng trả về một bảng toàn `missing`: AstraQA
    // sẽ đọc nó thành "cả repo chưa làm gì". Hỏng hết là hỏng job, nói thẳng.
    if (toJudge.length > 0 && stats.judge_parsed === 0) {
      throw new Error(
        `Không lượt judge nào thành công (${stats.judge_failed}/${toJudge.length} ticket hỏng). ` +
          `Lỗi đầu tiên: ${failedByKey.values().next().value ?? 'không rõ'}`,
      );
    }

    // Cùng một luật, áp cho bộ lọc bằng chứng: sinh ra N mảnh rồi loại sạch N
    // thì bảng trả về toàn item "đã xét, không thấy gì" — AstraQA đọc thành
    // NO_EVIDENCE hàng loạt, và không có dòng nào nói rằng chỗ hỏng là bộ lọc.
    // Ca đã gặp: WORKSPACE_DIR tương đối → repoDir tương đối → mọi path bị coi
    // là "thoát khỏi repo". Lỗi thì hiện lỗi, không bao giờ trả bảng rỗng im lặng.
    if (stats.evidence_kept === 0 && stats.evidence_dropped > 0) {
      throw new Error(
        `Bộ lọc bằng chứng loại toàn bộ ${stats.evidence_dropped}/${stats.evidence_dropped} mảnh — ` +
          `kiểm WORKSPACE_DIR/repoDir (repoDir="${repoDir}", tuyệt đối=${path.isAbsolute(repoDir)}).`,
      );
    }

    stats.tickets_truncated = truncatedKeys.length;
    if (truncatedKeys.length) {
      // Một dòng, gọi đúng tên ticket: "có mô tả bị cắt" mà không nói cắt của
      // ai thì người đọc phải mở từng item ra dò.
      warnings.push(
        `Mô tả dài quá ${MAX_BODY_CHARS} ký tự nên đã bị cắt ở ${truncatedKeys.length} ticket ` +
          `(${truncatedKeys.slice(0, 10).join(', ')}${truncatedKeys.length > 10 ? '…' : ''}) — ` +
          'kết luận của chúng dựa trên phần mô tả đã cắt.',
      );
    }

    stats.duration_ms = Date.now() - startedAt;
    const generatedAt = new Date().toISOString();
    return {
      run_id: body.run_id ?? null,
      generated_at: generatedAt,
      backend,
      // SHA đầy đủ của commit đã clone. Cùng giá trị lặp lại trong `item.scan.revision`
      // để mỗi item tự chứa, dựng được link dẫn chứng mà không phải ngoái lên.
      source_revision: head || null,
      /*
       * `.astraqa/rules.yml` như nó nằm trong repo, hoặc `null` khi repo không
       * có. `null` khác với một tệp rỗng và bên gọi phân biệt hai cái: tệp rỗng
       * là đội đã nói "dùng mặc định", không có tệp là đội chưa nói gì.
       */
      repo_rules: repoRules,
      /*
       * Mốc so sánh đã GIẢI RA, và những tệp đổi từ đó tới HEAD.
       *
       * Ba trạng thái, phân biệt được bằng đúng hai field này:
       *   - không hỏi          → `base_revision: null`, `changed_files: null`, không cảnh báo
       *   - hỏi và lấy được    → `base_revision: <sha>`, `changed_files: [...]`
       *   - hỏi mà không thấy  → `base_revision: null`, `changed_files: null`, KÈM cảnh báo
       *
       * `changed_files` là `null` chứ không phải `[]` khi không biết: một mảng
       * rỗng là câu trả lời "không tệp nào đổi", và hai chuyện ấy khác nhau.
       */
      base_revision: diff.base,
      changed_files: diff.files,
      /*
       * Chuyện đáng nói mà không đáng hỏng job: base không tìm thấy, key trong
       * `tickets_subset` không có trong `tickets_md`. Luôn có mặt (mảng rỗng khi
       * không có gì) để bên gọi không phải phân biệt "không có cảnh báo" với
       * "bản server này chưa biết field ấy".
       */
      warnings,
      items,
      report_md: buildReportMd({
        runId: body.run_id ?? job.id,
        generatedAt,
        backend,
        repoUrl: redact(body.repo_url),
        ref: body.ref ?? '',
        head,
        items,
        tickets,
        droppedByKey,
        clampedByKey,
        failedByKey,
        stats,
        diff,
        warnings,
      }),
      stats,
    };
  } finally {
    stats.duration_ms = stats.duration_ms || Date.now() - startedAt;
    job.current = undefined;
    // Xong job là xoá. Repo của người khác không có lý do gì nằm lại trên đĩa.
    await fs
      .rm(path.join(config.workspaceDir, job.id), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      .catch((err) => log(`job ${job.id}: không xoá được thư mục tạm — ${redact(String(err))}`));
  }
}
