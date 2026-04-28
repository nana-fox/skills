#!/usr/bin/env node

/**
 * buddy-runtime.mjs — Verification Runtime Entry Point
 *
 * Usage:
 *   node buddy-runtime.mjs --action <action> --project-dir <dir> [options]
 *
 * Actions:
 *   preflight  — Check codex CLI availability, return JSON status
 *   local      — Run local evidence checks only (grep/test/lint)
 *   probe      — New Codex verification (reads evidence file, calls codex exec)
 *   followup   — Resume last Codex session with follow-up
 *
 * Options:
 *   --evidence <file>   — Path to evidence file (probe/followup)
 *   --checks <list>     — Comma-separated check list (local action)
 *   --rule <rule>       — Rule that triggered this route
 *   --level <level>     — V-level (V0-V3)
 *   --turn <n>          — Conversation turn number
 *   --session-id <id>   — Buddy session ID (reuse for budget tracking)
 */

import {
  checkCodexAvailable, buildProbeArgs, buildResumeArgs, execCodex,
  parseSessionId, saveSession, loadSession,
  saveBuddySession, loadBuddySession,
} from './lib/codex-adapter.mjs';
import { collectEvidence } from './lib/local-evidence.mjs';
import { createEnvelope } from './lib/envelope.mjs';
import { appendLog, getCallCount, annotateLastEntry } from './lib/audit.mjs';
import { getStats } from './lib/metrics.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(process.env.HOME || '/tmp', '.buddy', 'logs.jsonl');
const CODEX_OUTPUT_SCHEMA = path.join(__dirname, '..', 'schemas', 'codex-output.schema.json');

// Parse Codex output: try structured JSON first, fallback to unstructured text.
function parseCodexOutput(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.verdict && Array.isArray(parsed.findings)) {
      return { mode: 'structured', data: parsed };
    }
  } catch { /* fallback */ }
  return { mode: 'unstructured', data: null };
}

// Detect whether Codex output contains open questions needing follow-up.
function hasQuestions(parsed, rawText) {
  if (parsed.mode === 'structured') {
    return Array.isArray(parsed.data?.questions) && parsed.data.questions.length > 0;
  }
  // Unstructured: count question-mark lines that look like natural language questions.
  const lines = rawText.split('\n');
  const questionLines = lines.filter(l => /\?/.test(l) && /[a-zA-Z一-鿿]{4,}/.test(l));
  return questionLines.length >= 2;
}

/**
 * Get or create a persistent buddy session ID for audit tracking.
 * Unlike Codex session IDs (per-probe), this persists across all calls
 * in one Claude session for observability.
 */
function getOrCreateBuddySessionId(argsSessionId) {
  if (argsSessionId) return argsSessionId;
  const existing = loadBuddySession();
  if (existing) return existing;
  const newId = `buddy-${crypto.randomUUID().slice(0, 8)}`;
  saveBuddySession(newId);
  return newId;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      const hasValue = next !== undefined && next !== '' && !next.startsWith('--');
      const val = hasValue ? next : 'true';
      args[key] = val;
      if (hasValue) i++;
    }
  }
  return args;
}

