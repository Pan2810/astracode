import { describe, expect, it, beforeEach } from 'vitest';
import {
  ModelRegistry,
  parseModelsFile,
  EMPTY_MODELS_FILE,
  mergeModelsFiles,
  type AvailableModel,
  type ModelsFile,
} from './ModelRegistry.js';
import { Logger, MemorySink } from '../telemetry/logger.js';
import { ConfigError } from '../errors.js';
import type { ModelSource } from './ModelSource.js';

/** Nguồn model tĩnh — tách chuyện "lấy danh sách" khỏi chuyện "ghép profile". */
function staticSource(models: AvailableModel[]): ModelSource {
  return { label: 'test', governed: true, list: () => Promise.resolve(models) };
}

function failingSource(err: unknown): ModelSource {
  return {
    label: 'test',
    governed: true,
    list: () => Promise.reject(err),
  };
}

const PROFILES: ModelsFile = {
  schemaVersion: 1,
  baseURL: 'https://mkp-api.example/v1',
  models: [
    {
      id: 'coder-32b',
      label: 'Coder 32B',
      contextWindow: 32_768,
      maxOutput: 8192,
      toolCalling: 'native',
      streamingToolCalls: true,
      vision: false,
      injectionResistance: 'medium',
      roles: ['editor'],
      editStrategy: 'search-replace',
    },
    {
      id: 'big-70b',
      label: 'Big 70B',
      contextWindow: 128_000,
      maxOutput: 8192,
      toolCalling: 'native',
      streamingToolCalls: true,
      vision: false,
      injectionResistance: 'high',
      roles: ['planner'],
      editStrategy: 'search-replace',
    },
    {
      id: 'tiny-7b',
      label: 'Tiny 7B',
      contextWindow: 8192,
      maxOutput: 2048,
      toolCalling: 'xml-fallback',
      streamingToolCalls: false,
      vision: false,
      injectionResistance: 'low',
      roles: ['fast'],
      editStrategy: 'diff-fenced',
    },
  ],
  routing: {
    planner: 'big-70b',
    editor: 'coder-32b',
    fast: 'tiny-7b',
    vision: '',
    fallback: ['coder-32b', 'big-70b'],
  },
};

function available(overrides: Partial<AvailableModel> & { name: string }): AvailableModel {
  return {
    description: '',
    context_limit: 0,
    online: true,
    allowed: true,
    input_price_vnd: 0,
    output_price_vnd: 0,
    ...overrides,
  };
}

describe('ModelRegistry.merge', () => {
  let sink: MemorySink;
  let registry: ModelRegistry;

  beforeEach(() => {
    sink = new MemorySink();
    registry = new ModelRegistry({
      source: staticSource([]),
      profiles: PROFILES,
      logger: new Logger({ sink, level: 'debug' }),
    });
  });

  it('ghép profile với danh sách của gateway theo id', () => {
    registry.merge([available({ name: 'coder-32b', description: 'từ gateway' })]);

    const m = registry.get('coder-32b')!;
    expect(m.toolCalling).toBe('native');
    expect(m.contextWindow).toBe(32_768);
    expect(m.description).toBe('từ gateway');
    expect(m.profileSource).toBe('measured');
  });

  /**
   * Model thiếu profile chạy bằng năng lực GIẢ ĐỊNH, và giả định đó lạc quan.
   *
   * Đổi so với bản đầu (khi đó ép `toolCalling: 'none'`). Lý lẽ cũ — "đoán
   * native là hỏng âm thầm" — đúng khi AstraCode cắm được vào endpoint bất kỳ.
   * Nó không còn đúng: model đến từ gateway của chính tổ chức, và đoán sai giờ
   * KHÔNG còn âm thầm vì `AgentLoop` tự phát hiện rồi chuyển sang XML.
   *
   * Cái giá của mặc định bi quan thì có thật: nó biến `astracode measure`
   * thành bước bắt buộc trước khi dùng được gì.
   */
  it('model THIẾU profile -> chạy bằng năng lực giả định, không bị hạ cấp', () => {
    registry.merge([available({ name: 'model-la', context_limit: 16_000 })]);

    const m = registry.get('model-la')!;
    expect(m.toolCalling).toBe('native');
    expect(m.vision).toBe(true);
    expect(m.profileSource).toBe('inferred');
    // Cửa sổ ngữ cảnh vẫn lấy từ gateway — nó biết thật, không cần đo.
    expect(m.contextWindow).toBe(16_000);
    // Không cảnh báo: đây là đường đi bình thường, không phải trạng thái hỏng.
    expect(sink.records.some((r) => r.level === 'warn' && r.model === 'model-la')).toBe(false);
  });

  /**
   * `unknown` ≠ `low`. Đây là phân biệt quan trọng nhất của cả thay đổi này:
   * "chưa ai đo" bị xếp chung với "đã đo và model kém" sẽ vừa chặn nhầm mọi
   * model mới, vừa làm mất ý nghĩa của cảnh báo khi có model kém thật.
   */
  it('model THIẾU profile có kháng injection là unknown, không phải low', () => {
    registry.merge([available({ name: 'model-la' })]);
    expect(registry.get('model-la')!.injectionResistance).toBe('unknown');
  });

  it('model bị gateway từ chối quyền thì không dùng được', () => {
    registry.merge([
      available({ name: 'coder-32b', allowed: false }),
      available({ name: 'big-70b', online: false }),
      available({ name: 'tiny-7b' }),
    ]);

    expect(registry.usable().map((m) => m.id)).toEqual(['tiny-7b']);
    // Vẫn hiện trong picker để user biết nó tồn tại nhưng không có quyền.
    expect(registry.all()).toHaveLength(3);
  });

  it('profile có nhưng gateway không cấp thì không xuất hiện', () => {
    registry.merge([available({ name: 'coder-32b' })]);
    expect(registry.get('big-70b')).toBeUndefined();
    expect(registry.all()).toHaveLength(1);
  });
});

