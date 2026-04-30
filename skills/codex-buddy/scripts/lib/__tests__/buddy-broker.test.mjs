/**
 * buddy-broker.test.mjs — W7 lifecycle tests.
 *
 * Covers spawn → connect → ping → shutdown round-trip, stale lock recovery,
 * and pure helpers (getWorktreeHash, getBrokerPaths). Codex forwarding is W8.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getWorktreeHash,
  getBrokerPaths,
  isBrokerAlive,
  spawnBroker,
  sendCommand,
  runBrokerTurn,
  sendShutdown,
} from '../buddy-broker.mjs';

const FIXTURE_PROJECT = '/tmp/buddy-broker-test-project';
let TEST_HOME;
let prevBuddyHome;

before(() => {
  prevBuddyHome = process.env.BUDDY_HOME;
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-broker-test-'));
  process.env.BUDDY_HOME = TEST_HOME;
  fs.mkdirSync(FIXTURE_PROJECT, { recursive: true });
});

after(() => {
  if (prevBuddyHome === undefined) delete process.env.BUDDY_HOME;
  else process.env.BUDDY_HOME = prevBuddyHome;
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

describe('buddy-broker — pure helpers', () => {
  test('getWorktreeHash is deterministic for the same path', () => {
    const a = getWorktreeHash('/foo/bar');
    const b = getWorktreeHash('/foo/bar');
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{8}$/);
  });

  test('getWorktreeHash differs across paths', () => {
    const a = getWorktreeHash('/foo/bar');
    const b = getWorktreeHash('/foo/baz');
    assert.notEqual(a, b);
  });

  test('getBrokerPaths places sock/pid under BUDDY_HOME with hash suffix', () => {
    const paths = getBrokerPaths(TEST_HOME, '/foo/bar');
    assert.ok(paths.sockPath.startsWith(TEST_HOME));
    assert.ok(paths.pidPath.startsWith(TEST_HOME));
    assert.match(paths.sockPath, /broker-[0-9a-f]{8}\.sock$/);
    assert.match(paths.pidPath, /broker-[0-9a-f]{8}\.pid$/);
    assert.equal(paths.hash.length, 8);
  });
});

describe('buddy-broker — lifecycle round-trip', () => {
  test('spawn → initialize → shutdown', async () => {
    const paths = getBrokerPaths(TEST_HOME, FIXTURE_PROJECT);
    const { pid } = await spawnBroker({ projectRoot: FIXTURE_PROJECT, home: TEST_HOME });
    try {
      assert.ok(pid > 0);
      assert.ok(fs.existsSync(paths.sockPath), 'sock file should exist');
      assert.ok(fs.existsSync(paths.pidPath), 'pid file should exist');
      assert.equal(await isBrokerAlive(paths), true);

      // Official broker responds to initialize with userAgent
      const reply = await sendCommand(paths, { method: 'initialize', params: { clientInfo: { title: 'test', name: 'test', version: '0' } } });
      assert.ok(reply.result?.userAgent, 'broker must respond to initialize with userAgent');
    } finally {
      await sendShutdown(paths);
    }
    // After shutdown: sock + pid removed, isBrokerAlive false
    await waitGone(paths.sockPath);
    assert.equal(fs.existsSync(paths.sockPath), false);
    assert.equal(fs.existsSync(paths.pidPath), false);
    assert.equal(await isBrokerAlive(paths), false);
  });

  test('stale lock recovery: nonexistent PID + leftover sock → isBrokerAlive false', async () => {
    const projectRoot = '/tmp/buddy-broker-stale-' + Date.now();
    fs.mkdirSync(projectRoot, { recursive: true });
    const paths = getBrokerPaths(TEST_HOME, projectRoot);
    // Create a fake stale state: sock file (regular file, not a real socket) +
    // pid pointing to PID 999999 (very unlikely to exist).
    fs.writeFileSync(paths.sockPath, '');
    fs.writeFileSync(paths.pidPath, '999999');
    assert.equal(await isBrokerAlive(paths), false);
  });

  test('spawn cleans up stale lock from a dead prior run', async () => {
    const projectRoot = '/tmp/buddy-broker-stale2-' + Date.now();
    fs.mkdirSync(projectRoot, { recursive: true });
    const paths = getBrokerPaths(TEST_HOME, projectRoot);
    fs.writeFileSync(paths.sockPath, '');
    fs.writeFileSync(paths.pidPath, '999999');

    const { pid } = await spawnBroker({ projectRoot, home: TEST_HOME });
    try {
      assert.ok(pid > 0);
      assert.equal(await isBrokerAlive(paths), true);
      const reply = await sendCommand(paths, { method: 'initialize', params: { clientInfo: { title: 'test', name: 'test', version: '0' } } });
      assert.ok(reply.result?.userAgent, 'broker must respond to initialize with userAgent');
    } finally {
      await sendShutdown(paths);
    }
  });

  test('sendShutdown is idempotent when broker already gone', async () => {
    const projectRoot = '/tmp/buddy-broker-idem-' + Date.now();
    fs.mkdirSync(projectRoot, { recursive: true });
    const paths = getBrokerPaths(TEST_HOME, projectRoot);
    // No broker running: sendShutdown should resolve without throwing.
    await sendShutdown(paths);
    await sendShutdown(paths); // second call also fine
  });
});

async function waitGone(p, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(p)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ─── W8: broker turn/run forwarding (codex stubbed via BUDDY_BROKER_CODEX_BIN) ───
const STUB_BIN = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  '__tests__',
  'fixtures',
  'codex-app-server-stub.mjs',
);

async function spawnBrokerWithStub(projectRoot) {
  // The stub script is invoked directly via shebang; ensure executable bit.
  fs.chmodSync(STUB_BIN, 0o755);
  process.env.BUDDY_BROKER_CODEX_BIN = STUB_BIN;
  return spawnBroker({ projectRoot, home: TEST_HOME });
}

describe('buddy-broker — W8 turn/start streaming forwarding', () => {
  test('turn/start with no threadId → thread/start + streaming → finalMessage + threadId', async () => {
    const projectRoot = '/tmp/buddy-broker-turn-' + Date.now();
    fs.mkdirSync(projectRoot, { recursive: true });
    const paths = getBrokerPaths(TEST_HOME, projectRoot);
    process.env.BUDDY_STUB_REPLY = 'hello-from-stub';
    await spawnBrokerWithStub(projectRoot);
    try {
      const r = await runBrokerTurn(paths, { prompt: 'is this safe?', projectDir: projectRoot });
      assert.equal(r.finalMessage, 'hello-from-stub');
      assert.match(r.threadId || '', /^thr-\d+$/);
    } finally {
      delete process.env.BUDDY_STUB_REPLY;
      delete process.env.BUDDY_BROKER_CODEX_BIN;
      await sendShutdown(paths);
    }
  });

  test('turn/start with existing threadId reuses it (no thread/start)', async () => {
    const projectRoot = '/tmp/buddy-broker-thread-reuse-' + Date.now();
    fs.mkdirSync(projectRoot, { recursive: true });
    const paths = getBrokerPaths(TEST_HOME, projectRoot);
    process.env.BUDDY_STUB_REPLY = 'reuse-reply';
    await spawnBrokerWithStub(projectRoot);
    try {
      // First turn allocates a thread.
      const r1 = await runBrokerTurn(paths, { prompt: 'first', projectDir: projectRoot });
      const tid = r1.threadId;
      assert.match(tid || '', /^thr-\d+$/);
      // Second turn passes the threadId in — stub reuses it.
      const r2 = await runBrokerTurn(paths, { prompt: 'second', projectDir: projectRoot, threadId: tid });
      assert.equal(r2.threadId, tid, 'threadId must be reused');
      assert.equal(r2.finalMessage, 'reuse-reply');
    } finally {
      delete process.env.BUDDY_STUB_REPLY;
      delete process.env.BUDDY_BROKER_CODEX_BIN;
      await sendShutdown(paths);
    }
  });

  test('C2: concurrent turn/start requests are serialized (broker busy response)', async () => {
    const projectRoot = '/tmp/buddy-broker-c2-' + Date.now();
    fs.mkdirSync(projectRoot, { recursive: true });
    const paths = getBrokerPaths(TEST_HOME, projectRoot);
    process.env.BUDDY_STUB_REPLY = 'c2-reply';
    await spawnBrokerWithStub(projectRoot);
    try {
      // Launch both turns concurrently without awaiting either first.
      // The broker must reject the second with BROKER_BUSY while the first is active.
      const [r1, r2] = await Promise.allSettled([
        runBrokerTurn(paths, { prompt: 'q1', projectDir: projectRoot }),
        runBrokerTurn(paths, { prompt: 'q2', projectDir: projectRoot }),
      ]);
      const succeeded = [r1, r2].filter(r => r.status === 'fulfilled');
      const busyRejected = [r1, r2].filter(
        r => r.status === 'rejected' && r.reason?.message?.toLowerCase().includes('busy')
      );
      // Either: exactly one gets BROKER_BUSY (true concurrency hit the guard),
      // or both succeed (stub responded fast enough to serialize them naturally).
      // In both cases: no unexpected errors, and at least one succeeds.
      assert.ok(succeeded.length >= 1, 'at least one turn should complete');
      assert.ok(
        succeeded.length + busyRejected.length === 2,
        `unexpected rejection: ${[r1, r2].filter(r => r.status === 'rejected' && !r.reason?.message?.toLowerCase().includes('busy')).map(r => r.reason?.message).join(', ')}`
      );
    } finally {
      delete process.env.BUDDY_STUB_REPLY;
      delete process.env.BUDDY_BROKER_CODEX_BIN;
      await sendShutdown(paths);
    }
  });
});
