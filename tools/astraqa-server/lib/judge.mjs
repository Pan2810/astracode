/**
 * Job judge: chấm lại từng ticket bằng model, trên đúng bằng chứng tầng grep đã tìm ra.
 *
 * Khác `analyze.mjs` ở ba điểm, và cả ba đều là lý do nó tồn tại riêng:
 *
 *   - **Không đi tìm.** `analyze` phải tự dò cả repo để đoán file nào liên quan.
 *     Ở đây bên gọi đã có bằng chứng: nó gửi kèm `path` + `lines` mà tầng grep
 *     tìm được, và việc của job này là ÐỌC đúng những dòng đó rồi kết luận. Nhờ
 *     thế prompt ngắn hơn nhiều lần và model không phải đoán trong bóng tối.
 *   - **Song song.** `analyze` chạy tuần tự để `done/total` có nghĩa. Ở đây mỗi
 *     ticket độc lập hoàn toàn, nên chạy tới `ASTRACODE_JUDGE_CONCURRENCY` lượt
 *     cùng lúc và `done` đếm số lượt đã xong — thứ tự hoàn thành, không phải thứ
 *     tự gửi.
 *   - **Trả dần.** `GET` trả `results[]` đang lớn lên chứ không chờ cả job, nên
 *     bên gọi ghi được từng dòng ngay khi nó xong. Một job 190 ticket mà chỉ trả
 *     kết quả ở phút cuối thì màn hình đứng im suốt, và không ai biết nó chạy
 *     hay treo.
 *
 * **Từ vựng verdict KHÔNG nằm ở đây.** Bên gọi gửi `verdict_guide` — danh sách
 * tên verdict kèm định nghĩa, bằng chính câu chữ của nó — và job này chỉ chấp
 * nhận một trong những tên ấy. Server vẫn không biết "MATCH" nghĩa là gì, đúng
 * như nó không biết ticket format nào hay repo nào tồn tại.
 *
 * **Một ticket hỏng không làm hỏng job.** Ticket ấy trả về `tier: "grep"` kèm
 * `error`, nghĩa là "giữ nguyên kết luận của tầng trước" — bên gọi không phải
 * đoán, và 189 ticket đã chấm không mất trắng vì ticket thứ 190.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { cloneRepo } from './git.mjs';
import { readGuidanceText } from './repoRules.mjs';
import { buildVerdictPrompt } from './verdictPrompt.mjs';
import { extractJsonBlock } from './jsonBlock.mjs';
import { askFci, fciConfigured } from './fciJudge.mjs';
import { openCache, cacheKey, CACHE_DIRNAME } from './judgeCache.mjs';

/**
 * Ngân sách prompt.
 *
 * Ba con số dưới đây là tiền. Bản đầu (12 dòng ngữ cảnh, 6 mảnh, 120 dòng mỗi
 * mảnh) cho phép một ticket mang tới 720 dòng code vào prompt, trong khi thứ
 * quyết định verdict gần như luôn nằm ở vài chục dòng quanh chỗ khớp: phần còn
 * lại là tiền trả cho những dòng model đọc lướt qua. Ba mảnh, mỗi mảnh ±20 dòng
 * quanh dòng khớp, là đủ để thấy cả thân hàm mà vẫn gọn hơn một bậc.
 *
 * Bên gọi vẫn nới lại được cho một job riêng bằng `options` — nhưng mặc định
 * phải là bản rẻ, vì mặc định mới là thứ chạy 190 lần mỗi đêm.
 */
export const DEFAULT_JUDGE_OPTIONS = {
  /** Số dòng đọc thêm mỗi phía quanh khoảng được trích. */
  context_lines: 20,
  /** Trần số mảnh code cho một ticket, để một ticket 40 dẫn chứng không nổ prompt. */
  max_snippets: 3,
  /** Trần số dòng của một mảnh sau khi đã cộng ngữ cảnh: đúng ±20 dòng quanh dòng khớp. */
  max_snippet_lines: 41,
  timeout_sec: 600,
};

/**
 * Ticket bên gọi gửi lên, đã kiểm.
 *
 * Ném ngay nếu sai dạng: một job chạy 190 lượt model trên dữ liệu hỏng là cách
 * đắt nhất để phát hiện ra mình gửi sai field.
 */
