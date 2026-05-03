import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  checkCodexAvailable,
  buildProbeArgs,
  buildResumeArgs,
  execCodex,
  parseSessionId,
  parseSessionIdFromSessions,
  saveSession,
  saveConversationSession,
  loadConversationSession,
  trimPrompt,
} from './codex-adapter.mjs';
import { execKimi, preflight as kimiPreflight } from './kimi-adapter.mjs';
import { runKimiWireTurn } from './kimi-wire-client.mjs';
import { runAppServerTurn } from './codex-app-server.mjs';
import {
  spawnBroker,
  runBrokerTurn,
  loadBrokerThread,
  saveBrokerThread,
  clearBrokerThread,
  loadBrokerLastTask,
} from './buddy-broker.mjs';
import { checkTopicDrift } from './topic-drift.mjs';

const PROVIDERS = {
  codex: {
    name: 'codex',
    displayName: 'Codex',
    transports: ['broker', 'app-server', 'exec'],
    supportsFreshThread: true,
    supportsFollowup: true,
    capabilities: {
      name: 'codex',
      transports: ['broker', 'app-server', 'exec'],
      supportsThread: true,
      supportsResume: true,
      supportsFollowup: true,
      supportsCancel: false,
      supportsStreaming: true,
      outputMode: 'events',
    },
    preflight() {
      const ok = checkCodexAvailable();
      return {
        status: ok ? 'ok' : 'error',
        codex_available: ok,
        model: 'codex',
        message: ok ? 'Codex CLI ready' : 'Codex CLI not found. Install: npm i -g @openai/codex',
      };
    },
    startTurn: startCodexTurn,
    followupTurn: followupCodexTurn,
  },
  kimi: {
    name: 'kimi',
    displayName: 'Kimi',
    transports: ['wire', 'exec'],
    supportsFreshThread: false,
    supportsFollowup: false,
    capabilities: {
      name: 'kimi',
      transports: ['wire', 'exec'],
      supportsThread: true,
      supportsResume: false,
      supportsFollowup: false,
      supportsCancel: true,
      supportsStreaming: true,
      outputMode: 'events',
    },
    preflight() {
      const kimi = kimiPreflight();
      return {
        status: kimi.ok ? 'ok' : 'error',
        kimi_available: kimi.ok,
        kimi_version: kimi.version,
        model: 'kimi',
        message: kimi.ok
          ? `Kimi CLI ready (${kimi.version})`
          : `Kimi CLI not found or failed: ${kimi.error}. Install: https://moonshotai.github.io/kimi-cli/`,
      };
    },
    startTurn: startKimiTurn,
    followupTurn: followupKimiTurn,
  },
};

export function normalizeProviderName(value) {
  const raw = String(value || 'codex').trim().toLowerCase();
  return raw || 'codex';
}

export function getProvider(value) {
  const name = normalizeProviderName(value);
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unsupported buddy model: ${name}. Expected one of: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return provider;
}

export function listProviders() {
  return Object.keys(PROVIDERS);
}

async function startKimiTurn({
  prompt,
  projectDir,
  model = null,
  timeoutMs,
  onEvent = null,
} = {}) {
  const available = kimiPreflight();
  if (!available.ok) {
    throw Object.assign(
      new Error(`Kimi CLI not found or failed: ${available.error}. Install: https://moonshotai.github.io/kimi-cli/`),
      { code: 'kimi-unavailable' },
    );
  }
  const startedAt = Date.now();
  const transport = normalizeKimiTransport(process.env.BUDDY_KIMI_TRANSPORT);
  if (transport === 'wire') {
    try {
      process.stderr.write('[buddy] kimi wire probe started, ETA 30-80s\n');
      const noContentTimeoutMs = parsePositiveInt(process.env.BUDDY_KIMI_NO_CONTENT_TIMEOUT_MS);
      const wire = await runKimiWireTurn(prompt, {
        projectDir,
        timeoutMs,
        onEvent,
        ...(noContentTimeoutMs ? { noContentTimeoutMs } : {}),
      });
      const latencyMs = Date.now() - startedAt;
      process.stderr.write(`[buddy] kimi wire probe completed in ${latencyMs}ms\n`);
      return {
        ...wire,
        latencyMs,
        degraded: false,
        events: [
          { type: 'provider_event', subtype: 'turn/started', payload: { provider: 'kimi', transport: 'wire' } },
          ...(wire.events || []),
          { type: 'provider_event', subtype: 'turn/completed', payload: { provider: 'kimi', transport: 'wire' } },
        ],
      };
    } catch (err) {
      if (!shouldFallbackFromKimiWireError(err)) throw err;
      process.stderr.write(`[buddy] kimi wire failed, falling back to exec: ${err.message}\n`);
      return startKimiExecTurn({ prompt, projectDir, model, timeoutMs, fallback: 'wire-to-exec', startedAt });
    }
  }

  return startKimiExecTurn({ prompt, projectDir, model, timeoutMs, fallback: 'none', startedAt });
}

