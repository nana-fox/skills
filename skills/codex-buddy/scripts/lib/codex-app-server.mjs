/**
 * codex-app-server.mjs — JSON-RPC client for `codex app-server`.
 *
 * Protocol (from openai/codex-plugin-cc):
 *   1. Spawn `codex app-server` (stdio, JSONL, JSON-RPC 2.0)
 *   2. Send `initialize` (request) → receive result
 *   3. Send `initialized` (notification)
 *   4. Send `thread/start` (request) → returns { threadId }
 *   5. Send `turn/start` (request) → start a turn
 *   6. Listen for notifications: `item/completed`, `turn/completed`
 *      Collect agentMessage items → finalMessage = lastAgentMessage
 *   7. Close
 *
 * This is Phase A: spawn-per-call, no broker. Goal is protocol compatibility,
 * not max latency reduction. Phase B (broker) is gated on Phase A latency data.
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';

const SERVICE_NAME = 'codex-buddy';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min watchdog (matches exec)

class JsonRpcClient {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject }
    this.notificationHandler = () => {};
    this.closed = false;

    this.rl = readline.createInterface({ input: proc.stdout });
    this.rl.on('line', (line) => this._handleLine(line));

    proc.stderr.on('data', (d) => {
      // Surface in case of fatal init errors; non-fatal noise allowed.
      const s = d.toString();
      if (/^(ERROR|error|fatal|FATAL)/i.test(s)) process.stderr.write(`[codex app-server] ${s}`);
    });

    proc.on('exit', (code) => {
      this.closed = true;
      const err = new Error(`codex app-server exited (code=${code})`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });

    proc.on('error', (e) => {
      this.closed = true;
      const err = new Error(`codex app-server spawn error: ${e.message}`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
  }

  _handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(`JSON-RPC error: ${msg.error.message || JSON.stringify(msg.error)}`));
        else pending.resolve(msg.result);
      }
    } else if (msg.method) {
      this.notificationHandler(msg);
    }
  }

  request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error('app-server closed'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC ${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(payload);
    });
  }

  notify(method, params) {
    if (this.closed) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    this.proc.stdin.write(payload);
  }

  onNotification(handler) {
    this.notificationHandler = handler;
  }

  close() {
    if (this.closed) return;
    try { this.proc.stdin.end(); } catch {}
    try { this.rl.close(); } catch {}
  }
}

/**
 * Spawn `codex app-server` as a long-lived child. The W8 broker invokes this
 * once and keeps the process alive across many turns. Honours
 * BUDDY_BROKER_CODEX_BIN (test stubbing) — defaults to "codex".
 */
function spawnAppServer(cwd) {
  const bin = process.env.BUDDY_BROKER_CODEX_BIN || 'codex';
  // -c mcp_servers={} skips MCP server startup (matches exec mode optimization).
  // When using a test stub, allow it to receive plain stdio with no extra args.
  const args = process.env.BUDDY_BROKER_CODEX_BIN
    ? []
    : ['app-server', '-c', 'mcp_servers={}'];
  const proc = spawn(bin, args, {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return proc;
}

export { JsonRpcClient, spawnAppServer };

/**
 * Run a single Codex turn via app-server. Spawn-per-call (Phase A).
 *
 * @param {object} options
 * @param {string} options.prompt          — user prompt text
 * @param {string} options.projectDir      — cwd for the thread
 * @param {string} [options.model]         — model name; default null (use config)
 * @param {string} [options.sandbox]       — read-only | workspace-write | danger-full-access
 * @param {string} [options.outputSchema]  — path to JSON schema file
 * @param {boolean} [options.ephemeral]    — default true
 * @param {number} [options.watchdogMs]    — default 10 min
 * @returns {Promise<{ finalMessage: string, threadId: string, items: object[] }>}
 */
export async function runAppServerTurn({
  prompt,
  projectDir,
  model = null,
  sandbox = 'read-only',
  outputSchema = null,
  ephemeral = true,
  watchdogMs = DEFAULT_TIMEOUT_MS,
}) {
  const proc = spawnAppServer(projectDir);
  const client = new JsonRpcClient(proc);

  const turnState = {
    threadId: null,
    items: [],
    lastAgentMessage: '',
    completed: false,
    completionResolve: null,
    completionReject: null,
  };
  const completionPromise = new Promise((resolve, reject) => {
    turnState.completionResolve = resolve;
    turnState.completionReject = reject;
  });

  // Only accept notifications for our thread (defense against multi-thread broker mode).
  // turnState.threadId is set after thread/start; before that, accept all (single-thread phase).
  const matchesThread = (params) => {
    if (!turnState.threadId) return true;
    const t = params?.threadId || params?.thread_id || params?.thread?.id;
    return !t || t === turnState.threadId;
  };

  client.onNotification((msg) => {
    if (!matchesThread(msg.params)) return;
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
  });

  const watchdog = setTimeout(() => {
    turnState.completionReject(new Error(`app-server watchdog timeout after ${watchdogMs / 1000}s`));
    try { proc.kill('SIGTERM'); } catch {}
  }, watchdogMs);

  try {
    // 1. initialize handshake
    await client.request('initialize', {
      clientInfo: { name: SERVICE_NAME, version: '0.1.0' },
    });
    client.notify('initialized', {});

    // 2. thread/start (only send fields that map to v2 schema; omit null model)
    const threadParams = {
      cwd: projectDir,
      approvalPolicy: 'never',
      sandbox,
      ephemeral,
    };
    if (model) threadParams.model = model;
    const threadResult = await client.request('thread/start', threadParams);
    // ThreadStartResponse: { thread: { id, ... }, model, ... }
    turnState.threadId = threadResult?.thread?.id || null;
    if (!turnState.threadId) {
      throw new Error(`thread/start did not return thread.id: ${JSON.stringify(threadResult).slice(0, 200)}`);
    }

    // 3. turn/start
    const turnParams = {
      threadId: turnState.threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    };
    if (model) turnParams.model = model;
    if (outputSchema) turnParams.outputSchema = outputSchema;
    const turnResult = await client.request('turn/start', turnParams);

    // 4. wait for turn/completed via notifications
    await completionPromise;

    return {
      finalMessage: turnState.lastAgentMessage,
      threadId: turnState.threadId,
      items: turnState.items,
      turnResult,
    };
  } finally {
    clearTimeout(watchdog);
    client.close();
    try { proc.kill('SIGTERM'); } catch {}
  }
}

/**
 * Quick capability check: does `codex app-server` respond to initialize?
 * Returns true/false; never throws.
 */
export async function checkAppServerAvailable() {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawnAppServer(process.cwd()); } catch { return resolve(false); }
    let resolved = false;
    const finish = (ok) => {
      if (resolved) return;
      resolved = true;
      try { proc.kill('SIGTERM'); } catch {}
      resolve(ok);
    };
    const client = new JsonRpcClient(proc);
    const t = setTimeout(() => finish(false), 5000);
    client.request('initialize', { clientInfo: { name: SERVICE_NAME, version: '0.1.0' }, protocolVersion: '2025-01-01' })
      .then(() => { clearTimeout(t); finish(true); })
      .catch(() => { clearTimeout(t); finish(false); });
    proc.on('error', () => { clearTimeout(t); finish(false); });
  });
}
