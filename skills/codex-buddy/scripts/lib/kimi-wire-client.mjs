import { spawn } from 'node:child_process';
import readline from 'node:readline';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const INITIALIZE_TIMEOUT_MS = 2_000;

export async function runKimiWireTurn(prompt, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const startedAt = Date.now();
  const proc = spawnKimiWire(opts.projectDir);
  const client = new WireClient(proc);
  const events = [];
  let finalMessage = '';
  let initialized = true;

  client.onNotification((msg) => {
    if (msg.method === 'event') {
      const normalized = normalizeWireEvent(msg.params || {});
      if (normalized) events.push(normalized);
      return;
    }

    if (msg.method === 'request' && msg.id !== undefined) {
      const request = msg.params?.payload || msg.params?.request || {};
      const requestType = msg.params?.type || request.type || null;
      events.push({
        type: 'provider_event',
        subtype: 'kimi/request_rejected',
        payload: {
          request_type: requestType,
          reason: 'unsupported wire request in codex-buddy review mode',
        },
      });
      client.respondResult(msg.id, buildRejectedRequestResult(requestType, request));
    }
  });

  try {
    try {
      await withTimeout(
        client.request('initialize', {
          protocol_version: '1.9',
          client: { name: 'codex-buddy', version: '1.0.0' },
          capabilities: {
            supports_question: false,
            supports_plan_mode: false,
          },
        }),
        INITIALIZE_TIMEOUT_MS,
        'kimi wire initialize timeout',
      );
    } catch (err) {
      if (err?.code === -32601 || /method not found/i.test(err.message || '')) {
        initialized = false;
      } else if (/initialize timeout/i.test(err.message || '')) {
        initialized = false;
      } else {
        throw Object.assign(new Error(`Kimi wire initialize failed: ${err.message}`), {
          code: 'kimi-wire-initialize-failed',
        });
      }
    }

    const promptPromise = client.request('prompt', { user_input: prompt });
    const result = await requestWithCancelTimeout({
      promise: promptPromise,
      timeoutMs,
      onTimeout: async () => {
        try { await client.request('cancel', {}, 500); } catch {}
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
        }, killGraceMs).unref?.();
      },
    });
    finalMessage = extractText(result) || events
      .filter((event) => event.subtype === 'kimi/content')
      .map((event) => event.payload.text)
      .filter(Boolean)
      .join('');

    return {
      provider: 'kimi',
      model: 'kimi',
      transport: 'wire',
      runtime: 'wire',
      finalMessage,
      providerSessionId: extractSessionId(result),
      initialized,
      latencyMs: Date.now() - startedAt,
      events,
    };
  } finally {
    client.close();
  }
}

export function spawnKimiWire(projectDir) {
  const bin = process.env.BUDDY_KIMI_BIN || 'kimi';
  const proc = spawn(bin, ['--wire'], {
    cwd: projectDir || process.cwd(),
    env: {
      ...process.env,
      KIMI_CLI_NO_AUTO_UPDATE: process.env.KIMI_CLI_NO_AUTO_UPDATE || '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return proc;
}

class WireClient {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandler = () => {};
    this.stderrTail = [];
    this.closed = false;

    this.rl = readline.createInterface({ input: proc.stdout });
    this.rl.on('line', (line) => this.handleLine(line));

    proc.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        this.stderrTail.push(line);
        this.stderrTail = this.stderrTail.slice(-3);
      }
    });

    proc.on('exit', (code, signal) => {
      this.closed = true;
      const detail = this.stderrTail.length ? `: ${this.stderrTail.join(' | ')}` : '';
      const err = Object.assign(new Error(`kimi wire exited before response (code=${code}, signal=${signal})${detail}`), {
        code: 'kimi-wire-exit',
      });
      for (const pending of this.pending.values()) pending.reject(err);
      this.pending.clear();
    });

    proc.on('error', (err) => {
      this.closed = true;
      const wrapped = Object.assign(new Error(`kimi wire spawn error: ${err.message}`), {
        code: 'kimi-wire-spawn-failed',
      });
      for (const pending of this.pending.values()) pending.reject(wrapped);
      this.pending.clear();
    });
  }

  request(method, params = {}, timeoutMs = null) {
    if (this.closed) {
      return Promise.reject(Object.assign(new Error('kimi wire client is closed'), { code: 'kimi-wire-closed' }));
    }
    const id = String(this.nextId++);
    const payload = JSON.stringify({ id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(Object.assign(new Error(`kimi wire ${method} timeout after ${timeoutMs}ms`), {
            code: 'kimi-wire-timeout',
          }));
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      });
      this.proc.stdin.write(payload);
    });
  }

  respondError(id, code, message) {
    if (this.closed) return;
    this.proc.stdin.write(JSON.stringify({ id, error: { code, message } }) + '\n');
  }

  respondResult(id, result) {
    if (this.closed) return;
    this.proc.stdin.write(JSON.stringify({ id, result }) + '\n');
  }

  onNotification(handler) {
    this.notificationHandler = handler;
  }

  handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = Object.assign(new Error(msg.error.message || 'kimi wire JSON-RPC error'), {
          code: msg.error.code,
        });
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (msg.method) this.notificationHandler(msg);
  }

  close() {
    try { this.rl.close(); } catch {}
    try { this.proc.stdin.end(); } catch {}
    try { this.proc.kill('SIGTERM'); } catch {}
  }
}

function normalizeWireEvent(params) {
  const type = params.type || params.kind || params.event;
  const payload = params.payload || params.event || params;
  const text = extractText(payload);
  if (text) {
    return {
      type: 'provider_event',
      subtype: 'kimi/content',
      payload: { text, raw_type: type || null },
    };
  }
  return {
    type: 'provider_event',
    subtype: 'kimi/event',
    payload: { raw_type: type || null, event: payload },
  };
}

function extractText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.think === 'string') return '';
  if (typeof value.content === 'string') return value.content;
  if (typeof value.message === 'string') return value.message;
  const parts = value.parts || value.content || value.messages;
  if (Array.isArray(parts)) {
    return parts.map(extractText).filter(Boolean).join('\n\n');
  }
  return '';
}

function buildRejectedRequestResult(type, request) {
  if (type === 'ApprovalRequest') {
    return {
      request_id: request.id || request.request_id || null,
      response: 'reject',
      feedback: 'codex-buddy Kimi review mode does not approve client-side actions.',
    };
  }
  if (type === 'ToolCallRequest') {
    return {
      tool_call_id: request.id || request.tool_call_id || null,
      return_value: {
        is_error: true,
        output: 'codex-buddy Kimi review mode does not execute external tools.',
        message: 'External tool execution is disabled.',
        display: [],
      },
    };
  }
  if (type === 'QuestionRequest') {
    return {
      request_id: request.id || request.request_id || null,
      answers: {},
    };
  }
  if (type === 'HookRequest') {
    return {
      request_id: request.id || request.request_id || null,
      action: 'block',
      reason: 'codex-buddy Kimi review mode does not handle client hooks.',
    };
  }
  return {
    is_error: true,
    message: 'unsupported wire request in codex-buddy review mode',
  };
}

function extractSessionId(value) {
  return value?.sessionId || value?.session_id || value?.conversationId || value?.conversation_id || null;
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function requestWithCancelTimeout({ promise, timeoutMs, onTimeout }) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(async () => {
        await onTimeout();
        reject(Object.assign(new Error(`kimi wire prompt timed out after ${timeoutMs}ms`), {
          code: 'kimi-wire-timeout',
        }));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}
