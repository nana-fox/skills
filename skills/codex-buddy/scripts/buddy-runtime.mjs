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
  loadSession,
  saveBuddySession, loadBuddySession,
} from './lib/codex-adapter.mjs';
import { getProvider } from './lib/providers.mjs';
import { collectEvidence } from './lib/local-evidence.mjs';
import { createEnvelope } from './lib/envelope.mjs';
import { appendLog, getCallCount } from './lib/audit.mjs';
import { parseAnnotationFlags, ANNOTATION_FLAG_MAP } from './lib/annotations.mjs';
import { assessReply } from './lib/reply-assessor.mjs';
import { getStats } from './lib/metrics.mjs';
import { appendSessionEvent, readSessionEvents, newVerificationTaskId, getSessionLogPath } from './lib/session-log.mjs';
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

function normalizeKimiVerdict(text) {
  const raw = String(text || '').trim();
  const firstLine = raw.split('\n').map((line) => line.trim()).find(Boolean) || '';
  const token = firstLine.match(/^(?:verdict\s*:\s*)?(GO|NO-GO|INCONCLUSIVE)\b/i)?.[1]?.toUpperCase();
  if (token === 'GO') return { verdict: 'GO', reviewStatus: 'passed' };
  if (token === 'NO-GO') return { verdict: 'NO-GO', reviewStatus: 'blocked' };
  return { verdict: 'INCONCLUSIVE', reviewStatus: 'inconclusive' };
}

function isKimiCleanPass(kimiVerdict) {
  return kimiVerdict?.reviewStatus === 'passed';
}

