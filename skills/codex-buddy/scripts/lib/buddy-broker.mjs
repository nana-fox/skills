/**
 * buddy-broker.mjs — W7 broker lifecycle (client API).
 *
 * Manages a per-worktree broker daemon: spawn, connect, ping, shutdown,
 * detect-alive, stale-lock recovery. The daemon body lives in
 * scripts/buddy-broker-process.mjs. Codex app-server forwarding is W8.
 *
 * Endpoints (Unix domain sockets) live under BUDDY_HOME, namespaced by a
 * short hash of the worktree absolute path so multiple worktrees on the
 * same host don't collide.
 *
 *   ${BUDDY_HOME}/broker-<hash>.sock
 *   ${BUDDY_HOME}/broker-<hash>.pid
 *   ${BUDDY_HOME}/broker-<hash>.log
 *
 * Wire format: line-delimited JSON ({"id","method","params"} → {"id","result"|"error"}).
 * One-shot: each sendCommand opens a fresh connection, writes one request,
 * reads one reply, closes. (W8 may upgrade to a multiplexed long-lived
 * connection when forwarding turn notifications.)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getBuddyHome, resolveWorkspaceRoot } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROKER_PROCESS_PATH = path.resolve(HERE, '..', 'buddy-broker-process.mjs');

const SPAWN_WAIT_DEFAULT_MS = 5000;
const SHUTDOWN_WAIT_MS = 2000;
const COMMAND_TIMEOUT_MS = 5000;

/**
 * Hash the canonical workspace root for broker file naming.
 * W-017: align to resolveWorkspaceRoot (git root + realpathSync) so broker
 * files are co-located with the session state key — SessionEnd can reliably
 * find and stop the broker regardless of which subdir --project-dir was.
 */
export function getWorktreeHash(projectRoot) {
  const wsRoot = resolveWorkspaceRoot(projectRoot);
  let canonical = wsRoot;
  try { canonical = fs.realpathSync(wsRoot); } catch { /* non-existent path */ }
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

export function getBrokerPaths(home, projectRoot) {
  const root = home || getBuddyHome();
  const hash = getWorktreeHash(projectRoot);
  return {
    sockPath: path.join(root, `broker-${hash}.sock`),
    pidPath: path.join(root, `broker-${hash}.pid`),
    logPath: path.join(root, `broker-${hash}.log`),
    hash,
  };
}

function readPidFile(pidPath) {
  try {
    const raw = fs.readFileSync(pidPath, 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}


function tryUnlink(p) {
  try { fs.unlinkSync(p); } catch {}
}

function cleanupStaleFiles(paths) {
  tryUnlink(paths.sockPath);
  tryUnlink(paths.pidPath);
}

/**
 * Returns true iff a broker is reachable on sockPath. False if the socket file
 * is missing, refuses connection, or the recorded PID is dead.
 */
export async function isBrokerAlive(paths) {
  if (!fs.existsSync(paths.sockPath)) return false;
  // Cheap probe: open + close a connection. If the broker isn't listening
  // (e.g. we left a stale regular file), this fails fast.
  const reachable = await new Promise((resolve) => {
    const sock = net.createConnection(paths.sockPath);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    setTimeout(() => finish(false), 500);
  });
  // Socket connect is the authoritative check. Don't fall back to PID: OS can
  // reuse a PID after the broker exits, so a live PID != a live broker.
  return reachable;
}

/**
 * Spawn a fresh broker daemon. Cleans up any stale sock/pid first, then
 * launches `node scripts/buddy-broker-process.mjs` detached and waits for the
 * socket file to appear. Throws if the daemon does not become reachable
 * within waitMs.
 */
export async function spawnBroker({
  projectRoot,
  home,
  waitMs = SPAWN_WAIT_DEFAULT_MS,
} = {}) {
  if (!projectRoot) throw new Error('spawnBroker: projectRoot required');
  const buddyHome = home || getBuddyHome();
  fs.mkdirSync(buddyHome, { recursive: true });

  const paths = getBrokerPaths(buddyHome, projectRoot);

  // If a live broker is already running, reuse it.
  if (await isBrokerAlive(paths)) {
    const pid = readPidFile(paths.pidPath) || 0;
    return { paths, pid, reused: true };
  }
  cleanupStaleFiles(paths);

  // Official broker CLI: node app-server-broker.mjs serve --endpoint unix:<sock> --cwd <dir> --pid-file <pid>
  const endpoint = `unix:${paths.sockPath}`;
  const logFd = fs.openSync(paths.logPath, 'a');
  const child = spawn(process.execPath, [
    BROKER_PROCESS_PATH, 'serve',
    '--endpoint', endpoint,
    '--cwd', path.resolve(projectRoot),
    '--pid-file', paths.pidPath,
  ], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, BUDDY_HOME: buddyHome },
  });
  // Closing our copy of the fd is fine — child has its own.
  fs.closeSync(logFd);
  child.unref();

  // Surface immediate spawn failures synchronously where we can.
  const earlyErr = await Promise.race([
    new Promise((resolve) => child.once('error', resolve)),
    new Promise((resolve) => setTimeout(() => resolve(null), 50)),
  ]);
  if (earlyErr) throw new Error(`spawnBroker: ${earlyErr.message}`);

  // Poll for socket availability.
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await isBrokerAlive(paths)) {
      return { paths, pid: child.pid, reused: false };
    }
    await sleep(50);
  }
  // Timed out — kill any orphan and clean up before reporting.
  try { process.kill(child.pid, 'SIGTERM'); } catch {}
  cleanupStaleFiles(paths);
  throw new Error(`spawnBroker: broker did not become reachable within ${waitMs}ms (sock=${paths.sockPath})`);
}

