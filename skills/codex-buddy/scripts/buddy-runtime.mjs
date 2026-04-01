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
import { appendLog, getBudgetRemaining, BUDGET_LIMIT } from './lib/audit.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const LOG_FILE = path.join(process.env.HOME || '/tmp', '.buddy', 'logs.jsonl');

/**
 * Get or create a persistent buddy session ID for budget tracking.
 * Unlike Codex session IDs (per-probe), this persists across all calls
 * in one Claude session, ensuring the 4-call budget is enforced.
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
    budget_remaining: buddySessionId ? getBudgetRemaining(LOG_FILE, buddySessionId) : BUDGET_LIMIT,
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
  appendLog(LOG_FILE, envelope, buddySessionId, args['project-dir'], latencyMs);

  output({
    status: result.ok ? 'verified' : 'blocked',
    rule: envelope.rule,
    route: 'local',
    evidence_summary: result.evidence,
    conclusion: envelope.conclusion,
    unverified: envelope.unverified,
    session_id: buddySessionId,
    call_count: 0,
    budget_remaining: getBudgetRemaining(LOG_FILE, buddySessionId),
  });
}

async function actionProbe(args) {
  const startTime = Date.now();
  const buddySessionId = getOrCreateBuddySessionId(args['session-id']);
  const budget = getBudgetRemaining(LOG_FILE, buddySessionId);

  if (budget <= 0) {
    output({ status: 'blocked', rule: 'budget-exceeded', budget_remaining: 0 });
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
  const outputFile = `/tmp/buddy-codex-${Date.now()}.txt`;

  const cmdSpec = buildProbeArgs({
    projectDir: args['project-dir'],
    outputFile,
    prompt,
  });

  try {
    // C1 fix: use execCodex (async spawn) instead of execSync with string
    const execOutput = await execCodex(cmdSpec);
    const codexSessionId = parseSessionId(execOutput);
    if (codexSessionId) saveSession(codexSessionId);

    const codexResult = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';

    const envelope = createEnvelope({
      turn: parseInt(args.turn) || 0,
      level: args.level || 'V2',
      rule: args.rule || 'vlevel:V2',
      route: 'codex',
      // S1: increase truncation to 1000 chars
      evidence: [`codex: ${codexResult.slice(0, 1000)}`],
      // I1 fix: don't hardcode 'proceed' — let SKILL.md judge
      conclusion: 'needs-review',
    });

    const latencyMs = Date.now() - startTime;
    appendLog(LOG_FILE, envelope, buddySessionId, args['project-dir'], latencyMs);

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
      call_count: BUDGET_LIMIT - getBudgetRemaining(LOG_FILE, buddySessionId),
      budget_remaining: getBudgetRemaining(LOG_FILE, buddySessionId),
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
    output({ status: 'error', message: 'No Codex session ID available for follow-up. Run probe first.' });
    return;
  }

  const budget = getBudgetRemaining(LOG_FILE, buddySessionId);
  if (budget <= 0) {
    output({ status: 'blocked', rule: 'budget-exceeded', budget_remaining: 0 });
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
    appendLog(LOG_FILE, envelope, buddySessionId, args['project-dir'], latencyMs);

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
      call_count: BUDGET_LIMIT - getBudgetRemaining(LOG_FILE, buddySessionId),
      budget_remaining: getBudgetRemaining(LOG_FILE, buddySessionId),
    });
  } catch (e) {
    output({ status: 'error', message: e.message.split('\n')[0], codex_output_file: outputFile });
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args['project-dir'] && args.action !== 'preflight') {
    output({ status: 'error', message: 'Missing required --project-dir' });
    return;
  }

  if (!args['project-dir'] && args.action === 'preflight') {
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
    default:
      output({ status: 'error', message: `Unknown action: ${args.action}` });
  }
}

main().catch(e => {
  output({ status: 'error', message: e.message });
  process.exit(1);
});
