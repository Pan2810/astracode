/**
 * Contract v1 của AstraQA cho "consistency input", phía Node.
 *
 * Hai repo này độc lập: Node CI không đọc được cây thư mục của AstraQA. Nên bản
 * hợp đồng ở đây là một **bản sao có kiểm chứng** — `fixtures/consistency-v1/`
 * cùng `manifest.json` ghi SHA-256 từng file, và `test/consistency.test.mjs`
 * tính lại băm từ chính nội dung fixture. Fixture lệch bản, hoặc quy tắc chuẩn
 * hoá của hai bên trôi khỏi nhau, thì test đỏ ngay tại đây chứ không phải lúc
 * một verdict gắn nhầm tiêu chí.
 *
 * Điều đáng nhớ nhất: **vị trí không phải danh tính.** Wire v1
 * (`tickets_schema_version: 1`) vẫn gửi `acceptance_criteria` là mảng chuỗi và
 * `assessment.mjs` vẫn trả `id` là 1..N — không đổi gì cả. Cái đổi là phía
 * AstraQA giữ một bản đồ `index → criterion_id` **cho đúng một request**, và
 * `attachCriteria` dưới đây là bản Node của phép ánh xạ ngược ấy. Dựng lại bản
 * đồ từ một lần đọc ticket sau đó là cách một câu trả lời về tiêu chí 2 bị gán
 * cho tiêu chí đã trôi sang vị trí 3.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.join(HERE, '..', 'fixtures', 'consistency-v1');

export const CONTRACT_VERSION = 1;
export const CANONICAL_FORM = 'cjson/1';

/**
 * Lớp khoảng trắng, viết thẳng ra thay vì dùng `\s`.
 *
 * `\s` của JavaScript và của Python KHÔNG cùng một tập: Python bắt `\x1c-\x1f`,
 * JavaScript thì không; JavaScript bắt `﻿`, Python thì không. Chênh nhau ở
 * một codepoint là đủ để hai bên sinh ra hai `criterion_id` khác nhau cho cùng
 * một câu. Liệt kê tập ấy làm hai bản cài đặt bằng nhau theo cấu trúc.
 */
const SPACE_CLASS = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
const WHITESPACE = new RegExp(`[${SPACE_CLASS}]+`, 'g');
const TRAILING = new RegExp(`[${SPACE_CLASS}]+$`);
const BLANK = new RegExp(`^[${SPACE_CLASS}]*$`);

const D_CRITERION = 'astraqa.consistency.v1.criterion';
const D_STATEMENT = 'astraqa.consistency.v1.statement';
const D_REQUIREMENT = 'astraqa.consistency.v1.requirement';

/** Văn bản như hợp đồng lưu: NFC, xuống dòng LF, không bỏ gì mang nghĩa. */
export function normalizeText(value) {
  const text = String(value ?? '')
    .normalize('NFC')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const lines = text.split('\n').map((line) => line.replace(TRAILING, ''));
  while (lines.length && BLANK.test(lines[0])) lines.shift();
  while (lines.length && BLANK.test(lines[lines.length - 1])) lines.pop();
  return lines.join('\n');
}

/** Cái làm hai tiêu chí là MỘT tiêu chí: gộp mọi khoảng trắng về một dấu cách. */
export function identityText(value) {
  return normalizeText(value).replace(WHITESPACE, ' ').replace(/^ +| +$/g, '');
}

/** `cjson/1`: NFC, khoá sắp xếp, không khoảng trắng thừa, không số thực. */
export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (typeof value === 'string') return value.normalize('NFC');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      // Hợp đồng không mang số thực. Cho lọt một cái là để băm phụ thuộc vào
      // cách mỗi ngôn ngữ in số thực.
      throw new TypeError('Hợp đồng consistency không mang giá trị số thực');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).map((k) => k.normalize('NFC')).sort()) {
      out[key] = canonicalValue(value[key]);
    }
    return out;
  }
  throw new TypeError(`Không chuẩn hoá được ${typeof value}`);
}

