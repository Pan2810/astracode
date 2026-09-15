/**
 * Quan sát được: log ra console và ghi lại xuống đĩa theo `run_id`.
 *
 * Lý do tồn tại: AstraQA gọi rồi có thể rớt kết nối, hoặc job cũ rơi ra khỏi sổ
 * 200 job trong bộ nhớ. Khi đó `GET /api/v1/analyze/<id>` không còn gì để trả,
 * mà người trực đêm vẫn cần biết job đó đã làm gì. Nên mỗi run để lại ba file:
 *
 *   logs/<run_id>.log      — dòng thời gian, ghi nối, sống qua nhiều lần chạy
 *   results/<run_id>.json  — đúng object `result` của hợp đồng (hoặc lỗi)
 *   results/<run_id>.md    — `report_md` tách riêng để mở đọc ngay
 *
 * Bất biến: MỌI chuỗi đi qua đây — console lẫn đĩa — đều qua `redact` trước.
 * Không có đường nào ghi thẳng. Thêm một `console.log` ở chỗ khác là mở lại
 * đúng cái lỗ mà `redact.mjs` bịt.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_SLUG = 80;

/**
 * `run_id` đến từ request nên nó là dữ liệu của người lạ, mà ta lại lấy nó làm
 * tên file. Chỉ giữ `[A-Za-z0-9._-]`, và cắt mọi dấu chấm đầu chuỗi để `..`
 * hay `.` không sống sót thành đường thoát thư mục.
 */
export function slugifyRunId(raw, fallback = 'run') {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
    .slice(0, MAX_SLUG);
  return cleaned || fallback;
}

function stamp() {
  return new Date().toISOString();
}

/**
 * Sổ log của một run.
 *
 * `enabled: false` (test) thì vẫn trả đủ hàm nhưng không đụng đĩa — để test đơn
 * vị không rải file, mà đường đi trong code vẫn y hệt bản chạy thật.
 */
export function createRunLog({ runsDir, runId, jobId, redact = (s) => String(s), log = () => {}, enabled = true }) {
  const slug = slugifyRunId(runId, jobId ? `job-${jobId.slice(0, 8)}` : 'run');
  const logFile = path.join(runsDir, 'logs', `${slug}.log`);
  const jsonFile = path.join(runsDir, 'results', `${slug}.json`);
  const mdFile = path.join(runsDir, 'results', `${slug}.md`);

  // Ghi nối tiếp nhau: hai dòng của cùng một run không được cài răng lược.
  let queue = Promise.resolve();
  const enqueue = (fn) => {
    queue = queue.then(fn).catch((err) => {
      // Ghi đĩa hỏng (đầy đĩa, mất quyền) không được làm chết job đang chạy.
      log(`[${slug}] KHÔNG ghi được xuống đĩa — ${redact(String(err?.message ?? err))}`);
    });
    return queue;
  };

  async function append(file, text) {
    if (!enabled) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, text, 'utf8');
  }

  async function overwrite(file, text) {
    if (!enabled) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, 'utf8');
  }

  /** Một dòng log: ra console ngay, xuống đĩa theo hàng đợi. Đã che secret. */
  function line(message) {
    const safe = redact(String(message ?? ''));
    const row = `${stamp()} [${slug}] ${safe}`;
    log(row);
    enqueue(() => append(logFile, row + '\n'));
    return row;
  }

  /** Kết quả thành công: JSON đầy đủ + report_md tách riêng. */
  function saveResult(result) {
    const safe = redact(JSON.stringify(result, null, 2));
    const md = redact(String(result?.report_md ?? ''));
    return enqueue(async () => {
      await overwrite(jsonFile, safe + '\n');
      await overwrite(mdFile, md + '\n');
    });
  }

  /** Job hỏng cũng để lại vết: cùng chỗ, cùng tên, để không phải đi tìm. */
  function saveFailure(error) {
    const payload = { run_id: runId ?? null, job_id: jobId ?? null, status: 'failed', failed_at: stamp(), error: redact(String(error ?? '')) };
    const safe = JSON.stringify(payload, null, 2);
    return enqueue(async () => {
      await overwrite(jsonFile, safe + '\n');
      await overwrite(mdFile, `# ${slug} — FAILED\n\n${payload.failed_at}\n\n\`\`\`\n${payload.error}\n\`\`\`\n`);
    });
  }

  /** Chờ mọi thứ chạm đĩa. Dùng khi cần chắc file đã có trước khi đọc. */
  const flush = () => queue;

  return { slug, logFile, jsonFile, mdFile, line, saveResult, saveFailure, flush };
}

/**
 * Banner lúc khởi động. Trả về mảng dòng (không tự in) để test đọc được nguyên
 * văn thứ sẽ hiện ra console.
 *
 * Luật ở đây: khai TRẠNG THÁI của mỗi bí mật, không bao giờ khai giá trị.
 */
export function bannerLines(config, { runsDir, devMode }) {
  const yn = (v) => (v ? 'đã set' : 'CHƯA set');
  const lines = [
    'astraqa-server đang lắng nghe',
    `  cổng          : ${config.port} (127.0.0.1)`,
    `  backend       : ${config.judgeBackend}`,
    `  model         : ${config.judgeBackend === 'fci' ? config.fciModel || '(chưa đặt)' : '(không dùng model qua server)'}`,
    `  WORKSPACE_DIR : ${config.workspaceDir}`,
    `  song song     : tối đa ${config.judgeConcurrency ?? 2} lượt judge cùng lúc (cả server)`,
    `  logs          : ${path.join(runsDir, 'logs')}`,
    `  results       : ${path.join(runsDir, 'results')}`,
    `  SERVICE_TOKEN : ${yn(config.serviceToken)}`,
  ];

  if (config.judgeBackend === 'fci') {
    lines.push(`  FPT_BASE_URL  : ${config.fciBaseUrl || '(chưa đặt)'}`);
    lines.push(`  FPT_API_KEY   : ${yn(config.fciApiKey)}`);
  } else if (config.judgeBackend === 'cli') {
    lines.push(`  ASTRACODE_CLI : ${config.cliPath}`);
    lines.push(`  ASTRAWORK_JWT : ${yn(config.astraworkJwt)}`);
  } else {
    lines.push('  ghi chú       : quét tất định, không gọi model — trần kết luận là "partial"');
  }

  if (config.judgeBackend === 'fci' && !(config.fciBaseUrl && config.fciApiKey && config.fciModel)) {
    lines.push('CẢNH BÁO: backend "fci" thiếu FPT_BASE_URL / FPT_API_KEY / FPT_MODEL — mọi job sẽ failed.');
  }
  if (devMode) {
    lines.push('CẢNH BÁO: ASTRACODE_SERVICE_TOKEN rỗng — chế độ dev, KHÔNG kiểm xác thực. Đừng dùng ngoài máy mình.');
  }
  return lines;
}
