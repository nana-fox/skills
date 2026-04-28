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
  test('spawn → ping → shutdown', async () => {
    const paths = getBrokerPaths(TEST_HOME, FIXTURE_PROJECT);
    const { pid } = await spawnBroker({ projectRoot: FIXTURE_PROJECT, home: TEST_HOME });
    try {
      assert.ok(pid > 0);
      assert.ok(fs.existsSync(paths.sockPath), 'sock file should exist');
      assert.ok(fs.existsSync(paths.pidPath), 'pid file should exist');
      assert.equal(await isBrokerAlive(paths), true);

      const pong = await sendCommand(paths, { method: 'ping' });
      assert.equal(pong.result?.ok, true);
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
      const pong = await sendCommand(paths, { method: 'ping' });
      assert.equal(pong.result?.ok, true);
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

describe('buddy-broker — W8 turn/run forwarding', () => {
  test('turn/run with no threadId → thread/start + turn returns finalMessage + threadId', async () => {
    const projectRoot = '/tmp/buddy-broker-turn-' + Date.now();
    fs.mkdirSync(projectRoot, { recursive: true });
    const paths = getBrokerPaths(TEST_HOME, projectRoot);
    process.env.BUDDY_STUB_REPLY = 'hello-from-stub';
    await spawnBrokerWithStub(projectRoot);
    try {
      const reply = await sendCommand(paths, {
        method: 'turn/run',
        params: { prompt: 'is this safe?' },
        timeoutMs: 5000,
      });
      assert.equal(reply.result?.finalMessage, 'hello-from-stub');
      assert.match(reply.result?.threadId || '', /^thr-\d+$/);
      assert.equal(typeof reply.result?.latency_ms, 'number');
    } finally {
      delete process.env.BUDDY_STUB_REPLY;
      delete process.env.BUDDY_BROKER_CODEX_BIN;
      await sendShutdown(paths);
    }
  });

  test('turn/run with existing threadId reuses it (no thread/start)', async () => {
    const projectRoot = '/tmp/buddy-broker-thread-reuse-' + Date.now();
    fs.mkdirSync(projectRoot, { recursive: true });
    const paths = getBrokerPaths(TEST_HOME, projectRoot);
    process.env.BUDDY_STUB_REPLY = 'reuse-reply';
    await spawnBrokerWithStub(projectRoot);
    try {
      // First turn allocates a thread.
      const r1 = await sendCommand(paths, {
        method: 'turn/run',
        params: { prompt: 'first' },
        timeoutMs: 5000,
      });
      const tid = r1.result?.threadId;
      assert.match(tid || '', /^thr-\d+$/);
      // Second turn passes the threadId in — stub records it but does NOT
      // mint a new one (which would have indexed nextThreadIdx).
      const r2 = await sendCommand(paths, {
        method: 'turn/run',
        params: { prompt: 'second', threadId: tid },
        timeoutMs: 5000,
      });
      assert.equal(r2.result?.threadId, tid, 'threadId must be reused');
      assert.equal(r2.result?.finalMessage, 'reuse-reply');
    } finally {
      delete process.env.BUDDY_STUB_REPLY;
      delete process.env.BUDDY_BROKER_CODEX_BIN;
      await sendShutdown(paths);
    }
  });

  test('status reports codex_ready=true once a turn has run', async () => {
    const projectRoot = '/tmp/buddy-broker-status-' + Date.now();
    fs.mkdirSync(projectRoot, { recursive: true });
    const paths = getBrokerPaths(TEST_HOME, projectRoot);
    await spawnBrokerWithStub(projectRoot);
    try {
      // Before any turn: codex not yet spawned
      const before = await sendCommand(paths, { method: 'status' });
      assert.equal(before.result?.codex_ready, false);
      await sendCommand(paths, { method: 'turn/run', params: { prompt: 'go' }, timeoutMs: 5000 });
      const after = await sendCommand(paths, { method: 'status' });
      assert.equal(after.result?.codex_ready, true);
    } finally {
      delete process.env.BUDDY_BROKER_CODEX_BIN;
      await sendShutdown(paths);
    }
  });
});
