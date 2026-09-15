/**
 * `astracode models` — model nào dùng được, và biết gì về chúng.
 *
 * Hai nguồn ghép lại, giống hệt extension: gateway nói model nào TỒN TẠI và ai
 * được dùng; `~/.astra/models.json` nói model đó LÀM ĐƯỢC GÌ. Cột "profile"
 * cho biết đang đọc số đo thật hay mặc định an toàn.
 */
import { buildSession } from './session.js';
import { c, heading, out, table } from './ui.js';

export async function runModels(): Promise<void> {
  const session = buildSession();
  await session.registry.load();
  const models = session.registry.all();

  heading('Model');
  if (models.length === 0) {
    out(c.yellow('  Gateway không trả về model nào.'));
    return;
  }

  table(
    models.map((m) => ({
      model: m.allowed ? m.id : c.dim(m.id),
      'tool-calling':
        m.toolCalling === 'native'
          ? c.green('native')
          : m.toolCalling === 'xml-fallback'
            ? c.yellow('xml-fallback')
            : c.red('none'),
      context: m.contextWindow.toLocaleString('en-US'),
      injection:
        m.injectionResistance === 'high'
          ? c.green('high')
          : m.injectionResistance === 'medium'
            ? c.yellow('medium')
            : m.injectionResistance === 'low'
              ? c.red('low')
              : // `unknown` ≠ `low`. Tô đỏ thứ chưa ai đo là dạy người dùng bỏ
                // qua màu đỏ, và đến lúc có một model thật sự kém thì không còn
                // ai đọc nữa.
                c.dim('chưa đo'),
      profile: m.profileSource === 'measured' ? c.green('đã đo') : c.dim('mặc định'),
      quyền: m.allowed ? '' : c.dim('không có quyền'),
      trạng_thái: m.online ? '' : c.red('offline'),
    })),
  );

  // Không giục ai đi đo. Lệnh này là chỗ NGƯỜI QUẢN MODEL nhìn hiện trạng, nên
  // nó nói sự thật rồi dừng — model chưa đo vẫn chạy bình thường bằng năng lực
  // giả định, và việc đo chỉ cần khi giả định đó sai.
  const unmeasured = models.filter((m) => m.profileSource === 'inferred' && m.allowed);
  if (unmeasured.length > 0) {
    out('');
    out(
      c.dim(
        `  ${unmeasured.length} model chạy bằng năng lực giả định (native + vision). ` +
          'Chúng vẫn dùng được bình thường.',
      ),
    );
    out(
      c.dim(
        '  Chỉ cần `astracode measure` khi một model cư xử khác giả định — ví dụ không gọi ' +
          'được tool, hoặc cần biết mức kháng injection trước khi giao quyền ghi.',
      ),
    );
  }
  out('');
}
