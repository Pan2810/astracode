/**
 * Backend `fci` — gọi thẳng endpoint OpenAI-compatible của FCI.
 *
 * Khác backend `cli` ở chỗ model KHÔNG tự duyệt repo: nó chỉ thấy phần ngữ cảnh
 * mà `repoContext.mjs` gom sẵn. Đổi lại, một lượt là một request HTTP — rẻ hơn
 * và đoán được thời gian hơn nhiều so với một phiên agent.
 *
 * `temperature: 0` là bắt buộc: cùng một repo và cùng một ticket phải cho cùng
 * một kết luận, nếu không thì hai lần chạy của AstraQA lại nói khác nhau về
 * cùng một ticket và không ai biết tin bản nào.
 *
 * Endpoint là "gateway OpenAI-compatible" chứ không phải riêng FCI: tên biến
 * `FPT_*` giữ nguyên, đổi nhà cung cấp chỉ là đổi giá trị `FPT_BASE_URL` và
 * `FPT_MODEL`. Không có nhánh riêng cho từng nhà cung cấp trong file này.
 */
import { withRetry, RetryableHttpError, RETRY_STATUSES } from './retry.mjs';

export function fciConfigured(config) {
  return Boolean(config.fciBaseUrl && config.fciApiKey && config.fciModel);
}

const SYSTEM =
  'Bạn là công cụ đối chiếu ticket với code. Bạn chỉ trả lời bằng một khối ```json đúng schema được yêu cầu, ' +
  'không viết gì ngoài khối đó. Chỉ trích dẫn đường dẫn và số dòng có trong phần ngữ cảnh được cung cấp; ' +
  'không bịa đường dẫn.';

/**
 * @returns {Promise<{text: string, usage: object|undefined}>}
 * @throws Error đã che secret (người gọi truyền `redact` vào).
 */
export async function askFci({ config, prompt, timeoutMs, redact, onRetry, sleep, signal }) {
  const url = `${String(config.fciBaseUrl).replace(/\/+$/, '')}/chat/completions`;

  return withRetry(
    async () => {
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.fciApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: config.fciModel,
            temperature: 0,
            messages: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: prompt },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new Error(`gọi FCI thất bại: ${redact(err instanceof Error ? err.message : String(err))}`);
      }

      if (!res.ok) {
        const body = redact(await res.text().catch(() => '')).slice(0, 300);
        const msg = `FCI trả ${res.status}: ${body || '(không có body)'}`;
        // 429/503 mới được thử lại; mọi mã khác ném thẳng, không chờ.
        if (RETRY_STATUSES.has(res.status)) throw new RetryableHttpError(res.status, msg);
        throw new Error(msg);
      }

      let json;
      try {
        json = await res.json();
      } catch (err) {
        throw new Error(`FCI trả body không phải JSON: ${redact(err instanceof Error ? err.message : String(err))}`);
      }

      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error('FCI trả về câu trả lời rỗng (choices[0].message.content).');
      }
      return { text, usage: json.usage };
    },
    { onRetry, sleep, signal },
  );
}
