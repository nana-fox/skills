import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { appendLog } from '../audit.mjs';
import { appendSessionEvent } from '../session-log.mjs';
import { getStats } from '../metrics.mjs';

describe('metrics', () => {
  let tmpHome;
  let oldHome;
  let logFile;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-metrics-'));
    oldHome = process.env.BUDDY_HOME;
    // session-log writes via getBuddyHome(); BUDDY_HOME env var is the override hook
    process.env.BUDDY_HOME = path.join(tmpHome, '.buddy');
    fs.mkdirSync(process.env.BUDDY_HOME, { recursive: true });
    logFile = path.join(process.env.BUDDY_HOME, 'logs.jsonl');
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env.BUDDY_HOME;
    else process.env.BUDDY_HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // C1 regression test: multiple partial annotate calls must accumulate, not overwrite.
  test('annotate field accumulation across multiple partial annotate events (C1 regression)', () => {
    const sid = 'buddy-c1';
    const vtask = 'vtask-c1-001';

    // One probe in decisions stream
    appendLog(logFile, { turn: 1, level: 'V2', rule: 'r', triggered: true, route: 'codex', evidence: [], conclusion: 'proceed' },
              sid, '/tmp', 1000, { action: 'probe', verification_task_id: vtask });

    // First annotate: only probe_found_new
    appendSessionEvent(sid, vtask, 'annotate', { probe_found_new: true });
    // Second annotate: only user_adopted (separate call, e.g. Claude annotates after user feedback)
    appendSessionEvent(sid, vtask, 'annotate', { user_adopted: true });

    const stats = getStats(logFile, sid);
    assert.equal(stats.probe_found_new_rate, 100,
      'probe_found_new from earlier annotate event must NOT be lost when later partial annotate writes user_adopted');
    assert.equal(stats.user_adopted_rate, 100,
      'user_adopted from later annotate event must be picked up');
  });

  // Last-write-wins applies per-field (re-annotation should overwrite same field, not unrelated fields).
  test('per-field last-wins on re-annotation', () => {
    const sid = 'buddy-c1b';
    const vtask = 'vtask-c1b-001';

    appendLog(logFile, { turn: 1, level: 'V2', rule: 'r', triggered: true, route: 'codex', evidence: [], conclusion: 'proceed' },
              sid, '/tmp', undefined, { action: 'probe', verification_task_id: vtask });

    appendSessionEvent(sid, vtask, 'annotate', { probe_found_new: true });
    appendSessionEvent(sid, vtask, 'annotate', { probe_found_new: false });   // correction
    appendSessionEvent(sid, vtask, 'annotate', { user_adopted: true });

    const stats = getStats(logFile, sid);
    assert.equal(stats.probe_found_new_rate, 0, 'corrected probe_found_new=false must win for that field');
    assert.equal(stats.user_adopted_rate, 100, 'user_adopted from a separate annotate event must still be visible');
  });

  test('legacy entries with in-place annotation still counted', () => {
    // Legacy: pre-v2 entry with mutated probe_found_new field on the log row itself.
    const legacy = { turn: 1, route: 'codex', session_id: 'buddy-legacy', timestamp: '2026-01-01T00:00:00Z',
                     probe_found_new: true, action: 'probe' };
    fs.appendFileSync(logFile, JSON.stringify(legacy) + '\n');

    const stats = getStats(logFile, 'buddy-legacy');
    assert.equal(stats.probe_found_new_rate, 100, 'legacy in-place annotation must still be honored');
  });
});
