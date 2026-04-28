/**
 * session-log.mjs — append-only event log for buddy verification tasks.
 *
 * Path: ~/.buddy/sessions/<buddy-session-id>.jsonl
 * Each line is a JSON event, keyed by buddy_session_id and verification_task_id.
 *
 * Event types:
 *   probe.start         — evidence sent to Codex
 *   probe.codex_output  — Codex returned (raw output, parsed verdict if structured)
 *   probe.synthesis     — Claude wrote synthesis (logged via --action log-event)
 *   annotate            — probe_found_new / user_adopted recorded
 *
 * Field semantics:
 *   payload_sha256       — sha256 of original payload (pre-redaction)
 *   payload_bytes        — byte length of original payload
 *   payload              — redacted payload (or raw if BUDDY_AUDIT_RAW=1)
 *   redaction_policy     — version string; 'raw' when BUDDY_AUDIT_RAW=1
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redact, shouldWriteRaw, REDACTION_POLICY_VERSION } from './redact.mjs';
import { getBuddyHome } from './paths.mjs';

const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KiB per event; larger goes to payload_ref

function sessionDir() {
  return path.join(getBuddyHome(), 'sessions');
}

function sessionFile(buddySessionId) {
  return path.join(sessionDir(), `${buddySessionId}.jsonl`);
}

function ensureDir() {
  const dir = sessionDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function payloadRefDir(buddySessionId) {
  const dir = path.join(sessionDir(), `${buddySessionId}.payloads`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function buildPayloadFields(buddySessionId, raw) {
  if (raw == null) {
    return { payload: null, payload_sha256: null, payload_bytes: 0, redaction_policy: null };
  }
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const bytes = Buffer.byteLength(text, 'utf8');
  const sha256 = crypto.createHash('sha256').update(text).digest('hex');
  const useRaw = shouldWriteRaw();
  const stored = useRaw ? text : redact(text);

  if (bytes > MAX_PAYLOAD_BYTES) {
    const refFile = path.join(payloadRefDir(buddySessionId), `${sha256}.txt`);
    if (!fs.existsSync(refFile)) fs.writeFileSync(refFile, stored, 'utf8');
    return {
      payload: null,
      payload_ref: refFile,
      payload_sha256: sha256,
      payload_bytes: bytes,
      redaction_policy: useRaw ? 'raw' : REDACTION_POLICY_VERSION,
    };
  }
  return {
    payload: stored,
    payload_sha256: sha256,
    payload_bytes: bytes,
    redaction_policy: useRaw ? 'raw' : REDACTION_POLICY_VERSION,
  };
}

/**
 * Append an event to the buddy session log.
 *
 * @param {string} buddySessionId
 * @param {string} verificationTaskId — groups stages of one verification (probe.start + probe.codex_output ...)
 * @param {string} event              — event type (probe.start / probe.codex_output / ...)
 * @param {object} fields             — event-specific fields (excluding payload helpers)
 * @param {string|object|null} rawPayload — large blob; will be redacted unless BUDDY_AUDIT_RAW=1
 */
export function appendSessionEvent(buddySessionId, verificationTaskId, event, fields = {}, rawPayload = null) {
  ensureDir();
  const file = sessionFile(buddySessionId);
  const payloadFields = buildPayloadFields(buddySessionId, rawPayload);
  const entry = {
    ts: new Date().toISOString(),
    event,
    buddy_session_id: buddySessionId,
    verification_task_id: verificationTaskId,
    ...fields,
    ...payloadFields,
  };
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

/**
 * Read all events for a buddy session (for replay / inspection).
 */
export function readSessionEvents(buddySessionId) {
  const file = sessionFile(buddySessionId);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

export function newVerificationTaskId() {
  return `vtask-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}
