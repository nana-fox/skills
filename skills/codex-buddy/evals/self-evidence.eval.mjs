#!/usr/bin/env node
/**
 * self-evidence.eval.mjs — best-effort audit of SKILL.md adherence (W2).
 *
 * Scans recent buddy session jsonl files and reports presence/absence of
 * `reply.vlevel-header` / `reply.synthesis` / `reply.narrate-discipline`
 * events relative to probe activity. WARNING-only — never fails CI.
 *
 * Reasoning: Claude may forget to call --action log-reply. We can't enforce
 * mid-turn, but we can flag drift over time so the user/dev can intervene.
 *
 * Usage:
 *   node evals/self-evidence.eval.mjs [--days N] [--buddy-home <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? 'true'] : null).filter(Boolean)
);
const days = parseInt(args.days || '1', 10);
const buddyHome = args['buddy-home'] || process.env.BUDDY_HOME || path.join(process.env.HOME || '/tmp', '.buddy');
const sessionsDir = path.join(buddyHome, 'sessions');

if (!fs.existsSync(sessionsDir)) {
  console.log(`[self-evidence] No sessions dir at ${sessionsDir} — nothing to audit.`);
  process.exit(0);
}

const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
const counters = {
  probe_count: 0,
  reply_vlevel_header: 0,
  reply_synthesis: 0,
  reply_narrate_discipline: 0,
};

for (const f of files) {
  const lines = fs.readFileSync(path.join(sessionsDir, f), 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(e.ts || 0);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    if (e.event === 'probe.codex_output') counters.probe_count++;
    else if (e.event === 'reply.vlevel-header') counters.reply_vlevel_header++;
    else if (e.event === 'reply.synthesis') counters.reply_synthesis++;
    else if (e.event === 'reply.narrate-discipline') counters.reply_narrate_discipline++;
  }
}

const report = {
  window_days: days,
  ...counters,
  coverage_vlevel_header: counters.probe_count ? counters.reply_vlevel_header / counters.probe_count : null,
  coverage_synthesis: counters.probe_count ? counters.reply_synthesis / counters.probe_count : null,
};
console.log(JSON.stringify(report, null, 2));

if (counters.probe_count >= 5 && counters.reply_vlevel_header === 0) {
  console.warn(`[self-evidence] WARNING: ${counters.probe_count} probes in last ${days}d, 0 reply.vlevel-header events — Claude likely forgot to call --action log-reply.`);
}
process.exit(0);