describe('ModelRegistry.resolve', () => {
  function make(list: AvailableModel[], profiles = PROFILES): ModelRegistry {
    const r = new ModelRegistry({
      source: staticSource([]),
      profiles,
      logger: new Logger({ sink: new MemorySink() }),
    });
    r.merge(list);
    return r;
  }

  it('ưu tiên routing đã cấu hình', () => {
    const r = make([available({ name: 'coder-32b' }), available({ name: 'big-70b' })]);
    expect(r.resolve('editor')).toBe('coder-32b');
    expect(r.resolve('planner')).toBe('big-70b');
  });

  it('bỏ qua routing khi model đó không dùng được', () => {
    const r = make([
      available({ name: 'coder-32b', allowed: false }),
      available({ name: 'big-70b' }),
    ]);
    // routing.editor trỏ coder-32b nhưng user không có quyền -> rơi xuống
    // model native còn lại.
    expect(r.resolve('editor')).toBe('big-70b');
  });

  it('rơi về model khai báo đúng vai trò', () => {
    const r = make([available({ name: 'tiny-7b' })]);
    expect(r.resolve('fast')).toBe('tiny-7b');
  });

  it('trả undefined khi không có model nào dùng được', () => {
    const r = make([]);
    expect(r.resolve('editor')).toBeUndefined();
  });

  it('vai vision mượn routing.planner khi không được khai riêng', () => {
    // Đọc ảnh và lập kế hoạch là cùng một loại việc (config/model.ts), nên
    // models.json của bản cũ — không có khoá `vision` — vẫn cho ra model đúng
    // thay vì rơi về model dùng được đầu tiên.
    const r = make([available({ name: 'coder-32b' }), available({ name: 'big-70b' })]);
    expect(r.resolve('vision')).toBe('big-70b');
  });

  it('routing.vision thắng routing.planner khi có khai', () => {
    const r = make(
      [available({ name: 'coder-32b' }), available({ name: 'big-70b' })],
      { ...PROFILES, routing: { ...PROFILES.routing, vision: 'coder-32b' } },
    );
    expect(r.resolve('vision')).toBe('coder-32b');
  });
});

describe('ModelRegistry.fallbackChain', () => {
  it('lọc chain theo quyền thực tế', () => {
    const r = new ModelRegistry({
      source: staticSource([]),
      profiles: PROFILES,
      logger: new Logger({ sink: new MemorySink() }),
    });
    r.merge([available({ name: 'coder-32b', allowed: false }), available({ name: 'big-70b' })]);
    expect(r.fallbackChain()).toEqual(['big-70b']);
  });
});

describe('ModelRegistry.safeForWrite', () => {
  function make(list: AvailableModel[]): ModelRegistry {
    const r = new ModelRegistry({
      source: staticSource([]),
      profiles: PROFILES,
      logger: new Logger({ sink: new MemorySink() }),
    });
    r.merge(list);
    return r;
  }

  it('từ chối model kháng injection mức low (SECURITY.md §1.7)', () => {
    const r = make([available({ name: 'tiny-7b' })]);
    expect(r.safeForWrite('tiny-7b')).toBe(false);
  });

  it('chấp nhận model native + kháng injection >= medium', () => {
    const r = make([available({ name: 'coder-32b' })]);
    expect(r.safeForWrite('coder-32b')).toBe(true);
  });

  /**
   * Chặn thứ chưa ai đo nghĩa là chặn TẤT CẢ cho tới khi có người chạy phép
   * đo — biến một lớp phòng thủ thành một bước cài đặt, và lớp phòng thủ nào
   * cũng thua một bước cài đặt mà người ta bỏ qua được.
   *
   * Lớp thật sự đứng giữa model và đĩa cứng vẫn là `PermissionManager`, và nó
   * không hỏi model giỏi cỡ nào.
   */
  it('KHÔNG từ chối model chưa đo — chỉ từ chối model ĐO ĐƯỢC là kém', () => {
    const r = make([available({ name: 'model-la' })]);
    expect(r.get('model-la')!.injectionResistance).toBe('unknown');
    expect(r.safeForWrite('model-la')).toBe(true);
  });
});

