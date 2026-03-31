import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildProbeCommand, buildResumeCommand, parseSessionId, checkCodexAvailable } from '../codex-adapter.mjs';

describe('codex-adapter', () => {
  test('buildProbeCommand generates correct exec command', () => {
    const cmd = buildProbeCommand({
      projectDir: '/tmp/myproject',
      outputFile: '/tmp/output.txt',
      prompt: 'Is this migration safe?',
    });

    assert.ok(cmd.includes('codex exec'));
    assert.ok(cmd.includes('-C "/tmp/myproject"'));
    assert.ok(cmd.includes('-s read-only'));
    assert.ok(cmd.includes('--skip-git-repo-check'));
    assert.ok(cmd.includes('-o "/tmp/output.txt"'));
    assert.ok(cmd.includes('Is this migration safe?'));
    assert.ok(!cmd.includes('--model'));
  });

  test('buildProbeCommand includes --json when requested', () => {
    const cmd = buildProbeCommand({
      projectDir: '/tmp/p',
      outputFile: '/tmp/o.txt',
      prompt: 'test',
      json: true,
    });

    assert.ok(cmd.includes('--json'));
  });

  test('buildProbeCommand includes --output-schema when provided', () => {
    const cmd = buildProbeCommand({
      projectDir: '/tmp/p',
      outputFile: '/tmp/o.txt',
      prompt: 'test',
      outputSchema: '/tmp/schema.json',
    });

    assert.ok(cmd.includes('--output-schema "/tmp/schema.json"'));
  });

  test('buildResumeCommand uses session ID', () => {
    const cmd = buildResumeCommand({
      sessionId: '019d-abc-123',
      outputFile: '/tmp/followup.txt',
      prompt: 'Follow up question',
    });

    assert.ok(cmd.includes('exec resume "019d-abc-123"'));
    assert.ok(cmd.includes('-o "/tmp/followup.txt"'));
    assert.ok(cmd.includes('Follow up question'));
  });

  test('parseSessionId extracts ID from codex output', () => {
    const output = `some preamble
session id: 019d318f-abcd-7890-1234-567890abcdef
some other stuff`;
    const id = parseSessionId(output);
    assert.equal(id, '019d318f-abcd-7890-1234-567890abcdef');
  });

  test('parseSessionId returns null for no match', () => {
    assert.equal(parseSessionId('no session here'), null);
  });

  test('checkCodexAvailable returns boolean', () => {
    const available = checkCodexAvailable();
    assert.equal(typeof available, 'boolean');
  });
});
