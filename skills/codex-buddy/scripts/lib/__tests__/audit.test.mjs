import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { appendLog, getCallCount, AUDIT_SCHEMA_VERSION } from '../audit.mjs';

describe('audit', () => {
  let tmpDir;
  let logFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-audit-'));
    logFile = path.join(tmpDir, 'decisions.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('appendLog writes new schema fields (ts, buddy_session_id, schema_version, verification_task_id)', () => {
    const envelope = { turn: 1, level: 'V2', rule: 'floor:correctness', triggered: true, route: 'codex', evidence: ['probe:ok'], conclusion: 'proceed' };
    appendLog(logFile, envelope, 'buddy-001', '/tmp/project', 1234, {
      action: 'probe',
      verification_task_id: 'vtask-abc-123',
    });

    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.buddy_session_id, 'buddy-001', 'must use buddy_session_id, not session_id');
    assert.ok(entry.ts, 'must have ts field');
    assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/, 'ts must be ISO timestamp');
    assert.equal(entry.schema_version, AUDIT_SCHEMA_VERSION, 'must tag schema_version');
    assert.equal(entry.verification_task_id, 'vtask-abc-123', 'must record verification_task_id for cross-stream join');
    assert.equal(entry.workspace, '/tmp/project');
    assert.equal(entry.latency_ms, 1234);
    assert.equal(entry.action, 'probe');

    // Old field names must NOT be written (we cut over cleanly).
    assert.equal(entry.session_id, undefined, 'legacy session_id must not be written');
    assert.equal(entry.timestamp, undefined, 'legacy timestamp must not be written');
  });

  test('appendLog tolerates missing verification_task_id (writes null)', () => {
    appendLog(logFile, { turn: 0, route: 'local', conclusion: 'proceed' }, 'buddy-002', '/tmp', undefined, { action: 'local' });
    const entry = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
    assert.equal(entry.verification_task_id, null, 'missing verification_task_id is null, not undefined');
    assert.equal(entry.buddy_session_id, 'buddy-002');
  });

  test('getCallCount counts codex calls by new field, with fallback to legacy session_id', () => {
    // New schema entries
    appendLog(logFile, { turn: 1, route: 'codex', conclusion: 'proceed' }, 'buddy-001', '/tmp', undefined, { verification_task_id: 'v1' });
    appendLog(logFile, { turn: 2, route: 'local', conclusion: 'proceed' }, 'buddy-001', '/tmp', undefined, { verification_task_id: 'v2' });
    appendLog(logFile, { turn: 3, route: 'codex', conclusion: 'proceed' }, 'buddy-001', '/tmp', undefined, { verification_task_id: 'v3' });

    // Legacy entry (manually crafted to simulate pre-v2 data)
    const legacyEntry = { turn: 4, route: 'codex', session_id: 'buddy-001', timestamp: '2026-01-01T00:00:00Z' };
    fs.appendFileSync(logFile, JSON.stringify(legacyEntry) + '\n');

    assert.equal(getCallCount(logFile, 'buddy-001'), 3, 'counts both new and legacy buddy_session_id');
  });

  test('annotateLastEntry export is removed (use session-log annotate event instead)', async () => {
    const mod = await import('../audit.mjs');
    assert.equal(mod.annotateLastEntry, undefined, 'annotateLastEntry must be removed — append annotate to session-log instead');
  });

  test('appendLog protects canonical v2 fields from caller shadowing (envelope/extra)', () => {
    // Caller tries to overwrite canonical metadata via envelope or extra — must NOT win.
    const malicious = {
      turn: 1, level: 'V2', rule: 'r', triggered: true, route: 'codex', evidence: [], conclusion: 'proceed',
      schema_version: 999,                // shadowing attempt via envelope
      ts: 'fake-ts',
      buddy_session_id: 'wrong-sid',
      verification_task_id: 'wrong-vtask',
      workspace: '/wrong',
    };
    appendLog(logFile, malicious, 'buddy-correct', '/correct', undefined, {
      schema_version: 888,                // shadowing attempt via extra
      ts: 'also-fake',
      buddy_session_id: 'wrong-extra',
      verification_task_id: 'vtask-real',
    });
    const entry = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
    assert.equal(entry.schema_version, AUDIT_SCHEMA_VERSION, 'canonical schema_version must not be overridden');
    assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/, 'canonical ts must not be overridden');
    assert.equal(entry.buddy_session_id, 'buddy-correct', 'canonical buddy_session_id must not be overridden');
    assert.equal(entry.workspace, '/correct', 'canonical workspace must not be overridden');
    // verification_task_id IS allowed via extra (it's a legitimate parameter)
    assert.equal(entry.verification_task_id, 'vtask-real', 'verification_task_id from extra is the canonical input');
  });
});
