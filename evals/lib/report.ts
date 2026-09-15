/**
 * In báo cáo eval ra terminal và lưu JSON để so lịch sử.
 *
 * Báo cáo cố ý in LÝ DO TRƯỢT của từng task ngay trong bảng. Một con số
 * pass-rate tụt từ 80% xuống 60% mà không kèm lý do thì phải mở JSON ra soi —
 * và trong thực tế thì không ai soi.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalRun, TaskOutcome } from './types.js';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

export function printRun(run: EvalRun): void {
  const { summary } = run;

  console.log(`\n${C.bold}${C.cyan}Kết quả eval${C.reset}`);
  console.log(C.dim + '─'.repeat(64) + C.reset);
  console.log(`  model     ${run.model}`);
  console.log(`  provider  ${run.provider} (${run.protocol})`);
  console.log(`  thời gian ${(run.durationMs / 1000).toFixed(1)}s\n`);

  const failed = run.outcomes.filter((o) => !o.pass);
  if (failed.length > 0) {
    console.log(`${C.bold}Task trượt${C.reset}`);
    for (const o of failed) {
      console.log(`  ${C.red}✗${C.reset} ${o.taskId.padEnd(28)} ${o.error ?? o.reason}`);
    }
    console.log();
  }

  const passedList = run.outcomes.filter((o) => o.pass);
  if (passedList.length > 0) {
    console.log(`${C.bold}Task đạt${C.reset}`);
    for (const o of passedList) {
      console.log(
        `  ${C.green}✓${C.reset} ${o.taskId.padEnd(28)} ` +
          `${C.dim}${o.toolCalls} tool · ${o.iterations} vòng · ` +
          `${o.totalTokens || '?'} token · ${(o.durationMs / 1000).toFixed(1)}s${C.reset}`,
      );
    }
    console.log();
  }

  console.log(`${C.bold}Theo nhóm${C.reset}`);
  for (const [group, g] of Object.entries(summary.byGroup)) {
    const rate = (g.passRate * 100).toFixed(0);
    const color = g.passRate === 1 ? C.green : g.passRate >= 0.8 ? C.yellow : C.red;
    console.log(`  ${group.padEnd(12)} ${color}${g.passed}/${g.total} (${rate}%)${C.reset}`);
  }

  const rate = (summary.passRate * 100).toFixed(0);
  const overallColor =
    summary.passRate === 1 ? C.green : summary.passRate >= 0.8 ? C.yellow : C.red;
  console.log(
    `\n  ${C.bold}Tổng${C.reset}        ${overallColor}${summary.passed}/${summary.total} (${rate}%)${C.reset}`,
  );
  console.log(
    `  ${C.dim}TB: ${summary.avgToolCalls.toFixed(1)} tool call · ` +
      `${Math.round(summary.avgTokens)} token · ` +
      `${(summary.avgDurationMs / 1000).toFixed(1)}s mỗi task${C.reset}`,
  );

  // Nhóm bảo mật trượt là chuyện khác hẳn nhóm codebase trượt.
  const sec = summary.byGroup.security;
  if (sec && sec.passed < sec.total) {
    console.log(
      `\n  ${C.red}${C.bold}Cảnh báo:${C.reset} ${sec.total - sec.passed} task BẢO MẬT trượt.\n` +
        `  ${C.dim}Trượt ở nhóm này nghĩa là agent làm theo chỉ thị gài trong file,\n` +
        `  hoặc đọc được thứ lẽ ra bị chặn. Xem docs/SECURITY.md §1 và §2.${C.reset}`,
    );
  }
  console.log();
}

export function printProgress(outcome: TaskOutcome, index: number, total: number): void {
  const mark = outcome.pass ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
  const counter = `${String(index).padStart(String(total).length)}/${total}`;
  console.log(`  ${C.dim}${counter}${C.reset} ${mark} ${outcome.taskId}`);
}

/** Lưu vào evals/results/<ngày>-<model>.json để so giữa các lần chạy. */
export async function saveRun(run: EvalRun): Promise<string> {
  const dir = resolve(HERE, 'results');
  await mkdir(dir, { recursive: true });

  const stamp = run.startedAt.slice(0, 19).replace(/[:T]/g, '-');
  const safeModel = run.model.replace(/[^a-zA-Z0-9._-]/g, '_');
  const file = resolve(dir, `${stamp}-${safeModel}.json`);

  await writeFile(file, JSON.stringify(run, null, 2) + '\n', 'utf8');
  return file;
}

/** So hai lần chạy — dùng khi vừa sửa system prompt và muốn biết tốt lên hay xấu đi. */
export function printDiff(before: EvalRun, after: EvalRun): void {
  const beforeMap = new Map(before.outcomes.map((o) => [o.taskId, o.pass]));

  const regressed: string[] = [];
  const fixed: string[] = [];

  for (const o of after.outcomes) {
    const was = beforeMap.get(o.taskId);
    if (was === undefined) continue;
    if (was && !o.pass) regressed.push(o.taskId);
    if (!was && o.pass) fixed.push(o.taskId);
  }

  const delta = after.summary.passRate - before.summary.passRate;
  const sign = delta > 0 ? '+' : '';

  console.log(`\n${C.bold}So với lần trước${C.reset}`);
  console.log(
    `  pass-rate ${(before.summary.passRate * 100).toFixed(0)}% -> ` +
      `${(after.summary.passRate * 100).toFixed(0)}% (${sign}${(delta * 100).toFixed(0)} điểm)`,
  );
  if (fixed.length > 0) console.log(`  ${C.green}sửa được:${C.reset} ${fixed.join(', ')}`);
  if (regressed.length > 0) console.log(`  ${C.red}hỏng đi:${C.reset} ${regressed.join(', ')}`);
  if (fixed.length === 0 && regressed.length === 0) console.log(`  ${C.dim}không đổi${C.reset}`);
  console.log();
}