export function parseJudgeTickets(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('"tickets" phải là mảng không rỗng.');
  }
  return raw.map((t, i) => {
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      throw new Error(`tickets[${i}] phải là object.`);
    }
    const key = String(t.key ?? '').trim();
    if (!key) throw new Error(`tickets[${i}].key phải là chuỗi không rỗng.`);
    const evidence = Array.isArray(t.evidence) ? t.evidence : [];
    const conf = Number(t.grep_confidence);
    return {
      key,
      summary: String(t.summary ?? '').trim(),
      // Phần mô tả dài, nếu bên gọi gửi. Vào prompt đã cắt bớt (xem
      // `verdictPrompt.mjs`): một mô tả 8 nghìn chữ không làm verdict đúng hơn.
      description: String(t.description ?? '').trim(),
      status: String(t.status ?? '').trim(),
      // Kết luận của tầng trước. Ði vào prompt như một ý kiến cần soát lại, và
      // là giá trị được giữ nguyên nếu lượt này hỏng.
      grep_verdict: String(t.grep_verdict ?? '').trim(),
      grep_reason: String(t.grep_reason ?? '').trim(),
      // Tầng grep tự chấm mình chắc đến đâu. `null` = nó không nói, và một
      // ticket không nói thì không bao giờ được bỏ qua vì "đã chắc".
      grep_confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf > 1 ? conf / 100 : conf)) : null,
      evidence: evidence
        .filter((ev) => ev && typeof ev === 'object' && String(ev.path ?? '').trim())
        .map((ev) => ({
          path: String(ev.path).trim(),
          lines: String(ev.lines ?? '').trim(),
          note: String(ev.note ?? '').trim(),
        })),
    };
  });
}

/**
 * Danh sách verdict hợp lệ và định nghĩa của chúng, do bên gọi cấp.
 *
 * Bắt buộc phải có: không có nó thì job này không biết được phép trả về những
 * giá trị nào, và "kiểm tra model trả đúng một trong các giá trị cho phép" —
 * cái chặn duy nhất giữa một model nói lung tung và một verdict sai nằm trên
 * màn hình của người dùng — sẽ không thực hiện được.
 */
export function parseVerdictGuide(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('"verdict_guide" phải là một JSON object {TÊN_VERDICT: "định nghĩa"}.');
  }
  const guide = {};
  for (const [name, text] of Object.entries(raw)) {
    const key = String(name ?? '').trim();
    if (!key) continue;
    guide[key] = String(text ?? '').trim();
  }
  if (Object.keys(guide).length < 2) {
    throw new Error('"verdict_guide" phải có ít nhất hai verdict để phân biệt.');
  }
  return guide;
}

/**
 * Chọn lọc và cache: đọc bốn field mới của request, và từ chối những tổ hợp vô nghĩa.
 *
 *   - `mode: "full"` (mặc định) — mọi ticket đều được model xét, trừ khi cache
 *     đã có sẵn câu trả lời cho đúng câu hỏi ấy.
 *   - `mode: "selected"` — ticket nào tầng grep đã đủ chắc (`grep_confidence >=
 *     skip_above`) thì giữ nguyên kết luận của nó, không tiêu một lượt model.
 *
 * Hai lỗi dưới đây trả 400 thay vì bỏ qua im lặng, và đó là chủ ý: `skip_above`
 * gửi kèm `mode: "full"` mà bị lờ đi nghĩa là bên gọi tưởng mình đang tiết kiệm
 * trong khi hoá đơn vẫn đầy đủ; còn `mode: "selected"` thiếu ngưỡng thì không
 * ai biết "đủ chắc" là bao nhiêu.
 */