/**
 * Open a fresh client connection to the broker. Caller is responsible for
 * closing it. Throws if the broker is not reachable.
 */
export function connectToBroker(paths, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(paths.sockPath);
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      reject(new Error(`connectToBroker: timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    sock.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(sock);
    });
    sock.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      reject(err);
    });
  });
}

/**
 * One-shot JSON-RPC: connect, send {id, method, params}, read one reply line, close.
 * Returns parsed reply object ({id, result} or {id, error}).
 */
export async function sendCommand(paths, { method, params, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const sock = await connectToBroker(paths, { timeoutMs });
  return new Promise((resolve, reject) => {
    const id = crypto.randomBytes(4).toString('hex');
    let buf = '';
    let settled = false;

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try { sock.destroy(); } catch {}
      fn(val);
    };

    const t = setTimeout(() => finish(reject, new Error(`sendCommand(${method}): timeout`)), timeoutMs);

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      const line = buf.slice(0, idx);
      try {
        finish(resolve, JSON.parse(line));
      } catch (e) {
        finish(reject, new Error(`sendCommand(${method}): invalid reply: ${e.message}`));
      }
    });
    sock.on('error', (err) => finish(reject, err));
    sock.on('close', () => finish(reject, new Error(`sendCommand(${method}): connection closed before reply`)));

    const payload = JSON.stringify({ id, method, params: params || {} }) + '\n';
    sock.write(payload);
  });
}

/**
 * Ask the broker to exit. Idempotent: if the broker isn't reachable, returns
 * silently. Waits up to SHUTDOWN_WAIT_MS for the socket file to disappear.
 */
export async function sendShutdown(paths) {
  if (!fs.existsSync(paths.sockPath)) {
    // Belt-and-suspenders: clean stale pid even when no sock present.
    tryUnlink(paths.pidPath);
    return;
  }
  try {
    await sendCommand(paths, { method: 'broker/shutdown' });
  } catch {
    // Broker may have closed the connection mid-reply; that's fine.
  }
  // Wait for files to vanish.
  const deadline = Date.now() + SHUTDOWN_WAIT_MS;
  while (Date.now() < deadline) {
    if (!fs.existsSync(paths.sockPath) && !fs.existsSync(paths.pidPath)) return;
    await sleep(25);
  }
  // C1 fix: do NOT SIGTERM the recorded PID — OS can reassign PIDs after the
  // broker exits; killing by stale PID risks killing an unrelated process.
  // Just unlink the lock files so a future spawnBroker can start fresh.
  cleanupStaleFiles(paths);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a turn via the official streaming broker protocol (stage6b).
 * Replaces turn/run (synchronous) with the official:
 *   initialize → initialized → thread/start (if no threadId) → turn/start
 *   → streaming item/completed notifications (real-time stderr) → turn/completed
 *
 * Returns { finalMessage, threadId, first_byte_ms, events }.
 */
export async function runBrokerTurn(brokerPaths, {
  prompt, projectDir, model, outputSchema, ephemeral, threadId: existingThreadId,
  timeoutMs = 10 * 60 * 1000,
} = {}) {
  const sock = await connectToBroker(brokerPaths, { timeoutMs: COMMAND_TIMEOUT_MS });
  return new Promise((resolve, reject) => {
    let buf = '';
    let nextId = 1;
    let firstByteAt = null;
    const startTime = Date.now();
    let finalMessage = '';
    let threadId = existingThreadId || null;
    const events = [];
    let settled = false;
    const pending = new Map();

    const watchdog = setTimeout(() => finish(reject, new Error('runBrokerTurn: timeout')), timeoutMs);

    function finish(fn, val) {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      try { sock.destroy(); } catch {}
      fn(val);
    }

    function send(msg) { sock.write(JSON.stringify(msg) + '\n'); }

    function request(method, params) {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej, method });
        send({ id, method, params: params || {} });
      });
    }

    function handleLine(line) {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }

      // Response to a pending request
      if (msg.id !== undefined && !msg.method) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result ?? {});
        return;
      }

      // Notification (no id) — streaming output
      if (msg.id === undefined && msg.method) {
        if (firstByteAt === null) firstByteAt = Date.now();
        events.push({
          type: 'provider_event',
          subtype: msg.method,
          payload: msg.params || {},
        });
        if (msg.method === 'item/completed') {
          const item = msg.params?.item || msg.params || {};
          if (item.type === 'agentMessage' && item.text) {
            finalMessage = item.text;
            // Real-time stderr: first 120 chars of latest agent message
            const preview = item.text.slice(0, 120).replace(/\n/g, ' ');
            process.stderr.write(`[buddy] Codex > ${preview}${item.text.length > 120 ? '…' : ''}\n`);
          }
        } else if (msg.method === 'turn/completed') {
          finish(resolve, {
            finalMessage,
            threadId,
            first_byte_ms: firstByteAt ? firstByteAt - startTime : null,
            events,
          });
        } else if (msg.method === 'turn/failed' || (msg.method === 'error' && !msg.id)) {
          finish(reject, new Error(`turn failed: ${JSON.stringify(msg.params)}`));
        }
      }
    }

    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
    sock.on('error', (err) => finish(reject, err));
    sock.on('close', () => { if (!settled) finish(reject, new Error('runBrokerTurn: connection closed unexpectedly')); });

    // Async kickoff
    (async () => {
      try {
        await request('initialize', { clientInfo: { title: 'codex-buddy', name: 'Claude Code', version: '1.0.0' } });
        send({ method: 'initialized', params: {} });
        if (!threadId) {
          const tParams = { cwd: projectDir, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: ephemeral !== false };
          if (model) tParams.model = model;
          const tr = await request('thread/start', tParams);
          threadId = tr?.thread?.id || null;
          if (!threadId) throw new Error('thread/start did not return thread.id');
        }
        const turnParams = { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] };
        if (model) turnParams.model = model;
        if (outputSchema) turnParams.outputSchema = outputSchema;
        await request('turn/start', turnParams);
        // Streaming notifications now flow until turn/completed
      } catch (err) {
        finish(reject, err);
      }
    })();
  });
}

// ─── W8: thread persistence per (buddy session, worktree) ───
// Conv file: ${BUDDY_HOME}/broker-thread-<buddy-sid>-<worktree-hash>.json
// Distinct from saveConversationSession (which keys codex exec session-ids).

function brokerThreadFile(home, buddySessionId, worktreeHash) {
  return path.join(home, `broker-thread-${buddySessionId}-${worktreeHash}.json`);
}

export function loadBrokerThread(buddySessionId, projectRoot, home) {
  if (!buddySessionId) return null;
  const buddyHome = home || getBuddyHome();
  const hash = getWorktreeHash(projectRoot);
  const file = brokerThreadFile(buddyHome, buddySessionId, hash);
  if (!fs.existsSync(file)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj.thread_id || null;
  } catch {
    return null;
  }
}

export function saveBrokerThread(buddySessionId, projectRoot, threadId, home, lastTask = null) {
  if (!buddySessionId || !threadId) return;
  const buddyHome = home || getBuddyHome();
  fs.mkdirSync(buddyHome, { recursive: true });
  const hash = getWorktreeHash(projectRoot);
  const file = brokerThreadFile(buddyHome, buddySessionId, hash);
  fs.writeFileSync(
    file,
    JSON.stringify({
      thread_id: threadId,
      buddy_session_id: buddySessionId,
      worktree_hash: hash,
      last_task: lastTask || null, // W6.5: first line of last task_to_judge for topic-drift check
      updated: new Date().toISOString(),
    }),
  );
}

/** Read the last_task stored alongside the thread for W6.5 drift detection. */
export function loadBrokerLastTask(buddySessionId, projectRoot, home) {
  if (!buddySessionId) return null;
  const buddyHome = home || getBuddyHome();
  const hash = getWorktreeHash(projectRoot);
  const file = brokerThreadFile(buddyHome, buddySessionId, hash);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).last_task || null;
  } catch {
    return null;
  }
}

export function clearBrokerThread(buddySessionId, projectRoot, home) {
  if (!buddySessionId) return;
  const buddyHome = home || getBuddyHome();
  const hash = getWorktreeHash(projectRoot);
  const file = brokerThreadFile(buddyHome, buddySessionId, hash);
  try { fs.unlinkSync(file); } catch {}
}
