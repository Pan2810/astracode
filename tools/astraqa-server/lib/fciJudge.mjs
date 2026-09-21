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
import { withRetry, RetryableHttpError, RETRY_STATUSES, parseRetryAfter } from './retry.mjs';

/**
 * Mô tả thân lỗi cho người đọc log.
 *
 * Gateway hỏng giữa đường trả về một TRANG HTML, không phải JSON. Cắt 300 ký tự
 * đầu của nó cho ra `FCI trả 524: <!DOCTYPE html>` — một dòng không nói gì, và
 * đó đúng là dòng đã hiện ra trong lần chạy thật. `<title>` của trang ấy mới là
 * chỗ có thông tin ("504 Gateway Time-out"), nên lấy nó và nói thẳng đây là
 * trang HTML chứ không phải câu trả lời của model.
 */
export function describeErrorBody(raw, contentType = '') {
  const text = String(raw ?? '').trim();
  if (!text) return '(không có body)';
  const looksHtml = /html/i.test(String(contentType)) || /^\s*<(?:!doctype|html)\b/i.test(text);
  if (!looksHtml) return text.slice(0, 300);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.replace(/\s+/g, ' ').trim();
  return `gateway trả trang HTML${title ? ` — "${title}"` : ''} (không phải câu trả lời của model)`;
}

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
export async function askFci({ config, prompt, timeoutMs, redact, onRetry, onAttempt, sleep, signal }) {
  const url = `${String(config.fciBaseUrl).replace(/\/+$/, '')}/chat/completions`;

  return withRetry(
    async () => {
      // Báo TRƯỚC khi gửi: mỗi lần thử lại cũng là một request thật tới nhà
      // cung cấp, nên nó phải được đếm như một lượt gọi.
      onAttempt?.();
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
            // Field riêng của từng nhà cung cấp, đến từ ASTRACODE_JUDGE_EXTRA_BODY.
            // Trộn nông và extra THẮNG: nó sinh ra để đè, ví dụ thêm
            // `chat_template_kwargs` tắt thinking của Qwen. Ðổi lại, đặt
            // `messages` vào đó sẽ thay cả prompt — đừng làm thế.
            ...(config.fciExtraBody ?? {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new Error(`gọi FCI thất bại: ${redact(err instanceof Error ? err.message : String(err))}`);
      }

      if (!res.ok) {
        const body = describeErrorBody(redact(await res.text().catch(() => '')), res.headers.get('content-type'));
        const msg = `FCI trả ${res.status}: ${body}`;
        // 429/503 mới được thử lại; mọi mã khác ném thẳng, không chờ.
        if (RETRY_STATUSES.has(res.status)) {
          // `Retry-After` là nhà cung cấp tự nói còn bao lâu nữa mới hết cửa sổ
          // hạn mức. Ðem theo để `withRetry` chờ đúng chừng ấy thay vì đoán.
          throw new RetryableHttpError(res.status, msg, parseRetryAfter(res.headers.get('retry-after')));
        }
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
    // Ngân sách của cả lượt, kể cả những lần thử lại: xem `deadlineAt` ở retry.mjs.
    { onRetry, sleep, signal, deadlineAt: Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : null },
  );
}
