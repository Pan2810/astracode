/**
 * Sinh media/icon.png (128x128) cho Marketplace / màn hình Extensions.
 *
 * Nguồn là media/logo.png — logo AstraWork, bản gốc 512x512, chép từ
 * `AstraWork/frontend/public/logo.png`. Giữ bản gốc trong repo và sinh lại bản
 * nhỏ bằng script, thay vì kéo thẳng một file 128px vào: cần đổi kích thước
 * hay thêm biến thể thì chạy lại, và vẫn không có asset nào mà không ai biết
 * nó từ đâu ra.
 *
 *   node scripts/make-icon.mjs
 *
 * Thu nhỏ bằng cách lấy TRUNG BÌNH cả ô 4x4 chứ không nhặt một điểm mẫu: logo
 * này toàn nét mảnh và đầu nhọn, nhặt điểm sẽ làm mấy cái chóp sao mất hẳn ở
 * 128px.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_SIZE = 128;
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'media', 'logo.png');
const OUT = resolve(HERE, '..', 'media', 'icon.png');

// ─── Đọc PNG ────────────────────────────────────────────────────────────────

/**
 * Giải mã PNG 8-bit RGBA, không xen kẽ — đúng dạng của logo nguồn.
 *
 * Chỉ nhận đúng dạng đó và ném khi gặp dạng khác, thay vì cố đoán: một file
 * indexed-color giải sai sẽ ra icon lệch màu mà build vẫn xanh, và không ai
 * nhìn kỹ một cái icon 128px cho tới lúc nó lên Marketplace.
 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${SRC}: không phải PNG`);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (buf[24] !== 8 || buf[25] !== 6) {
    throw new Error(`${SRC}: cần PNG 8-bit RGBA (đang là depth=${buf[24]} colorType=${buf[25]})`);
  }
  if (buf[28] !== 0) throw new Error(`${SRC}: PNG xen kẽ (interlaced) không đọc được`);

  const idat = [];
  let offset = 8;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(buf.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));

  // Bỏ filter từng hàng. Mỗi hàng mở đầu bằng một byte cho biết filter nào.
  const stride = width * 4;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`${SRC}: filter lạ ${filter} ở hàng ${y}`);
      out[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, data: out };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// ─── Thu nhỏ ────────────────────────────────────────────────────────────────

/**
 * Trung bình theo ô, tính trên màu ĐÃ NHÂN ALPHA.
 *
 * Trộn thẳng RGB rồi mới xét alpha sẽ kéo màu của vùng trong suốt (thường là
 * đen) vào rìa hình — logo hiện lên với viền tối lem nhem quanh mọi cạnh.
 */
function resize(src, size) {
  const scale = src.width / size;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.min(src.width, Math.ceil((x + 1) * scale));
      const y0 = Math.floor(y * scale);
      const y1 = Math.min(src.height, Math.ceil((y + 1) * scale));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.width + sx) * 4;
          const alpha = src.data[i + 3] / 255;
          r += src.data[i] * alpha;
          g += src.data[i + 1] * alpha;
          b += src.data[i + 2] * alpha;
          a += alpha;
          n++;
        }
      }

      const o = (y * size + x) * 4;
      const meanAlpha = a / n;
      // Chia lại cho alpha để về màu thường. Ô trong suốt hoàn toàn thì không
      // có màu nào để giữ — để 0, alpha 0 khiến nó vô hình dù giá trị là gì.
      out[o] = meanAlpha > 0 ? Math.round(r / n / meanAlpha) : 0;
      out[o + 1] = meanAlpha > 0 ? Math.round(g / n / meanAlpha) : 0;
      out[o + 2] = meanAlpha > 0 ? Math.round(b / n / meanAlpha) : 0;
      out[o + 3] = Math.round(meanAlpha * 255);
    }
  }
  return { width: size, height: size, data: out };
}

// ─── Ghi PNG ────────────────────────────────────────────────────────────────

function encodePng(img) {
  const stride = img.width * 4;
  const raw = Buffer.alloc(img.height * (stride + 1));
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    img.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

// ─── Chạy ───────────────────────────────────────────────────────────────────

const source = decodePng(readFileSync(SRC));
const png = encodePng(resize(source, OUT_SIZE));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(
  `Đã ghi ${OUT} — ${source.width}x${source.height} → ${OUT_SIZE}x${OUT_SIZE}, ${png.length} byte`,
);
