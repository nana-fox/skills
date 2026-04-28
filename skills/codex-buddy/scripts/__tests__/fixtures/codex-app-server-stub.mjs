#!/usr/bin/env node
/**
 * codex-app-server-stub.mjs — test fixture standing in for `codex app-server`.
 *
 * Speaks the same JSON-RPC line-protocol the broker speaks to Codex:
 *   - initialize    → { ok: true }
 *   - thread/start  → { thread: { id: "thr-<n>" } }
 *   - turn/start    → emits item/completed (agentMessage) + turn/completed
 *                     notifications, then returns an empty result.
 *
 * Honors env BUDDY_STUB_REPLY (default "stub-final-message") for the agent
 * message text. State is per-process so the broker's long-lived connection
 * sees thread reuse correctly: subsequent turn/start with same threadId
 * reuse the same id instead of allocating a new one.
 */
import readline from 'node:readline';

const REPLY = process.env.BUDDY_STUB_REPLY || 'stub-final-message';
let nextThreadIdx = 1;
const knownThreads = new Set();

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { ok: true, server: 'codex-stub' } });
  } else if (method === 'initialized') {
    // notification, no reply
  } else if (method === 'thread/start') {
    const threadId = `thr-${nextThreadIdx++}`;
    knownThreads.add(threadId);
    send({ jsonrpc: '2.0', id, result: { thread: { id: threadId }, model: 'stub' } });
  } else if (method === 'turn/start') {
    const threadId = params?.threadId || null;
    if (threadId) knownThreads.add(threadId);
    // 1. ack the request
    send({ jsonrpc: '2.0', id, result: { ok: true } });
    // 2. emit notifications: an agentMessage item, then turn/completed
    setImmediate(() => {
      send({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: { threadId, item: { type: 'agentMessage', text: REPLY } },
      });
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId } });
    });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `stub: unknown method ${method}` } });
  }
});

rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