export function parseSelection(body = {}) {
  const rawMode = body.mode === undefined || body.mode === null ? 'full' : String(body.mode).trim().toLowerCase();
  if (!['full', 'selected'].includes(rawMode)) {
    throw new Error('"mode" phải là "selected" hoặc "full".');
  }
  const hasSkip = body.skip_above !== undefined && body.skip_above !== null;
  let skipAbove = null;
  if (hasSkip) {
    const n = Number(body.skip_above);
    if (!Number.isFinite(n) || n <= 0 || n > 1) {
      throw new Error('"skip_above" phải là một số trong khoảng (0, 1].');
    }
    skipAbove = n;
  }
  if (rawMode === 'selected' && skipAbove === null) {
    throw new Error('mode "selected" cần "skip_above" — không có ngưỡng thì không biết thế nào là đã chắc.');
  }
  if (rawMode === 'full' && hasSkip) {
    throw new Error('"skip_above" chỉ có nghĩa với mode "selected"; mode "full" xét mọi ticket.');
  }
  if (body.cache !== undefined && body.cache !== null && typeof body.cache !== 'boolean') {
    throw new Error('"cache" phải là true hoặc false.');
  }
  return {
    mode: rawMode,
    skipAbove,
    // Mặc định BẬT: khoá cache đã gồm cả revision, ticket, rules và model, nên
    // một lần trúng là đúng câu hỏi ấy. Ðể mặc định tắt nghĩa là ai quên gửi
    // `cache: true` thì trả tiền lại từ đầu.
    cache: body.cache === undefined || body.cache === null ? true : body.cache,
    rulesVersion: String(body.rules_version ?? '').trim(),
    tenant: String(body.tenant ?? '').trim(),
  };
}

/** `"120-148"` → `{start, end}`; `"42"` → `{start: 42, end: 42}`; rỗng → null. */
function rangeOf(lines) {
  const raw = String(lines ?? '').replace(/\s+/g, '');
  if (!raw) return null;
  const m = /^(\d+)(?:-(\d+))?$/.exec(raw);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  return end >= start ? { start, end } : null;
}

/**
 * Ðọc đúng đoạn code được trích, kèm ngữ cảnh hai phía.
 *
 * Ngữ cảnh có vì một khoảng `41-41` là một dòng — model đọc một dòng `def
 * login():` không kết luận được gì. Kèm vài dòng trên dưới thì nó thấy được cả
 * thân hàm.
 *
 * File không còn (repo đã đổi từ lúc grep chạy) thì mảnh ấy bị bỏ kèm lý do,
 * chứ không làm cả ticket hỏng: những mảnh còn lại vẫn đủ để kết luận, và nếu
 * không mảnh nào đọc được thì chính chỗ đó nói ra.
 */
export async function readSnippets({ repoDir, evidence, options }) {
  const snippets = [];
  const skipped = [];
  const wanted = evidence.slice(0, Math.max(1, options.max_snippets));

  for (const ev of wanted) {
    const rel = ev.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    const abs = path.resolve(repoDir, rel);
    // Cùng một luật containment như `keepRealEvidence`: một `path` từ bên ngoài
    // không được đọc ra khỏi repo đã clone.
    if (abs !== repoDir && !abs.startsWith(repoDir + path.sep)) {
      skipped.push({ path: ev.path, why: 'đường dẫn thoát khỏi repo' });
      continue;
    }
    let text;
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch {
      skipped.push({ path: ev.path, why: 'không đọc được trong repo đã clone' });
      continue;
    }
    const all = text.split(/\r?\n/);
    const range = rangeOf(ev.lines);
    const pad = Math.max(0, Number(options.context_lines) || 0);
    let from = range ? Math.max(1, range.start - pad) : 1;
    let to = range ? Math.min(all.length, range.end + pad) : Math.min(all.length, options.max_snippet_lines);
    if (to - from + 1 > options.max_snippet_lines) to = from + options.max_snippet_lines - 1;
    snippets.push({
      path: rel,
      cited: ev.lines || null,
      from,
      to,
      note: ev.note || '',
      // Số dòng đi kèm từng dòng code: model được yêu cầu trích số dòng, và nó
      // chỉ trích đúng khi nhìn thấy số dòng thật.
      text: all.slice(from - 1, to).map((line, i) => `${from + i}: ${line}`).join('\n'),
    });
  }
  return { snippets, skipped };
}