describe('ModelRegistry.load', () => {
  function make(source: ModelSource): ModelRegistry {
    return new ModelRegistry({
      source,
      profiles: PROFILES,
      logger: new Logger({ sink: new MemorySink() }),
    });
  }

  it('nạp từ nguồn rồi ghép profile', async () => {
    const r = make(staticSource([available({ name: 'coder-32b' })]));
    await r.load();

    expect(r.isLoaded()).toBe(true);
    expect(r.usable().map((m) => m.id)).toEqual(['coder-32b']);
  });

  it('phơi nhãn và tính governed của nguồn cho UI cảnh báo', () => {
    const r = new ModelRegistry({
      source: { label: 'FPT Cloud (trực tiếp)', governed: false, list: async () => [] },
      profiles: PROFILES,
      logger: new Logger({ sink: new MemorySink() }),
    });
    expect(r.source.label).toBe('FPT Cloud (trực tiếp)');
    expect(r.source.governed).toBe(false);
  });

  it('lỗi từ nguồn được ném lên nguyên vẹn, không nuốt', async () => {
    const r = make(failingSource(new ConfigError('endpoint hỏng')));
    await expect(r.load()).rejects.toThrow(ConfigError);
    expect(r.isLoaded()).toBe(false);
  });
});

describe('parseModelsFile', () => {
  it('chấp nhận file hợp lệ', () => {
    expect(parseModelsFile(PROFILES).models).toHaveLength(3);
  });

  it('từ chối schemaVersion sai và nói rõ trường nào hỏng', () => {
    expect(() => parseModelsFile({ ...PROFILES, schemaVersion: 2 })).toThrow(/schemaVersion/);
  });

  it('từ chối toolCalling ngoài enum', () => {
    const bad = {
      ...PROFILES,
      models: [{ ...PROFILES.models[0], toolCalling: 'magic' }],
    };
    expect(() => parseModelsFile(bad)).toThrow(ConfigError);
  });

  it('từ chối warnAt không đứng trước compactAt', () => {
    const bad = {
      ...PROFILES,
      models: [{ ...PROFILES.models[0], warnAt: 0.9, compactAt: 0.8 }],
    };
    expect(() => parseModelsFile(bad)).toThrow(/warnAt.*lower than compactAt/);
  });

  it('EMPTY_MODELS_FILE hợp lệ — để UI khởi động được khi chưa có capability profile', () => {
    expect(() => parseModelsFile(EMPTY_MODELS_FILE)).not.toThrow();
  });
});

/**
 * Chồng profile của người dùng lên bản ship sẵn.
 *
 * Đây là thứ cho phép "đo một lần, cả tổ chức cùng dùng" mà vẫn để một người
 * đo lại riêng một model khi cần.
 */
describe('mergeModelsFiles', () => {
  const profile = (id: string, extra: Partial<ModelsFile['models'][number]> = {}) => ({
    id,
    label: '',
    contextWindow: 32_000,
    maxOutput: 4096,
    toolCalling: 'native' as const,
    streamingToolCalls: false,
    vision: false,
    injectionResistance: 'unknown' as const,
    roles: [],
    editStrategy: 'diff-fenced' as const,
    ...extra,
  });

  const file = (
    models: ModelsFile['models'],
    routing: Partial<ModelsFile['routing']> = {},
  ): ModelsFile => ({
    schemaVersion: 1,
    baseURL: '',
    models,
    routing: { planner: '', editor: '', fast: '', vision: '', fallback: [], ...routing },
  });

  it('người dùng thắng theo TỪNG model, không xoá phần còn lại', () => {
    const merged = mergeModelsFiles(
      file([profile('a', { contextWindow: 8000 }), profile('b')]),
      file([profile('a', { contextWindow: 128_000 })]),
    );

    expect(merged.models).toHaveLength(2);
    expect(merged.models.find((m) => m.id === 'a')!.contextWindow).toBe(128_000);
    // Đo lại một model không nên xoá hiểu biết về những model khác.
    expect(merged.models.find((m) => m.id === 'b')).toBeDefined();
  });

  it('routing xét theo từng vai, không thay cả cụm', () => {
    const merged = mergeModelsFiles(
      file([], { editor: 'ship-editor', fast: 'ship-fast' }),
      file([], { editor: 'cua-toi' }),
    );

    expect(merged.routing.editor).toBe('cua-toi');
    // Khai `editor` ở máy mình không được làm mất `fast` của bản ship sẵn.
    expect(merged.routing.fast).toBe('ship-fast');
  });

  it('người dùng không khai gì thì bản ship sẵn giữ nguyên', () => {
    const base = file([profile('a')], { editor: 'a', fallback: ['a'] });
    const merged = mergeModelsFiles(base, EMPTY_MODELS_FILE);

    expect(merged.models).toHaveLength(1);
    expect(merged.routing.editor).toBe('a');
    expect(merged.routing.fallback).toEqual(['a']);
  });
});
