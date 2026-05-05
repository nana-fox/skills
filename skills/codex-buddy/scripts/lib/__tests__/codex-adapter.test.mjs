import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildProbeArgs, buildResumeArgs, buildProbeCommand, buildResumeCommand,
  parseSessionId, checkCodexAvailable, classifyCodexExecError, execCodex,
} from '../codex-adapter.mjs';

describe('codex-adapter', () => {
  // Primary API: safe args arrays (no shell interpretation)
  test('buildProbeArgs returns correct args array', () => {
    const { bin, args } = buildProbeArgs({
      projectDir: '/tmp/myproject',
      outputFile: '/tmp/output.txt',
      prompt: 'Is this migration safe?',
    });

    assert.equal(bin, 'codex');
    assert.ok(args.includes('exec'));
    assert.ok(args.includes('-C'));
    assert.ok(args.includes('/tmp/myproject'));
    assert.ok(args.includes('-s'));
    assert.ok(args.includes('read-only'));
    assert.ok(args.includes('--skip-git-repo-check'));
    assert.ok(args.includes('-o'));
    assert.ok(args.includes('/tmp/output.txt'));
    assert.ok(args.includes('Is this migration safe?'));
    assert.ok(!args.includes('--model'));
  });

  test('buildProbeArgs includes --json when requested', () => {
    const { args } = buildProbeArgs({
      projectDir: '/tmp/p',
      outputFile: '/tmp/o.txt',
      prompt: 'test',
      json: true,
    });
    assert.ok(args.includes('--json'));
  });

  test('buildProbeArgs includes --output-schema when provided', () => {
    const { args } = buildProbeArgs({
      projectDir: '/tmp/p',
      outputFile: '/tmp/o.txt',
      prompt: 'test',
      outputSchema: '/tmp/schema.json',
    });
    assert.ok(args.includes('--output-schema'));
    assert.ok(args.includes('/tmp/schema.json'));
  });

  test('buildResumeArgs uses session ID', () => {
    const { bin, args } = buildResumeArgs({
      sessionId: '019d-abc-123',
      outputFile: '/tmp/followup.txt',
      prompt: 'Follow up question',
    });
    assert.equal(bin, 'codex');
    assert.ok(args.includes('resume'));
    assert.ok(args.includes('019d-abc-123'));
    assert.ok(args.includes('-o'));
    assert.ok(args.includes('/tmp/followup.txt'));
    assert.ok(args.includes('Follow up question'));
  });

  // Display string builders (backwards compat)
  test('buildProbeCommand returns display string', () => {
    const cmd = buildProbeCommand({
      projectDir: '/tmp/p',
      outputFile: '/tmp/o.txt',
      prompt: 'test prompt',
    });
    assert.ok(typeof cmd === 'string');
    assert.ok(cmd.includes('codex'));
    assert.ok(cmd.includes('exec'));
  });

  test('buildResumeCommand returns display string', () => {
    const cmd = buildResumeCommand({
      sessionId: '019d-abc',
      outputFile: '/tmp/o.txt',
      prompt: 'followup',
    });
    assert.ok(typeof cmd === 'string');
    assert.ok(cmd.includes('resume'));
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

  test('classifyCodexExecError detects sandbox approval blockers', () => {
    const err = classifyCodexExecError(new Error('approval required: command needs user confirmation'));
    assert.equal(err.kind, 'approval-required');
    assert.equal(err.recoverable, true);
    assert.match(err.message, /less invasive/);
  });

  test('classifyCodexExecError detects sandbox permission blockers', () => {
    const err = classifyCodexExecError(new Error('sandbox denied: EPERM operation not permitted'));
    assert.equal(err.kind, 'sandbox-permission');
    assert.equal(err.recoverable, true);
    assert.match(err.message, /read-only/);
  });

  test('execCodex sends SIGKILL if process ignores SIGTERM', async () => {
    const pidFile = path.join(os.tmpdir(), `buddy-test-sigkill-pid-${Date.now()}.txt`);
    const fakeScript = path.join(os.tmpdir(), `buddy-test-sigkill-${Date.now()}.mjs`);
    fs.writeFileSync(fakeScript, `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', () => {}); // ignore SIGTERM
setInterval(() => {}, 1_000_000);
`);

    try {
      await assert.rejects(
        () => execCodex({ bin: 'node', args: [fakeScript] }, { timeout: 100, sigkillDelayMs: 150 }),
        /watchdog timeout/,
      );

      // Wait past sigkillDelayMs — process must be dead (SIGKILL sent)
      await new Promise((r) => setTimeout(r, 300));

      const pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      assert.equal(alive, false, `Process ${pid} should be dead after SIGKILL escalation`);
    } finally {
      fs.rmSync(fakeScript, { force: true });
      fs.rmSync(pidFile, { force: true });
    }
  });
});
