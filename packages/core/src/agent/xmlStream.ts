/**
 * Lọc thẻ tool ra khỏi dòng text đang chảy — để đường XML cũng stream được.
 *
 * Vấn đề nó giải: `parseXmlToolCalls` chỉ chạy được trên văn bản HOÀN CHỈNH.
 * Nếu chờ model nói xong rồi mới bóc thẻ thì người dùng ngồi nhìn màn hình
 * trắng suốt cả lượt — mà đường XML lại là đường mặc định cho mọi model chưa
 * đo (nguyên tắc #4: "Streaming là mặc định").
 *
 * Không thể phát thẳng từng mẩu ra UI: mẩu `<gr` rồi `ep>` sẽ nhấp nháy thẻ thô
 * rồi biến mất. Nên lớp này giữ lại đúng phần CÓ THỂ là đầu một thẻ tool và
 * phát ngay mọi thứ còn lại. Phần giữ lại có trần cứng (`MAX_TAG_HOLD`), nên
 * độ trễ hiển thị là vài ký tự chứ không phải cả lượt.
 *
 * Lớp này CHỈ lo phần hiển thị. Việc bóc lời gọi thật vẫn do
 * `parseXmlToolCalls` làm trên văn bản đầy đủ — một nguồn sự thật cho hành vi,
 * một nguồn cho hiển thị, và cái thứ hai được phép kém chính xác hơn.
 */

import { closeTagPattern, looseOpenTagPattern, openTagPattern } from './xmlProtocol.js';

/**
 * Trần cho phần giữ lại khi một thẻ mở đang chảy dở.
 *
 * Thẻ mở được phép có thuộc tính (xem `openTagPattern`), nên về lý thuyết phần
 * "chưa biết có phải thẻ không" dài vô hạn. Quá ngần này ký tự mà vẫn chưa thấy
 * dấu `>` thì đó là văn xuôi chứ không phải thẻ — thả ra, thà hiện thừa một
 * dấu `<` còn hơn nuốt mất cả đoạn model đang nói.
 */
const MAX_TAG_HOLD = 200;

export class XmlTextStream {
  /** Phần chưa quyết định được là text thường hay đầu một thẻ tool. */
  private buffer = '';
  /** Tên tool của thẻ đang mở, nếu con trỏ đang nằm trong một lời gọi. */
  private inside: string | undefined;
  private readonly names: string[];
  private readonly openRe: RegExp | undefined;
  private readonly looseRe: RegExp | undefined;
  private readonly closeRe = new Map<string, RegExp>();
  /** Cần giữ lại bấy nhiêu ký tự khi đang ở trong thẻ, để bắt được thẻ đóng. */
  private readonly retain: number;
  /**
   * Ký tự ngay TRƯỚC buffer, đã phát ra rồi.
   *
   * Cần nó vì thẻ dạng hụt `read_file>` không có dấu `<` để neo: chỉ ký tự
   * liền trước mới phân biệt được một lời gọi với chữ `read_file` nằm giữa một
   * từ dài hơn — và ký tự đó có thể đã trôi ra từ mẩu trước.
   */
  private prev: string | undefined;

  constructor(toolNames: string[]) {
    this.names = [...toolNames];
    this.openRe =
      toolNames.length > 0 ? new RegExp(openTagPattern(toolNames)) : undefined;
    this.looseRe =
      toolNames.length > 0 ? new RegExp(looseOpenTagPattern(toolNames)) : undefined;
    for (const name of toolNames) this.closeRe.set(name, new RegExp(closeTagPattern(name)));
    // `</name>` là name.length + 3 ký tự, cộng chỗ cho khoảng trắng trước `>`.
    this.retain =
      toolNames.length > 0 ? Math.max(...toolNames.map((n) => n.length + 3)) + 8 : 0;
  }

  /** Nạp một mẩu từ model, trả về phần chắc chắn hiển thị được ngay. */
  push(delta: string): string {
    this.buffer += delta;
    return this.drain();
  }

  /**
   * Kết thúc lượt.
   *
   * Thẻ mở mà không có thẻ đóng thì phần đuôi bị NUỐT, không phát ra: đó là
   * lời gọi hỏng, và repair loop sẽ bảo model viết lại. Hiện nửa cái thẻ ra UI
   * chỉ làm người dùng tưởng agent đang nói nhảm.
   */
  flush(): string {
    if (this.inside !== undefined) {
      this.buffer = '';
      return '';
    }
    const rest = this.buffer;
    this.buffer = '';
    return rest;
  }