/** Model đã trả gì. Chỉ nhận một verdict có trong guide; sai thì ném. */
export function pickVerdict(parsed, { key, guide }) {
  const block = extractJsonBlock(typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
  const item = Array.isArray(block?.items) ? block.items[0] : block;
  if (!item || typeof item !== 'object') {
    throw new Error(`${key}: câu trả lời không có object nào để đọc.`);
  }
  const verdict = String(item.verdict ?? '').trim().toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(guide, verdict)) {
    throw new Error(
      `${key}: verdict "${verdict || '(rỗng)'}" không nằm trong danh sách được phép ` +
        `(${Object.keys(guide).join(', ')}).`,
    );
  }
  const raw = Number(item.confidence);
  return {
    key,
    verdict,
    // Ngoài [0,1] thì kẹp về biên chứ không ném: một model trả 95 thay vì 0.95
    // vẫn đang nói "rất chắc", và huỷ cả lượt vì cách viết là đắt vô ích.
    confidence: Number.isFinite(raw) ? Math.min(1, Math.max(0, raw > 1 ? raw / 100 : raw)) : null,
    reason: String(item.reason ?? '').trim(),
    tier: 'ai',
  };
}

/**
 * Chạy một job judge.
 *
 * `job.results` là mảng bên gọi đang đọc dần, nên mỗi lượt xong PHẢI push vào
 * đó ngay thay vì gom lại trả một lần ở cuối.
 */
