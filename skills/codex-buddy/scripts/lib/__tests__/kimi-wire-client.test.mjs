import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runKimiWireTurn } from '../kimi-wire-client.mjs';

function fakeWireScript(body) {
  const file = path.join(os.tmpdir(), `fake-kimi-wire-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function withFakeKimi(bin, fn) {
  const prevBin = process.env.BUDDY_KIMI_BIN;
  try {
    process.env.BUDDY_KIMI_BIN = bin;
    return fn();
  } finally {
    if (prevBin === undefined) delete process.env.BUDDY_KIMI_BIN;
    else process.env.BUDDY_KIMI_BIN = prevBin;
  }
}

test('runKimiWireTurn collects event text and final result text', async () => {
  const fakeKimi = fakeWireScript(`
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 'kimi-wire-test' } });
    return;
  }
  if (msg.method === 'prompt') {
    if (msg.params?.user_input !== 'hello') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'missing user_input' } });
      return;
    }
    send({ jsonrpc: '2.0', method: 'event', params: { type: 'ContentPart', payload: { type: 'text', text: 'streamed hello' } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { parts: [{ type: 'ContentPart', text: 'final hello' }] } });
    process.exit(0);
  }
});
`);
  try {
    const result = await withFakeKimi(fakeKimi, () => runKimiWireTurn('hello', { projectDir: '/tmp', timeoutMs: 2000 }));
    assert.equal(result.transport, 'wire');
    assert.equal(result.runtime, 'wire');
    assert.equal(result.finalMessage, 'final hello');
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].subtype, 'kimi/content');
    assert.equal(result.events[0].payload.text, 'streamed hello');
  } finally {
    fs.rmSync(fakeKimi, { force: true });
  }
});

test('runKimiWireTurn continues when initialize is unsupported', async () => {
  const fakeKimi = fakeWireScript(`
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
    return;
  }
  if (msg.method === 'prompt') {
    if (msg.params?.user_input !== 'hello') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'missing user_input' } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { text: 'no initialize final' } });
    process.exit(0);
  }
});
`);
  try {
    const result = await withFakeKimi(fakeKimi, () => runKimiWireTurn('hello', { projectDir: '/tmp', timeoutMs: 2000 }));
    assert.equal(result.finalMessage, 'no initialize final');
    assert.equal(result.initialized, false);
  } finally {
    fs.rmSync(fakeKimi, { force: true });
  }
});

test('runKimiWireTurn safely rejects wire request messages', async () => {
  const fakeKimi = fakeWireScript(`
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'prompt') {
    send({ jsonrpc: '2.0', id: '99', method: 'request', params: { type: 'ToolCallRequest', payload: { id: 'tool-1', name: 'danger' } } });
    return;
  }
  if (msg.id === '99') {
    send({ jsonrpc: '2.0', id: '2', result: { text: msg.result?.return_value?.message || 'request rejected' } });
    process.exit(0);
  }
});
`);
  try {
    const result = await withFakeKimi(fakeKimi, () => runKimiWireTurn('hello', { projectDir: '/tmp', timeoutMs: 2000 }));
    assert.match(result.finalMessage, /disabled|rejected|unsupported/i);
    assert.equal(result.events[0].subtype, 'kimi/request_rejected');
  } finally {
    fs.rmSync(fakeKimi, { force: true });
  }
});

test('runKimiWireTurn sends cancel before killing a timed out prompt', async () => {
  const marker = path.join(os.tmpdir(), `kimi-wire-cancel-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  const fakeKimi = fakeWireScript(`
import fs from 'node:fs';
import readline from 'node:readline';
const marker = ${JSON.stringify(marker)};
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'prompt') send({ jsonrpc: '2.0', method: 'event', params: { type: 'ContentPart', payload: { type: 'text', text: 'started' } } });
  if (msg.method === 'cancel') {
    fs.writeFileSync(marker, 'cancelled');
    send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
  }
});
`);
  try {
    await assert.rejects(
      () => withFakeKimi(fakeKimi, () => runKimiWireTurn('hello', {
        projectDir: '/tmp',
        timeoutMs: 80,
        killGraceMs: 20,
      })),
      (err) => err.code === 'kimi-wire-timeout' && /timed out/i.test(err.message),
    );
    assert.equal(fs.readFileSync(marker, 'utf8'), 'cancelled');
  } finally {
    fs.rmSync(fakeKimi, { force: true });
    fs.rmSync(marker, { force: true });
  }
});