function startKimiExecTurn({
  prompt,
  projectDir,
  model = null,
  timeoutMs,
  fallback = 'none',
  startedAt = Date.now(),
} = {}) {
  process.stderr.write('[buddy] kimi probe started, ETA 30-80s\n');
  const result = execKimi(prompt, { projectDir, model: model || undefined, timeoutMs });
  if (result.spawnError) {
    const timeout = result.errorCode === 'kimi-timeout' ? ` after ${result.timeoutMs}ms` : '';
    throw Object.assign(
      new Error(`Kimi spawn error${timeout}: ${result.spawnError} (bin=${result.bin}, cwd=${result.cwd})`),
      { code: result.errorCode || 'kimi-spawn-failed' },
    );
  }
  if (result.exitCode !== 0) {
    const detail = result.stderrTail || (result.stderr || result.raw || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ');
    if (result.errorCode === 'kimi-permission') {
      throw Object.assign(
        new Error(`Kimi permission error: ${detail} (bin=${result.bin}, cwd=${result.cwd})`),
        { code: 'kimi-permission' },
      );
    }
    throw Object.assign(
      new Error(`Kimi exited with code ${result.exitCode}${detail ? `: ${detail}` : ''}`),
      { code: 'kimi-exit-failed' },
    );
  }
  if (!String(result.raw || '').trim() && result.parseStatus === 'failed') {
    const detail = String(result.stderr || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ');
    throw Object.assign(
      new Error(`Kimi returned empty output${detail ? `: ${detail}` : ''}`),
      { code: 'kimi-empty-output' },
    );
  }
  const finalMessage = result.parseStatus !== 'failed'
    ? result.parsed.text.join('\n\n')
    : result.raw;
  const latencyMs = Date.now() - startedAt;
  process.stderr.write(`[buddy] kimi probe completed in ${latencyMs}ms, parse_status=${result.parseStatus}\n`);
  return {
    provider: 'kimi',
    model: 'kimi',
    transport: 'exec',
    runtime: 'exec',
    finalMessage,
    providerSessionId: result.parsed.sessionId,
    parseStatus: result.parseStatus,
    parserVersion: result.parserVersion,
    fallback: fallback === 'none'
      ? (result.parseStatus !== 'failed' ? 'none' : 'raw')
      : fallback,
    degraded: true,
    exitCode: result.exitCode,
    errorCode: result.errorCode || null,
    stderrTail: result.stderrTail || '',
    timeoutMs: result.timeoutMs,
    bin: result.bin,
    cwd: result.cwd,
    latencyMs,
    events: [
      { type: 'provider_event', subtype: 'turn/started', payload: { provider: 'kimi' } },
      { type: 'provider_event', subtype: 'message/completed', payload: { text: finalMessage } },
      { type: 'provider_event', subtype: 'turn/completed', payload: { exit_code: result.exitCode } },
    ],
    think: result.parsed.think || [],
  };
}

function normalizeKimiTransport(value) {
  const raw = String(value || 'wire').trim().toLowerCase();
  if (raw === 'exec') return 'exec';
  return 'wire';
}

function parsePositiveInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function shouldFallbackFromKimiWireError(err) {
  const code = err?.code || '';
  return [
    'kimi-wire-spawn-failed',
    'kimi-wire-exit',
    'kimi-wire-initialize-failed',
    'kimi-wire-closed',
  ].includes(code);
}

async function followupKimiTurn() {
  throw Object.assign(
    new Error('Kimi provider does not support follow-up resume yet; run a fresh probe or resume manually with kimi -r if you have a provider session id.'),
    { code: 'kimi-followup-unsupported' },
  );
}

async function startCodexTurn({
  prompt,
  projectDir,
  model = null,
  outputSchema = null,
  buddySessionId,
  sessionPolicy = 'isolated',
  ephemeral: ephemeralArg = undefined,
  freshThread = false,
  startTime = Date.now(),
} = {}) {
  if (process.env.BUDDY_STUB_CODEX !== '1' && !checkCodexAvailable()) {
    throw Object.assign(new Error('Codex CLI not found'), { code: 'codex-unavailable' });
  }

  const isConversation = sessionPolicy === 'conversation';
  const resumedSessionId = isConversation ? loadConversationSession(buddySessionId) : null;
  const ephemeral = isConversation ? false : ephemeralArg !== 'false';
  const useBroker = process.env.BUDDY_USE_LEGACY_EXEC !== '1'
    && process.env.BUDDY_USE_BROKER !== '0'
    && !resumedSessionId;
  const useAppServer = !useBroker && process.env.BUDDY_USE_APP_SERVER === '1' && !resumedSessionId;
  const requestedTransport = useBroker ? 'broker' : (useAppServer ? 'app-server' : 'exec');
  let transport = requestedTransport;
  let brokerFallback = false;
  let brokerFallbackReason = null;
  let finalMessage = '';
  let threadId = null;
  let codexSessionId = null;
  let firstByteMs = null;
  let events = [];
  let outputFile = null;

  process.stderr.write(`[buddy] probe started, runtime=${requestedTransport}, sid=${buddySessionId}, ETA 30-80s\n`);

  if (useBroker) {
    try {
      if (process.env.BUDDY_FORCE_BROKER_STARTUP_ERROR) {
        throw new Error(process.env.BUDDY_FORCE_BROKER_STARTUP_ERROR);
      }
      const prevTask = freshThread ? null : loadBrokerLastTask(buddySessionId, projectDir);
      const { warning: driftWarning } = checkTopicDrift(prevTask, prompt);
      if (driftWarning) process.stderr.write(driftWarning + '\n');

      const persistedThread = freshThread ? null : loadBrokerThread(buddySessionId, projectDir);
      const brokerResult = await spawnBroker({ projectRoot: projectDir });
      const { paths: brokerPaths } = brokerResult;
      if (brokerResult.reused === false) {
        process.stderr.write(`[buddy] broker spawned, ready (pid=${brokerResult.pid})\n`);
      } else if (persistedThread) {
        process.stderr.write(`[buddy] reusing thread ${persistedThread}\n`);
      }
      const outputSchemaObj = loadOutputSchemaObject(outputSchema);
      const r = await runBrokerTurn(brokerPaths, {
        prompt: trimPrompt(prompt),
        projectDir,
        model,
        outputSchema: outputSchemaObj,
        ephemeral,
        threadId: persistedThread,
      });
      finalMessage = r.finalMessage || '';
      codexSessionId = r.threadId || null;
      threadId = r.threadId || null;
      firstByteMs = typeof r.first_byte_ms === 'number' ? r.first_byte_ms : null;
      events = r.events || [];
      if (!freshThread && codexSessionId) {
        saveBrokerThread(buddySessionId, projectDir, codexSessionId, undefined, prompt.split('\n')[0]);
      } else if (freshThread) {
        clearBrokerThread(buddySessionId, projectDir);
      }
    } catch (brokerErr) {
      if (!shouldFallbackFromBrokerError(brokerErr)) throw brokerErr;
      brokerFallback = true;
      brokerFallbackReason = brokerErr.message.split('\n')[0];
      transport = 'exec';
      process.stderr.write(`[buddy] broker unavailable, falling back to exec: ${brokerFallbackReason}\n`);
      const execResult = await runCodexExec({ prompt, projectDir, model, outputSchema, ephemeral, startTime });
      ({ finalMessage, codexSessionId, firstByteMs, outputFile } = execResult);
      events = [{ type: 'provider_event', subtype: 'transport/fallback', payload: { from: 'broker', to: 'exec', reason: brokerFallbackReason } }];
    }
  } else if (useAppServer) {
    const outputSchemaObj = loadOutputSchemaObject(outputSchema);
    const r = await runAppServerTurn({
      prompt: trimPrompt(prompt),
      projectDir,
      model,
      outputSchema: outputSchemaObj,
      ephemeral,
    });
    finalMessage = r.finalMessage || '';
    codexSessionId = r.threadId || null;
    threadId = r.threadId || null;
    events = (r.items || []).map((item) => ({ type: 'provider_event', subtype: 'item/completed', payload: { item } }));
    events.push({ type: 'provider_event', subtype: 'turn/completed', payload: { threadId } });
  } else {
    const execResult = await runCodexExec({
      prompt,
      projectDir,
      model,
      outputSchema,
      ephemeral,
      startTime,
      resumedSessionId,
    });
    ({ finalMessage, codexSessionId, firstByteMs, outputFile } = execResult);
  }

  if (transport !== 'broker') {
    if (codexSessionId) {
      saveSession(codexSessionId);
      if (isConversation) saveConversationSession(buddySessionId, codexSessionId);
    } else if (ephemeral) {
      saveSession('');
    }
  }

  return {
    provider: 'codex',
    model: 'codex',
    transport,
    runtime: transport,
    requestedTransport,
    brokerFallback,
    brokerFallbackReason,
    finalMessage,
    threadId,
    codexSessionId,
    firstByteMs,
    outputFile,
    events,
    ephemeral,
    sessionPolicy,
    resumed: !!resumedSessionId,
  };
}

async function followupCodexTurn({
  prompt,
  providerSessionId,
  projectDir,
} = {}) {
  if (!providerSessionId) {
    throw Object.assign(new Error('No Codex session ID available for follow-up.'), { code: 'codex-session-missing' });
  }
  if (process.env.BUDDY_STUB_CODEX !== '1' && !checkCodexAvailable()) {
    throw Object.assign(new Error('Codex CLI not found'), { code: 'codex-unavailable' });
  }

  const startedAt = Date.now();
  const outputFile = `/tmp/buddy-codex-followup-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`;
  const cmdSpec = buildResumeArgs({
    sessionId: providerSessionId,
    outputFile,
    prompt,
  });
  await execCodex(cmdSpec);
  const finalMessage = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';
  const latencyMs = Date.now() - startedAt;
  return {
    provider: 'codex',
    model: 'codex',
    transport: 'exec',
    runtime: 'exec',
    finalMessage,
    providerSessionId,
    codexSessionId: providerSessionId,
    outputFile,
    latencyMs,
    events: [
      { type: 'provider_event', subtype: 'followup/started', payload: { provider: 'codex', project_dir: projectDir || null } },
      { type: 'provider_event', subtype: 'followup/completed', payload: { provider_session_id: providerSessionId } },
    ],
  };
}

function loadOutputSchemaObject(schemaFile) {
  if (!schemaFile) return null;
  try { return JSON.parse(fs.readFileSync(schemaFile, 'utf8')); } catch { return null; }
}

async function runCodexExec({
  prompt,
  projectDir,
  model,
  outputSchema,
  ephemeral,
  startTime,
  resumedSessionId = null,
}) {
  let firstByteMs = null;
  const outputFile = `/tmp/buddy-codex-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`;
  const cmdSpec = resumedSessionId
    ? buildResumeArgs({ sessionId: resumedSessionId, outputFile, prompt })
    : buildProbeArgs({
        projectDir,
        outputFile,
        prompt,
        model,
        ephemeral,
        outputSchema,
      });
  const execOutput = await execCodex(cmdSpec, {
    onFirstByte: (ms) => { firstByteMs = ms; },
  });
  const codexSessionId = resumedSessionId
    || (ephemeral
      ? null
      : (parseSessionId(execOutput)
        || parseSessionIdFromSessions(Math.max(60_000, Date.now() - startTime + 5000))));
  const finalMessage = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';
  return { finalMessage, codexSessionId, firstByteMs, outputFile };
}

export function shouldFallbackFromBrokerError(error) {
  const message = String(error?.message || error || '');
  return /\b(?:listen|bind)\s+(?:EPERM|EACCES)\b|broker did not become reachable|ECONNREFUSED|EADDRINUSE/i.test(message);
}
