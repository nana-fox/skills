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
  checkCodexAvailable, buildResumeArgs, execCodex,
  loadSession,
  saveBuddySession, loadBuddySession,
} from './lib/codex-adapter.mjs';
import { getProvider } from './lib/providers.mjs';
import { collectEvidence } from './lib/local-evidence.mjs';
import { createEnvelope } from './lib/envelope.mjs';
import { appendLog, getCallCount } from './lib/audit.mjs';
import { parseAnnotationFlags, ANNOTATION_FLAG_MAP } from './lib/annotations.mjs';
import { getStats } from './lib/metrics.mjs';
import { appendSessionEvent, readSessionEvents, newVerificationTaskId } from './lib/session-log.mjs';
import { getBuddyHome } from './lib/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function logFilePath() { return path.join(getBuddyHome(), 'logs.jsonl'); }
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
 * stage5e: keyed by cwd (project-dir) so concurrent Claude sessions in
 * different worktrees don't collide. cwd absent → falls back to legacy
 * global file (loadBuddySession with no opts).
 */
function getOrCreateBuddySessionId(argsSessionId, cwd) {
  if (argsSessionId) return argsSessionId;
  const lookup = cwd ? { cwd } : {};
  const existing = loadBuddySession(lookup);
  if (existing) return existing;
  const newId = `buddy-${crypto.randomUUID().slice(0, 8)}`;
  saveBuddySession(newId, lookup);
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

function readAllStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * Read evidence from --evidence (file path or "-" for stdin) or --evidence-stdin.
 * Returns { ok, prompt, source, error }.
 */
async function loadEvidence(args) {
  const useStdin = args['evidence-stdin'] === 'true' || args.evidence === '-';
  if (useStdin) {
    if (process.stdin.isTTY) {
      return { ok: false, error: 'evidence-stdin requested but stdin is a TTY (no piped input)' };
    }
    const prompt = await readAllStdin();
    if (!prompt.length) return { ok: false, error: 'stdin produced empty evidence' };
    return { ok: true, prompt, source: 'stdin' };
  }
  const file = args.evidence;
  if (!file || !fs.existsSync(file)) {
    return { ok: false, error: `Evidence not found: ${file || '<missing>'}. Pass --evidence <file> or --evidence-stdin.` };
  }
  return { ok: true, prompt: fs.readFileSync(file, 'utf8'), source: file };
}

async function actionPreflight(args) {
  const buddyModel = args['buddy-model'] || 'codex';
  const lookup = args['project-dir'] ? { cwd: args['project-dir'] } : {};
  const buddySessionId = loadBuddySession(lookup);
  let provider;
  try {
    provider = getProvider(buddyModel);
  } catch (e) {
    output({ status: 'error', model: buddyModel, message: e.message });
    return;
  }

  output({
    ...provider.preflight(),
    transports: provider.transports,
    supports_fresh_thread: provider.supportsFreshThread,
    call_count: buddySessionId ? getCallCount(logFilePath(), buddySessionId) : 0,
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

  const buddySessionId = getOrCreateBuddySessionId(args['session-id'], args['project-dir']);

  const envelope = createEnvelope({
    turn: parseInt(args.turn) || 0,
    level: args.level || 'V2',
    rule: args.rule || 'manual',
    route: 'local',
    evidence: result.evidence,
    conclusion: result.ok ? 'proceed' : 'needs-evidence',
  });

  const latencyMs = Date.now() - startTime;
  const localTaskId = newVerificationTaskId();
  appendLog(logFilePath(), {
    envelope,
    buddySessionId,
    workspace: args['project-dir'],
    action: 'local',
    verificationTaskId: localTaskId,
    latencyMs,
    model: 'codex',
  });

  output({
    status: result.ok ? 'verified' : 'blocked',
    rule: envelope.rule,
    route: 'local',
    evidence_summary: result.evidence,
    conclusion: envelope.conclusion,
    unverified: envelope.unverified,
    session_id: buddySessionId,
    call_count: getCallCount(logFilePath(), buddySessionId),
  });
}

async function actionProbe(args) {
  const startTime = Date.now();
  let provider;
  try {
    provider = getProvider(args['buddy-model'] || 'codex');
  } catch (e) {
    output({ status: 'error', message: e.message });
    return;
  }
  const buddyModel = provider.name;
  const buddySessionId = getOrCreateBuddySessionId(args['session-id'], args['project-dir']);
  if (args['fresh-thread'] === 'true' && !provider.supportsFreshThread) {
    output({
      status: 'error',
      model: buddyModel,
      message: '--fresh-thread is only supported by the codex broker transport; kimi is exec-only.',
    });
    return;
  }

  const ev = await loadEvidence(args);
  if (!ev.ok) {
    output({ status: 'error', message: ev.error });
    return;
  }
  const prompt = ev.prompt;
  const evidenceSource = ev.source;
  const sessionPolicy = args['session-policy'] === 'conversation' ? 'conversation' : 'isolated';
  const verificationTaskId = args['verification-task-id'] || newVerificationTaskId();
  appendSessionEvent(buddySessionId, verificationTaskId, 'probe.start', {
    evidence_source: evidenceSource,
    project_dir: args['project-dir'],
    provider: buddyModel,
    model: buddyModel,
    session_policy: sessionPolicy,
    rule: args.rule || 'vlevel:V2',
    level: args.level || 'V2',
  }, prompt);

  const schemaFile = fs.existsSync(CODEX_OUTPUT_SCHEMA) ? CODEX_OUTPUT_SCHEMA : null;
  try {
    const turn = await provider.startTurn({
      prompt,
      projectDir: args['project-dir'],
      model: args.model || null,
      outputSchema: schemaFile,
      buddySessionId,
      sessionPolicy,
      ephemeral: args.ephemeral,
      freshThread: args['fresh-thread'] === 'true',
      startTime,
    });
    const providerOutput = turn.finalMessage || '';
    const parsed = buddyModel === 'codex'
      ? parseCodexOutput(providerOutput)
      : { mode: turn.parseStatus || 'final-message', data: null };
    const followupRecommended = buddyModel === 'codex' && hasQuestions(parsed, providerOutput);

    for (const event of turn.events || []) {
      appendSessionEvent(buddySessionId, verificationTaskId, 'probe.provider_event', {
        provider: turn.provider,
        transport: turn.transport,
        thread_id: turn.threadId || null,
        turn_id: event.turn_id || null,
        event_subtype: event.subtype,
      }, event.payload || null);
    }

    if (turn.think?.length) {
      appendSessionEvent(buddySessionId, verificationTaskId, 'probe.provider_think', {
        provider: turn.provider,
        transport: turn.transport,
        provider_session_id: turn.providerSessionId || null,
      }, turn.think.join('\n\n'));
    }

    const envelope = createEnvelope({
      turn: parseInt(args.turn) || 0,
      level: args.level || 'V2',
      rule: args.rule || 'vlevel:V2',
      route: buddyModel,
      evidence: [`${buddyModel}: ${providerOutput.slice(0, 1000)}`],
      conclusion: 'needs-review',
    });

    const latencyMs = Date.now() - startTime;
    appendLog(logFilePath(), {
      envelope,
      buddySessionId,
      workspace: args['project-dir'],
      action: 'probe',
      verificationTaskId,
      latencyMs,
      model: buddyModel,
      parseStatus: turn.parseStatus,
      fallback: turn.fallback,
    });

    appendSessionEvent(buddySessionId, verificationTaskId, 'probe.provider_output', {
      provider: turn.provider,
      transport: turn.transport,
      runtime: turn.runtime,
      thread_id: turn.threadId || null,
      codex_session_id: turn.codexSessionId || null,
      provider_session_id: turn.providerSessionId || null,
      ephemeral: turn.ephemeral,
      broker_fallback: turn.brokerFallback || false,
      broker_fallback_reason: turn.brokerFallbackReason || null,
      parse_mode: parsed.mode,
      verdict: parsed.data?.verdict || null,
      latency_ms: latencyMs,
      first_byte_ms: turn.firstByteMs ?? null,
      followup_recommended: followupRecommended,
      output_file: turn.outputFile || null,
      parse_status: turn.parseStatus,
      fallback: turn.fallback,
      parser_version: turn.parserVersion,
      exit_code: turn.exitCode,
      events_count: (turn.events || []).length,
    }, providerOutput);

    process.stderr.write(`[buddy] probe completed in ${latencyMs}ms, verdict=${parsed.data?.verdict || parsed.mode}\n`);

    output({
      status: 'verified',
      rule: envelope.rule,
      route: buddyModel,
      provider: turn.provider,
      model: buddyModel,
      transport: turn.transport,
      evidence_summary: envelope.evidence,
      ...(turn.outputFile ? { codex_output_file: turn.outputFile } : {}),
      conclusion: envelope.conclusion,
      unverified: envelope.unverified,
      session_id: buddySessionId,
      verification_task_id: verificationTaskId,
      codex_session_id: turn.codexSessionId || null,
      kimi_session_id: buddyModel === 'kimi' ? (turn.providerSessionId || null) : undefined,
      thread_id: turn.threadId || null,
      provider_session_id: turn.providerSessionId || null,
      ephemeral: turn.ephemeral,
      session_policy: sessionPolicy,
      runtime: turn.runtime,
      broker_fallback: turn.brokerFallback || false,
      broker_fallback_reason: turn.brokerFallbackReason || null,
      resumed: !!turn.resumed,
      followup_available: buddyModel === 'codex' && !turn.ephemeral && !!turn.codexSessionId,
      followup_recommended: followupRecommended,
      call_count: getCallCount(logFilePath(), buddySessionId),
      parse_mode: parsed.mode,
      parse_status: turn.parseStatus,
      fallback: turn.fallback,
      events_count: (turn.events || []).length,
      structured: parsed.data,
    });
  } catch (e) {
    appendSessionEvent(buddySessionId, verificationTaskId, 'probe.error', {
      message: e.message.split('\n')[0],
      provider: buddyModel,
    });
    output({ status: 'error', rule: e.code || `${buddyModel}-failed`, message: e.message.split('\n')[0], verification_task_id: verificationTaskId });
  }
}

// Look up the codex_session_id of a specific verification task from session log,
// avoiding the global ~/.buddy/session.json pointer (which can be overwritten by
// any concurrent probe and link followup to the wrong session).
function lookupCodexSessionByTaskId(buddySessionId, verificationTaskId) {
  if (!verificationTaskId) return null;
  const events = readSessionEvents(buddySessionId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if ((e.event === 'probe.provider_output' || e.event === 'probe.codex_output' || e.event === 'followup.codex_output')
        && e.verification_task_id === verificationTaskId
        && e.codex_session_id) {
      return e.codex_session_id;
    }
  }
  return null;
}

// I3 fix: implement followup using buildResumeArgs + execCodex
async function actionFollowup(args) {
  const buddySessionId = getOrCreateBuddySessionId(args['session-id'], args['project-dir']);
  // Resolution order (most specific → least, to avoid global session.json overwrite race):
  //   1. --codex-session-id (explicit)
  //   2. --verification-task-id → look up codex_session_id from session log
  //   3. loadSession() global last pointer (deprecated; warns)
  let codexSessionId = args['codex-session-id'] || null;
  if (!codexSessionId && args['verification-task-id']) {
    codexSessionId = lookupCodexSessionByTaskId(buddySessionId, args['verification-task-id']);
  }
  if (!codexSessionId) {
    codexSessionId = loadSession();
    if (codexSessionId) {
      process.stderr.write('[buddy-runtime] Warning: using global ~/.buddy/session.json pointer; pass --verification-task-id or --codex-session-id to disambiguate.\n');
    }
  }

  if (!codexSessionId) {
    output({ status: 'error', message: 'No Codex session ID available for follow-up. Pass --verification-task-id <id> or --codex-session-id <id>, or run probe with --ephemeral false first.' });
    return;
  }

  if (process.env.BUDDY_STUB_CODEX !== '1' && !checkCodexAvailable()) {
    output({ status: 'error', rule: 'codex-unavailable', message: 'Codex CLI not found' });
    return;
  }

  const ev = await loadEvidence(args);
  if (!ev.ok) {
    output({ status: 'error', message: ev.error });
    return;
  }
  const prompt = ev.prompt;
  const outputFile = `/tmp/buddy-codex-followup-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`;
  const startTime = Date.now();
  const verificationTaskId = args['verification-task-id'] || newVerificationTaskId();
  process.stderr.write(`[buddy] followup started, sid=${buddySessionId}, codex_session=${codexSessionId.slice(0, 8)}, ETA 30-80s\n`);
  appendSessionEvent(buddySessionId, verificationTaskId, 'followup.start', {
    evidence_source: ev.source,
    codex_session_id: codexSessionId,
  }, prompt);

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
    appendLog(logFilePath(), {
      envelope,
      buddySessionId,
      workspace: args['project-dir'],
      action: 'followup',
      verificationTaskId,
      latencyMs,
      model: 'codex',
    });

    appendSessionEvent(buddySessionId, verificationTaskId, 'followup.codex_output', {
      codex_session_id: codexSessionId,
      latency_ms: latencyMs,
      codex_output_file: outputFile,
    }, codexResult);

    process.stderr.write(`[buddy] followup completed in ${latencyMs}ms\n`);

    output({
      status: 'verified',
      rule: envelope.rule,
      route: 'codex',
      evidence_summary: envelope.evidence,
      codex_output_file: outputFile,
      conclusion: envelope.conclusion,
      unverified: envelope.unverified,
      session_id: buddySessionId,
      verification_task_id: verificationTaskId,
      codex_session_id: codexSessionId,
      call_count: getCallCount(logFilePath(), buddySessionId),
    });
  } catch (e) {
    appendSessionEvent(buddySessionId, verificationTaskId, 'followup.error', {
      message: e.message.split('\n')[0],
      codex_output_file: outputFile,
    });
    output({ status: 'error', message: e.message.split('\n')[0], codex_output_file: outputFile, verification_task_id: verificationTaskId });
  }
}

// Annotate the most recent probe for a session with probe_found_new / user_adopted.
// Claude calls this after synthesizing Codex output to record post-hoc metrics.
async function actionAnnotate(args) {
  const buddySessionId = getOrCreateBuddySessionId(args['session-id'], args['project-dir']);
  const { fields } = parseAnnotationFlags(args);
  if (!Object.keys(fields).length) {
    output({ status: 'error',
             message: `No fields to annotate. Use ${Object.keys(ANNOTATION_FLAG_MAP).map(f => '--' + f).join(' and/or ')}.` });
    return;
  }
  // Default task id: latest probe output ONLY (not followup.codex_output).
  // metrics computes annotation rates over probes, so attaching annotation to
  // a followup task would silently drop the metric. Caller can override with
  // --verification-task-id to annotate a followup explicitly.
  let taskId = args['verification-task-id'];
  if (!taskId) {
    const events = readSessionEvents(buddySessionId);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.event === 'probe.provider_output' || e.event === 'probe.codex_output') {
        taskId = e.verification_task_id;
        break;
      }
    }
  }
  if (!taskId) {
    output({ status: 'error', session_id: buddySessionId,
             message: 'No probe/followup found for this buddy session — nothing to annotate.' });
    return;
  }
  appendSessionEvent(buddySessionId, taskId, 'annotate', fields);
  output({ status: 'ok', session_id: buddySessionId, verification_task_id: taskId,
           annotated: fields, message: 'Annotated session-log probe' });
}

