import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  FIXTURE_DIR,
  attachCriteria,
  canonicalJson,
  criterionIdentity,
  identityText,
  normalizeText,
  prepareRequest,
  readFixture,
  readManifest,
  requirementHash,
  statementHash,
} from '../lib/consistency.mjs';
import { parseJsonTickets } from '../lib/tickets.mjs';
import { normalizeAssessment, notAssessed } from '../lib/assessment.mjs';
import { keepRealEvidence } from '../lib/analyze.mjs';

const options = { exclude_globs: [], max_files_per_ticket: 5 };

test('bản sao fixture đúng là bản hợp đồng nó khai, không phải file ai đó sửa tay', () => {
  const manifest = readManifest();
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.canonical_form, 'cjson/1');
  for (const [name, entry] of Object.entries(manifest.files)) {
    const raw = fs.readFileSync(path.join(FIXTURE_DIR, name));
    assert.equal(
      `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`,
      entry.sha256,
      `${name} lệch khỏi SHA-256 trong manifest`,
    );
  }
});

test('Node tính lại được đúng danh tính và băm mà AstraQA đã ghi', () => {
  // Đây là phép kiểm quan trọng nhất của cả file: nếu quy tắc chuẩn hoá của hai
  // bên trôi khỏi nhau dù chỉ một khoảng trắng, hai bên sẽ gọi cùng một câu
  // bằng hai cái tên khác nhau, và mọi verdict lưu theo tên ấy sẽ mồ côi.
  const bundle = readFixture('jira-5-docs-10-code-10');
  const { manifest, requirements } = bundle;
  for (const requirement of requirements) {
    for (const criterion of requirement.criteria) {
      assert.equal(
        criterionIdentity({
          sourceId: manifest.source_id,
          issueId: requirement.issue_id,
          statement: criterion.identity_text,
          upstreamId: criterion.upstream_id,
        }),
        criterion.criterion_id,
      );
      assert.equal(
        statementHash(criterion.identity_text, criterion.mandatory),
        criterion.statement_hash,
      );
      assert.equal(identityText(criterion.exact_text), criterion.identity_text);
      assert.equal(normalizeText(criterion.exact_text), criterion.exact_text);
    }
    assert.equal(requirementHash(requirement), requirement.requirement_hash);
  }
});

test('cjson/1: khoá sắp xếp, không khoảng trắng thừa, chữ không ASCII để nguyên', () => {
  assert.equal(canonicalJson({ b: 1, a: 'khóa' }), '{"a":"khóa","b":1}');
  assert.equal(canonicalJson(['a', { z: true, y: null }]), '["a",{"y":null,"z":true}]');
  // NFC: "ó" dựng sẵn và "ó" tổ hợp phải ra cùng một chuỗi.
  assert.equal(canonicalJson('khóa'), canonicalJson('khóa'));
  assert.throws(() => canonicalJson({ ratio: 0.5 }), /số thực/);
});

test('đảo thứ tự AC: danh tính giữ nguyên, chỉ vị trí trên wire đổi', () => {
  const base = readFixture('jira-5-docs-10-code-10');
  const moved = readFixture('reorder-ac');
  const ids = (b) => b.requirements[0].criteria.map((c) => c.criterion_id);

  assert.deepEqual([...ids(moved)].sort(), [...ids(base)].sort());
  assert.notDeepEqual(ids(moved), ids(base), 'thứ tự trên wire phải đổi');
  assert.equal(moved.requirements[0].requirement_hash, base.requirements[0].requirement_hash);

  // Và bản đồ phải đi theo mảng, không đi theo danh tính.
  const { maps } = prepareRequest(moved, { requestId: 'req-1' });
  const map = maps.get('FNS-1');
  assert.equal(map.index_to_criterion['1'], ids(moved)[0]);
  assert.equal(map.index_to_criterion['2'], ids(moved)[1]);
});

test('sửa "5" thành "10" là tiêu chí mới, không phải cùng tiêu chí đổi chữ', () => {
  const base = readFixture('jira-5-docs-10-code-10');
  const edited = readFixture('ac-5-to-10');
  const [beforeLock, beforeReset] = base.requirements[0].criteria;
  const [afterLock, afterReset] = edited.requirements[0].criteria;

  assert.notEqual(afterLock.criterion_id, beforeLock.criterion_id);
  assert.equal(afterReset.criterion_id, beforeReset.criterion_id, 'AC không đụng tới phải giữ id');
  assert.notEqual(
    edited.requirements[0].requirement_hash,
    base.requirements[0].requirement_hash,
  );
});

test('status đổi một mình: yêu cầu, tiêu chí và băm của chúng không nhúc nhích', () => {
  const base = readFixture('jira-5-docs-10-code-10');
  const moved = readFixture('status-change-only');
  assert.equal(moved.requirements[0].requirement_hash, base.requirements[0].requirement_hash);
  assert.deepEqual(
    moved.requirements[0].criteria.map((c) => c.criterion_id),
    base.requirements[0].criteria.map((c) => c.criterion_id),
  );
  assert.notEqual(
    moved.requirements[0].status.status_hash,
    base.requirements[0].status.status_hash,
  );
  assert.notEqual(moved.manifest.input_hash, base.manifest.input_hash);
});

