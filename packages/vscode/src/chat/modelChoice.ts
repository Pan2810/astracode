/**
 * Chọn model cho một lượt chat, khi người dùng có thể đổi model NGAY TRONG
 * thanh soạn thay vì phải mở bảng cài đặt.
 *
 * ## Hai nguồn quyết định, và thứ tự giữa chúng
 *
 * `ModelRegistry` định tuyến theo VAI: `editor` cho việc sửa code, `planner`
 * cho chế độ plan và cho ảnh (xem `roleForTurn`). Đó là cấu hình của MÁY, đọc
 * từ settings, và nó đúng khi không ai nói gì thêm.
 *
 * Chọn model ở thanh soạn là một lời nói thêm, và nó chỉ sống trong PHIÊN CHAT
 * đang mở — không ghi vào settings. Khi có lời nói đó, nó thắng, và nó thắng
 * cho MỌI vai: người dùng vừa chỉ vào một cái tên cụ thể, nên chạy plan mode
 * bằng một model khác cái tên đó là làm ngược lại điều họ vừa yêu cầu.
 *
 * ## Vì sao tách thành module thuần
 *
 * Cả `ChatController` lẫn bảng cài đặt đều cần cùng một câu trả lời cho "lượt
 * tới chạy bằng model nào, và vì sao". Để logic đó nằm trong `ChatController`
 * là để nó không test được — file đó phụ thuộc `vscode` và chưa có test nào
 * (OPEN-ISSUES #5, #27). Ở đây thì có.
 */

/** Model hiện trong bảng chọn của thanh soạn. */
export interface ChatModelOption {
  id: string;
  /** Tên gateway đặt. Rỗng thì UI hiện `id`. */
  label: string;
  /** Tài khoản này dùng được không. Không dùng được thì vẫn hiện, nhưng mờ. */
  available: boolean;
  contextWindow: number;
  toolCalling: 'native' | 'xml-fallback' | 'none';
  /** Đọc được ảnh không — người dùng cần thấy trước khi đính kèm ảnh. */
  vision: boolean;
  profileSource: 'measured' | 'inferred';
}

export interface ModelChoiceInput {
  /** Model người dùng chọn ở thanh soạn cho phiên này. */
  override: string | undefined;
  /** Model mà cấu hình máy sẽ dùng cho vai của lượt này. */
  roleModel: string | undefined;
  /** Danh sách model gateway đang cấp. */
  models: ChatModelOption[];
}

export type ModelChoiceReason =
  /** Không ai chọn gì — dùng cấu hình theo vai. */
  | 'role'
  /** Người dùng đã chọn ở thanh soạn. */
  | 'override'
  /**
   * Đã chọn, nhưng model đó không còn dùng được (gateway đổi danh sách, hoặc
   * quyền bị thu hồi giữa phiên) — rơi về cấu hình theo vai.
   */
  | 'override-unavailable';

export interface ModelChoice {
  /** Model thật sự sẽ chạy. `undefined` = không có model nào dùng được. */
  id: string | undefined;
  reason: ModelChoiceReason;
  /**
   * Câu nói cho người dùng, tiếng Anh (họ đọc nó trong IDE). Chỉ có mặt khi có
   * điều đáng nói — im lặng là mặc định.
   */
  notice?: string;
}

/**
 * Model của lượt tới.
 *
 * Nhánh đáng chú ý là `override-unavailable`: một model đã chọn có thể biến mất
 * khỏi danh sách giữa phiên. Im lặng rơi về model theo vai ở đó là để người
 * dùng tưởng mình đang chạy bằng thứ họ chọn — nên nó trả kèm một câu giải
 * thích, và người gọi có nhiệm vụ hiện câu đó ra.
 */
export function chooseTurnModel(input: ModelChoiceInput): ModelChoice {
  const { override, roleModel, models } = input;

  if (override === undefined) {
    return { id: roleModel, reason: 'role' };
  }

  const picked = models.find((m) => m.id === override);
  if (picked?.available === true) {
    return { id: override, reason: 'override' };
  }

  return {
    id: roleModel,
    reason: 'override-unavailable',
    notice:
      picked === undefined
        ? `${override} is no longer on the model list, so this turn runs on ` +
          `${roleModel ?? 'no model'} instead. Pick a model again.`
        : `${override} is not available on this account right now, so this turn runs on ` +
          `${roleModel ?? 'no model'} instead.`,
  };
}

/**
 * Model để đề xuất khi người dùng vừa gỡ lựa chọn của mình.
 *
 * Tách riêng vì UI cần nói ra tên đó ("Default: gpt-oss-120b") — nếu chỉ hiện
 * chữ "Default" thì người dùng bấm vào một cái tên họ không nhìn thấy.
 */
export function describeModelOption(option: ChatModelOption): string {
  const parts: string[] = [];
  // Số ĐÚNG, không làm tròn về "k": 32768 làm tròn ra "33k" đọc như một model
  // khác với cái người dùng biết là 32k. Bảng cài đặt cũng hiện số đầy đủ, nên
  // hai chỗ nói cùng một con số.
  if (option.contextWindow > 0) {
    parts.push(`${option.contextWindow.toLocaleString('en-US')} ctx`);
  }
  parts.push(option.toolCalling === 'native' ? 'native tools' : 'XML tools');
  if (option.vision) parts.push('images');
  parts.push(option.profileSource === 'measured' ? 'measured' : 'not measured');
  return parts.join(' · ');
}
