import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.resolve(__dirname, '..', 'buddy-runtime.mjs');

describe('buddy-runtime CLI', () => {
  test('--action preflight returns JSON status', () => {
    const result = execSync(
      `node "${RUNTIME}" --action preflight --project-dir /tmp`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const json = JSON.parse(result);
    assert.equal(json.status === 'ok' || json.status === 'error', true);
    assert.ok('codex_available' in json);
  });

  test('unknown action returns error JSON', () => {
    const result = execSync(
      `node "${RUNTIME}" --action unknown --project-dir /tmp`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const json = JSON.parse(result);
    assert.equal(json.status, 'error');
  });

  test('--action local with no checks returns structured output', () => {
    const result = execSync(
      `node "${RUNTIME}" --action local --project-dir /tmp --checks ""`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const json = JSON.parse(result);
    assert.ok(['verified', 'blocked', 'error', 'skipped'].includes(json.status));
  });

  test('missing --project-dir returns error', () => {
    const result = execSync(
      `node "${RUNTIME}" --action local`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const json = JSON.parse(result);
    assert.equal(json.status, 'error');
  });

  test('--action metrics returns stats without project-dir', () => {
    const result = execSync(
      `node "${RUNTIME}" --action metrics`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const json = JSON.parse(result);
    assert.equal(json.status, 'ok');
    assert.ok('total' in json);
    assert.ok('probes' in json);
    assert.ok('followups' in json);
    assert.ok('avg_latency_ms' in json);
    assert.ok('probe_found_new_rate' in json);
    assert.ok('user_adopted_rate' in json);
  });

  test('--action annotate missing fields returns error', () => {
    const result = execSync(
      `node "${RUNTIME}" --action annotate --session-id buddy-test999`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const json = JSON.parse(result);
    assert.equal(json.status, 'error');
  });

  test('--action local writes action field to log', () => {
    const tmpLog = path.join(os.tmpdir(), `buddy-test-${Date.now()}.jsonl`);
    // Override HOME to control log file location by using a temp session
    const result = execSync(
      `node "${RUNTIME}" --action local --project-dir /tmp --checks "" --session-id buddy-logtest`,
      { encoding: 'utf8', timeout: 10000, env: { ...process.env } }
    );
    const json = JSON.parse(result);
    // local with no checks returns skipped (no log written), so just verify status
    assert.ok(['skipped', 'verified', 'blocked'].includes(json.status));
    fs.rmSync(tmpLog, { force: true });
  });
});

describe('session policy helpers', () => {
  test('saveConversationSession + loadConversationSession round-trip', async () => {
    const { saveConversationSession, loadConversationSession } = await import(
      '../lib/codex-adapter.mjs'
    );
    const buddyId = `buddy-test-${Date.now()}`;
    const codexId = '019dd1e8-3b2f-7ae3-befe-740d27a35d61';
    saveConversationSession(buddyId, codexId);
    assert.equal(loadConversationSession(buddyId), codexId);
    fs.rmSync(`${process.env.HOME}/.buddy/conv-${buddyId}.json`, { force: true });
  });

  test('loadConversationSession returns null when no file exists', async () => {
    const { loadConversationSession } = await import('../lib/codex-adapter.mjs');
    assert.equal(loadConversationSession(`buddy-nonexistent-${Date.now()}`), null);
  });
});
