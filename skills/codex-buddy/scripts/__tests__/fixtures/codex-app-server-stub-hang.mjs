#!/usr/bin/env node
/**
 * codex-app-server-stub-hang.mjs — test fixture that acks turn/start but
 * never sends item/completed or turn/completed, simulating a hung/stalled Codex.
 *
 * If BUDDY_STUB_LOG_FILE is set, appends every received JSON-RPC method name
 * (one per line) to that file — lets tests verify turn/interrupt was sent.
 */
import readline from 'node:readline';
import fs from 'node:fs';

const LOG_FILE = process.env.BUDDY_STUB_LOG_FILE;
let nextThreadIdx = 1;

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

function logMethod(method) {
  if (LOG_FILE) {
    try { fs.appendFileSync(LOG_FILE, method + '\n'); } catch {}
  }
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method } = msg;
  logMethod(method);
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { ok: true, server: 'codex-stub-hang' } });
  } else if (method === 'initialized') {
    // notification, no reply
  } else if (method === 'thread/start') {
    const threadId = `thr-${nextThreadIdx++}`;
    send({ jsonrpc: '2.0', id, result: { thread: { id: threadId }, model: 'stub' } });
  } else if (method === 'turn/start') {
    // Ack but NEVER send item/completed or turn/completed — simulates hung Codex.
    send({ jsonrpc: '2.0', id, result: { ok: true } });
  } else if (method === 'turn/interrupt') {
    send({ jsonrpc: '2.0', id, result: { ok: true } });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `stub: unknown method ${method}` } });
  }
});

rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