function output(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

async function actionPreflight(_args) {
  const codexAvailable = checkCodexAvailable();
  const buddySessionId = loadBuddySession();
  output({
    status: codexAvailable ? 'ok' : 'error',
    codex_available: codexAvailable,
    call_count: buddySessionId ? getCallCount(LOG_FILE, buddySessionId) : 0,
    message: codexAvailable ? 'Codex CLI ready' : 'Codex CLI not found. Install: npm i -g @openai/codex',
  });
}

async function actionLocal(args) {
  const startTime = Date.now();
  const rawChecks = args.checks === 'true' || !args.checks ? '' : args.checks;
  const checks = rawChecks.split(',').filter(Boolean);
  const result = await collectEvidence(args['project-dir'], { checks });

  // S4: empty checks = skipped, not verified
  if (result.skipped) {
    output({
      status: 'skipped',
      rule: 'none',
      route: 'local',
      evidence_summary: [],
      conclusion: 'skipped',
      message: 'No checks provided',
    });
    return;
  }

  const buddySessionId = getOrCreateBuddySessionId(args['session-id']);

  const envelope = createEnvelope({
    turn: parseInt(args.turn) || 0,
    level: args.level || 'V2',
    rule: args.rule || 'manual',
    route: 'local',
    evidence: result.evidence,
    conclusion: result.ok ? 'proceed' : 'needs-evidence',
  });

  const latencyMs = Date.now() - startTime;
  appendLog(LOG_FILE, envelope, buddySessionId, args['project-dir'], latencyMs, { action: 'local' });

  output({
    status: result.ok ? 'verified' : 'blocked',
    rule: envelope.rule,
    route: 'local',
    evidence_summary: result.evidence,
    conclusion: envelope.conclusion,
    unverified: envelope.unverified,
    session_id: buddySessionId,
    call_count: getCallCount(LOG_FILE, buddySessionId),
  });
}

async function actionProbe(args) {
  const startTime = Date.now();
  const buddySessionId = getOrCreateBuddySessionId(args['session-id']);
  if (!checkCodexAvailable()) {
    output({ status: 'error', rule: 'codex-unavailable', message: 'Codex CLI not found' });
    return;
  }

  const evidenceFile = args.evidence;
  if (!evidenceFile || !fs.existsSync(evidenceFile)) {
    output({ status: 'error', message: `Evidence file not found: ${evidenceFile}` });
    return;
  }

  const prompt = fs.readFileSync(evidenceFile, 'utf8');
  const outputFile = `/tmp/buddy-codex-${Date.now()}.txt`;

  const ephemeral = args.ephemeral !== 'false'; // default true
  const schemaFile = fs.existsSync(CODEX_OUTPUT_SCHEMA) ? CODEX_OUTPUT_SCHEMA : null;
  const cmdSpec = buildProbeArgs({
    projectDir: args['project-dir'],
    outputFile,
    prompt,
    model: args.model || null,
    ephemeral,
    outputSchema: schemaFile,
  });

  try {
    const execOutput = await execCodex(cmdSpec);
    const codexSessionId = ephemeral ? null : parseSessionId(execOutput);
    if (codexSessionId) {
      saveSession(codexSessionId);
    } else if (ephemeral) {
      // Clear stale session so follow-up can't accidentally resume an old one
      saveSession('');
    }

    const codexResult = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';
    const parsed = parseCodexOutput(codexResult);
    const followupRecommended = hasQuestions(parsed, codexResult);

    const envelope = createEnvelope({
      turn: parseInt(args.turn) || 0,
      level: args.level || 'V2',
      rule: args.rule || 'vlevel:V2',
      route: 'codex',
      evidence: [`codex: ${codexResult.slice(0, 1000)}`],
      conclusion: 'needs-review',
    });

    const latencyMs = Date.now() - startTime;
    appendLog(LOG_FILE, envelope, buddySessionId, args['project-dir'], latencyMs, { action: 'probe' });

    output({
      status: 'verified',
      rule: envelope.rule,
      route: 'codex',
      evidence_summary: envelope.evidence,
      codex_output_file: outputFile,
      conclusion: envelope.conclusion,
      unverified: envelope.unverified,
      session_id: buddySessionId,
      codex_session_id: codexSessionId,
      ephemeral,
      followup_available: !ephemeral && !!codexSessionId,
      followup_recommended: followupRecommended,
      call_count: getCallCount(LOG_FILE, buddySessionId),
      parse_mode: parsed.mode,
      structured: parsed.data,
    });
  } catch (e) {
    output({ status: 'error', message: e.message.split('\n')[0], codex_output_file: outputFile });
  }
}

// I3 fix: implement followup using buildResumeArgs + execCodex
async function actionFollowup(args) {
  const buddySessionId = getOrCreateBuddySessionId(args['session-id']);
  const codexSessionId = args['codex-session-id'] || loadSession();

  if (!codexSessionId) {
    output({ status: 'error', message: 'No Codex session ID available for follow-up. Run probe with --ephemeral false first.' });
    return;
  }

  if (!checkCodexAvailable()) {
    output({ status: 'error', rule: 'codex-unavailable', message: 'Codex CLI not found' });
    return;
  }

  const evidenceFile = args.evidence;
  if (!evidenceFile || !fs.existsSync(evidenceFile)) {
    output({ status: 'error', message: `Evidence file not found: ${evidenceFile}` });
    return;
  }

  const prompt = fs.readFileSync(evidenceFile, 'utf8');
  const outputFile = `/tmp/buddy-codex-followup-${Date.now()}.txt`;
  const startTime = Date.now();

  const cmdSpec = buildResumeArgs({
    sessionId: codexSessionId,
    outputFile,
    prompt,
  });

  try {
    await execCodex(cmdSpec);

    const codexResult = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';

    const envelope = createEnvelope({
      turn: parseInt(args.turn) || 0,
      level: args.level || 'V2',
      rule: args.rule || 'vlevel:V2',
      route: 'codex',
      evidence: [`codex-followup: ${codexResult.slice(0, 1000)}`],
      conclusion: 'needs-review',
    });

    const latencyMs = Date.now() - startTime;
    appendLog(LOG_FILE, envelope, buddySessionId, args['project-dir'], latencyMs, { action: 'followup' });

    output({
      status: 'verified',
      rule: envelope.rule,
      route: 'codex',
      evidence_summary: envelope.evidence,
      codex_output_file: outputFile,
      conclusion: envelope.conclusion,
      unverified: envelope.unverified,
      session_id: buddySessionId,
      codex_session_id: codexSessionId,
      call_count: getCallCount(LOG_FILE, buddySessionId),
    });
  } catch (e) {
    output({ status: 'error', message: e.message.split('\n')[0], codex_output_file: outputFile });
  }
}

// Annotate the most recent log entry for a session with probe_found_new / user_adopted.
// Claude calls this after synthesizing Codex output to record post-hoc metrics.
async function actionAnnotate(args) {
  const buddySessionId = getOrCreateBuddySessionId(args['session-id']);
  const fields = {};
  if (args['probe-found-new'] !== undefined) {
    fields.probe_found_new = args['probe-found-new'] === 'true';
  }
  if (args['user-adopted'] !== undefined) {
    fields.user_adopted = args['user-adopted'] === 'true';
  }
  if (!Object.keys(fields).length) {
    output({ status: 'error', message: 'No fields to annotate. Use --probe-found-new and/or --user-adopted.' });
    return;
  }
  const ok = annotateLastEntry(LOG_FILE, buddySessionId, fields);
  output({ status: ok ? 'ok' : 'error', session_id: buddySessionId, annotated: fields,
           message: ok ? 'Annotated last entry' : 'No log entry found for session' });
}

async function actionMetrics(args) {
  const stats = getStats(LOG_FILE, args['session-id'] || null);
  output({ status: 'ok', ...stats });
}

async function main() {
  const args = parseArgs(process.argv);

  const noProjectDirActions = ['preflight', 'annotate', 'metrics'];
  if (!args['project-dir'] && !noProjectDirActions.includes(args.action)) {
    output({ status: 'error', message: 'Missing required --project-dir' });
    return;
  }
  if (!args['project-dir']) {
    args['project-dir'] = process.cwd();
  }

  switch (args.action) {
    case 'preflight':
      await actionPreflight(args);
      break;
    case 'local':
      await actionLocal(args);
      break;
    case 'probe':
      await actionProbe(args);
      break;
    case 'followup':
      await actionFollowup(args);
      break;
    case 'annotate':
      await actionAnnotate(args);
      break;
    case 'metrics':
      await actionMetrics(args);
      break;
    default:
      output({ status: 'error', message: `Unknown action: ${args.action}` });
  }
}

main().catch(e => {
  output({ status: 'error', message: e.message });
  process.exit(1);
});
