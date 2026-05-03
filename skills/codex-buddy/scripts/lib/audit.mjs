import fs from 'node:fs';
import path from 'node:path';

// Decision summary stream (~/.buddy/logs.jsonl).
// Pairs with the lifecycle event stream (~/.buddy/sessions/<sid>.jsonl) via
// (buddy_session_id, verification_task_id). See lib/session-log.mjs.
//
// Schema v2 (2026-04-29 → 2026-04-30): unified field names + strict row contract.
// Source of truth: schemas/audit-row-v2.schema.json
//   schema_version=2, ts, buddy_session_id, verification_task_id, workspace,
//   action, plus the bare envelope (turn/level/rule/triggered/route/evidence/conclusion).

export const AUDIT_SCHEMA_VERSION = 2;

// Whitelist of envelope fields that may be persisted; any other field on a
// caller-provided envelope is dropped (CloudEvents/OTel "known attributes
// controlled, extensions explicit"). Aliases like session_id/timestamp are
// silently dropped — the v2 row schema disallows them.
const ENVELOPE_KEYS = Object.freeze([
  'turn', 'level', 'rule', 'triggered', 'route',
  'evidence', 'conclusion', 'confidence', 'unverified',
]);

const ALLOWED_ACTIONS = Object.freeze(['local', 'probe', 'followup']);

function pickEnvelope(envelope) {
  const out = {};
  if (!envelope || typeof envelope !== 'object') return out;
  for (const k of ENVELOPE_KEYS) {
    if (envelope[k] !== undefined) out[k] = envelope[k];
  }
  return out;
}

/**
 * Append one audit-row-v2 to logFile.
 *
 * Options-object signature (stage5d): callers cannot leak unknown / aliased
 * fields into persisted rows. The envelope is filtered to ENVELOPE_KEYS;
 * everything else is dropped silently.
 *
 * @param {string} logFile
 * @param {object} opts
 * @param {object} opts.envelope                 — bare decision envelope (createEnvelope output)
 * @param {string} opts.buddySessionId
 * @param {string} opts.workspace
 * @param {string} opts.action                   — 'local' | 'probe' | 'followup'
 * @param {string} opts.verificationTaskId       — required in v2 (string, never null)
 * @param {number} [opts.latencyMs]
 * @param {string} [opts.message]
 * @param {string} [opts.model]       — 'codex' | 'kimi' (multi-model routing)
 * @param {string} [opts.parseStatus] — 'ok' | 'partial' | 'failed' (Kimi parser status)
 * @param {string} [opts.fallback]    — 'none' | 'raw' (whether synthesis used raw fallback)
 */
export function appendLog(logFile, opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('appendLog: options object required');
  }
  if (process.env.BUDDY_TEST_AUDIT_APPEND_EPERM === '1') {
    const err = new Error('EACCES: permission denied, open logs.jsonl');
    err.code = 'EACCES';
    throw err;
  }
  const { envelope, buddySessionId, workspace, action, verificationTaskId,
          latencyMs, message, model, parseStatus, fallback } = opts;

  if (!buddySessionId)     throw new TypeError('appendLog: buddySessionId required');
  if (!workspace)          throw new TypeError('appendLog: workspace required');
  if (!verificationTaskId) throw new TypeError('appendLog: verificationTaskId required (v2)');
  if (!ALLOWED_ACTIONS.includes(action)) {
    throw new TypeError(`appendLog: action must be one of ${ALLOWED_ACTIONS.join('|')}; got ${action}`);
  }

  const dir = path.dirname(logFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const row = {
    schema_version: AUDIT_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    buddy_session_id: buddySessionId,
    verification_task_id: verificationTaskId,
    workspace,
    action,
    ...pickEnvelope(envelope),
  };
  if (latencyMs !== undefined) row.latency_ms = latencyMs;
  if (message !== undefined && message !== null) row.message = String(message);
  if (model !== undefined) row.model = model;
  if (parseStatus !== undefined) row.parse_status = parseStatus;
  if (fallback !== undefined) row.fallback = fallback;

  fs.appendFileSync(logFile, JSON.stringify(row) + '\n');
}

// Read either new (buddy_session_id) or legacy (session_id) field — the
// existing ~/.buddy/logs.jsonl on user machines holds both v2 rows and pre-v2
// rows; readers must tolerate the union.
function entrySessionId(entry) {
  return entry.buddy_session_id ?? entry.session_id;
}

export function getCallCount(logFile, buddySessionId) {
  if (process.env.BUDDY_TEST_AUDIT_READ_EPERM === '1') {
    const err = new Error('EACCES: permission denied, read logs.jsonl');
    err.code = 'EACCES';
    throw err;
  }
  if (!fs.existsSync(logFile)) return 0;

  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  return lines.reduce((count, line) => {
    let entry;
    try { entry = JSON.parse(line); } catch { return count; }
    if (entrySessionId(entry) === buddySessionId && (entry.route === 'codex' || entry.route === 'both' || entry.route === 'kimi')) {
      return count + 1;
    }
    return count;
  }, 0);
}

export function getCallCount_session(logFile, buddySessionId) {
  return getCallCount(logFile, buddySessionId);
}

// annotateLastEntry was removed in stage5b/v2; annotate via session-log event.
