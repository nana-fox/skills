#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { getBuddyHome } from './paths.mjs';
import { readSessionEvents } from './session-log.mjs';

function defaultLog() { return path.join(getBuddyHome(), 'logs.jsonl'); }

// Schema v2 uses buddy_session_id; legacy entries use session_id.
function entrySessionId(e) { return e.buddy_session_id ?? e.session_id; }

// Resolve action for legacy entries written before P0 added the action field.
function resolveAction(e) {
  if (e.action) return e.action;
  if (e.route === 'local') return 'local';
  if (e.route === 'codex') return 'probe';
  return null;
}

// For schema v2 entries, annotation lives in the session-log as one or more
// 'annotate' events keyed by (buddy_session_id, verification_task_id).
//
// Multiple partial annotate events for the same task MUST accumulate (e.g.
// `annotate --probe-found-new true` then `annotate --user-adopted true`).
// We merge per field, so later events override earlier values of the SAME
// field but never erase fields they didn't touch.
function buildAnnotationLookup(entries) {
  const sessionIds = new Set(entries.map(entrySessionId).filter(Boolean));
  const byTaskId = new Map();
  const ANNOTATE_FIELDS = ['probe_found_new', 'user_adopted'];
  for (const sid of sessionIds) {
    let events = [];
    try { events = readSessionEvents(sid); } catch { continue; }
    for (const e of events) {
      if (e.event !== 'annotate') continue;
      if (!e.verification_task_id) continue;
      const key = `${sid}::${e.verification_task_id}`;
      const merged = byTaskId.get(key) || {};
      for (const f of ANNOTATE_FIELDS) {
        if (e[f] !== undefined) merged[f] = e[f];
      }
      byTaskId.set(key, merged);
    }
  }
  return byTaskId;
}

// Resolve an annotation field for an entry, preferring session-log when available.
function resolveAnnotation(entry, annotationLookup, field) {
  const sid = entrySessionId(entry);
  if (sid && entry.verification_task_id) {
    const event = annotationLookup.get(`${sid}::${entry.verification_task_id}`);
    if (event && event[field] !== undefined) return event[field];
  }
  // Legacy entries had annotation mutated in-place on the log entry itself.
  if (entry[field] !== undefined) return entry[field];
  return undefined;
}

export function getStats(logFile = defaultLog(), buddySessionId = null) {
  if (!fs.existsSync(logFile)) {
    return { total: 0, probes: 0, followups: 0, locals: 0, avg_latency_ms: null,
             probe_found_new_rate: null, user_adopted_rate: null, followup_triggered_rate: null };
  }

  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  const entries = lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean).filter(e => !buddySessionId || entrySessionId(e) === buddySessionId);

  const annotationLookup = buildAnnotationLookup(entries);

  const probes    = entries.filter(e => resolveAction(e) === 'probe');
  const followups = entries.filter(e => resolveAction(e) === 'followup');
  const locals    = entries.filter(e => resolveAction(e) === 'local');

  const withLatency = entries.filter(e => e.latency_ms !== undefined);
  const avg_latency_ms = withLatency.length
    ? Math.round(withLatency.reduce((s, e) => s + e.latency_ms, 0) / withLatency.length)
    : null;

  function rate(subset, field) {
    const annotated = subset.map(e => resolveAnnotation(e, annotationLookup, field))
                            .filter(v => v !== undefined);
    if (!annotated.length) return null;
    return Math.round(annotated.filter(v => v === true).length / annotated.length * 100);
  }

  return {
    total: entries.length,
    probes: probes.length,
    followups: followups.length,
    locals: locals.length,
    avg_latency_ms,
    probe_found_new_rate: rate(probes, 'probe_found_new'),
    user_adopted_rate:    rate(probes, 'user_adopted'),
    followup_triggered_rate: probes.length
      ? Math.round(followups.length / probes.length * 100)
      : null,
  };
}

// CLI: node metrics.mjs [--log-file path] [--session-id id]
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace('file://', ''))) {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) {
      const key = process.argv[i].slice(2);
      const next = process.argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
    }
  }
  const stats = getStats(args['log-file'] || defaultLog(), args['session-id'] || null);
  process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
}