  /** Bỏ `n` ký tự đầu buffer, nhớ lại ký tự cuối cùng vừa bỏ. */
  private take(n: number): void {
    if (n <= 0) return;
    this.prev = this.buffer[n - 1];
    this.buffer = this.buffer.slice(n);
  }

  private drain(): string {
    let visible = '';

    for (;;) {
      if (this.inside !== undefined) {
        const close = this.closeRe.get(this.inside)!.exec(this.buffer);
        if (close === null) {
          // Nội dung bên trong thẻ không bao giờ hiện ra, nên bỏ luôn — giữ lại
          // vừa đủ để một thẻ đóng bị cắt ngang hai mẩu vẫn khớp được.
          if (this.buffer.length > this.retain) {
            this.take(this.buffer.length - this.retain);
          }
          return visible;
        }
        this.take(close.index + close[0].length);
        this.inside = undefined;
        continue;
      }

      const opened = this.findOpen();
      if (opened) {
        visible += this.buffer.slice(0, opened.at);
        this.take(opened.at + opened.length);
        this.inside = opened.name;
        continue;
      }

      const hold = this.holdFrom();
      visible += this.buffer.slice(0, hold);
      this.take(hold);
      return visible;
    }
  }

  /**
   * Thẻ mở sớm nhất trong buffer — dạng đủ `<tên>` hoặc dạng hụt `tên>`.
   *
   * Nhận cả dạng hụt vì parser cũng nhận (`recoverBrokenCalls`). Hai lớp phải
   * đi cùng một luật: lớp này lỡ một thẻ mà parser vẫn cứu được thì tool chạy
   * đúng nhưng người dùng thấy `read_file>` rơi giữa câu trả lời.
   */
  private findOpen(): { at: number; length: number; name: string } | undefined {
    let best: { at: number; length: number; name: string } | undefined;

    for (const re of [this.openRe, this.looseRe]) {
      if (!re) continue;
      re.lastIndex = 0;
      const m = re.exec(this.buffer);
      if (m && (!best || m.index < best.at)) {
        best = { at: m.index, length: m[0].length, name: m[1]! };
      }
    }
    return best;
  }

  /**
   * Vị trí bắt đầu phần phải giữ lại: chỗ sớm nhất mà đoạn từ đó tới cuối
   * buffer vẫn còn có thể lớn lên thành một thẻ mở.
   *
   * Lấy chỗ SỚM NHẤT chứ không phải muộn nhất: với buffer `<gr <g` thì chỉ chỗ
   * thứ hai mới còn cơ hội, nhưng nếu tool tên `gr` tồn tại thì chỗ đầu cũng
   * còn cơ hội — xét từ đầu mới không phát nhầm ra ngoài.
   */
  private holdFrom(): number {
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.couldOpenAt(i)) return i;
    }
    return this.buffer.length;
  }

  /**
   * Đoạn từ `i` tới cuối buffer còn cơ hội lớn lên thành một thẻ mở không?
   *
   * Đã có dấu `>` mà `findOpen` không nhận thì thẻ đã đóng khung và không phải
   * thẻ tool — thả ra ngay, giữ lại nữa chỉ làm treo phần hiển thị.
   */
  private couldOpenAt(i: number): boolean {
    const tail = this.buffer.slice(i);
    if (tail.includes('>')) return false;
    if (tail.length > MAX_TAG_HOLD) return false;

    if (tail.startsWith('<')) {
      const rest = tail.slice(1);
      const space = rest.search(/\s/);
      // Chưa có khoảng trắng: mới gõ được một phần tên thẻ.
      if (space < 0) return this.names.some((n) => n.startsWith(rest));
      // Đã có khoảng trắng: tên phải xong và đúng, phần sau là thuộc tính thừa.
      return this.names.includes(rest.slice(0, space));
    }

    // Dạng hụt dấu `<`. Chỉ xét khi ký tự liền trước không phải chữ hay `/`,
    // để `grep` trong một từ dài hơn không bị giữ lại vô cớ.
    const prev = i > 0 ? this.buffer[i - 1]! : this.prev;
    if (prev !== undefined && /[\w/]/.test(prev)) return false;
    return this.names.some((n) => n.startsWith(tail));
  }
}
