import { describe, expect, it } from 'vitest';
import { chooseTurnModel, describeModelOption, type ChatModelOption } from './modelChoice.js';

function option(over: Partial<ChatModelOption> = {}): ChatModelOption {
  return {
    id: 'qwen3-coder-30b',
    label: 'Qwen3 Coder 30B',
    available: true,
    contextWindow: 32_768,
    toolCalling: 'native',
    vision: false,
    profileSource: 'measured',
    ...over,
  };
}

const MODELS: ChatModelOption[] = [
  option(),
  option({ id: 'gpt-oss-120b', label: 'GPT-OSS 120B', contextWindow: 128_000, profileSource: 'inferred' }),
  option({ id: 'gemma-3-27b', label: 'Gemma 3 27B', toolCalling: 'xml-fallback', vision: true }),
  option({ id: 'llama-3.1-8b', label: 'Llama 3.1 8B', available: false }),
];

describe('chooseTurnModel', () => {
  it('không chọn gì -> dùng model theo vai, không nói gì', () => {
    const choice = chooseTurnModel({
      override: undefined,
      roleModel: 'gpt-oss-120b',
      models: MODELS,
    });
    expect(choice).toEqual({ id: 'gpt-oss-120b', reason: 'role' });
  });

  it('đã chọn ở thanh soạn -> thắng cấu hình theo vai', () => {
    const choice = chooseTurnModel({
      override: 'qwen3-coder-30b',
      roleModel: 'gpt-oss-120b',
      models: MODELS,
    });
    expect(choice.id).toBe('qwen3-coder-30b');
    expect(choice.reason).toBe('override');
    expect(choice.notice).toBeUndefined();
  });

  it('thắng cho MỌI vai — kể cả vai plan/vision của lượt đó', () => {
    // `roleModel` ở đây là model của vai `planner`. Người dùng vừa chỉ vào một
    // cái tên cụ thể, nên chạy plan mode bằng tên khác là làm ngược yêu cầu.
    const choice = chooseTurnModel({
      override: 'qwen3-coder-30b',
      roleModel: 'gemma-3-27b',
      models: MODELS,
    });
    expect(choice.id).toBe('qwen3-coder-30b');
  });

  it('model đã chọn biến mất khỏi danh sách -> rơi về vai VÀ nói ra', () => {
    // Im lặng ở đây là để người dùng tưởng mình đang chạy bằng thứ họ chọn.
    const choice = chooseTurnModel({
      override: 'model-da-bi-xoa',
      roleModel: 'gpt-oss-120b',
      models: MODELS,
    });
    expect(choice.id).toBe('gpt-oss-120b');
    expect(choice.reason).toBe('override-unavailable');
    expect(choice.notice).toContain('model-da-bi-xoa');
    expect(choice.notice).toContain('gpt-oss-120b');
  });

  it('model đã chọn còn trong danh sách nhưng tài khoản không được cấp -> cũng rơi về vai', () => {
    const choice = chooseTurnModel({
      override: 'llama-3.1-8b',
      roleModel: 'gpt-oss-120b',
      models: MODELS,
    });
    expect(choice.reason).toBe('override-unavailable');
    expect(choice.notice).toContain('not available on this account');
  });

  it('không có model nào dùng được thì trả undefined, không ném', () => {
    const choice = chooseTurnModel({ override: undefined, roleModel: undefined, models: [] });
    expect(choice.id).toBeUndefined();
  });

  it('rơi về vai mà vai cũng không có model -> câu nói vẫn đọc được', () => {
    const choice = chooseTurnModel({ override: 'x', roleModel: undefined, models: [] });
    expect(choice.notice).toContain('no model');
  });
});

describe('describeModelOption', () => {
  it('nói đủ bốn thứ người dùng cần để chọn', () => {
    expect(describeModelOption(option())).toBe('32,768 ctx · native tools · measured');
    expect(describeModelOption(option({ toolCalling: 'xml-fallback', vision: true }))).toBe(
      '32,768 ctx · XML tools · images · measured',
    );
    expect(describeModelOption(option({ profileSource: 'inferred' }))).toContain('not measured');
  });

  it('hiện số ĐÚNG, không làm tròn về "k"', () => {
    // 32768 làm tròn ra "33k" đọc như một model khác với cái người dùng biết là
    // 32k, và bảng cài đặt thì hiện số đầy đủ — hai chỗ phải nói cùng con số.
    expect(describeModelOption(option())).not.toContain('33k');
  });

  it('cửa sổ ngữ cảnh chưa biết thì bỏ hẳn, không hiện "0 ctx"', () => {
    expect(describeModelOption(option({ contextWindow: 0 }))).toBe('native tools · measured');
  });
});