export async function runJudgeJob({ job, body, config, redact, log, limiter, usage }) {
  const options = { ...DEFAULT_JUDGE_OPTIONS, ...(body.options ?? {}) };
  const timeoutMs = Math.max(1, Number(options.timeout_sec) || DEFAULT_JUDGE_OPTIONS.timeout_sec) * 1000;
  const all = parseJudgeTickets(body.tickets);
  const guide = parseVerdictGuide(body.verdict_guide);
  const selection = parseSelection(body);

  /*
   * `ASTRACODE_MAX_TICKETS` applies here too, and for a sharper reason than on
   * the analyze path: one judged ticket is exactly one model call, so a board of
   * 190 is 190 calls against a quota that is counted per day. A demo needs a
   * handful of rows to show the tier works.
   *
   * The tickets over the cap are NOT dropped: they come back as `tier: "grep"`
   * with a reason saying so, because "kept the previous tier because nobody
   * looked" and "kept it because the model agreed" must not read the same.
   */
  const cap = Math.max(0, Number(config.maxTickets ?? 0) || 0);
  const tickets = cap > 0 ? all.slice(0, cap) : all;
  const over = cap > 0 ? all.slice(cap) : [];

  if (!fciConfigured(config)) {
    // Judge là tầng model, không có tầng dự bị tất định: `none` chỉ biết "có
    // nhắc tới", đúng thứ tầng grep đã làm. Chạy nó ở đây là tiêu thời gian để
    // ra lại kết luận cũ dưới một cái nhãn "AI" — nhãn sai là tệ hơn không có.
    throw new Error('Judge cần backend model: thiếu FPT_BASE_URL, FPT_API_KEY hoặc FPT_MODEL.');
  }

  const repoDir = path.join(config.workspaceDir, job.id, 'repo');
  await fs.mkdir(repoDir, { recursive: true });

  /*
   * Tiến độ: tám con số, và `total` là số lượt THẬT SỰ gọi model.
   *
   * Không phải số ticket gửi lên. Một job 190 ticket mà 150 ticket đã chắc ở
   * tầng grep và 30 ticket trúng cache thì chỉ có 10 lượt phải chờ — một thanh
   * tiến độ chạy tới 190 ở đó là thanh sai, và nó sai theo hướng khiến người
   * ngồi xem tưởng còn lâu mới xong.
   *
   * Trước khi clone xong thì chưa biết cái nào trúng cache (khoá có revision),
   * nên `total` khởi đầu bằng số ticket rồi được chỉnh lại đúng một lần, ngay
   * sau khi phân loại.
   */
  const counted = {
    done: 0,
    total: tickets.length,
    skipped: 0,
    cached: 0,
    model_calls: 0,
    token_in: 0,
    token_out: 0,
    throttled: 0,
  };
  const publish = () => {
    job.progress = { ...counted };
  };
  publish();

  const startedAt = Date.now();
  const stats = {
    model: config.fciModel,
    tickets_total: all.length,
    tickets_skipped: over.length,
    max_tickets: cap,
    mode: selection.mode,
    skip_above: selection.skipAbove,
    cache: selection.cache,
    rules_version: selection.rulesVersion || null,
    skipped_sure: 0,
    cache_hits: 0,
    cache_writes: 0,
    judged: 0,
    failed: 0,
    no_snippet: 0,
    hits_429: 0,
    hits_503: 0,
    throttled: 0,
    token_in: 0,
    token_out: 0,
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
    job.revision = head || null;

    /*
     * Quy ước riêng của codebase, nếu bên gọi trỏ tới một tệp.
     *
     * Ðường dẫn do AstraQA gửi (`guidance_path`) chứ không phải AstraCode tự
     * tìm: bộ rules đang áp có thể ở cấp tenant chứ không nằm trong repo, và
     * chỉ bên kia mới biết bộ nào đang thắng. Ở đây chỉ mở đúng đường dẫn đó
     * trong bản clone — và chỉ khi nó thật sự nằm trong bản clone.
     *
     * Ðọc hỏng thì thôi: thiếu quy ước làm câu trả lời nghèo đi, không làm nó
     * sai, còn ném ở đây thì hỏng cả job vì một tệp phụ.
     */
    const guidance = await readGuidanceText({
      repoDir,
      rel: body.guidance_path,
      log,
    });
    /*
     * Cache mở SAU khi clone, vì khoá có `revision` — và đó là cả điểm mạnh của
     * nó: một commit mới là những khoá mới, nên cache không bao giờ trả lời
     * thay cho code đã đổi.
     */
    const cache = selection.cache
      ? await openCache({ dir: path.join(config.workspaceDir, CACHE_DIRNAME), tenant: selection.tenant, log })
      : null;
    /*
     * Hình dạng prompt: quy ước của codebase đang áp, cộng ba tham số quyết
     * định model được đọc bao nhiêu code. Vào khoá vì đổi chúng là đổi câu hỏi
     * — xem chú thích ở `cacheKey`.
     */
    const promptShape = JSON.stringify({
      guidance: guidance || '',
      context_lines: options.context_lines,
      max_snippets: options.max_snippets,
      max_snippet_lines: options.max_snippet_lines,
    });
    const keyFor = (ticket) =>
      cacheKey({
        repoUrl: body.repo_url,
        revision: head || '',
        ticketKey: ticket.key,
        summary: ticket.summary,
        description: ticket.description,
        status: ticket.status,
        rulesVersion: selection.rulesVersion,
        model: config.fciModel,
        prompt: promptShape,
      });

    /*
     * Phân loại một lần, trước khi gửi lượt nào.
     *
     * Ba rổ: đã chắc ở tầng grep (không gọi model), đã có trong cache (không
     * gọi model), và phần còn lại — đúng cái phần `progress.total` đếm. Làm
     * trước thay vì kiểm lẻ trong từng lượt để thanh tiến độ nói đúng ngay từ
     * dòng đầu, chứ không tụt dần khi job chạy.
     */
    const pending = [];
    for (const ticket of tickets) {
      if (
        selection.mode === 'selected' &&
        ticket.grep_confidence !== null &&
        ticket.grep_confidence >= selection.skipAbove
      ) {
        stats.skipped_sure += 1;
        counted.skipped += 1;
        job.results.push({
          key: ticket.key,
          tier: 'grep',
          ...(ticket.grep_verdict ? { verdict: ticket.grep_verdict } : {}),
          confidence: ticket.grep_confidence,
          reason: 'đã chắc ở tầng grep',
          skipped: true,
        });
        continue;
      }
      const k = cache ? keyFor(ticket) : null;
      const hit = k ? cache.get(k) : null;
      if (hit) {
        stats.cache_hits += 1;
        counted.cached += 1;
        // `cached: true` đi kèm để bên gọi phân biệt được "model vừa nói thế"
        // với "model đã nói thế trên đúng commit này" — cùng một kết luận,
        // nhưng không cùng một lần xét.
        job.results.push({ ...hit, cached: true });
        continue;
      }
      pending.push({ ticket, cacheKeyOf: k });
    }
    counted.total = pending.length;
    publish();

    log(
      `clone xong: ${tickets.length}/${all.length} ticket để chấm lại, commit ${head || '(không rõ)'} — ` +
        `model ${config.fciModel}, tối đa ${limiter.cap} lượt cùng lúc` +
        (over.length ? `, bỏ qua ${over.length} vì ASTRACODE_MAX_TICKETS=${cap}` : ''),
    );
    log(
      `chọn lọc: mode ${selection.mode}` +
        (selection.skipAbove === null ? '' : ` (skip_above ${selection.skipAbove})`) +
        ` | cache ${cache ? `bật, tenant ${cache.tenant}, ${cache.loaded} entry` : 'tắt'}` +
        ` → ${stats.skipped_sure} đã chắc ở tầng grep, ${stats.cache_hits} trúng cache, ` +
        `${pending.length} lượt phải gọi model`,
    );

    const one = async ({ ticket, cacheKeyOf }) => {
      const at = Date.now();
      try {
        const { snippets, skipped } = await readSnippets({ repoDir, evidence: ticket.evidence, options });
        if (snippets.length === 0) {
          // Không đọc được mảnh nào thì không có gì để model đọc. Nói ra, giữ
          // kết luận tầng grep — chấm mù là cách nhanh nhất để một nhãn "AI"
          // mang một kết luận không dựa trên gì.
          stats.no_snippet += 1;
          const why =
            skipped.length > 0
              ? `không đọc được mảnh nào: ${skipped.map((s) => `${s.path} (${s.why})`).join('; ')}`
              : 'ticket không có dẫn chứng nào để đọc';
          log(`${ticket.key} | ${Date.now() - at}ms | GIỮ TẦNG GREP — ${why}`);
          return { key: ticket.key, tier: 'grep', error: why };
        }

        if (job.abort?.signal?.aborted) {
          // Ðã gọi dừng trong lúc đọc file. Không gửi nữa — và nói ra, để bên
          // gọi phân biệt "chưa xét" với "đã xét, không kết luận được".
          return { key: ticket.key, tier: 'grep', error: 'đã dừng trước khi tới lượt' };
        }
        const prompt = buildVerdictPrompt({ ticket, guide, snippets, skipped, guidance });
        const { text, usage: spent } = await limiter.run(() =>
          askFci({
            config,
            prompt,
            timeoutMs,
            redact,
            signal: job.abort?.signal,
            onAttempt: () => {
              usage.model_calls += 1;
              counted.model_calls += 1;
              publish();
            },
            onRetry: ({ status, attempt, of, waitMs, source, message }) => {
              stats[status === 429 ? 'hits_429' : 'hits_503'] += 1;
              if (status === 429) {
                // `throttled` đếm số lần PHẢI CHỜ vì hạn mức — thứ để trả lời
                // "chạy chậm vì server hay vì nhà cung cấp đang chặn".
                stats.throttled += 1;
                counted.throttled += 1;
                publish();
              }
              log(
                `${ticket.key}: ${status} — chờ ${waitMs / 1000}s rồi thử lại (lần ${attempt}/${of}, ` +
                  `${source === 'retry-after' ? 'theo Retry-After' : 'theo bảng chờ'}). ${message.slice(0, 160)}`,
              );
            },
          }),
        );
        // Token của nhà cung cấp, không phải ước lượng của ta. Thiếu field thì
        // cộng 0: đếm thiếu còn đọc được, đếm bịa thì không.
        const tin = Number(spent?.prompt_tokens);
        const tout = Number(spent?.completion_tokens);
        if (Number.isFinite(tin)) {
          stats.token_in += tin;
          counted.token_in += tin;
        }
        if (Number.isFinite(tout)) {
          stats.token_out += tout;
          counted.token_out += tout;
        }
        const out = pickVerdict(text, { key: ticket.key, guide });
        stats.judged += 1;
        if (cache && cacheKeyOf) {
          // Chỉ lưu lượt THÀNH CÔNG. Một lỗi mạng được cache lại sẽ thành kết
          // luận vĩnh viễn cho ticket ấy trên commit ấy.
          stats.cache_writes += 1;
          await cache.put(
            cacheKeyOf,
            {
              // Ði qua redactor: một `repo_url` có credential nhúng sẵn sẽ nằm
              // lại trên đĩa rất lâu, khác với một dòng log bảy ngày.
              repo_url: redact(body.repo_url),
              revision: job.revision,
              key: ticket.key,
              rules_version: selection.rulesVersion || null,
              model: config.fciModel,
            },
            out,
          );
        }
        log(
          `${ticket.key} | ${Date.now() - at}ms | ${ticket.grep_verdict || '(grep chưa nói)'} → ${out.verdict} ` +
            `(confidence ${out.confidence === null ? '?' : out.confidence.toFixed(2)}) | ${snippets.length} mảnh code`,
        );
        return out;
      } catch (err) {
        const why = redact(err instanceof Error ? err.message : String(err));
        stats.failed += 1;
        log(`${ticket.key} | ${Date.now() - at}ms | LƯỢT HỎNG, giữ tầng grep — ${why}`);
        return { key: ticket.key, tier: 'grep', error: why };
      }
    };

    /*
     * Chạy tới `limiter.cap` lượt cùng lúc.
     *
     * Trần thật nằm trong `limiter` (cấp server, chia chung giữa mọi job, vì hạn
     * mức của nhà cung cấp tính theo API key). Ở đây chỉ cần không bắn cả 190
     * promise cùng lúc: mỗi promise đang chờ giữ một prompt trong bộ nhớ, và
     * `AbortSignal.timeout` của nó bắt đầu chạy từ lúc tạo chứ không từ lúc
     * limiter cho vào — nên 190 lượt xếp hàng sẽ hết giờ trước khi tới lượt.
     */
    const queue = pending.slice();
    const lanes = Array.from({ length: Math.min(limiter.cap, queue.length) }, async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        if (job.abort?.signal?.aborted) return;
        const result = await one(item);
        job.results.push(result);
        // `done` đếm lượt gọi model đã xong, để nó so được với `total`. Những
        // dòng bỏ qua và dòng trúng cache đã nằm sẵn trong `results` từ lúc
        // phân loại, và chúng có ô đếm riêng.
        counted.done += 1;
        publish();
      }
    });
    await Promise.all(lanes);
    // Ghi nốt những gì còn xếp hàng: kết quả phải nằm trên đĩa trước khi job
    // đóng sổ, không thì một lần chạy lại ngay sau đó vẫn phải trả tiền.
    await cache?.flush();

    // Những ticket vượt trần vẫn có mặt trong kết quả. Bỏ hẳn chúng sẽ khiến
    // bên gọi tưởng job đã xét tới, rồi không hiểu vì sao phần còn lại của
    // bảng không đổi.
    for (const ticket of over) {
      job.results.push({
        key: ticket.key,
        tier: 'grep',
        error: `chưa xét: vượt trần ASTRACODE_MAX_TICKETS=${cap}`,
      });
    }
    publish();

    stats.duration_ms = Date.now() - startedAt;
    stats.cancelled = Boolean(job.abort?.signal?.aborted);
    log(
      `job judge xong${stats.cancelled ? ' (đã dừng theo yêu cầu)' : ''}: ${stats.judged} chấm lại, ` +
        `${stats.cache_hits} lấy từ cache, ${stats.skipped_sure} bỏ qua vì đã chắc, ` +
        `${stats.failed} hỏng, ${stats.no_snippet} không có mảnh code | ` +
        `token ${stats.token_in} vào / ${stats.token_out} ra` +
        (stats.throttled ? `, ${stats.throttled} lần bị 429 chặn` : '') +
        ` | ${stats.duration_ms}ms`,
    );
    return {
      run_id: body.run_id ?? null,
      generated_at: new Date().toISOString(),
      source_revision: head || null,
      results: job.results,
      stats,
    };
  } finally {
    stats.duration_ms = stats.duration_ms || Date.now() - startedAt;
    await fs
      .rm(path.join(config.workspaceDir, job.id), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      .catch((err) => log(`job ${job.id}: không xoá được thư mục tạm — ${redact(String(err))}`));
  }
}
