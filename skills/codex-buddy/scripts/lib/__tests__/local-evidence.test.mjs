import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectEvidence } from '../local-evidence.mjs';

describe('local-evidence', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-evidence-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('file existence check — file exists', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test.js'), 'console.log("hi")');
    const result = await collectEvidence(tmpDir, { checks: ['file-exists:test.js'] });
    assert.ok(result.evidence.some(e => e.includes('exists')));
    assert.equal(result.ok, true);
  });

  test('file existence check — file missing', async () => {
    const result = await collectEvidence(tmpDir, { checks: ['file-exists:missing.js'] });
    assert.ok(result.evidence.some(e => e.includes('missing') || e.includes('not found')));
    assert.equal(result.ok, false);
  });

  test('grep check finds matches', async () => {
    fs.writeFileSync(path.join(tmpDir, 'app.js'), 'function hello() { return "world"; }');
    const result = await collectEvidence(tmpDir, { checks: ['grep:hello:app.js'] });
    assert.ok(result.evidence.some(e => e.includes('grep')));
    assert.equal(result.ok, true);
  });

  test('returns structured result', async () => {
    const result = await collectEvidence(tmpDir, { checks: [] });
    assert.ok(Array.isArray(result.evidence));
    assert.ok(typeof result.ok === 'boolean');
  });
});
