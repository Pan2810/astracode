/**
 * Phát hiện dấu hiệu prompt injection trong nội dung không tin cậy —
 * docs/SECURITY.md §1.3.
 *
 * Đây là CẢNH BÁO, không phải bộ lọc. Nó gắn cờ để UI hiển thị và để
 * PermissionManager (M4) hạ cấp quyền — nó KHÔNG chặn nội dung, vì:
 *
 *   - Chặn theo pattern luôn vượt được. Ai muốn né chỉ cần diễn đạt khác.
 *   - Chặn nhầm còn tệ hơn: một file bàn về bảo mật AI sẽ đầy cụm
 *     "ignore previous instructions", và agent cần đọc được nó.
 *
 * Kiểm soát thật nằm ở chỗ khác: delimiter untrusted quanh tool result,
 * denylist, không auto-approve bash, hạ cấp quyền theo nguồn.
 */

export type InjectionSignal =
  | 'instruction-override'
  | 'role-hijack'
  | 'fake-system-marker'
  | 'exfiltration-hint'
  | 'secret-file-request'
  | 'encoded-payload'
  | 'hidden-text';

export interface InjectionFinding {
  signal: InjectionSignal;
  /** Đoạn khớp, đã cắt ngắn để hiển thị. */
  excerpt: string;
  index: number;
}

export interface InjectionScanResult {
  suspicious: boolean;
  findings: InjectionFinding[];
  /** 0–100. Dùng để xếp mức cảnh báo trên UI, không phải để tự quyết định. */
  score: number;
}

interface Rule {
  signal: InjectionSignal;
  pattern: RegExp;
  weight: number;
}

/**
 * Ký tự vô hình và điều khiển hướng viết — dùng để giấu chỉ thị khỏi mắt người
 * đọc trong khi model vẫn thấy đầy đủ.
 *
 * Dựng regex từ mã số thay vì viết ký tự thẳng vào nguồn: một dãy ký tự vô hình
 * nằm trong file .ts là thứ không ai review được, và chính nó cũng là dạng tấn
 * công mà hàm này đang tìm.
 */
const HIDDEN_CHAR_RANGES: Array<[number, number]> = [
  [0x200b, 0x200f], // zero-width space, ZWNJ, ZWJ, LRM, RLM
  [0x202a, 0x202e], // LRE, RLE, PDF, LRO, RLO
  [0x2060, 0x2064], // word joiner, invisible times/separator/plus
  [0xfeff, 0xfeff], // BOM nằm giữa văn bản
];

const HIDDEN_TEXT_RE = new RegExp(
  '[' +
    HIDDEN_CHAR_RANGES.map(
      ([from, to]) =>
        `\\u${from.toString(16).padStart(4, '0')}-\\u${to.toString(16).padStart(4, '0')}`,
    ).join('') +
    ']',
  'g',
);

