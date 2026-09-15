import { describe, expect, it } from 'vitest';
import {
  CHAT_PROTOCOL_VERSION,
  MAX_IMAGE_BASE64,
  parseChatMessage,
  turnEndStatusLabel,
} from './protocol.js';

describe('turnEndStatusLabel', () => {
  it('chỉ abort thật mới hiện cancelled', () => {
    expect(turnEndStatusLabel('aborted')).toBe('cancelled');
    expect(turnEndStatusLabel('error')).toBeUndefined();
    expect(turnEndStatusLabel('answer')).toBeUndefined();
  });

  it('giữ cảnh báo khi chạm trần vòng lặp', () => {
    expect(turnEndStatusLabel('iteration_limit')).toBe('STOPPED AT THE ITERATION LIMIT');
  });
});

/**
 * Webview chat có acquireVsCodeApi() nên message của nó chạm được vào extension
 * host — cùng ranh giới tin cậy với màn hình cài đặt (documents/SECURITY.md §6.6).
 * Ở đây rủi ro cao hơn một bậc: webview này còn render output của model.
 */
describe('parseChatMessage', () => {
  const v = CHAT_PROTOCOL_VERSION;

  it('chấp nhận message không tham số', () => {
    const types = [
      'ready',
      'stop',
      'clear',
      'openSettings',
      'signIn',
      'signOut',
      'refreshModels',
      'testConnection',
            'showLogs',
      'refreshWork',
    ] as const;
    for (const type of types) {
      expect(parseChatMessage({ protocolVersion: v, type })).toEqual({
        protocolVersion: v,
        type,
      });
    }
  });

  it('từ chối sai protocolVersion — webview cũ trong cache không được xử lý', () => {
    expect(parseChatMessage({ protocolVersion: v + 1, type: 'stop' })).toBeUndefined();
    expect(parseChatMessage({ type: 'stop' })).toBeUndefined();
  });

  it('từ chối giá trị không phải object', () => {
    for (const bad of [null, undefined, 'stop', 7, []]) {
      expect(parseChatMessage(bad)).toBeUndefined();
    }
  });

  it('send yêu cầu text không rỗng', () => {
    expect(parseChatMessage({ protocolVersion: v, type: 'send', text: 'hi' })).toEqual({
      protocolVersion: v,
      type: 'send',
      text: 'hi',
    });

    expect(parseChatMessage({ protocolVersion: v, type: 'send', text: '' })).toBeUndefined();
    expect(parseChatMessage({ protocolVersion: v, type: 'send', text: 42 })).toBeUndefined();
    expect(parseChatMessage({ protocolVersion: v, type: 'send' })).toBeUndefined();
  });

  it('chặn prompt dài bất thường — webview bị chiếm có thể bơm cả megabyte', () => {
    expect(
      parseChatMessage({
        protocolVersion: v,
        type: 'send',
        text: 'x'.repeat(40_000),
      }),
    ).toBeUndefined();
  });

  /**
   * Ảnh là dữ liệu nhị phân từ webview đi thẳng lên model. Kiểm ở đây vì đây là
   * chỗ duy nhất chặn được: sau ranh giới này nó chỉ còn là base64 trong body.
   */
  describe('ảnh đính kèm', () => {
    const png = { name: 'shot.png', mediaType: 'image/png', data: 'iVBORw0KGgo=' };
    const send = (images: unknown, text = 'xem ảnh') =>
      parseChatMessage({ protocolVersion: v, type: 'send', text, images });

    it('nhận ảnh hợp lệ', () => {
      expect(send([png])).toEqual({
        protocolVersion: v,
        type: 'send',
        text: 'xem ảnh',
        images: [png],
      });
    });

    it('cho gửi ảnh không kèm chữ, nhưng không cho gửi rỗng cả hai', () => {
      expect(send([png], '')).toMatchObject({ text: '', images: [png] });
      expect(send([], '')).toBeUndefined();
      expect(send(undefined, '')).toBeUndefined();
    });

    it('từ chối mediaType ngoài danh sách', () => {
      expect(send([{ ...png, mediaType: 'image/svg+xml' }])).toBeUndefined();
      expect(send([{ ...png, mediaType: 'text/html' }])).toBeUndefined();
    });

    it('từ chối data không phải base64 thuần', () => {
      expect(send([{ ...png, data: 'data:image/png;base64,iVBORw0KGgo=' }])).toBeUndefined();
      expect(send([{ ...png, data: '<svg onload=alert(1)>' }])).toBeUndefined();
      expect(send([{ ...png, data: '' }])).toBeUndefined();
    });

    it('từ chối quá nhiều ảnh hoặc ảnh quá lớn', () => {
      expect(send([png, png, png, png, png])).toBeUndefined();
      expect(send([{ ...png, data: 'A'.repeat(MAX_IMAGE_BASE64 + 1) }])).toBeUndefined();
    });

    it('cắt đường dẫn khỏi tên — chip không được để lộ cây thư mục của máy', () => {
      const parsed = send([{ ...png, name: 'C:\\Users\\me\\secret\\shot.png' }]);
      expect(parsed).toMatchObject({ images: [{ name: 'shot.png' }] });
    });

    it('bỏ cả message khi một ảnh hỏng, không âm thầm gửi thiếu', () => {
      expect(send([png, { ...png, data: '!!!' }])).toBeUndefined();
    });
  });

  it('mentionQuery giới hạn độ dài', () => {
    expect(parseChatMessage({ protocolVersion: v, type: 'mentionQuery', query: 'auth' })).toEqual({
      protocolVersion: v,
      type: 'mentionQuery',
      query: 'auth',
    });
    expect(
      parseChatMessage({ protocolVersion: v, type: 'mentionQuery', query: 'x'.repeat(300) }),
    ).toBeUndefined();
  });

  it('openFile yêu cầu path là chuỗi không rỗng', () => {
    expect(parseChatMessage({ protocolVersion: v, type: 'openFile', path: 'src/a.ts' })).toEqual({
      protocolVersion: v,
      type: 'openFile',
      path: 'src/a.ts',
    });
    expect(parseChatMessage({ protocolVersion: v, type: 'openFile', path: '' })).toBeUndefined();
    expect(parseChatMessage({ protocolVersion: v, type: 'openFile', path: 42 })).toBeUndefined();
  });

  it('từ chối type lạ', () => {
    expect(parseChatMessage({ protocolVersion: v, type: 'evalCode' })).toBeUndefined();
    expect(parseChatMessage({ protocolVersion: v, type: 'runBash', cmd: 'rm -rf' })).toBeUndefined();
  });

  it('không mang theo trường thừa từ payload gốc', () => {
    const parsed = parseChatMessage({
      protocolVersion: v,
      type: 'send',
      text: 'hi',
      command: 'rm -rf /',
      __proto__extra: 'x',
    });
    expect(parsed).toEqual({
      protocolVersion: v,
      type: 'send',
      text: 'hi',
    });
  });
});

