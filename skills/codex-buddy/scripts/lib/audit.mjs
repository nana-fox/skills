import fs from 'node:fs';
import path from 'node:path';

// Decision summary stream (~/.buddy/decisions.jsonl by convention).
// Pairs with the lifecycle event stream (~/.buddy/sessions/<sid>.jsonl) via
// (buddy_session_id, verification_task_id). See lib/session-log.mjs.
//
// Schema v2 (2026-04-29): unified field names with session-log
//   ts                   ISO timestamp (was: timestamp)
//   buddy_session_id     buddy session id (was: session_id)
//   verification_task_id key into session-log; null for entries with no probe lifecycle
//   schema_version       2 (absent on legacy entries; readers fall back)

export const AUDIT_SCHEMA_VERSION = 2;

export function appendLog(logFile, envelope, buddySessionId, workspace, latencyMs, extra = {}) {
  const dir = path.dirname(logFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const { verification_task_id = null, ...restExtra } = extra;
  // Caller-provided objects come first; canonical metadata is written LAST so
  // it cannot be silently shadowed by a malformed envelope/extra. The only
  // caller-controlled canonical input is verification_task_id (legitimate
  // parameter via `extra`), which we extract above.
  const entry = {
    ...envelope,
    ...restExtra,
    schema_version: AUDIT_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    buddy_session_id: buddySessionId,
    verification_task_id,
    workspace,
  };
  if (latencyMs !== undefined) {
    entry.latency_ms = latencyMs;
  }

  fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
}

// Read either new (buddy_session_id) or legacy (session_id) field.
function entrySessionId(entry) {
  return entry.buddy_session_id ?? entry.session_id;
}

export function getCallCount(logFile, buddySessionId) {
  if (!fs.existsSync(logFile)) return 0;

  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  return lines.reduce((count, line) => {
    let entry;
    try { entry = JSON.parse(line); } catch { return count; }
    if (entrySessionId(entry) === buddySessionId && (entry.route === 'codex' || entry.route === 'both')) {
      return count + 1;
    }
    return count;
  }, 0);
}

export function getCallCount_session(logFile, buddySessionId) {
  return getCallCount(logFile, buddySessionId);
}

// Note: annotateLastEntry was removed in schema v2.
// JSONL is append-only; mutating the last entry breaks that contract and
// races on concurrent writes. Annotation now goes to the session-log as a
// dedicated event: appendSessionEvent(sid, vtask, 'annotate', fields).
// Readers (metrics.mjs) join session-log annotate events back to decisions.