/** `sha256:<hex>` trên một nhãn miền, một newline, rồi dạng chuẩn của payload. */
export function digest(domain, payload) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(Buffer.from(`${domain}\n`, 'utf8'))
    .update(Buffer.from(canonicalJson(payload), 'utf8'))
    .digest('hex')}`;
}

/** Danh tính ổn định của một tiêu chí. Không chứa snapshot, không chứa vị trí. */
export function criterionIdentity({ sourceId, issueId, statement, upstreamId = '' }) {
  const payload = String(upstreamId).trim()
    ? { basis: 'upstream', issue_id: issueId, source_id: sourceId, upstream_id: identityText(upstreamId) }
    : { basis: 'statement', issue_id: issueId, source_id: sourceId, statement: identityText(statement) };
  return `crit_${digest(D_CRITERION, payload).split(':')[1].slice(0, 32)}`;
}

export function statementHash(statement, mandatory) {
  return digest(D_STATEMENT, { mandatory, statement: identityText(statement) });
}

/**
 * Băm yêu cầu: summary, description và các tiêu chí — **sắp xếp theo id**.
 *
 * Sắp xếp là lý do đảo thứ tự mảng AC không đổi băm. Không chứa status,
 * resolution, progress, assignee, hay bất kỳ mốc thời gian nào, kể cả `updated`
 * của chính Jira: mở ticket lên lưu lại mà không sửa chữ nào thì vẫn là cùng
 * một yêu cầu.
 */
export function requirementHash({ summary, description, criteria }) {
  return digest(D_REQUIREMENT, {
    criteria: criteria
      .map((item) => ({
        criterion_id: item.criterion_id,
        mandatory: item.mandatory,
        statement: item.identity_text,
      }))
      .sort((a, b) => (a.criterion_id < b.criterion_id ? -1 : a.criterion_id > b.criterion_id ? 1 : 0)),
    description: normalizeText(description),
    summary: normalizeText(summary),
  });
}

/**
 * Ticket wire v1 từ một bundle, kèm bản đồ index → criterion_id.
 *
 * `status` để rỗng có chủ ý: status là lời khai của workflow, còn "code có làm
 * việc này không" là câu hỏi về code. Gửi kèm "Done" là mời mô hình đồng ý với
 * ticket, rồi phép kiểm báo rằng ticket đồng ý với chính nó. Trường vẫn còn
 * trên wire — bỏ đi là đổi schema — nhưng rỗng.
 */
export function prepareRequest(bundle, { requestId }) {
  const tickets = [];
  const maps = new Map();
  for (const requirement of bundle.requirements ?? []) {
    const key = String(requirement.issue_key ?? '');
    if (!key) continue;
    const criteria = requirement.criteria ?? [];
    const sentTexts = criteria.map((item) => String(item.exact_text ?? ''));
    tickets.push({
      key,
      summary: String(requirement.summary ?? ''),
      status: '',
      description: String(requirement.description ?? ''),
      acceptance_criteria: sentTexts,
    });
    const indexToCriterion = {};
    criteria.forEach((item, index) => {
      indexToCriterion[String(index + 1)] = String(item.criterion_id ?? '');
    });
    maps.set(key, {
      request_id: requestId,
      bundle_id: String(bundle.manifest?.bundle_id ?? ''),
      issue_key: key,
      issue_id: String(requirement.issue_id ?? ''),
      index_to_criterion: indexToCriterion,
      sent_texts: sentTexts,
      sent_hash: digest(D_STATEMENT, { sent: sentTexts }),
    });
  }
  return { tickets, maps };
}

/**
 * Gắn tên tiêu chí vào từng dòng assessment, hoặc từ chối dòng ấy.
 *
 * Dòng bị từ chối trả về `criterion_id: ''` kèm `mapping_error` chứ không bị bỏ
 * đi: một dòng biến mất thì ở phía dưới đọc thành "tiêu chí này chưa ai đánh
 * giá", mà thật ra là đã có câu trả lời và ta không biết nó nói về cái gì.
 */
export function attachCriteria(rows, criterionMap, { sentTexts } = {}) {
  const expected = criterionMap.sent_texts ?? [];
  if (sentTexts && JSON.stringify(sentTexts) !== JSON.stringify(expected)) {
    return (rows ?? []).map((row) => ({
      ...row,
      criterion_id: '',
      mapping_error: 'Danh sách tiêu chí đã gửi không khớp bản đồ của request này.',
    }));
  }
  return (rows ?? []).map((row) => {
    const id = Number(row?.id);
    const criterionId = Number.isInteger(id)
      ? criterionMap.index_to_criterion?.[String(id)] ?? ''
      : '';
    return criterionId
      ? { ...row, criterion_id: criterionId }
      : {
          ...row,
          criterion_id: '',
          mapping_error: `Assessment id ${row?.id} nằm ngoài ${expected.length} tiêu chí đã gửi.`,
        };
  });
}

/** Đọc một fixture đã sao chép sang repo này. */
export function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'));
}

/** Manifest SHA-256 của bản sao fixture, để kiểm chính bản sao ấy. */
export function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8'));
}
