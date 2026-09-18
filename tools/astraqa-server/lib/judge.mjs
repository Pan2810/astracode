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
import { buildVerdictPrompt } from './verdictPrompt.mjs';
import { extractJsonBlock } from './jsonBlock.mjs';
import { askFci, fciConfigured } from './fciJudge.mjs';

export const DEFAULT_JUDGE_OPTIONS = {
  /** Số dòng đọc thêm mỗi phía quanh khoảng được trích. */
  context_lines: 12,
  /** Trần số mảnh code cho một ticket, để một ticket 40 dẫn chứng không nổ prompt. */
  max_snippets: 6,
  /** Trần số dòng của một mảnh sau khi đã cộng ngữ cảnh. */
  max_snippet_lines: 120,
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
    return {
      key,
      summary: String(t.summary ?? '').trim(),
      status: String(t.status ?? '').trim(),
      // Kết luận của tầng trước. Ði vào prompt như một ý kiến cần soát lại, và
      // là giá trị được giữ nguyên nếu lượt này hỏng.
      grep_verdict: String(t.grep_verdict ?? '').trim(),
      grep_reason: String(t.grep_reason ?? '').trim(),
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
  const tickets = parseJudgeTickets(body.tickets);
  const guide = parseVerdictGuide(body.verdict_guide);

  if (!fciConfigured(config)) {
    // Judge là tầng model, không có tầng dự bị tất định: `none` chỉ biết "có
    // nhắc tới", đúng thứ tầng grep đã làm. Chạy nó ở đây là tiêu thời gian để
    // ra lại kết luận cũ dưới một cái nhãn "AI" — nhãn sai là tệ hơn không có.
    throw new Error('Judge cần backend model: thiếu FPT_BASE_URL, FPT_API_KEY hoặc FPT_MODEL.');
  }

  const repoDir = path.join(config.workspaceDir, job.id, 'repo');
  await fs.mkdir(repoDir, { recursive: true });

  job.progress = { done: 0, total: tickets.length };
  const startedAt = Date.now();
  const stats = {
    model: config.fciModel,
    tickets_total: tickets.length,
    judged: 0,
    failed: 0,
    no_snippet: 0,
    hits_429: 0,
    hits_503: 0,
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
    log(
      `clone xong: ${tickets.length} ticket để chấm lại, commit ${head || '(không rõ)'} — ` +
        `model ${config.fciModel}, tối đa ${limiter.cap} lượt cùng lúc`,
    );

    const one = async (ticket) => {
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

        const prompt = buildVerdictPrompt({ ticket, guide, snippets, skipped });
        const { text } = await limiter.run(() =>
          askFci({
            config,
            prompt,
            timeoutMs,
            redact,
            signal: job.abort?.signal,
            onAttempt: () => {
              usage.model_calls += 1;
            },
            onRetry: ({ status, attempt, of, waitMs, message }) => {
              stats[status === 429 ? 'hits_429' : 'hits_503'] += 1;
              log(
                `${ticket.key}: ${status} — chờ ${waitMs / 1000}s rồi thử lại (lần ${attempt}/${of}). ` +
                  `${message.slice(0, 160)}`,
              );
            },
          }),
        );
        const out = pickVerdict(text, { key: ticket.key, guide });
        stats.judged += 1;
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
    const queue = tickets.slice();
    const lanes = Array.from({ length: Math.min(limiter.cap, queue.length) }, async () => {
      for (;;) {
        const ticket = queue.shift();
        if (!ticket) return;
        if (job.abort?.signal?.aborted) return;
        const result = await one(ticket);
        job.results.push(result);
        job.progress = { done: job.results.length, total: tickets.length };
      }
    });
    await Promise.all(lanes);

    stats.duration_ms = Date.now() - startedAt;
    log(
      `job judge xong: ${stats.judged} chấm lại, ${stats.failed} hỏng, ${stats.no_snippet} không có mảnh code | ` +
        `${stats.duration_ms}ms`,
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
