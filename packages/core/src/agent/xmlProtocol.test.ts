import { describe, expect, it } from 'vitest';
import {
  XML_TOOL_RESULT_FOOTER,
  XML_TOOL_RESULT_HEADING,
  XML_TOOL_RESULT_PREFIX,
  buildXmlToolPrompt,
  coerceArgs,
  parseXmlToolCalls,
  readXmlToolResults,
} from './xmlProtocol.js';
import type { ToolDefinition } from '../provider/types.js';

const GREP: ToolDefinition = {
  name: 'grep',
  description: 'Tìm theo regex',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Biểu thức cần tìm' },
      limit: { type: 'number', description: 'Số kết quả tối đa' },
      caseSensitive: { type: 'boolean' },
      paths: { type: 'array' },
    },
    required: ['pattern'],
  },
};

describe('buildXmlToolPrompt', () => {
  const prompt = buildXmlToolPrompt([GREP]);

  it('liệt kê tham số kèm bắt buộc hay không', () => {
    expect(prompt).toContain('pattern (string, bắt buộc)');
    expect(prompt).toContain('limit (number, tuỳ chọn)');
  });

  it('có ví dụ hoàn chỉnh — model yếu làm theo ví dụ tốt hơn theo đặc tả', () => {
    expect(prompt).toContain('## Ví dụ một lượt hoàn chỉnh');
    expect(prompt).toMatch(/<grep>[\s\S]*<pattern>[\s\S]*<\/grep>/);
  });

  it('nói rõ mỗi lượt chỉ gọi một công cụ', () => {
    expect(prompt).toMatch(/MỘT công cụ/);
  });
});