// Allow Claude to log synthesis (or any post-hoc note) into the buddy session log.
// Reads content from --content <file>, --content - (stdin), or --content-stdin.
async function actionLogSynthesis(args) {
  const buddySessionId = getOrCreateBuddySessionId(args['session-id'], args['project-dir']);
  const verificationTaskId = args['verification-task-id'] || 'unknown';
  let content = '';
  if (args['content-stdin'] === 'true' || args.content === '-') {
    content = await readAllStdin();
  } else if (args.content && fs.existsSync(args.content)) {
    content = fs.readFileSync(args.content, 'utf8');
  } else if (typeof args.content === 'string' && args.content !== 'true') {
    content = args.content;
  }
  if (!content.length) {
    output({ status: 'error', message: 'Empty synthesis content. Pass --content <file|->,  --content-stdin, or inline string.' });
    return;
  }
  appendSessionEvent(buddySessionId, verificationTaskId, 'probe.synthesis', {
    note: args.note || null,
  }, content);
  output({ status: 'ok', session_id: buddySessionId, verification_task_id: verificationTaskId, message: 'Synthesis logged' });
}

// W2: Self-evidence — let Claude echo a reply slice into session log for audit.
// Best-effort: if Claude forgets to call, evals/self-evidence.eval.mjs warns later;
// not fail-closed. Three kinds: vlevel-header / synthesis / narrate-discipline.
const REPLY_KINDS = new Set(['vlevel-header', 'synthesis', 'narrate-discipline']);
async function actionLogReply(args) {
  const buddySessionId = getOrCreateBuddySessionId(args['session-id'], args['project-dir']);
  const verificationTaskId = args['verification-task-id'] || 'unknown';
  const kind = args.kind;
  if (!REPLY_KINDS.has(kind)) {
    output({ status: 'error', message: `Invalid --kind. Expected one of: ${[...REPLY_KINDS].join(', ')}` });
    return;
  }
  let content = '';
  if (args['content-stdin'] === 'true' || args.content === '-') {
    content = await readAllStdin();
  } else if (args.content && fs.existsSync(args.content)) {
    content = fs.readFileSync(args.content, 'utf8');
  } else if (typeof args.content === 'string' && args.content !== 'true') {
    content = args.content;
  }
  // narrate-discipline can legitimately be empty (signaling "I obeyed, no slip")
  if (!content.length && kind !== 'narrate-discipline') {
    output({ status: 'error', message: 'Empty content. Pass --content <file|->, --content-stdin, or inline string.' });
    return;
  }
  appendSessionEvent(buddySessionId, verificationTaskId, `reply.${kind}`, {
    kind,
  }, content || '(empty)');
  output({ status: 'ok', session_id: buddySessionId, verification_task_id: verificationTaskId, kind, message: 'Reply logged' });
}

async function actionReplay(args) {
  // C2 fix: pass cwd so loadBuddySession uses new path, not global legacy pointer.
  const buddySessionId = args['session-id'] || loadBuddySession(args['project-dir'] ? { cwd: args['project-dir'] } : {});
  if (!buddySessionId) {
    output({ status: 'error', message: 'No buddy session ID. Pass --session-id <id>.' });
    return;
  }
  const events = readSessionEvents(buddySessionId);
  output({ status: 'ok', session_id: buddySessionId, events_count: events.length, events });
}

async function actionMetrics(args) {
  const stats = getStats(logFilePath(), args['session-id'] || null);
  output({ status: 'ok', ...stats });
}

async function main() {
  const args = parseArgs(process.argv);

  const noProjectDirActions = ['preflight', 'annotate', 'metrics', 'log-synthesis', 'log-reply', 'replay'];
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
    case 'log-synthesis':
      await actionLogSynthesis(args);
      break;
    case 'log-reply':
      await actionLogReply(args);
      break;
    case 'replay':
      await actionReplay(args);
      break;
    default:
      output({ status: 'error', message: `Unknown action: ${args.action}` });
  }
}

main().catch(e => {
  output({ status: 'error', message: e.message });
  process.exit(1);
});
