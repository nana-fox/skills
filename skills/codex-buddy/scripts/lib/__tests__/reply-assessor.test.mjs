import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { assessReply } from '../reply-assessor.mjs';

describe('reply assessor', () => {
  test('fails when a V-level header is required but missing', () => {
    const result = assessReply({
      prompt: '这个改动安全吗？',
      reply: '我觉得可以继续。',
      assertions: { vlevel_required: true },
    });

    assert.equal(result.status, 'failed');
    assert.deepEqual(result.violations.map(v => v.code), ['missing-vlevel-header']);
  });

  test('fails when the V-level header is not the first line', () => {
    const result = assessReply({
      prompt: '这个方案怎么选？',
      reply: '先说结论。\nV2[METHOD] | delayed protocol header.',
      assertions: { vlevel_required: true },
    });

    assert.equal(result.status, 'failed');
    assert.deepEqual(result.violations.map(v => v.code), ['missing-vlevel-header']);
  });

  test('fails V2 replies that should probe but do not mention probe evidence', () => {
    const result = assessReply({
      prompt: '这个架构方案怎么选？',
      reply: 'V2[METHOD] | 这是路径选择。\n建议走 A。',
      assertions: { must_probe: true },
    });

    assert.equal(result.status, 'failed');
    assert.ok(result.violations.some(v => v.code === 'missing-probe'));
  });

  test('passes a low-intrusion sandbox recovery reply', () => {
    const result = assessReply({
      prompt: 'Codex probe 因为 sandbox 需要授权卡住了，怎么继续？',
      reply: [
        'V2[METHOD] | sandbox recovery affects execution flow.',
        '先改用 file-first evidence 和 local evidence，缩小到 read-only 证据包。',
        '只有用户请求的验证确实需要写入或联网时，才一次性说明并请求授权。',
      ].join('\n'),
      assertions: {
        vlevel_required: true,
        must_use_file_first: true,
        must_not_request_approval_first: true,
      },
    });

    assert.equal(result.status, 'ok');
    assert.deepEqual(result.violations, []);
  });
});