describe('parseXmlToolCalls', () => {
  const names = ['grep', 'read_file'];

  it('bóc được lời gọi và tách phần văn bản', () => {
    const r = parseXmlToolCalls(
      'Để tôi tìm thử.\n<grep>\n<pattern>function login</pattern>\n</grep>',
      names,
    );
    expect(r.text).toBe('Để tôi tìm thử.');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ name: 'grep', args: { pattern: 'function login' } });
  });

  it('giữ nguyên nội dung nhiều dòng, không cần escape', () => {
    const r = parseXmlToolCalls(
      '<grep>\n<pattern>dòng 1\ndòng 2</pattern>\n</grep>',
      names,
    );
    expect(r.calls[0]!.args.pattern).toBe('dòng 1\ndòng 2');
  });

  it('bắt nhiều lời gọi trong một lượt', () => {
    const r = parseXmlToolCalls(
      '<grep><pattern>a</pattern></grep>\n<read_file><path>x.ts</path></read_file>',
      names,
    );
    expect(r.calls.map((c) => c.name)).toEqual(['grep', 'read_file']);
  });

  it('KHÔNG nhầm HTML/JSX model in ra là lời gọi tool', () => {
    const r = parseXmlToolCalls(
      'Ví dụ JSX:\n<div className="x">\n<span>hi</span>\n</div>',
      names,
    );
    expect(r.calls).toHaveLength(0);
    expect(r.text).toContain('<div className="x">');
  });

  it('báo thẻ thiếu đóng để repair loop xử lý thay vì im lặng', () => {
    const r = parseXmlToolCalls('<grep>\n<pattern>a</pattern>', names);
    expect(r.calls).toHaveLength(0);
    expect(r.malformed).toContain('grep');
  });

  it('không có tool nào thì trả text nguyên vẹn', () => {
    const r = parseXmlToolCalls('<grep><pattern>a</pattern></grep>', []);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toContain('<grep>');
  });

  it('văn bản thuần không có thẻ', () => {
    const r = parseXmlToolCalls('Hàm login nằm ở src/auth.ts dòng 12.', names);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe('Hàm login nằm ở src/auth.ts dòng 12.');
  });

  it.each([
    ['thừa khoảng trắng', '<read_file >\n<path>x.ts</path>\n</read_file>'],
    ['có thuộc tính', '<read_file id="1">\n<path>x.ts</path>\n</read_file>'],
    ['xuống dòng trong thẻ', '<read_file\n>\n<path>x.ts</path>\n</read_file>'],
    ['khoảng trắng ở thẻ đóng', '<read_file>\n<path>x.ts</path>\n</read_file >'],
    ['tham số có thuộc tính', '<read_file>\n<path type="str">x.ts</path>\n</read_file>'],
  ])('bóc được lời gọi khi thẻ %s', (_label, raw) => {
    const r = parseXmlToolCalls(raw, names);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.args.path).toBe('x.ts');
    expect(r.text).toBe('');
  });

  /**
   * Nguyên văn thứ GLM-5.2 sinh ra khi thẻ dính liền sau một câu văn: dấu `<`
   * của thẻ mở rơi mất, nhưng thẻ đóng vẫn đúng.
   */
  describe('cứu lời gọi hụt dấu <', () => {
    it('bóc được lời gọi và cắt sạch khỏi phần văn bản', () => {
      const r = parseXmlToolCalls(
        'Tôi cần đọc các file cấu hình chính.read_file>\n<path>package.json</path>\n</read_file>',
        names,
      );
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]!.name).toBe('read_file');
      expect(r.calls[0]!.args.path).toBe('package.json');
      expect(r.text).toBe('Tôi cần đọc các file cấu hình chính.');
      expect(r.malformed).toHaveLength(0);
    });

    it('lấy chỗ mở gần thẻ đóng nhất, không lấy tên nhắc trong câu văn', () => {
      const r = parseXmlToolCalls(
        'Công cụ read_file dùng để đọc file.\nread_file>\n<path>a.ts</path>\n</read_file>',
        names,
      );
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]!.args.path).toBe('a.ts');
      expect(r.text).toBe('Công cụ read_file dùng để đọc file.');
    });

    it('KHÔNG cứu khi không bóc được tham số nào — tránh nuốt nhầm văn xuôi', () => {
      const r = parseXmlToolCalls('nói về read_file> rồi </read_file> thôi', names);
      expect(r.calls).toHaveLength(0);
    });

    it('KHÔNG cứu khi tên nằm giữa một từ dài hơn', () => {
      const r = parseXmlToolCalls(
        'xem xread_file>\n<path>a.ts</path>\n</read_file>',
        names,
      );
      expect(r.calls).toHaveLength(0);
      expect(r.malformed).toContain('read_file');
    });

    it('lời gọi đúng chuẩn vẫn được ưu tiên, không đi qua đường cứu', () => {
      const r = parseXmlToolCalls('<read_file>\n<path>a.ts</path>\n</read_file>', names);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]!.start).toBe(0);
    });
  });

  describe('nhận ra model ĐỊNH gọi tool nhưng viết sai', () => {
    it('tên thẻ sai kiểu viết', () => {
      const r = parseXmlToolCalls('<readFile>\n<path>x.ts</path>\n</readFile>', names);
      expect(r.calls).toHaveLength(0);
      expect(r.malformed).toContain('read_file');
      expect(r.malformedReason).toContain('read_file');
    });

    it('định dạng tool_call của model khác', () => {
      const r = parseXmlToolCalls(
        '<tool_call>read_file\n<arg_key>path</arg_key>\n</tool_call>',
        names,
      );
      expect(r.calls).toHaveLength(0);
      expect(r.malformedReason).toContain('tool_call');
    });

    it('thẻ đóng không có thẻ mở khớp', () => {
      const r = parseXmlToolCalls('Xong rồi.\n</grep>', names);
      expect(r.calls).toHaveLength(0);
      expect(r.malformed).toContain('grep');
    });

    it('KHÔNG kêu oan khi đã bóc được lời gọi', () => {
      const r = parseXmlToolCalls(
        'Ví dụ <readFile> chỉ là chữ.\n<grep><pattern>a</pattern></grep>',
        names,
      );
      expect(r.calls).toHaveLength(1);
      expect(r.malformed).toHaveLength(0);
      expect(r.malformedReason).toBeUndefined();
    });

    it('KHÔNG kêu oan với HTML/JSX thường', () => {
      const r = parseXmlToolCalls('<div className="x">\n<span>hi</span>\n</div>', names);
      expect(r.malformed).toHaveLength(0);
      expect(r.malformedReason).toBeUndefined();
    });
  });
});

