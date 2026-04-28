#!/usr/bin/env node
/**
 * buddy-bench.mjs — latency benchmark for codex probes.
 *
 * Default mode: reads ~/.buddy/sessions/*.jsonl, groups probe.codex_output
 * events by runtime, outputs p50/p95/avg/n + first_byte_ms breakdown.
 *
 * broker-startup-delta mode (W9 acceptance):
 *   For each buddy session: compare the FIRST broker probe (fresh app-server
 *   spawn) vs subsequent probes (warm reuse). Reports median delta.
 *   Acceptance gate: median(reuse) - median(first) ≥ -5000ms
 *   (reuse should be ≥5s faster than first).
 *
 * Usage:
 *   node scripts/buddy-bench.mjs [--days N]
 *   node scripts/buddy-bench.mjs --mode broker-startup-delta [--days N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { getBuddyHome } from './lib/paths.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? 'true'] : null).filter(Boolean)
);
const days = parseInt(args.days || '30', 10);
const mode = args.mode || 'default';
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

const sessionsDir = path.join(getBuddyHome(), 'sessions');
if (!fs.existsSync(sessionsDir)) {
  console.error(`No sessions dir at ${sessionsDir}`);
  process.exit(1);
}

const byRuntime = new Map();
for (const f of fs.readdirSync(sessionsDir).filter(x => x.endsWith('.jsonl'))) {
  const lines = fs.readFileSync(path.join(sessionsDir, f), 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.event !== 'probe.codex_output') continue;
    const ts = Date.parse(e.ts || 0);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const rt = e.runtime || 'unknown';
    if (!byRuntime.has(rt)) byRuntime.set(rt, []);
    byRuntime.get(rt).push({
      latency_ms: e.latency_ms || 0,
      first_byte_ms: e.first_byte_ms ?? null,
      payload_bytes: e.payload_bytes || 0,
    });
  }
}

function pct(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100));
  return sorted[idx];
}
function avg(arr) { return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null; }

const report = { window_days: days, runtimes: {} };
for (const [rt, samples] of byRuntime) {
  const lat = samples.map(s => s.latency_ms);
  const fb = samples.map(s => s.first_byte_ms).filter(x => x != null);
  const startupPct = fb.length && pct(lat, 50)
    ? Math.round(100 * pct(fb, 50) / pct(lat, 50))
    : null;
  report.runtimes[rt] = {
    n: samples.length,
    latency_p50_ms: pct(lat, 50),
    latency_p95_ms: pct(lat, 95),
    latency_avg_ms: avg(lat),
    first_byte_p50_ms: fb.length ? pct(fb, 50) : null,
    first_byte_samples: fb.length,
    startup_pct_p50: startupPct,
    payload_bytes_avg: avg(samples.map(s => s.payload_bytes)),
  };
}

console.log(JSON.stringify(report, null, 2));

const decisions = [];
for (const [rt, m] of Object.entries(report.runtimes)) {
  if (m.first_byte_samples < 5) {
    decisions.push(`${rt}: not enough first_byte samples (${m.first_byte_samples} < 5) — collect more probes before deciding W4b`);
  } else if (m.startup_pct_p50 != null && m.startup_pct_p50 > 30) {
    decisions.push(`${rt}: startup_pct=${m.startup_pct_p50}% > 30% — W4b broker likely yields real latency win`);
  } else if (m.startup_pct_p50 != null) {
    decisions.push(`${rt}: startup_pct=${m.startup_pct_p50}% ≤ 30% — model inference dominates; skip W4b broker, focus on input compression / progress UX`);
  }
}
if (decisions.length) console.error('\n--- Decision hints ---\n' + decisions.join('\n'));

// ─── broker-startup-delta mode ───────────────────────────────────────────────
if (mode === 'broker-startup-delta') {
  // Group broker probes by buddy_session_id, ordered by ts.
  const bySession = new Map();
  for (const f of fs.readdirSync(sessionsDir).filter(x => x.endsWith('.jsonl'))) {
    const sid = f.replace('.jsonl', '');
    const lines = fs.readFileSync(path.join(sessionsDir, f), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.event !== 'probe.codex_output' || e.runtime !== 'broker') continue;
      const ts = Date.parse(e.ts || 0);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      if (!bySession.has(sid)) bySession.set(sid, []);
      bySession.get(sid).push({ ts, latency_ms: e.latency_ms || 0 });
    }
  }

  const firstLatencies = [];
  const reuseLatencies = [];
  for (const probes of bySession.values()) {
    if (probes.length < 2) continue;
    probes.sort((a, b) => a.ts - b.ts);
    firstLatencies.push(probes[0].latency_ms);
    for (const p of probes.slice(1)) reuseLatencies.push(p.latency_ms);
  }

  const medFirst = pct(firstLatencies, 50);
  const medReuse = pct(reuseLatencies, 50);
  const delta = medFirst != null && medReuse != null ? medReuse - medFirst : null;

  const result = {
    mode: 'broker-startup-delta',
    sessions_with_reuse: bySession.size,
    first_probe_n: firstLatencies.length,
    reuse_probe_n: reuseLatencies.length,
    first_probe_median_ms: medFirst,
    reuse_probe_median_ms: medReuse,
    delta_ms: delta,
    acceptance_gate_ms: -5000,
    acceptance: delta != null ? (delta <= -5000 ? 'PASS' : 'FAIL') : 'INSUFFICIENT_DATA',
    note: delta == null ? 'Need ≥2 broker probes in at least one buddy session.' : null,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.acceptance === 'FAIL' ? 1 : 0);
}
