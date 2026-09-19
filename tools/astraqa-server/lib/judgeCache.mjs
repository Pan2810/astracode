/**
 * Cache kết quả judge — để không trả tiền hai lần cho cùng một câu hỏi.
 *
 * Một lượt judge là một lượt gọi model. Hai lần chạy AstraQA trên cùng một
 * commit, cùng một ticket, cùng một bộ rules và cùng một model là cùng một câu
 * hỏi; câu trả lời lần trước vẫn đúng, và gọi lại chỉ là tiêu thêm hạn mức để
 * nhận lại đúng chữ ấy (prompt đi với `temperature: 0`, nên nó thật sự là đúng
 * chữ ấy).
 *
 * ## Khoá đã bao hàm mọi thứ làm câu trả lời đổi
 *
 *   repo_url + revision + ticket key + hash(nội dung ticket) + rules_version
 *   + model + dấu vân tay của prompt
 *
 * Vì vậy KHÔNG có TTL. Một entry cũ sáu tháng vẫn trả lời đúng câu hỏi của nó —
 * commit ấy vẫn là commit ấy. Hết hạn theo thời gian ở đây chỉ tạo ra những
 * lượt gọi lại không đổi kết quả. Thứ duy nhất cần là một cái chổi để dọn đĩa:
 * `DELETE /api/v1/judge/cache?older_than=30d`.
 *
 * Ðổi một thành phần bất kỳ là một khoá khác, nên `revision` mới luôn miss —
 * đó là điều kiện để cache này an toàn: nó không bao giờ trả lời thay cho code
 * đã đổi.
 *
 * ## Vì sao JSONL, mỗi tenant một tệp
 *
 * Append một dòng là thao tác rẻ nhất còn đọc lại được bằng mắt, và một job
 * hỏng giữa chừng chỉ làm dở dòng cuối chứ không làm hỏng cả tệp (dòng hỏng bị
 * bỏ qua lúc nạp). Tách theo tenant để một lần dọn của tenant này không đụng dữ
 * liệu của tenant kia, và để `<tenant>.jsonl` đọc được như một sổ chạy tay.
 *
 * KHÔNG cache lượt hỏng. Một `error` được lưu lại sẽ biến một sự cố mạng mười
 * giây thành một kết luận vĩnh viễn.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Thư mục cache nằm trong WORKSPACE_DIR, cạnh (không phải trong) thư mục từng job. */
export const CACHE_DIRNAME = 'judge-cache';

/**
 * Tên tenant → tên tệp an toàn.
 *
 * Tenant đến từ request, nên nó là đầu vào của người lạ: không lọc thì
 * `"../../../etc/passwd"` ghi ra ngoài WORKSPACE_DIR. Chỉ giữ chữ, số, `.`,
 * `-`, `_`; mọi thứ khác thành `-`. Rỗng sau khi lọc → `default`.
 *
 * ## Vì sao có đuôi băm
 *
 * Lọc trần thì `"Đội A"` và `"Nội A"` cùng rút về `"i-A"` — hai đội dùng chung
 * một tệp cache, và đội này đọc được kết luận của đội kia. Nên hễ phép lọc làm
 * mất ký tự nào, tên tệp mang thêm tám ký tự băm của tên gốc: vẫn đọc được
 * bằng mắt, nhưng hai tên khác nhau không bao giờ thành một tệp.
 */
export function safeTenant(raw) {
  const s = String(raw ?? '').trim().slice(0, 64);
  if (!s) return 'default';
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '');
  if (cleaned === s) return cleaned;
  const tag = createHash('sha256').update(s).digest('hex').slice(0, 8);
  return cleaned ? `${cleaned}-${tag}` : `tenant-${tag}`;
}

