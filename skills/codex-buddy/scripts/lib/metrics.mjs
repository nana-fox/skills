#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { getBuddyHome } from './paths.mjs';

function defaultLog() { return path.join(getBuddyHome(), 'logs.jsonl'); }

export function getStats(logFile = defaultLog(), sessionId = null) {
  if (!fs.existsSync(logFile)) {
    return { total: 0, probes: 0, followups: 0, locals: 0, avg_latency_ms: null,
             probe_found_new_rate: null, user_adopted_rate: null, followup_triggered_rate: null };
  }

  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  const entries = lines.map(l => JSON.parse(l))
    .filter(e => !sessionId || e.session_id === sessionId);

  // Infer action from route for legacy entries written before P0 added the action field.
  function resolveAction(e) {
    if (e.action) return e.action;
    if (e.route === 'local') return 'local';
    if (e.route === 'codex') return 'probe'; // pre-P0 codex calls were all probes
    return null;
  }

  const probes    = entries.filter(e => resolveAction(e) === 'probe');
  const followups = entries.filter(e => resolveAction(e) === 'followup');
  const locals    = entries.filter(e => resolveAction(e) === 'local');

  const withLatency = entries.filter(e => e.latency_ms !== undefined);
  const avg_latency_ms = withLatency.length
    ? Math.round(withLatency.reduce((s, e) => s + e.latency_ms, 0) / withLatency.length)
    : null;

  function rate(subset, field) {
    const annotated = subset.filter(e => e[field] !== undefined);
    if (!annotated.length) return null;
    return Math.round(annotated.filter(e => e[field] === true).length / annotated.length * 100);
  }

  return {
    total: entries.length,
    probes: probes.length,
    followups: followups.length,
    locals: locals.length,
    avg_latency_ms,
    probe_found_new_rate: rate(probes, 'probe_found_new'),   // % probes where Codex found something new
    user_adopted_rate:    rate(probes, 'user_adopted'),       // % probes where user adopted suggestion
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