describe('coerceArgs — XML không có kiểu, mọi thứ về đây đều là chuỗi', () => {
  const schema = GREP.parameters;

  it('ép số', () => {
    expect(coerceArgs({ limit: '25' }, schema)).toEqual({ limit: 25 });
  });

  it('giữ nguyên chuỗi nếu không ép được, để zod báo lỗi thật', () => {
    expect(coerceArgs({ limit: 'nhiều' }, schema)).toEqual({ limit: 'nhiều' });
  });

  it('ép boolean theo nhiều cách model hay viết', () => {
    expect(coerceArgs({ caseSensitive: 'true' }, schema).caseSensitive).toBe(true);
    expect(coerceArgs({ caseSensitive: 'YES' }, schema).caseSensitive).toBe(true);
    expect(coerceArgs({ caseSensitive: '0' }, schema).caseSensitive).toBe(false);
  });

  it('mảng viết mỗi dòng một giá trị', () => {
    expect(coerceArgs({ paths: 'a.ts\nb.ts' }, schema).paths).toEqual(['a.ts', 'b.ts']);
  });

  it('mảng một phần tử', () => {
    expect(coerceArgs({ paths: 'a.ts' }, schema).paths).toEqual(['a.ts']);
  });

  it('chuỗi giữ nguyên', () => {
    expect(coerceArgs({ pattern: 'function x' }, schema).pattern).toBe('function x');
  });

  it('tham số không có trong schema thì để nguyên cho zod từ chối', () => {
    expect(coerceArgs({ unknown: 'x' }, schema).unknown).toBe('x');
  });
});

/**
 * Đường XML trả kết quả tool bằng một message `role: "user"` giả. Khi mở lại
 * phiên cũ, nhận nhầm nó là lời người dùng nghĩa là hiện nguyên văn cả đống
 * `<tool_result>` như thể chính họ đã gõ ra.
 */
describe('readXmlToolResults', () => {
  const injected = [
    XML_TOOL_RESULT_PREFIX,
    '',
    `${XML_TOOL_RESULT_HEADING}read_file`,
    '<tool_result untrusted="true">',
    'nội dung file',
    '</tool_result>',
    '',
    `${XML_TOOL_RESULT_HEADING}grep`,
    'không khớp dòng nào',
    '',
    XML_TOOL_RESULT_FOOTER,
  ].join('\n');

  it('đọc được tên VÀ nội dung kết quả, đúng thứ tự đã gọi', () => {
    expect(readXmlToolResults(injected)).toEqual([
      { name: 'read_file', content: 'nội dung file' },
      { name: 'grep', content: 'không khớp dòng nào' },
    ]);
  });

  it('gỡ vỏ <tool_result> — vỏ là ranh giới cho model, không phải nội dung', () => {
    const [first] = readXmlToolResults(injected)!;
    expect(first!.content).not.toContain('tool_result');
  });

  it('câu dặn ở cuối không dính vào kết quả cuối cùng', () => {
    const last = readXmlToolResults(injected)!.at(-1);
    expect(last!.content).not.toContain(XML_TOOL_RESULT_FOOTER);
  });

  it('lời người dùng thật trả undefined, kể cả khi có nhắc tới tool', () => {
    expect(readXmlToolResults('đọc giúp tôi file này')).toBeUndefined();
    expect(readXmlToolResults(`${XML_TOOL_RESULT_HEADING}read_file`)).toBeUndefined();
    expect(readXmlToolResults('')).toBeUndefined();
  });

  it('không có kết quả nào thì là mảng rỗng, không phải undefined', () => {
    // Phân biệt "đây là message của hệ thống nhưng rỗng" với "đây là lời
    // người dùng" — hai thứ hiển thị khác hẳn nhau.
    expect(readXmlToolResults(XML_TOOL_RESULT_PREFIX)).toEqual([]);
  });
});