/** `"30d"` → ms. Nhận `s`/`m`/`h`/`d`; sai dạng → `null` (người gọi trả 400). */
export function parseDuration(raw) {
  const m = /^(\d+)\s*([smhd])$/.exec(String(raw ?? '').trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return n > 0 ? n * unit : null;
}

/**
 * Khoá của một lượt judge.
 *
 * `summary + status` đi qua hash chứ không vào khoá nguyên văn: tiêu đề ticket
 * có thể dài và có thể chứa chữ của khách hàng, còn thứ cần ở đây chỉ là "nội
 * dung ticket có đổi không".
 *
 * ## `prompt` — dấu vân tay của chính câu hỏi
 *
 * Sáu thành phần đầu nói về ticket và code. Nhưng cùng một ticket trên cùng một
 * commit vẫn thành hai câu hỏi khác nhau nếu prompt khác: đổi `guidance_path`
 * sang một tệp quy ước khác, hay nới `max_snippets` để model được đọc nhiều
 * code hơn. Không có thành phần này thì lần chạy thứ hai — lần vừa được nới
 * đúng để có câu trả lời tốt hơn — sẽ nhận lại kết luận rẻ tiền của lần trước
 * và không ai thấy gì bất thường.
 */
export function cacheKey({ repoUrl, revision, ticketKey, summary, description, status, rulesVersion, model, prompt }) {
  // Mô tả nằm chung một băm với tiêu đề và trạng thái: nó cũng đi vào prompt,
  // nên ticket được viết lại nội dung là một câu hỏi khác.
  const body = createHash('sha256')
    .update(`${String(summary ?? '')}\u0000${String(description ?? '')}\u0000${String(status ?? '')}`)
    .digest('hex')
    .slice(0, 16);
  const shape = createHash('sha256').update(String(prompt ?? '')).digest('hex').slice(0, 16);
  const parts = [
    String(repoUrl ?? ''),
    String(revision ?? ''),
    String(ticketKey ?? ''),
    body,
    String(rulesVersion ?? ''),
    String(model ?? ''),
    shape,
  ];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/**
 * Mở cache của một tenant.
 *
 * Nạp một lần lúc mở (job đọc nhiều lần, đĩa chỉ chạm một lần), rồi giữ trong
 * bộ nhớ đúng thời gian job chạy. Ghi thì nối tiếp nhau qua một hàng đợi một
 * làn: một job chạy tám lượt song song, và tám lệnh append cùng lúc vào một tệp
 * là cách để có một dòng lai giữa hai entry.
 */
export async function openCache({ dir, tenant, log = () => {} }) {
  const name = safeTenant(tenant);
  const file = path.join(dir, `${name}.jsonl`);
  /** @type {Map<string, any>} */
  const entries = new Map();
  let bad = 0;

  let raw = '';
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    raw = '';
  }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && typeof rec.k === 'string') entries.set(rec.k, rec);
    } catch {
      // Dòng hỏng (job bị giết giữa lúc ghi) không được làm hỏng cả job đang
      // chạy: bỏ qua, đếm lại, nói ra một lần ở dòng log của job.
      bad += 1;
    }
  }
  if (bad) log(`cache judge: bỏ qua ${bad} dòng hỏng trong ${file}`);

  /** Hàng đợi ghi: mỗi lần append chờ lần trước xong. */
  let tail = Promise.resolve();

  return {
    tenant: name,
    file,
    loaded: entries.size,
    bad,
    /** @returns {any|null} kết quả đã lưu, hoặc null nếu chưa có. */
    get(k) {
      const rec = entries.get(k);
      return rec ? rec.result : null;
    },
    /** Lưu một kết quả THÀNH CÔNG. Lỗi ghi không làm hỏng job — chỉ mất một lần tiết kiệm. */
    async put(k, meta, result) {
      const rec = { k, at: new Date().toISOString(), ...meta, result };
      entries.set(k, rec);
      tail = tail.then(async () => {
        try {
          await fs.mkdir(dir, { recursive: true });
          await fs.appendFile(file, `${JSON.stringify(rec)}\n`, 'utf8');
        } catch (err) {
          log(`cache judge: không ghi được ${file} — ${err instanceof Error ? err.message : String(err)}`);
        }
      });
      return tail;
    },
    /** Chờ mọi lần ghi đang xếp hàng. Gọi ở cuối job để kết quả nằm trên đĩa trước khi job đóng sổ. */
    flush() {
      return tail;
    },
  };
}

/**
 * Cache đang chiếm bao nhiêu — cho `/healthz`.
 *
 * Ðếm dòng bằng cách đọc tệp: cả cache của một đội cũng chỉ vài trăm KB. Tệp
 * quá lớn (> `MAX_COUNT_BYTES`) thì chỉ báo dung lượng và để `entries: null`,
 * chứ không để một liveness probe đọc 50MB mỗi lần gọi.
 */
const MAX_COUNT_BYTES = 16 * 1024 * 1024;

export async function cacheStats(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return { tenants: 0, entries: 0, bytes: 0 };
  }
  const files = names.filter((n) => n.endsWith('.jsonl'));
  let bytes = 0;
  let entries = 0;
  let counted = true;
  for (const n of files) {
    const full = path.join(dir, n);
    let size = 0;
    try {
      size = (await fs.stat(full)).size;
    } catch {
      continue;
    }
    bytes += size;
    if (size > MAX_COUNT_BYTES) {
      counted = false;
      continue;
    }
    try {
      const raw = await fs.readFile(full, 'utf8');
      entries += raw.split('\n').filter((l) => l.trim()).length;
    } catch {
      counted = false;
    }
  }
  return { tenants: files.length, entries: counted ? entries : null, bytes };
}

/**
 * Dọn entry cũ hơn `olderThanMs`.
 *
 * Viết lại từng tệp qua một tệp tạm rồi `rename`: một lần dọn bị cắt giữa chừng
 * để lại tệp cũ nguyên vẹn chứ không để lại một cache cụt.
 */
export async function sweepCache(dir, olderThanMs, now = Date.now()) {
  const cutoff = now - olderThanMs;
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return { files: 0, kept: 0, removed: 0 };
  }
  let kept = 0;
  let removed = 0;
  let files = 0;
  for (const n of names.filter((x) => x.endsWith('.jsonl'))) {
    const full = path.join(dir, n);
    let raw;
    try {
      raw = await fs.readFile(full, 'utf8');
    } catch {
      continue;
    }
    files += 1;
    const out = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let rec;
      try {
        rec = JSON.parse(s);
      } catch {
        // Dòng hỏng bị dọn luôn: nó không trả lời được câu hỏi nào.
        removed += 1;
        continue;
      }
      const at = Date.parse(rec?.at ?? '');
      if (Number.isFinite(at) && at < cutoff) {
        removed += 1;
        continue;
      }
      kept += 1;
      out.push(s);
    }
    const tmp = `${full}.tmp-${process.pid}`;
    await fs.writeFile(tmp, out.length ? `${out.join('\n')}\n` : '', 'utf8');
    await fs.rename(tmp, full);
  }
  return { files, kept, removed };
}