/**
 * Message quyền (M4) — ranh giới tin cậy quan trọng nhất trong giao thức này.
 *
 * Webview render nội dung do model sinh ra. Nếu webview bị lợi dụng thì thứ nó
 * gửi ngược về host phải không làm được gì ngoài ba lựa chọn đã định — một
 * decision lạ lọt qua đây nghĩa là agent ghi được file mà người dùng chưa duyệt.
 */
describe('parseChatMessage — duyệt quyền', () => {
  const v = CHAT_PROTOCOL_VERSION;

  it('nhận đúng ba quyết định hợp lệ', () => {
    for (const decision of ['allow_once', 'allow_always', 'deny'] as const) {
      expect(parseChatMessage({ protocolVersion: v, type: 'permissionAnswer', id: 'p1', decision })).toEqual({
        protocolVersion: v,
        type: 'permissionAnswer',
        id: 'p1',
        decision,
      });
    }
  });

  it('từ chối decision ngoài danh sách', () => {
    for (const decision of ['allow', 'ALLOW_ONCE', 'yes', true, 1, null, {}]) {
      expect(
        parseChatMessage({ protocolVersion: v, type: 'permissionAnswer', id: 'p1', decision }),
      ).toBeUndefined();
    }
  });

  it('từ chối id rỗng, sai kiểu, hoặc quá dài', () => {
    const base = { protocolVersion: v, type: 'permissionAnswer', decision: 'allow_once' };
    expect(parseChatMessage({ ...base, id: '' })).toBeUndefined();
    expect(parseChatMessage({ ...base, id: 7 })).toBeUndefined();
    expect(parseChatMessage({ ...base, id: 'x'.repeat(65) })).toBeUndefined();
  });

  it('không mang theo trường thừa', () => {
    expect(
      parseChatMessage({
        protocolVersion: v,
        type: 'permissionAnswer',
        id: 'p1',
        decision: 'deny',
        tool: 'bash',
        command: 'rm -rf /',
      }),
    ).toEqual({ protocolVersion: v, type: 'permissionAnswer', id: 'p1', decision: 'deny' });
  });

  it('questionAnswer: nhận mảng lồng mảng chuỗi hợp lệ', () => {
    expect(
      parseChatMessage({
        protocolVersion: v,
        type: 'questionAnswer',
        id: 'q1',
        selections: [['A'], ['X', 'Y']],
      }),
    ).toEqual({
      protocolVersion: v,
      type: 'questionAnswer',
      id: 'q1',
      selections: [['A'], ['X', 'Y']],
    });
  });

  it('questionAnswer: từ chối quá nhiều câu hỏi hoặc quá nhiều lựa chọn', () => {
    const tooManyQuestions = Array.from({ length: 5 }, () => ['A']);
    expect(
      parseChatMessage({ protocolVersion: v, type: 'questionAnswer', id: 'q1', selections: tooManyQuestions }),
    ).toBeUndefined();

    const tooManyOptions = [Array.from({ length: 5 }, (_, i) => `opt${i}`)];
    expect(
      parseChatMessage({ protocolVersion: v, type: 'questionAnswer', id: 'q1', selections: tooManyOptions }),
    ).toBeUndefined();
  });

  it('questionAnswer: từ chối nhãn không phải chuỗi, rỗng, hoặc quá dài', () => {
    for (const bad of [[[1]], [['']], [['x'.repeat(201)]]]) {
      expect(
        parseChatMessage({ protocolVersion: v, type: 'questionAnswer', id: 'q1', selections: bad }),
      ).toBeUndefined();
    }
  });

  it('questionAnswer: từ chối selections rỗng, thiếu, hoặc không phải mảng', () => {
    for (const selections of [[], 'x', 7, null, undefined]) {
      expect(
        parseChatMessage({ protocolVersion: v, type: 'questionAnswer', id: 'q1', selections }),
      ).toBeUndefined();
    }
  });

  it('questionAnswer: từ chối id rỗng, sai kiểu, hoặc quá dài', () => {
    const base = { protocolVersion: v, type: 'questionAnswer', selections: [['A']] };
    expect(parseChatMessage({ ...base, id: '' })).toBeUndefined();
    expect(parseChatMessage({ ...base, id: 7 })).toBeUndefined();
    expect(parseChatMessage({ ...base, id: 'x'.repeat(65) })).toBeUndefined();
  });

  it('questionAnswer: không mang theo trường thừa', () => {
    expect(
      parseChatMessage({
        protocolVersion: v,
        type: 'questionAnswer',
        id: 'q1',
        selections: [['A']],
        extra: 'bỏ đi',
      }),
    ).toEqual({ protocolVersion: v, type: 'questionAnswer', id: 'q1', selections: [['A']] });
  });

  it('setMode chỉ nhận ba chế độ biết trước', () => {
    for (const mode of ['plan', 'ask', 'acceptEdits'] as const) {
      expect(parseChatMessage({ protocolVersion: v, type: 'setMode', mode })).toEqual({
        protocolVersion: v,
        type: 'setMode',
        mode,
      });
    }
    for (const mode of ['god', 'auto', 'ACCEPTEDITS', '', null]) {
      expect(parseChatMessage({ protocolVersion: v, type: 'setMode', mode })).toBeUndefined();
    }
  });

  it('showChanges không nhận tham số nào', () => {
    expect(parseChatMessage({ protocolVersion: v, type: 'showChanges', path: '../x' })).toEqual({
      protocolVersion: v,
      type: 'showChanges',
    });
  });

  // ── M6 ────────────────────────────────────────────────────────────────────

  it('listSessions không nhận tham số nào', () => {
    expect(
      parseChatMessage({ protocolVersion: v, type: 'listSessions', workspace: '/etc' }),
    ).toEqual({ protocolVersion: v, type: 'listSessions' });
  });

  it('resumeSession chỉ nhận id là chuỗi có độ dài hợp lý', () => {
    expect(parseChatMessage({ protocolVersion: v, type: 'resumeSession', id: 's1' })).toEqual({
      protocolVersion: v,
      type: 'resumeSession',
      id: 's1',
    });

    for (const id of ['', 'x'.repeat(65), 7, null, undefined]) {
      expect(parseChatMessage({ protocolVersion: v, type: 'resumeSession', id })).toBeUndefined();
    }
  });

  it('pinRemove chỉ nhận id là chuỗi có độ dài hợp lý', () => {
    expect(parseChatMessage({ protocolVersion: v, type: 'pinRemove', id: 'pin1' })).toEqual({
      protocolVersion: v,
      type: 'pinRemove',
      id: 'pin1',
    });

    for (const id of ['', 'x'.repeat(65), 7, null, undefined]) {
      expect(parseChatMessage({ protocolVersion: v, type: 'pinRemove', id })).toBeUndefined();
    }
  });

  it('pinSelectionHint không nhận tham số nào', () => {
    expect(
      parseChatMessage({ protocolVersion: v, type: 'pinSelectionHint', ref: '../x' }),
    ).toEqual({ protocolVersion: v, type: 'pinSelectionHint' });
  });

  // ── Cài đặt: gộp vào giao thức chat từ v5 ────────────────────────────────
  // Message ở đây ghi thẳng vào settings.json nên phải chặt hơn phần chat.
  //
  // `setBaseUrl` từng đứng ở đây và đã bị gỡ cùng hai ô địa chỉ: gateway và
  // trang web giờ là hằng số trong code, nên webview không còn đường nào đổi
  // đích đến của extension nữa.

  it('setModel nhận một tên model, không còn vai trò', () => {
    expect(parseChatMessage({ protocolVersion: v, type: 'setModel', value: 'm1' })).toEqual({
      protocolVersion: v,
      type: 'setModel',
      value: 'm1',
    });

    expect(parseChatMessage({ protocolVersion: v, type: 'setModel', value: 42 })).toBeUndefined();
    // Chuỗi dài quá cỡ một khoá settings: chặn ở cổng, không ghi xuống đĩa.
    expect(
      parseChatMessage({ protocolVersion: v, type: 'setModel', value: 'x'.repeat(5000) }),
    ).toBeUndefined();
  });

  it('setPlanModel qua đúng cùng một cổng với setModel', () => {
    // Ô thứ hai ghi xuống settings.json y như ô thứ nhất, nên nó phải chịu
    // đúng cùng phép kiểm — thêm một khoá cấu hình mà quên cổng là thêm một
    // đường ghi đĩa không ai canh.
    expect(parseChatMessage({ protocolVersion: v, type: 'setPlanModel', value: 'm2' })).toEqual({
      protocolVersion: v,
      type: 'setPlanModel',
      value: 'm2',
    });

    expect(
      parseChatMessage({ protocolVersion: v, type: 'setPlanModel', value: 42 }),
    ).toBeUndefined();
    expect(
      parseChatMessage({ protocolVersion: v, type: 'setPlanModel', value: 'x'.repeat(5000) }),
    ).toBeUndefined();
  });

  /**
   * Id dự án đi thẳng vào một URL (`/auth/switch-project/{id}`) và id task đi
   * vào thuộc tính telemetry. Cả hai phải là số nguyên dương THẬT — nhận chuỗi
   * "7" hay số âm ở đây là để webview quyết định hình dạng của một request mà
   * host gửi đi bằng token của người dùng.
   */
  it('setProject và setTask chỉ nhận id là số nguyên dương', () => {
    expect(parseChatMessage({ protocolVersion: v, type: 'setProject', id: 7 })).toEqual({
      protocolVersion: v,
      type: 'setProject',
      id: 7,
    });
    expect(parseChatMessage({ protocolVersion: v, type: 'setProject', id: '7' })).toBeUndefined();
    expect(parseChatMessage({ protocolVersion: v, type: 'setProject', id: -1 })).toBeUndefined();
    expect(parseChatMessage({ protocolVersion: v, type: 'setProject', id: 1.5 })).toBeUndefined();

    // `null` là "thôi khai task", một lựa chọn hợp lệ — khác hẳn id rác.
    expect(parseChatMessage({ protocolVersion: v, type: 'setTask', id: null })).toEqual({
      protocolVersion: v,
      type: 'setTask',
      id: null,
    });
    expect(parseChatMessage({ protocolVersion: v, type: 'setTask', id: 0 })).toBeUndefined();
  });

  /**
   * `reportTaskDone` là message DUY NHẤT từ webview dẫn tới một lần GHI lên WBS
   * của cả dự án, nên nó là chỗ chặt nhất trong cầu này.
   */
  it('reportTaskDone nhận ngày đúng khuôn và số không âm', () => {
    const good = {
      protocolVersion: v,
      type: 'reportTaskDone',
      taskId: 7,
      planStart: '2026-08-10',
      planEnd: '2026-08-15',
      actualStart: '2026-08-11',
      actualEnd: '2026-08-16',
      tokens: 1234,
      costUsd: 1.5,
    };
    expect(parseChatMessage(good)).toEqual(good);

    // Rỗng là "chưa đặt lịch" — một lựa chọn hợp lệ, khác hẳn ngày rác.
    expect(parseChatMessage({ ...good, planStart: '', planEnd: '' })).toMatchObject({
      planStart: '',
      planEnd: '',
    });
  });

  /**
   * Bỏ CẢ message chứ không sửa giúp: một ngày bị "sửa giúp" thành ngày khác là
   * thứ không ai tra ra được khi nó đã nằm trên bảng WBS của dự án.
   */
  it('reportTaskDone bỏ cả message khi một ô sai', () => {
    const good = {
      protocolVersion: v,
      type: 'reportTaskDone',
      taskId: 7,
      planStart: '2026-08-10',
      planEnd: '2026-08-15',
      actualStart: '2026-08-11',
      actualEnd: '2026-08-16',
      tokens: 1234,
      costUsd: 1.5,
    };

    expect(parseChatMessage({ ...good, planEnd: '15/08/2026' })).toBeUndefined();
    expect(parseChatMessage({ ...good, actualEnd: '2026-8-1' })).toBeUndefined();
    expect(parseChatMessage({ ...good, taskId: 0 })).toBeUndefined();
    expect(parseChatMessage({ ...good, tokens: -1 })).toBeUndefined();
    expect(parseChatMessage({ ...good, tokens: '1234' })).toBeUndefined();
    expect(parseChatMessage({ ...good, costUsd: Number.NaN })).toBeUndefined();
    // Trần để một ô gõ nhầm không thành một dòng vô nghĩa cả dự án đọc thấy.
    expect(parseChatMessage({ ...good, tokens: 1e12 })).toBeUndefined();
  });

  it('openTaskReport đòi id là số nguyên dương', () => {
    expect(parseChatMessage({ protocolVersion: v, type: 'openTaskReport', taskId: 7 })).toEqual({
      protocolVersion: v,
      type: 'openTaskReport',
      taskId: 7,
    });
    expect(
      parseChatMessage({ protocolVersion: v, type: 'openTaskReport', taskId: '7' }),
    ).toBeUndefined();
  });

  it('setBaseUrl không còn được nhận', () => {
    expect(
      parseChatMessage({
        protocolVersion: v,
        type: 'setBaseUrl',
        scope: 'gateway',
        value: 'https://ke-khac',
      }),
    ).toBeUndefined();
  });

    it('không lan truyền trường thừa sang host', () => {
    expect(
      parseChatMessage({
        protocolVersion: v,
        type: 'setModel',
        value: 'm1',
        extra: 'bỏ đi',
      }),
    ).toEqual({ protocolVersion: v, type: 'setModel', value: 'm1' });
  });
});


