/**
 * `contributes.configuration` trong package.json phải hợp lệ theo schema của
 * VS Code, và phải giữ nguyên tắc "không có địa chỉ thật làm mặc định".
 *
 * Vì sao đáng một bộ test riêng: cả hai loại sai ở đây đều KHÔNG làm gì vỡ.
 * Typecheck không đọc package.json, build vẫn xanh, extension vẫn chạy. VS Code
 * chỉ ghi một dòng ở Runtime Status — chỗ mà không ai mở trừ khi đã nghi ngờ
 * điều gì đó.
 *
 * Đó đúng là chuyện đã xảy ra ở 0.0.14: một chú thích dạng chuỗi được đặt trong
 * `properties` để giải thích vì sao không nên có default. VS Code validate mọi
 * entry trong `properties` như một JSON-schema object, nên chú thích ấy thành
 * `property '_comment_endpoints' must be an object` và nằm đó suốt hai bản phát
 * hành. Trớ trêu là nội dung nó cảnh báo lại đúng thứ ca test thứ hai bên dưới
 * canh giữ.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MODEL_ID, DEFAULT_PLAN_MODEL_ID } from '@astra/core';

const ROOT = join(__dirname, '..');

interface Manifest {
  contributes?: {
    configuration?: {
      properties?: Record<string, unknown>;
    };
  };
}

function configProperties(): Record<string, unknown> {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Manifest;
  return pkg.contributes?.configuration?.properties ?? {};
}

describe('contributes.configuration', () => {
  it('mọi entry trong properties là object, không phải chú thích', () => {
    const notObjects = Object.entries(configProperties())
      .filter(([, v]) => typeof v !== 'object' || v === null || Array.isArray(v))
      .map(([k]) => k);

    // Chú thích để trong bảng này sẽ bị VS Code từ chối. Cần ghi chú thì đặt ở
    // cấp cao nhất của package.json, cạnh "// TODO-publish".
    expect(notObjects).toEqual([]);
  });

  it('mọi khoá cấu hình đều thuộc namespace astra.', () => {
    const foreign = Object.keys(configProperties()).filter((k) => !k.startsWith('astra.'));
    expect(foreign).toEqual([]);
  });

  it('không có ô cấu hình nào cho địa chỉ AstraWork', () => {
    // Địa chỉ là hằng số trong code (core/config/endpoints.ts), không phải cấu
    // hình. Hai lý do để nó không quay lại đây:
    //
    //   1. Bảng settings được Marketplace render nguyên văn ở tab Feature
    //      Contributions — một ô địa chỉ ở đây là công bố hạ tầng ra Internet.
    //   2. `.vscode/settings.json` nằm TRONG repo, nên một ô địa chỉ là chỗ để
    //      người gửi PR trỏ máy người khác đi nơi khác.
    const keys = Object.keys(configProperties());
    const addressLike = keys.filter((k) => /url|endpoint|gateway|astrawork/i.test(k));
    expect(addressLike).toEqual([]);
  });

  it('có ĐÚNG hai ô chọn model, khớp mặc định trong code', () => {
    const props = configProperties();

    // Hai ô, chia theo loại việc (xem core/config/model.ts). Ba ô cũ
    // editor/planner/fast không được lặng lẽ quay lại: mỗi ô thêm vào là một
    // nơi nữa để lệch với `routing` trong models.json.
    const modelKeys = Object.keys(props).filter((k) => /^astra\.\w*[Mm]odel$/.test(k)).sort();
    expect(modelKeys).toEqual(['astra.model', 'astra.planModel']);

    // Manifest chỉ HIỂN THỊ mặc định; nguồn thật là core/config/model.ts, vì CLI
    // cũng rơi về nó mà không đọc được manifest này.
    expect((props['astra.model'] as { default?: unknown }).default).toBe(DEFAULT_MODEL_ID);
    expect((props['astra.planModel'] as { default?: unknown }).default).toBe(
      DEFAULT_PLAN_MODEL_ID,
    );
  });

  /**
   * Từ 0.0.29 việc đẩy bộ đếm lên board Năng suất không còn công tắc — quyết
   * định vận hành, ghi ở documents/SECURITY.md §9.2.1.
   *
   * Ca này canh cả hai nửa của quyết định ấy, vì mỗi nửa hỏng theo một kiểu im
   * lặng khác nhau. Một ô `astra.telemetry` quay lại manifest thì board thiếu
   * số của bất kỳ ai tắt nó, và không có lỗi nào báo. Một nhánh `isEnabled`
   * quay lại trong UsageSync thì còn tệ hơn: nó chặn ngay cả khi manifest sạch,
   * nên không ai đọc settings.json mà đoán ra được.
   */
  it('không còn công tắc bật/tắt việc đẩy số đo', () => {
    expect(Object.keys(configProperties())).not.toContain('astra.telemetry');

    const src = readFileSync(join(ROOT, 'src', 'telemetry', 'UsageSync.ts'), 'utf8');
    expect(src).not.toMatch(/isEnabled/);
    // `flush()` chỉ được thoát sớm vì "đang gửi" hoặc "không có gì để gửi".
    // Bất kỳ điều kiện nào khác ở đầu hàm là một cổng chặn mới.
    const flushHead = src.slice(src.indexOf('async flush('), src.indexOf('this.syncing = true;'));
    expect(flushHead.match(/if \(/g) ?? []).toHaveLength(1);
  });
});