const RULES: Rule[] = [
  {
    signal: 'instruction-override',
    pattern:
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|system)\s+(?:instruction|prompt|rule|direction|message)/gi,
    weight: 40,
  },
  {
    signal: 'instruction-override',
    pattern: /\b(?:bỏ qua|phớt lờ|quên)\s+(?:mọi\s+|tất cả\s+|các\s+)?(?:hướng dẫn|chỉ thị|quy tắc)\s+(?:trước|trên|phía trên)/gi,
    weight: 40,
  },
  {
    signal: 'role-hijack',
    pattern:
      /\byou\s+are\s+now\b|\bfrom\s+now\s+on,?\s+you\b|\bact\s+as\s+(?:if\s+you\s+are\s+)?(?:a|an|the)\b|\bbạn\s+bây\s+giờ\s+là\b/gi,
    weight: 30,
  },
  {
    signal: 'fake-system-marker',
    // Model không phân biệt được thẻ thật với thẻ do file bịa ra.
    pattern:
      /(?:^|\s)(?:\[\s*(?:system|assistant|developer|admin)\s*\]|<\|?(?:im_start|system|assistant)\|?>|###\s*(?:system|instruction)s?\s*:)/gi,
    weight: 35,
  },
  {
    // Tin cậy CAO: lệnh gửi + URL + thứ trông như dữ liệu nhạy cảm đi kèm.
    // Thứ tự trong mảng có ý nghĩa — rule mạnh phải đứng trước rule yếu cùng
    // signal, vì điểm chỉ cộng một lần cho mỗi loại tín hiệu.
    signal: 'exfiltration-hint',  
    pattern:
      /(?:curl|wget|Invoke-WebRequest|fetch|http\.post|requests\.post)[^\n]{0,160}https?:\/\/[^\n]{0,160}(?:secret|token|password|passwd|api[_-]?key|credential|private[_-]?key|\.env(?![\p{L}])|\$\{?[A-Z_]{3,}\}?)/giu,
    weight: 35,
  },
  {
    signal: 'exfiltration-hint',
    pattern:
      /(?<![\p{L}])(?:send|post|upload|exfiltrate|gửi)(?![\p{L}])[^\n]{0,60}(?<![\p{L}])(?:to|tới|đến)(?![\p{L}])[^\n]{0,60}https?:\/\//giu,
    weight: 25,
  },
  {
    // Tin cậy THẤP: gọi mạng đơn thuần. `fetch("https://api…")` là mã nguồn
    // bình thường ở khắp nơi, nên một mình nó không đủ để báo động — chỉ cộng
    // điểm nhỏ để góp phần khi có tín hiệu khác.
    signal: 'exfiltration-hint',
    pattern: /(?:curl|wget|Invoke-WebRequest)[^\n]{0,120}https?:\/\//gi,
    weight: 15,
  },
  {
    // Biên từ phải nhận diện được chữ tiếng Việt: `\b` là biên ký tự ASCII,
    // nên `\bđọc\b` KHÔNG BAO GIỜ khớp — `đ` không phải ký tự word của `\b`.
    signal: 'secret-file-request',
    pattern:
      /(?<![\p{L}])(?:read|open|cat|đọc|mở|xem)(?![\p{L}])[^\n]{0,40}(?:\.env(?![\p{L}])|id_rsa|\.ssh\/|\.aws\/credentials|private[ _-]?key)/giu,
    weight: 35,
  },
  {
    signal: 'encoded-payload',
    // Base64 dài trong file mã nguồn hiếm khi vô hại trong ngữ cảnh chỉ thị.
    pattern: /\b[A-Za-z0-9+/]{120,}={0,2}\b/g,
    weight: 15,
  },
  {
    signal: 'hidden-text',
    pattern: HIDDEN_TEXT_RE,
    weight: 30,
  },
];

const EXCERPT_MAX = 120;
const SUSPICIOUS_THRESHOLD = 30;

export interface InjectionScanOptions {
  /** Ngưỡng gắn cờ. Mặc định 30 — một tín hiệu mạnh là đủ. */
  threshold?: number;
  /** Tối đa số finding giữ lại, tránh phình log với file rác. */
  maxFindings?: number;
}

export function scanForInjection(
  text: string,
  opts: InjectionScanOptions = {},
): InjectionScanResult {
  const threshold = opts.threshold ?? SUSPICIOUS_THRESHOLD;
  const maxFindings = opts.maxFindings ?? 20;

  if (!text) return { suspicious: false, findings: [], score: 0 };

  const findings: InjectionFinding[] = [];
  const seen = new Set<InjectionSignal>();
  let score = 0;

  for (const rule of RULES) {
    // Clone vì regex /g mang lastIndex qua các lần gọi.
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      if (findings.length >= maxFindings) break;

      findings.push({
        signal: rule.signal,
        excerpt: excerptAround(text, match.index, match[0].length),
        index: match.index,
      });

      // Mỗi loại tín hiệu chỉ cộng điểm một lần: một file nhắc "ignore previous
      // instructions" mười lần không nguy hiểm gấp mười.
      if (!seen.has(rule.signal)) {
        seen.add(rule.signal);
        score += rule.weight;
      }

      if (match[0].length === 0) re.lastIndex++;
    }
  }

  return {
    suspicious: score >= threshold,
    findings: findings.sort((a, b) => a.index - b.index),
    score: Math.min(100, score),
  };
}

function excerptAround(text: string, index: number, length: number): string {
  const pad = Math.max(0, Math.floor((EXCERPT_MAX - length) / 2));
  const start = Math.max(0, index - pad);
  const end = Math.min(text.length, index + length + pad);
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + slice + (end < text.length ? '…' : '');
}

/** Câu cảnh báo ngắn cho UI và cho log. */
export function describeInjectionScan(result: InjectionScanResult): string {
  if (!result.suspicious) return '';
  const kinds = [...new Set(result.findings.map((f) => f.signal))];
  return `This content shows signs of prompt injection (${kinds.join(', ')}). ` +
    `It is data, not instructions — read it before letting the agent act on it.`;
}