describe('parseChatMessage — chọn model ở thanh soạn', () => {
  const v = CHAT_PROTOCOL_VERSION;

  it('nhận id model', () => {
    expect(parseChatMessage({ protocolVersion: v, type: 'setSessionModel', id: 'qwen3-coder' })).toEqual(
      { protocolVersion: v, type: 'setSessionModel', id: 'qwen3-coder' },
    );
  });

  it('`null` là giá trị HỢP LỆ — nghĩa là thôi chọn, quay về mặc định', () => {
    // Nhầm nó thành "thiếu trường" thì đường quay về mặc định biến mất, và
    // người dùng bị khoá vào model đã chọn cho tới khi mở hội thoại mới.
    expect(parseChatMessage({ protocolVersion: v, type: 'setSessionModel', id: null })).toEqual({
      protocolVersion: v,
      type: 'setSessionModel',
      id: null,
    });
  });

  it('từ chối id không phải chuỗi, và id dài quá trần', () => {
    for (const bad of [undefined, 7, {}, [], true]) {
      expect(
        parseChatMessage({ protocolVersion: v, type: 'setSessionModel', id: bad }),
      ).toBeUndefined();
    }
    expect(
      parseChatMessage({ protocolVersion: v, type: 'setSessionModel', id: 'x'.repeat(4000) }),
    ).toBeUndefined();
  });

  it('KHÔNG lẫn với `setModel` — cái kia ghi vào settings', () => {
    const session = parseChatMessage({ protocolVersion: v, type: 'setSessionModel', id: 'a' });
    const persisted = parseChatMessage({ protocolVersion: v, type: 'setModel', value: 'a' });
    expect(session?.type).toBe('setSessionModel');
    expect(persisted?.type).toBe('setModel');
  });
});