test('payload semantic đi ra với status rỗng, và wire v1 vẫn nhận nguyên như cũ', () => {
  const bundle = readFixture('status-change-only');
  const { tickets } = prepareRequest(bundle, { requestId: 'req-2' });

  assert.equal(bundle.requirements[0].status.normalized, 'in_progress');
  assert.equal(tickets[0].status, '', 'status không được đi kèm câu hỏi về code');
  assert.ok(tickets[0].acceptance_criteria.every((c) => typeof c === 'string'));

  // Và cái parser đang chạy hôm nay nhận nó, không đổi một dòng nào của tickets.mjs.
  const parsed = parseJsonTickets(tickets);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].key, 'FNS-1');
  assert.deepEqual(parsed[0].acceptance_criteria, tickets[0].acceptance_criteria);
});

test('trả lời theo index được gắn đúng tiêu chí, và dòng lạc thì bị từ chối chứ không bị bỏ', async () => {
  const bundle = readFixture('reorder-ac');
  const { tickets, maps } = prepareRequest(bundle, { requestId: 'req-3' });
  const map = maps.get('FNS-1');

  const assessment = await normalizeAssessment({
    raw: [
      { id: 1, status: 'unknown', evidence: [] },
      { id: 2, status: 'unknown', evidence: [] },
      { id: 7, status: 'satisfied', evidence: [] },
    ],
    ticket: parseJsonTickets(tickets)[0],
    repoDir: FIXTURE_DIR,
    options,
    validateEvidence: keepRealEvidence,
  });

  const named = attachCriteria(assessment.criteria, map);
  assert.equal(named[0].criterion_id, bundle.requirements[0].criteria[0].criterion_id);
  assert.equal(named[1].criterion_id, bundle.requirements[0].criteria[1].criterion_id);
  // `normalizeAssessment` đã bỏ id 7 (ngoài phạm vi) trước khi tới đây; điều
  // được canh ở đây là phép ánh xạ không tự bịa ra tiêu chí cho một id lạ.
  const stray = attachCriteria([{ id: 7, status: 'satisfied' }], map);
  assert.equal(stray[0].criterion_id, '');
  assert.match(stray[0].mapping_error, /ngoài 2 tiêu chí/);
});

test('bản đồ của request khác thì không dùng lại được', () => {
  const bundle = readFixture('jira-5-docs-10-code-10');
  const { maps } = prepareRequest(bundle, { requestId: 'req-4' });
  const map = maps.get('FNS-1');
  const rows = [{ id: 1, status: 'satisfied' }];

  assert.equal(attachCriteria(rows, map, { sentTexts: map.sent_texts })[0].criterion_id,
    bundle.requirements[0].criteria[0].criterion_id);
  const drifted = attachCriteria(rows, map, { sentTexts: ['một câu khác hẳn'] });
  assert.equal(drifted[0].criterion_id, '');
  assert.match(drifted[0].mapping_error, /không khớp bản đồ/);
});

test('hai AC trùng chữ vẫn phân biệt được trên wire, và AC rỗng thì không có mặt', () => {
  const bundle = readFixture('duplicate-and-empty-ac');
  const criteria = bundle.requirements[0].criteria;
  const ids = criteria.map((c) => c.criterion_id);

  assert.equal(new Set(ids).size, ids.length, 'id phải phân biệt được');
  assert.equal(criteria.filter((c) => c.ambiguous).length, 2);
  assert.ok(criteria.every((c) => c.exact_text.trim().length > 0), 'AC rỗng phải bị loại');
  assert.ok(
    bundle.input_issues.some((i) => i.code === 'ambiguous_duplicate_criteria'),
    'trùng lặp phải được nói ra chứ không tự gộp',
  );
  assert.ok(bundle.input_issues.some((i) => i.code === 'empty_criterion'));

  const { maps } = prepareRequest(bundle, { requestId: 'req-5' });
  assert.deepEqual(Object.values(maps.get('FNS-1').index_to_criterion), ids);
});

test('ticket không có AC nào vẫn được gửi đi, để "chưa có AC" không thành "không được kiểm"', () => {
  const bundle = readFixture('jira-5-docs-10-code-10');
  const stripped = {
    ...bundle,
    requirements: [{ ...bundle.requirements[0], criteria: [] }],
  };
  const { tickets, maps } = prepareRequest(stripped, { requestId: 'req-6' });
  assert.equal(tickets.length, 1);
  assert.deepEqual(tickets[0].acceptance_criteria, []);
  assert.deepEqual(maps.get('FNS-1').index_to_criterion, {});
  assert.equal(notAssessed(tickets[0]).state, 'not_assessed');
});

test('bundle không mang bí mật, và không mang status/progress vào phần ngữ nghĩa', () => {
  const banned = /"(token|api_token|access_token|repo_token|password|secret|authorization|credential|ciphertext|progress|assignee)"\s*:/;
  for (const name of Object.keys(readManifest().files)) {
    const raw = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
    assert.equal(banned.test(raw), false, `${name} mang trường không được phép`);
  }
  const bundle = readFixture('jira-5-docs-10-code-10');
  const { tickets } = prepareRequest(bundle, { requestId: 'req-7' });
  assert.equal(JSON.stringify(tickets).includes('normalized_status'), false);
});
