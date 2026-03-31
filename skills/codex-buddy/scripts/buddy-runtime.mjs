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
 */

import { checkCodexAvailable, buildProbeCommand, parseSessionId, saveSession, loadSession } from './lib/codex-adapter.mjs';
import { collectEvidence } from './lib/local-evidence.mjs';
import { createEnvelope } from './lib/envelope.mjs';
import { appendLog, getBudgetRemaining, BUDGET_LIMIT } from './lib/audit.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const LOG_FILE = path.join(process.env.HOME || '/tmp', '.buddy', 'logs.jsonl');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
      args[key] = val;
      if (val !== 'true') i++;
    }
  }
  return args;
}

function output(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

async function actionPreflight(args) {
  const codexAvailable = checkCodexAvailable();
  output({
    status: codexAvailable ? 'ok' : 'error',
    codex_available: codexAvailable,
    budget_remaining: getBudgetRemaining(LOG_FILE, 'current'),
    message: codexAvailable ? 'Codex CLI ready' : 'Codex CLI not found. Install: npm i -g @openai/codex',
  });
}

async function actionLocal(args) {
  const startTime = Date.now();
  const checks = (args.checks || '').split(',').filter(Boolean);
  const result = await collectEvidence(args['project-dir'], { checks });

  const envelope = createEnvelope({
    turn: parseInt(args.turn) || 0,
    level: args.level || 'V2',
    rule: args.rule || 'manual',
    route: 'local',
    evidence: result.evidence,
    conclusion: result.ok ? 'proceed' : 'needs-evidence',
  });

  const sessionId = args['session-id'] || `local-${crypto.randomUUID().slice(0, 8)}`;
  const latencyMs = Date.now() - startTime;
  appendLog(LOG_FILE, envelope, sessionId, args['project-dir'], latencyMs);

  output({
    status: result.ok ? 'verified' : 'blocked',
    rule: envelope.rule,
    route: 'local',
    evidence_summary: result.evidence,
    conclusion: envelope.conclusion,
    unverified: envelope.unverified,
    session_id: sessionId,
    call_count: 0,
    budget_remaining: getBudgetRemaining(LOG_FILE, sessionId),
  });
}

async function actionProbe(args) {
  const startTime = Date.now();
  const sessionId = args['session-id'] || `probe-${crypto.randomUUID().slice(0, 8)}`;
  const budget = getBudgetRemaining(LOG_FILE, sessionId);

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

  const cmd = buildProbeCommand({
    projectDir: args['project-dir'],
    outputFile,
    prompt,
  });

  try {
    const execOutput = execSync(cmd, { encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
    const codexSessionId = parseSessionId(execOutput);
    if (codexSessionId) saveSession(codexSessionId);

    const codexResult = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';

    const envelope = createEnvelope({
      turn: parseInt(args.turn) || 0,
      level: args.level || 'V2',
      rule: args.rule || 'vlevel:V2',
      route: 'codex',
      evidence: [`codex: ${codexResult.slice(0, 200)}...`],
      conclusion: 'proceed',
    });

    const latencyMs = Date.now() - startTime;
    appendLog(LOG_FILE, envelope, sessionId, args['project-dir'], latencyMs);

    output({
      status: 'verified',
      rule: envelope.rule,
      route: 'codex',
      evidence_summary: envelope.evidence,
      codex_output_file: outputFile,
      conclusion: envelope.conclusion,
      unverified: envelope.unverified,
      session_id: codexSessionId || sessionId,
      call_count: BUDGET_LIMIT - getBudgetRemaining(LOG_FILE, sessionId),
      budget_remaining: getBudgetRemaining(LOG_FILE, sessionId),
    });
  } catch (e) {
    output({ status: 'error', message: e.message.split('\n')[0], codex_output_file: outputFile });
  }
}

async function actionFollowup(args) {
  const sessionId = args['session-id'] || loadSession();
  if (!sessionId) {
    output({ status: 'error', message: 'No session ID available for follow-up' });
    return;
  }

  const budget = getBudgetRemaining(LOG_FILE, sessionId);
  if (budget <= 0) {
    output({ status: 'blocked', rule: 'budget-exceeded', budget_remaining: 0 });
    return;
  }

  output({ status: 'error', message: 'followup action: use probe with --session-id for now' });
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
