/**
 * zod -> JSON Schema cho định nghĩa tool gửi lên model.
 *
 * Bọc thư viện thay vì gọi thẳng vì cần dọn output: `zod-to-json-schema` sinh
 * `$schema` và `definitions` theo chuẩn JSON Schema đầy đủ, còn API tool của
 * OpenAI chờ một object schema phẳng. Model yếu đặc biệt dễ rối khi thấy `$ref`.
 */
import type { z } from 'zod';
import { zodToJsonSchema as convert } from 'zod-to-json-schema';

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const raw = convert(schema, {
    // Nhúng thẳng thay vì tách ra $ref/definitions — tránh $ref cho model yếu.
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as Record<string, unknown>;

  delete raw.$schema;
  delete raw.definitions;
  delete raw.$ref;

  // Model thỉnh thoảng bịa thêm trường; nói rõ là không nhận để nó tự sửa.
  if (raw.type === 'object' && raw.additionalProperties === undefined) {
    raw.additionalProperties = false;
  }

  return raw;
}
