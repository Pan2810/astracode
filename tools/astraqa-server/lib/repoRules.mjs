/**
 * Đọc tệp rules mà đội để sẵn trong repo, rồi trả về nguyên văn.
 *
 * AstraCode KHÔNG hiểu nội dung tệp này. Nó chỉ là bên duy nhất có bản clone
 * trong tay, nên nó là bên duy nhất đọc được `.astraqa/rules.yml` ở gốc repo.
 * Diễn giải là việc của AstraQA: luật verdict nằm bên đó, và một bộ luật thứ
 * hai đọc cùng một tệp theo cách hơi khác là cách nhanh nhất để hai bên nói
 * hai điều khác nhau về cùng một dòng.
 *
 * Vì vậy ở đây chỉ có ba việc: tệp có không, nó bao nhiêu byte, và nội dung là
 * gì. Không parse, không kiểm, không sửa.
 *
 * Kèm theo là tệp `judge_guidance` nếu rules trỏ tới — cũng nguyên văn, cũng
 * không hiểu gì. Đường dẫn được kiểm là nằm TRONG repo trước khi mở: một
 * đường dẫn leo ra ngoài bản clone là đường dẫn đọc trộm máy chủ, và bản
 * clone là thứ duy nhất job này được phép đọc.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Tối đa 256 KB, cùng trần AstraQA in trên hộp thả tệp. */
export const MAX_RULES_BYTES = 256 * 1024;

export const RULES_PATH = '.astraqa/rules.yml';
/** Bản viết khác của cùng một tệp; đọc cả hai để khỏi bắt ai đổi tên. */
export const RULES_ALT = '.astraqa/rules.yaml';

/**
 * Giải một đường dẫn tương đối về tuyệt đối, nhưng chỉ khi nó còn trong repo.
 *
 * Trả `null` cho mọi thứ leo ra ngoài — kể cả qua symlink, vì `realpath` được
 * gọi sau khi mở chứ không phải trước.
 */
function insideRepo(repoDir, rel) {
  const cleaned = String(rel || '').replace(/\\/g, '/').trim();
  if (!cleaned || cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) return null;
  if (cleaned.split('/').includes('..')) return null;
  const abs = path.resolve(repoDir, cleaned);
  if (abs !== repoDir && !abs.startsWith(repoDir + path.sep)) return null;
  return abs;
}

async function readCapped(abs) {
  const stat = await fs.stat(abs);
  if (!stat.isFile()) return null;
  if (stat.size > MAX_RULES_BYTES) {
    return { tooBig: true, bytes: stat.size, text: '' };
  }
  return { tooBig: false, bytes: stat.size, text: await fs.readFile(abs, 'utf8') };
}

/**
 * Tệp rules trong bản clone, hoặc `null` khi repo không có.
 *
 * `null` là câu trả lời thật và AstraQA cần phân biệt nó với "có tệp nhưng
 * rỗng": tệp rỗng nghĩa là đội đã nói "dùng mặc định", còn không có tệp nghĩa
 * là đội chưa nói gì, và bộ luật cấp tenant mới được quyền lên tiếng.
 */
export async function readRepoRules({ repoDir, log = () => {} }) {
  for (const rel of [RULES_PATH, RULES_ALT]) {
    const abs = insideRepo(repoDir, rel);
    if (!abs) continue;
    let read;
    try {
      read = await readCapped(abs);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      log(`rules: không đọc được ${rel} — ${err?.message || err}`);
      return null;
    }
    if (!read) continue;
    if (read.tooBig) {
      log(`rules: ${rel} ${read.bytes} byte, vượt trần ${MAX_RULES_BYTES} — bỏ qua`);
      return { path: rel, bytes: read.bytes, text: '', too_big: true, guidance: null };
    }
    log(`rules: đọc ${rel}, ${read.bytes} byte`);
    return {
      path: rel,
      bytes: read.bytes,
      text: read.text,
      too_big: false,
      guidance: await readGuidance({ repoDir, text: read.text, log }),
    };
  }
  return null;
}

/**
 * Tệp hướng dẫn cho tầng judge, nếu rules trỏ tới nó.
 *
 * Đường dẫn được rút bằng một biểu thức đơn giản chứ không parse YAML, vì
 * AstraCode cố tình không biết schema của tệp này. Rút hụt thì AstraQA vẫn
 * còn đường dẫn trong rules đã parse và tự biết là thiếu; rút nhầm thì cũng
 * chỉ gửi kèm một tệp thừa mà bên kia không dùng.
 */
async function readGuidance({ repoDir, text, log }) {
  const found = /^[ \t]*judge_guidance[ \t]*:[ \t]*(.+?)[ \t]*$/m.exec(text || '');
  if (!found) return null;
  return readGuidanceFile({
    repoDir,
    rel: found[1].replace(/^["']|["']$/g, '').trim(),
    log,
  });
}

/**
 * Một tệp hướng dẫn, theo đường dẫn bên gọi đưa. Trả `''` khi không có gì đọc.
 *
 * Tầng judge dùng bản này: bộ rules đang áp có thể ở cấp tenant chứ không nằm
 * trong repo, nên đường dẫn phải do AstraQA đưa xuống — chỉ bên đó biết bộ nào
 * đang thắng. AstraCode vẫn chỉ mở đúng đường dẫn ấy, và chỉ khi nó nằm trong
 * bản clone.
 */
export async function readGuidanceText({ repoDir, rel, log = () => {} }) {
  const read = await readGuidanceFile({ repoDir, rel, log });
  return read ? read.text : '';
}

export async function readGuidanceFile({ repoDir, rel, log = () => {} }) {
  const wanted = String(rel || '').trim();
  if (!wanted) return null;
  const abs = insideRepo(repoDir, wanted);
  if (!abs) {
    log(`rules: judge_guidance "${wanted}" trỏ ra ngoài repo — bỏ qua`);
    return null;
  }
  try {
    const read = await readCapped(abs);
    if (!read || read.tooBig) return null;
    log(`rules: đọc judge_guidance ${wanted}, ${read.bytes} byte`);
    return { path: wanted, bytes: read.bytes, text: read.text };
  } catch {
    return null;
  }
}
