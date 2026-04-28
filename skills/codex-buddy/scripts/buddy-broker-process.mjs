#!/usr/bin/env node
/**
 * buddy-broker-process.mjs — W7 broker daemon.
 *
 * Entry: spawned detached by lib/buddy-broker.mjs#spawnBroker. Reads target
 * paths from env (BUDDY_BROKER_SOCK, BUDDY_BROKER_PID, BUDDY_BROKER_PROJECT_ROOT).
 * Listens on a Unix domain socket; accepts line-delimited JSON-RPC.
 *
 * Methods (W7):
 *   ping          → { ok: true, pid, started_at, project_root }
 *   status        → same as ping plus uptime_ms
 *   shutdown      → { ok: true }, then closes server and exits cleanly
 *
 * Codex app-server forwarding (turn/start, thread/*) is W8.
 *
 * Lifecycle invariants:
 *   - PID file is written before listen() resolves; removed on graceful exit.
 *   - Socket file is unlinked on graceful exit and on SIGTERM.
 *   - Idle timeout: if no client connects within IDLE_TIMEOUT_MS, the broker
 *     exits to avoid orphans when a Claude session ends without firing the
 *     session-end hook.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { JsonRpcClient, spawnAppServer } from './lib/codex-app-server.mjs';

const SERVICE_NAME = 'codex-buddy-broker';
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

const SOCK = process.env.BUDDY_BROKER_SOCK;
const PID_PATH = process.env.BUDDY_BROKER_PID;
const PROJECT_ROOT = process.env.BUDDY_BROKER_PROJECT_ROOT || process.cwd();
const IDLE_TIMEOUT_MS = Number.parseInt(process.env.BUDDY_BROKER_IDLE_MS || '', 10) || 60 * 60 * 1000; // 1h
const STARTED_AT = Date.now();

if (!SOCK || !PID_PATH) {
  process.stderr.write('[buddy-broker] missing BUDDY_BROKER_SOCK or BUDDY_BROKER_PID env\n');
  process.exit(2);
}

let server;
let shuttingDown = false;
let idleTimer;

function log(msg) {
  // stdout/stderr are already redirected to broker-<hash>.log by the parent.
  process.stdout.write(`[buddy-broker ${new Date().toISOString()}] ${msg}\n`);
}

function cleanupFiles() {
  try { fs.unlinkSync(SOCK); } catch {}
  try { fs.unlinkSync(PID_PATH); } catch {}
}

function gracefulExit(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (idleTimer) clearTimeout(idleTimer);
  if (server) {
    try { server.close(); } catch {}
  }
  // Tear down the long-lived codex app-server child if any.
  if (codexClient) { try { codexClient.close(); } catch {} }
  if (codexProc) { try { codexProc.kill('SIGTERM'); } catch {} }
  cleanupFiles();
  // Give in-flight writes a tick to drain.
  setTimeout(() => process.exit(code), 50);
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    log(`idle timeout (${IDLE_TIMEOUT_MS}ms) reached — exiting`);
    gracefulExit(0);
  }, IDLE_TIMEOUT_MS);
  // Don't keep the event loop alive solely for the idle timer.
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

// W8: long-lived codex app-server. Spawn-once per broker; subsequent turns
// reuse the JsonRpcClient. This is what makes broker mode worth the
// orchestration cost (saves the 5-10s codex startup per probe).
let codexProc = null;
let codexClient = null;
let codexInitPromise = null;

async function ensureCodexClient() {
  if (codexClient && !codexClient.closed) return codexClient;
  if (codexInitPromise) return codexInitPromise;
  codexInitPromise = (async () => {
    log('spawning codex app-server (lazy first-turn)');
    codexProc = spawnAppServer(PROJECT_ROOT);
    const client = new JsonRpcClient(codexProc);
    codexProc.on('exit', (code) => {
      log(`codex app-server exited (code=${code})`);
      codexClient = null;
      codexProc = null;
    });
    await client.request('initialize', {
      clientInfo: { name: SERVICE_NAME, version: '0.1.0' },
    });
    client.notify('initialized', {});
    codexClient = client;
    log('codex app-server ready');
    return client;
  })();
  try {
    return await codexInitPromise;
  } finally {
    codexInitPromise = null;
  }
}

/**
 * Run one turn against the long-lived codex app-server. If params.threadId
 * is provided we skip thread/start (W8 thread persistence). Returns the
 * final agent message + threadId + first_byte_ms.
 */
