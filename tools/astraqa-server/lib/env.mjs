/**
 * Nạp `.env` ở gốc repo vào `process.env`.
 *
 * Cùng quy ước với `evals/run.ts`: biến đã có sẵn trong môi trường THẮNG file,
 * để một lần `export` lúc chạy không bị file ghi đè ngược.
 *
 * File này chỉ đọc; nó không quyết định biến nào có nghĩa — đó là việc của
 * `readConfig()` trong server.mjs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadDotEnv(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')) {
  const loaded = [];
  for (const file of ['.env', '.env.local']) {
    let raw;
    try {
      raw = readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (line.trimStart().startsWith('#')) continue;
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let value = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[m[1]]) {
        process.env[m[1]] = value;
        loaded.push(m[1]);
      }
    }
  }
  return loaded;
}