function kimiProbeOutcome(kimiVerdict) {
  if (isKimiCleanPass(kimiVerdict)) {
    return {
      finalState: 'completed',
      status: 'verified',
      rule: null,
      exitCode: 0,
      recoverable: false,
      message: null,
      recoveryHint: null,
    };
  }
  if (kimiVerdict?.reviewStatus === 'blocked') {
    return {
      finalState: 'blocked',
      status: 'blocked',
      rule: 'kimi-no-go',
      exitCode: 1,
      recoverable: false,
      message: 'Kimi review returned NO-GO. Treat this as a blocking review result, not a passed verification.',
      recoveryHint: null,
    };
  }
  return {
    finalState: 'recoverable_error',
    status: 'error',
    rule: 'kimi-inconclusive',
    exitCode: 1,
    recoverable: true,
    message: `Kimi review was inconclusive: verdict=${kimiVerdict?.verdict || 'INCONCLUSIVE'}. Require GO before treating this as passed.`,
    recoveryHint: 'Kimi returned output but no GO verdict. Treat this review as inconclusive, retry Kimi with an explicit GO/NO-GO instruction, or run the same evidence with --buddy-model codex.',
  };
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

function createProviderProgressReporter({ buddySessionId, verificationTaskId, provider, startedAt }) {
  const stats = {
    contentChunks: 0,
    contentChars: 0,
    thinkingChunks: 0,
    thinkingChars: 0,
    statusEvents: 0,
    toolEvents: 0,
    protocolEvents: 0,
    otherEvents: 0,
    eventCount: 0,
    lastAt: null,
    lastSubtype: null,
    lastRawType: null,
    nextReportAt: startedAt + 2_000,
  };

  return {
    stats,
    onEvent(event) {
      const now = Date.now();
      stats.eventCount += 1;
      stats.lastAt = now;
      stats.lastSubtype = event?.subtype || null;
      stats.lastRawType = event?.payload?.raw_type || null;
      if (event?.subtype === 'kimi/content') {
        stats.contentChunks += 1;
        stats.contentChars += String(event.payload?.text || '').length;
      } else if (event?.subtype === 'kimi/thinking') {
        stats.thinkingChunks += 1;
        stats.thinkingChars += String(event.payload?.thinking || '').length;
      } else if (event?.subtype === 'kimi/status') {
        stats.statusEvents += 1;
      } else if (event?.subtype === 'kimi/tool' || event?.subtype === 'kimi/request_rejected') {
        stats.toolEvents += 1;
      } else if (event?.subtype === 'kimi/protocol') {
        stats.protocolEvents += 1;
      } else {
        stats.otherEvents += 1;
      }

      if (now < stats.nextReportAt) return;
      stats.nextReportAt = now + 5_000;
      const elapsed = Math.round((now - startedAt) / 1000);
      appendSessionEventBestEffort(buddySessionId, verificationTaskId, 'probe.provider_progress', {
        provider,
        events_count: stats.eventCount,
        content_chunks: stats.contentChunks,
        content_chars: stats.contentChars,
        thinking_chunks: stats.thinkingChunks,
        thinking_chars: stats.thinkingChars,
        status_events: stats.statusEvents,
        tool_events: stats.toolEvents,
        protocol_events: stats.protocolEvents,
        other_events: stats.otherEvents,
        last_event_subtype: stats.lastSubtype,
        last_raw_type: stats.lastRawType,
        elapsed_s: elapsed,
      });
      process.stderr.write(
        `[buddy] ${provider} streaming: chunks=${stats.contentChunks}, chars=${stats.contentChars}, thinking=${stats.thinkingChars}, elapsed=${elapsed}s\n`,
      );
    },
  };
}

function writeCompletionMarkerBestEffort(markerPath, payload) {
  if (!markerPath || markerPath === 'true') return false;
  try {
    const dir = path.dirname(markerPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(markerPath)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, markerPath);
    return true;
  } catch (e) {
    process.stderr.write(`[buddy] warning: completion marker write failed (${e.message.split('\n')[0]})\n`);
    return false;
  }
}

function buildCompletionPayload({ buddySessionId, verificationTaskId, provider, transport = null, runtime = null, finalState, startedAt, exitCode = null, rule = null, message = null }) {
  return {
    session_id: buddySessionId,
    verification_task_id: verificationTaskId,
    final_state: finalState,
    provider,
    transport,
    runtime,
    rule,
    message,
    exit_code: exitCode,
    duration_ms: Date.now() - startedAt,
    completed_at: new Date().toISOString(),
    session_log_path: getSessionLogPath(buddySessionId),
  };
}

function appendSessionEventBestEffort(buddySessionId, verificationTaskId, event, fields = {}, rawPayload = null) {
  try {
    return appendSessionEvent(buddySessionId, verificationTaskId, event, fields, rawPayload);
  } catch (e) {
    process.stderr.write(`[buddy] warning: session audit log write failed (${e.message.split('\n')[0]})\n`);
    return null;
  }
}

function appendAuditLogBestEffort(logFile, opts) {
  try {
    appendLog(logFile, opts);
    return true;
  } catch (e) {
    process.stderr.write(`[buddy] warning: summary audit log write failed (${e.message.split('\n')[0]})\n`);
    return false;
  }
}

function getCallCountBestEffort(logFile, buddySessionId) {
  try {
    return getCallCount(logFile, buddySessionId);
  } catch (e) {
    process.stderr.write(`[buddy] warning: summary audit log read failed (${e.message.split('\n')[0]})\n`);
    return null;
  }
}

/**
 * Read evidence from --evidence (file path or "-" for stdin) or --evidence-stdin.
 * Returns { ok, prompt, source, error }.
 */
async function loadEvidence(args) {
  const useStdin = args['evidence-stdin'] === 'true' || args.evidence === '-';
  if (useStdin) {
    if (process.stdin.isTTY || process.env.BUDDY_TEST_STDIN_TTY === '1') {
      return { ok: false, error: 'evidence-stdin requested but stdin is a TTY (no piped input). Use file-first recovery: write evidence to a file and rerun with --evidence <file> --project-dir "$PWD".' };
    }
    const prompt = await readAllStdin();
    if (!prompt.length) return { ok: false, error: 'stdin produced empty evidence. Use file-first recovery: write evidence to a file and rerun with --evidence <file> --project-dir "$PWD".' };
    return { ok: true, prompt, source: 'stdin' };
  }
  const file = args.evidence;
  if (!file || !fs.existsSync(file)) {
    return { ok: false, error: `Evidence not found: ${file || '<missing>'}. Use file-first: write evidence to a file and pass --evidence <file>. Use --evidence-stdin only with a real same-command pipe/heredoc.` };
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
    call_count: buddySessionId ? getCallCountBestEffort(logFilePath(), buddySessionId) : 0,
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
  const auditLogged = appendAuditLogBestEffort(logFilePath(), {
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
    audit_logged: auditLogged,
    call_count: getCallCountBestEffort(logFilePath(), buddySessionId),
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
      message: '--fresh-thread is only supported by the codex broker transport; kimi has its own provider transport.',
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
  appendSessionEventBestEffort(buddySessionId, verificationTaskId, 'probe.start', {
    evidence_source: evidenceSource,
    project_dir: args['project-dir'],
    provider: buddyModel,
    model: buddyModel,
    session_policy: sessionPolicy,
    rule: args.rule || 'vlevel:V2',
    level: args.level || 'V2',
  }, prompt);

  const schemaFile = fs.existsSync(CODEX_OUTPUT_SCHEMA) ? CODEX_OUTPUT_SCHEMA : null;
  const progress = createProviderProgressReporter({
    buddySessionId,
    verificationTaskId,
    provider: buddyModel,
    startedAt: startTime,
  });
  const _envTimeout = parseInt(process.env.BUDDY_PROBE_TIMEOUT_MS, 10);
  const probeTimeoutMs = (_envTimeout > 0 ? _envTimeout : null) ?? 4 * 60 * 1000;
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
      onEvent: buddyModel === 'kimi' ? progress.onEvent : null,
      timeoutMs: probeTimeoutMs,
    });
    const providerOutput = turn.finalMessage || '';
    const parsed = buddyModel === 'codex'
      ? parseCodexOutput(providerOutput)
      : { mode: turn.parseStatus || 'final-message', data: null };
    const kimiVerdict = buddyModel === 'kimi' ? normalizeKimiVerdict(providerOutput) : null;
    const followupRecommended = buddyModel === 'codex' && hasQuestions(parsed, providerOutput);

    for (const event of turn.events || []) {
      appendSessionEventBestEffort(buddySessionId, verificationTaskId, 'probe.provider_event', {
        provider: turn.provider,
        transport: turn.transport,
        thread_id: turn.threadId || null,
        turn_id: event.turn_id || null,
        event_subtype: event.subtype,
      }, event.payload || null);
    }

    if (turn.think?.length) {
      appendSessionEventBestEffort(buddySessionId, verificationTaskId, 'probe.provider_think', {
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
    const auditLogged = appendAuditLogBestEffort(logFilePath(), {
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

    appendSessionEventBestEffort(buddySessionId, verificationTaskId, 'probe.provider_output', {
      provider: turn.provider,
      transport: turn.transport,
      runtime: turn.runtime,
      thread_id: turn.threadId || null,
      codex_session_id: turn.codexSessionId || null,
      provider_session_id: turn.providerSessionId || null,
      ephemeral: turn.ephemeral,
      broker_fallback: turn.brokerFallback || false,
      broker_fallback_reason: turn.brokerFallbackReason || null,
      degraded: turn.degraded || false,
      parse_mode: parsed.mode,
      verdict: kimiVerdict?.verdict || parsed.data?.verdict || null,
      review_status: kimiVerdict?.reviewStatus || null,
      latency_ms: latencyMs,
      first_byte_ms: turn.firstByteMs ?? null,
      followup_recommended: followupRecommended,
      output_file: turn.outputFile || null,
      parse_status: turn.parseStatus,
      fallback: turn.fallback,
      parser_version: turn.parserVersion,
      exit_code: turn.exitCode,
      events_count: (turn.events || []).length,
      progress_stats: turn.progress || progress.stats,
    }, providerOutput);

    const probeOutcome = buddyModel === 'kimi'
      ? kimiProbeOutcome(kimiVerdict)
      : {
          finalState: 'completed',
          status: 'verified',
          rule: envelope.rule,
          exitCode: turn.exitCode ?? 0,
          recoverable: false,
          message: null,
          recoveryHint: null,
        };
    const resultRule = probeOutcome.rule || envelope.rule;

    const completedPayload = buildCompletionPayload({
      buddySessionId,
      verificationTaskId,
      provider: turn.provider,
      transport: turn.transport,
      runtime: turn.runtime,
      finalState: probeOutcome.finalState,
      startedAt: startTime,
      exitCode: probeOutcome.exitCode,
      rule: resultRule,
      message: probeOutcome.message,
    });
    appendSessionEventBestEffort(buddySessionId, verificationTaskId, 'probe.completed', completedPayload);
    writeCompletionMarkerBestEffort(args['completion-marker'], completedPayload);

    process.stderr.write(`[buddy] probe completed in ${latencyMs}ms, verdict=${kimiVerdict?.verdict || parsed.data?.verdict || parsed.mode}\n`);

    output({
      status: probeOutcome.status,
      rule: resultRule,
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
      degraded: turn.degraded || false,
      resumed: !!turn.resumed,
      followup_available: buddyModel === 'codex' && !turn.ephemeral && !!turn.codexSessionId,
      followup_recommended: followupRecommended,
      audit_logged: auditLogged,
      call_count: getCallCountBestEffort(logFilePath(), buddySessionId),
      parse_mode: parsed.mode,
      parse_status: turn.parseStatus,
      fallback: turn.fallback,
      events_count: (turn.events || []).length,
      progress_stats: turn.progress || progress.stats,
      verdict: kimiVerdict?.verdict || parsed.data?.verdict || null,
      review_status: kimiVerdict?.reviewStatus || null,
      recoverable: probeOutcome.recoverable || undefined,
      recovery_hint: probeOutcome.recoveryHint || undefined,
      message: probeOutcome.message || undefined,
      structured: parsed.data,
    });
    process.exitCode = probeOutcome.exitCode;
  } catch (e) {
    const progressStats = progress.stats;
    const progressMessage = progressStats.eventCount
      ? `; streamed_events=${progressStats.eventCount}, content_chunks=${progressStats.contentChunks}, content_chars=${progressStats.contentChars}, last_event=${progressStats.lastSubtype || 'unknown'}`
      : '';
    appendSessionEventBestEffort(buddySessionId, verificationTaskId, 'probe.error', {
      message: `${e.message.split('\n')[0]}${progressMessage}`,
      provider: buddyModel,
      events_count: progressStats.eventCount,
      content_chunks: progressStats.contentChunks,
      content_chars: progressStats.contentChars,
      thinking_chunks: progressStats.thinkingChunks,
      thinking_chars: progressStats.thinkingChars,
      status_events: progressStats.statusEvents,
      tool_events: progressStats.toolEvents,
      protocol_events: progressStats.protocolEvents,
      other_events: progressStats.otherEvents,
      last_event_subtype: progressStats.lastSubtype,
      last_raw_type: progressStats.lastRawType,
    });
    const finalState = e.recoverable === true ? 'recoverable_error' : 'error';
    const completedPayload = buildCompletionPayload({
      buddySessionId,
      verificationTaskId,
      provider: buddyModel,
      finalState,
      startedAt: startTime,
      exitCode: 1,
      rule: e.code || `${buddyModel}-failed`,
      message: `${e.message.split('\n')[0]}${progressMessage}`,
    });
    appendSessionEventBestEffort(buddySessionId, verificationTaskId, 'probe.completed', completedPayload);
    writeCompletionMarkerBestEffort(args['completion-marker'], completedPayload);
    output({
      status: 'error',
      rule: e.code || `${buddyModel}-failed`,
      message: `${e.message.split('\n')[0]}${progressMessage}`,
      verification_task_id: verificationTaskId,
      recoverable: e.recoverable === true || undefined,
      recovery_hint: e.recoveryHint || undefined,
      ...(progressStats.eventCount ? {
        streamed_events: progressStats.eventCount,
        content_chunks: progressStats.contentChunks,
        content_chars: progressStats.contentChars,
        thinking_chunks: progressStats.thinkingChunks,
        thinking_chars: progressStats.thinkingChars,
        status_events: progressStats.statusEvents,
        tool_events: progressStats.toolEvents,
        protocol_events: progressStats.protocolEvents,
        other_events: progressStats.otherEvents,
        last_event_subtype: progressStats.lastSubtype,
        last_raw_type: progressStats.lastRawType,
      } : {}),
    });
  }
}

// Look up the codex_session_id of a specific verification task from session log,
// avoiding the global ~/.buddy/session.json pointer (which can be overwritten by
// any concurrent probe and link followup to the wrong session).
function lookupProviderSessionByTaskId(buddySessionId, verificationTaskId, providerName = 'codex') {
  if (!verificationTaskId) return null;
  const events = readSessionEvents(buddySessionId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if ((e.event === 'probe.provider_output' || e.event === 'probe.codex_output' || e.event === 'followup.provider_output' || e.event === 'followup.codex_output')
        && e.verification_task_id === verificationTaskId) {
      if (e.provider && e.provider !== providerName && providerName !== 'codex') continue;
      const providerSessionId = e.provider_session_id
        || (providerName === 'codex' ? e.codex_session_id : null)
        || e.codex_session_id
        || null;
      if (providerSessionId) return providerSessionId;
    }
  }
  return null;
}

async function actionFollowup(args) {
  let provider;
  try {
    provider = getProvider(args['buddy-model'] || 'codex');
  } catch (e) {
    output({ status: 'error', message: e.message });
    return;
  }
  const buddyModel = provider.name;
  const buddySessionId = getOrCreateBuddySessionId(args['session-id'], args['project-dir']);
  // Resolution order (most specific → least, to avoid global session.json overwrite race):
  //   0. --provider-session-id (explicit provider namespace)
  //   1. --codex-session-id (explicit)
  //   2. --verification-task-id → look up provider_session_id from session log
  //   3. loadSession() global last pointer (deprecated; warns)
  let providerSessionId = args['provider-session-id'] || args['codex-session-id'] || null;
  if (!providerSessionId && args['verification-task-id']) {
    providerSessionId = lookupProviderSessionByTaskId(buddySessionId, args['verification-task-id'], buddyModel);
  }
  if (!providerSessionId && buddyModel === 'codex') {
    providerSessionId = loadSession();
    if (providerSessionId) {
      process.stderr.write('[buddy-runtime] Warning: using global ~/.buddy/session.json pointer; pass --verification-task-id or --codex-session-id to disambiguate.\n');
    }
  }

  if (!providerSessionId) {
    output({
      status: 'error',
      provider: buddyModel,
      message: `No ${provider.displayName || buddyModel} provider session ID available for follow-up. Pass --verification-task-id <id> or --provider-session-id <id>${buddyModel === 'codex' ? ' / --codex-session-id <id>, or run probe with --ephemeral false first' : ''}.`,
    });
    return;
  }

  const ev = await loadEvidence(args);
  if (!ev.ok) {
    output({ status: 'error', message: ev.error });
    return;
  }
  const prompt = ev.prompt;
  const startTime = Date.now();
  const verificationTaskId = args['verification-task-id'] || newVerificationTaskId();
  process.stderr.write(`[buddy] followup started, provider=${buddyModel}, sid=${buddySessionId}, provider_session=${providerSessionId.slice(0, 8)}, ETA 30-80s\n`);
  appendSessionEventBestEffort(buddySessionId, verificationTaskId, 'followup.start', {
    evidence_source: ev.source,
    provider: buddyModel,
    provider_session_id: providerSessionId,
    ...(buddyModel === 'codex' ? { codex_session_id: providerSessionId } : {}),
  }, prompt);

  try {
    const turn = await provider.followupTurn({
      prompt,
      providerSessionId,
      projectDir: args['project-dir'],
      model: args.model || null,
    });
    const providerResult = turn.finalMessage || '';

    const envelope = createEnvelope({
      turn: parseInt(args.turn) || 0,
      level: args.level || 'V2',
      rule: args.rule || 'vlevel:V2',
      route: buddyModel,
      evidence: [`${buddyModel}-followup: ${providerResult.slice(0, 1000)}`],
      conclusion: 'needs-review',
    });

    const latencyMs = Date.now() - startTime;
    const auditLogged = appendAuditLogBestEffort(logFilePath(), {
      envelope,
      buddySessionId,
      workspace: args['project-dir'],
      action: 'followup',
      verificationTaskId,
      latencyMs,
      model: buddyModel,
    });

    appendSessionEventBestEffort(buddySessionId, verificationTaskId, 'followup.provider_output', {
      provider: turn.provider,
      transport: turn.transport,
      runtime: turn.runtime,
      provider_session_id: turn.providerSessionId || providerSessionId,
      ...(turn.codexSessionId ? { codex_session_id: turn.codexSessionId } : {}),
      latency_ms: latencyMs,
      provider_output_file: turn.outputFile || null,
      ...(turn.outputFile && turn.provider === 'codex' ? { codex_output_file: turn.outputFile } : {}),
      events_count: (turn.events || []).length,
    }, providerResult);

    if (turn.provider === 'codex') {
      appendSessionEventBestEffort(buddySessionId, verificationTaskId, 'followup.codex_output', {
        codex_session_id: turn.codexSessionId || turn.providerSessionId || providerSessionId,
        provider_session_id: turn.providerSessionId || providerSessionId,
        latency_ms: latencyMs,
        codex_output_file: turn.outputFile || null,
      }, providerResult);
    }

    process.stderr.write(`[buddy] followup completed in ${latencyMs}ms\n`);

    output({
      status: 'verified',
      rule: envelope.rule,
      route: buddyModel,
      provider: turn.provider,
      model: buddyModel,
      transport: turn.transport,
      evidence_summary: envelope.evidence,
      provider_output_file: turn.outputFile || null,
      ...(turn.outputFile && turn.provider === 'codex' ? { codex_output_file: turn.outputFile } : {}),
      conclusion: envelope.conclusion,
      unverified: envelope.unverified,
      session_id: buddySessionId,
      verification_task_id: verificationTaskId,
      provider_session_id: turn.providerSessionId || providerSessionId,
      codex_session_id: turn.codexSessionId || (turn.provider === 'codex' ? (turn.providerSessionId || providerSessionId) : null),
      audit_logged: auditLogged,
      call_count: getCallCountBestEffort(logFilePath(), buddySessionId),
    });
  } catch (e) {
    appendSessionEventBestEffort(buddySessionId, verificationTaskId, 'followup.error', {
      message: e.message.split('\n')[0],
      provider: buddyModel,
      provider_session_id: providerSessionId,
      ...(buddyModel === 'codex' ? { codex_session_id: providerSessionId } : {}),
    });
    output({
      status: 'error',
      rule: e.code || `${buddyModel}-followup-failed`,
      provider: buddyModel,
      message: e.message.split('\n')[0],
      verification_task_id: verificationTaskId,
      recoverable: e.recoverable === true || undefined,
      recovery_hint: e.recoveryHint || undefined,
    });
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
  const auditEvent = appendSessionEventBestEffort(buddySessionId, taskId, 'annotate', fields);
  output({ status: 'ok', session_id: buddySessionId, verification_task_id: taskId,
           annotated: fields, audit_logged: !!auditEvent, message: 'Annotated session-log probe' });
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
  const auditEvent = appendSessionEventBestEffort(buddySessionId, verificationTaskId, 'probe.synthesis', {
    note: args.note || null,
  }, content);
  output({ status: 'ok', session_id: buddySessionId, verification_task_id: verificationTaskId, audit_logged: !!auditEvent, message: 'Synthesis logged' });
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
  const auditEvent = appendSessionEventBestEffort(buddySessionId, verificationTaskId, `reply.${kind}`, {
    kind,
  }, content || '(empty)');
  output({ status: 'ok', session_id: buddySessionId, verification_task_id: verificationTaskId, kind, audit_logged: !!auditEvent, message: 'Reply logged' });
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

async function actionStatus(args) {
  const buddySessionId = args['session-id'] || loadBuddySession(args['project-dir'] ? { cwd: args['project-dir'] } : {});
  if (!buddySessionId) {
    output({ status: 'error', message: 'No buddy session ID. Pass --session-id <id>.' });
    return;
  }
  const events = readSessionEvents(buddySessionId)
    .filter((event) => !args['verification-task-id'] || event.verification_task_id === args['verification-task-id']);
  const latest = (eventName) => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].event === eventName) return events[i];
    }
    return null;
  };
  const completed = latest('probe.completed');
  const outputEvent = latest('probe.provider_output');
  const errorEvent = latest('probe.error');
  const startEvent = latest('probe.start');
  const taskId = completed?.verification_task_id || outputEvent?.verification_task_id || errorEvent?.verification_task_id || startEvent?.verification_task_id || args['verification-task-id'] || null;

  if (completed) {
    const finalState = completed.final_state || 'completed';
    output({
      status: 'ok',
      session_id: buddySessionId,
      verification_task_id: taskId,
      final_state: finalState,
      host_state: finalState,
      provider: completed.provider || outputEvent?.provider || startEvent?.provider || null,
      transport: completed.transport || outputEvent?.transport || null,
      runtime: completed.runtime || outputEvent?.runtime || null,
      rule: completed.rule || startEvent?.rule || null,
      message: completed.message || null,
      completed_at: completed.completed_at || completed.ts,
      duration_ms: completed.duration_ms ?? outputEvent?.latency_ms ?? null,
      exit_code: completed.exit_code ?? null,
      session_log_path: completed.session_log_path || getSessionLogPath(buddySessionId),
      events_count: events.length,
    });
    return;
  }

  if (outputEvent || errorEvent || startEvent) {
    const finalState = outputEvent ? 'legacy_completed' : (errorEvent ? 'error' : 'running');
    output({
      status: 'ok',
      session_id: buddySessionId,
      verification_task_id: taskId,
      final_state: finalState,
      host_state: finalState,
      provider: outputEvent?.provider || errorEvent?.provider || startEvent?.provider || null,
      transport: outputEvent?.transport || null,
      runtime: outputEvent?.runtime || null,
      rule: outputEvent?.rule || startEvent?.rule || null,
      message: errorEvent?.message || null,
      completed_at: outputEvent?.ts || errorEvent?.ts || null,
      started_at: startEvent?.ts || null,
      duration_ms: outputEvent?.latency_ms ?? null,
      exit_code: outputEvent?.exit_code ?? (errorEvent ? 1 : null),
      session_log_path: getSessionLogPath(buddySessionId),
      events_count: events.length,
    });
    return;
  }

  output({
    status: 'ok',
    session_id: buddySessionId,
    verification_task_id: args['verification-task-id'] || null,
    final_state: 'unknown',
    host_state: 'unknown',
    session_log_path: getSessionLogPath(buddySessionId),
    events_count: events.length,
  });
}

async function actionMetrics(args) {
  const stats = getStats(logFilePath(), args['session-id'] || null);
  output({ status: 'ok', ...stats });
}

function readTextArg(args, key) {
  const value = args[key];
  if (!value || value === 'true') return null;
  if (fs.existsSync(value)) return fs.readFileSync(value, 'utf8');
  return value;
}

async function actionAssessReply(args) {
  const prompt = readTextArg(args, 'prompt') || '';
  const reply = readTextArg(args, 'reply') || '';
  let assertions = {};
  if (args.assertions && args.assertions !== 'true') {
    const raw = fs.existsSync(args.assertions) ? fs.readFileSync(args.assertions, 'utf8') : args.assertions;
    try {
      assertions = JSON.parse(raw);
    } catch (e) {
      output({ status: 'error', message: `Invalid --assertions JSON: ${e.message}` });
      return;
    }
  }
  output(assessReply({ prompt, reply, assertions }));
}

async function main() {
  const args = parseArgs(process.argv);

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
    case 'assess-reply':
      await actionAssessReply(args);
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
    case 'status':
      await actionStatus(args);
      break;
    default:
      output({ status: 'error', message: `Unknown action: ${args.action}` });
  }
}

main().catch(e => {
  output({ status: 'error', message: e.message });
  process.exit(1);
});
