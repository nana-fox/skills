import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import path from 'node:path';
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
});
