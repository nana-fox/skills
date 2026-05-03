import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getProvider,
  listProviders,
  normalizeProviderName,
  shouldFallbackFromBrokerError,
} from '../providers.mjs';

function fakeProviderKimi(body) {
  const file = path.join(os.tmpdir(), `fake-provider-kimi-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

async function withFakeKimi(bin, fn) {
  const prevBin = process.env.BUDDY_KIMI_BIN;
  const prevTransport = process.env.BUDDY_KIMI_TRANSPORT;
  const prevNoContentTimeout = process.env.BUDDY_KIMI_NO_CONTENT_TIMEOUT_MS;
  try {
    process.env.BUDDY_KIMI_BIN = bin;
    delete process.env.BUDDY_KIMI_TRANSPORT;
    return await fn();
  } finally {
    if (prevBin === undefined) delete process.env.BUDDY_KIMI_BIN;
    else process.env.BUDDY_KIMI_BIN = prevBin;
    if (prevTransport === undefined) delete process.env.BUDDY_KIMI_TRANSPORT;
    else process.env.BUDDY_KIMI_TRANSPORT = prevTransport;
    if (prevNoContentTimeout === undefined) delete process.env.BUDDY_KIMI_NO_CONTENT_TIMEOUT_MS;
    else process.env.BUDDY_KIMI_NO_CONTENT_TIMEOUT_MS = prevNoContentTimeout;
  }
}

describe('providers', () => {
  test('normalizes missing provider to codex', () => {
    assert.equal(normalizeProviderName(undefined), 'codex');
    assert.equal(normalizeProviderName(''), 'codex');
  });

  test('describes codex as broker-capable and kimi as wire-first', () => {
    const codex = getProvider('codex');
    const kimi = getProvider('kimi');

    assert.equal(codex.name, 'codex');
    assert.deepEqual(codex.transports, ['broker', 'app-server', 'exec']);
    assert.equal(codex.supportsFreshThread, true);

    assert.equal(kimi.name, 'kimi');
    assert.deepEqual(kimi.transports, ['wire', 'exec']);
    assert.equal(kimi.supportsFreshThread, false);
    assert.equal(kimi.capabilities.supportsCancel, true);
    assert.equal(kimi.capabilities.supportsStreaming, true);
  });

  test('registry exposes provider contract entrypoints', () => {
    assert.deepEqual(listProviders().sort(), ['codex', 'kimi']);
    for (const name of listProviders()) {
      const provider = getProvider(name);
      assert.equal(typeof provider.preflight, 'function');
      assert.equal(typeof provider.startTurn, 'function');
      assert.equal(typeof provider.followupTurn, 'function');
      assert.ok(provider.capabilities);
      assert.equal(provider.capabilities.name, name);
      assert.ok(Array.isArray(provider.capabilities.transports));
      assert.equal(typeof provider.capabilities.supportsFollowup, 'boolean');
    }
  });

  test('kimi followup is an explicit unsupported provider result', async () => {
    const kimi = getProvider('kimi');
    await assert.rejects(
      () => kimi.followupTurn({ providerSessionId: 'kimi-session', prompt: 'followup' }),
      (err) => err.code === 'kimi-followup-unsupported'
        && /does not support follow-up/i.test(err.message),
    );
  });

  test('kimi startTurn uses wire transport by default', async () => {
    const fakeKimi = fakeProviderKimi(`
import readline from 'node:readline';
if (process.argv.includes('--version')) {
  console.log('kimi, version fake');
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'prompt') {
    send({ jsonrpc: '2.0', id: msg.id, result: { text: 'wire provider result' } });
    process.exit(0);
  }
});
`);
    try {
      const result = await withFakeKimi(fakeKimi, () => getProvider('kimi').startTurn({
        prompt: 'review',
        projectDir: '/tmp',
        timeoutMs: 2000,
      }));
      assert.equal(result.transport, 'wire');
      assert.equal(result.finalMessage, 'wire provider result');
    } finally {
      fs.rmSync(fakeKimi, { force: true });
    }
  });

  test('kimi startTurn falls back to exec when wire startup fails', async () => {
    const fakeKimi = fakeProviderKimi(`
if (process.argv.includes('--version')) {
  console.log('kimi, version fake');
  process.exit(0);
}
if (process.argv.includes('--wire')) {
  console.error('wire unsupported');
  process.exit(2);
}
console.log('exec provider result');
process.exit(0);
`);
    try {
      const result = await withFakeKimi(fakeKimi, () => getProvider('kimi').startTurn({
        prompt: 'review',
        projectDir: '/tmp',
        timeoutMs: 2000,
      }));
      assert.equal(result.transport, 'exec');
      assert.equal(result.fallback, 'wire-to-exec');
      assert.equal(result.degraded, true);
      assert.equal(result.finalMessage, 'exec provider result');
    } finally {
      fs.rmSync(fakeKimi, { force: true });
    }
  });

  test('kimi startTurn does not fall back from wire timeout', async () => {
    const fakeKimi = fakeProviderKimi(`
import readline from 'node:readline';
if (process.argv.includes('--version')) {
  console.log('kimi, version fake');
  process.exit(0);
}
if (!process.argv.includes('--wire')) {
  console.log('exec fallback must not run');
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
});
`);
    try {
      await assert.rejects(
        () => withFakeKimi(fakeKimi, () => getProvider('kimi').startTurn({
          prompt: 'review',
          projectDir: '/tmp',
          timeoutMs: 50,
        })),
        (err) => err.code === 'kimi-wire-timeout',
      );
    } finally {
      fs.rmSync(fakeKimi, { force: true });
    }
  });

  test('kimi startTurn does not fall back from wire no-progress', async () => {
    const fakeKimi = fakeProviderKimi(`
import readline from 'node:readline';
if (process.argv.includes('--version')) {
  console.log('kimi, version fake');
  process.exit(0);
}
if (!process.argv.includes('--wire')) {
  console.log('exec fallback must not run');
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'prompt') {
    setInterval(() => {
      send({ jsonrpc: '2.0', method: 'event', params: { type: 'ContentPart', payload: { type: 'tool_call', name: 'noop' } } });
    }, 5);
  }
});
`);
    try {
      await assert.rejects(
        () => withFakeKimi(fakeKimi, () => {
          process.env.BUDDY_KIMI_NO_CONTENT_TIMEOUT_MS = '50';
          return getProvider('kimi').startTurn({
            prompt: 'review',
            projectDir: '/tmp',
            timeoutMs: 1000,
          });
        }),
        (err) => err.code === 'kimi-wire-no-progress'
          && err.recoverable === true
          && /no review text/i.test(err.message),
      );
    } finally {
      fs.rmSync(fakeKimi, { force: true });
    }
  });

  test('rejects unknown buddy providers', () => {
    assert.throws(() => getProvider('gemini'), /Unsupported buddy model/);
  });

  test('classifies broker startup failures that can fall back to exec', () => {
    assert.equal(shouldFallbackFromBrokerError(new Error('listen EPERM: operation not permitted /tmp/x.sock')), true);
    assert.equal(shouldFallbackFromBrokerError(new Error('bind EACCES: permission denied /tmp/x.sock')), true);
    assert.equal(shouldFallbackFromBrokerError(new Error('spawnBroker: broker did not become reachable within 5000ms')), true);
    assert.equal(shouldFallbackFromBrokerError(new Error('turn/start failed: operation not permitted reading fixture')), false);
    assert.equal(shouldFallbackFromBrokerError(new Error('turn failed: model refused')), false);
  });
});