async function runTurn(params) {
  const client = await ensureCodexClient();
  const {
    prompt,
    projectDir = PROJECT_ROOT,
    model = null,
    sandbox = 'read-only',
    outputSchema = null,
    ephemeral = false, // broker mode → persistent thread by default
    threadId: existingThreadId = null,
  } = params || {};
  if (!prompt) throw new Error('runTurn: prompt is required');

  const turnState = {
    threadId: existingThreadId,
    items: [],
    lastAgentMessage: '',
    completed: false,
    completionResolve: null,
    completionReject: null,
    firstByteAt: null,
    startedAt: Date.now(),
  };
  const completionPromise = new Promise((resolve, reject) => {
    turnState.completionResolve = resolve;
    turnState.completionReject = reject;
  });

  const matchesThread = (np) => {
    if (!turnState.threadId) return true;
    const t = np?.threadId || np?.thread_id || np?.thread?.id;
    return !t || t === turnState.threadId;
  };

  const notificationHandler = (msg) => {
    if (!matchesThread(msg.params)) return;
    if (turnState.firstByteAt === null) {
      turnState.firstByteAt = Date.now();
    }
    if (msg.method === 'item/completed') {
      const item = msg.params?.item || msg.params || {};
      turnState.items.push(item);
      if (item.type === 'agentMessage') {
        turnState.lastAgentMessage = item.text ?? turnState.lastAgentMessage;
      }
    } else if (msg.method === 'turn/completed') {
      turnState.completed = true;
      turnState.completionResolve();
    } else if (msg.method === 'turn/failed' || msg.method === 'turn/error' || msg.method === 'error') {
      turnState.completionReject(new Error(`turn failed: ${JSON.stringify(msg.params)}`));
    }
  };

  // Restore the previous handler when we're done — broker may run more turns.
  const prevHandler = client.notificationHandler;
  client.onNotification(notificationHandler);

  const watchdog = setTimeout(() => {
    turnState.completionReject(new Error(`broker turn watchdog timeout after ${TURN_TIMEOUT_MS / 1000}s`));
  }, TURN_TIMEOUT_MS);

  try {
    if (!turnState.threadId) {
      const threadParams = { cwd: projectDir, approvalPolicy: 'never', sandbox, ephemeral };
      if (model) threadParams.model = model;
      const tr = await client.request('thread/start', threadParams);
      turnState.threadId = tr?.thread?.id || null;
      if (!turnState.threadId) {
        throw new Error(`thread/start did not return thread.id: ${JSON.stringify(tr).slice(0, 200)}`);
      }
    }

    const turnParams = {
      threadId: turnState.threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    };
    if (model) turnParams.model = model;
    if (outputSchema) turnParams.outputSchema = outputSchema;
    await client.request('turn/start', turnParams);

    await completionPromise;

    return {
      finalMessage: turnState.lastAgentMessage,
      threadId: turnState.threadId,
      items: turnState.items,
      first_byte_ms: turnState.firstByteAt ? turnState.firstByteAt - turnState.startedAt : null,
      latency_ms: Date.now() - turnState.startedAt,
    };
  } finally {
    clearTimeout(watchdog);
    client.onNotification(prevHandler || (() => {}));
  }
}

async function handleRequest(req) {
  const { method, id } = req || {};
  switch (method) {
    case 'ping':
    case 'status':
      return {
        id,
        result: {
          ok: true,
          pid: process.pid,
          started_at: STARTED_AT,
          uptime_ms: Date.now() - STARTED_AT,
          project_root: PROJECT_ROOT,
          codex_ready: !!(codexClient && !codexClient.closed),
          method,
        },
      };
    case 'shutdown':
      // Reply, then schedule exit so the client gets the result.
      setImmediate(() => gracefulExit(0));
      return { id, result: { ok: true, shutting_down: true } };
    case 'turn/run':
      try {
        const result = await runTurn(req.params || {});
        return { id, result };
      } catch (e) {
        return { id, error: { code: -32000, message: e.message } };
      }
    default:
      return { id, error: { code: -32601, message: `unknown method: ${method}` } };
  }
}

function attachConnection(sock) {
  resetIdleTimer();
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', async (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch (e) {
        try { sock.write(JSON.stringify({ error: { code: -32700, message: `parse error: ${e.message}` } }) + '\n'); } catch {}
        continue;
      }
      try {
        const reply = await handleRequest(req);
        try { sock.write(JSON.stringify(reply) + '\n'); } catch {}
      } catch (e) {
        try { sock.write(JSON.stringify({ id: req.id, error: { code: -32000, message: e.message } }) + '\n'); } catch {}
      }
    }
  });
  sock.on('error', () => { try { sock.destroy(); } catch {} });
  sock.on('close', () => {});
}

async function main() {
  // Defensive: refuse to start if a sibling broker is already alive on the same sock.
  if (fs.existsSync(SOCK)) {
    // Try to connect. If it answers, abort. Else it's stale — unlink.
    const reachable = await new Promise((resolve) => {
      const probe = net.createConnection(SOCK);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => resolve(false));
      setTimeout(() => { try { probe.destroy(); } catch {}; resolve(false); }, 200);
    });
    if (reachable) {
      log(`refusing to start: another broker is alive on ${SOCK}`);
      process.exit(0);
    }
    try { fs.unlinkSync(SOCK); } catch {}
  }

  fs.mkdirSync(path.dirname(SOCK), { recursive: true });

  server = net.createServer(attachConnection);
  server.on('error', (err) => {
    log(`server error: ${err.message}`);
    gracefulExit(1);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(SOCK, () => {
      server.removeListener('error', reject);
      // Restrict to the current user; sockets default to umask which is usually fine
      // but be explicit since broker may carry sensitive prompt data later.
      try { fs.chmodSync(SOCK, 0o600); } catch {}
      resolve();
    });
  });

  fs.writeFileSync(PID_PATH, String(process.pid));
  log(`listening on ${SOCK} (pid=${process.pid}, project=${PROJECT_ROOT})`);
  resetIdleTimer();
}

process.on('SIGTERM', () => { log('SIGTERM'); gracefulExit(0); });
process.on('SIGINT', () => { log('SIGINT'); gracefulExit(0); });
process.on('uncaughtException', (err) => {
  log(`uncaught: ${err.stack || err.message}`);
  gracefulExit(1);
});

main().catch((err) => {
  log(`fatal: ${err.stack || err.message}`);
  cleanupFiles();
  process.exit(1);
});
