import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execKimi } from '../kimi-adapter.mjs';

function fakeKimiScript(body) {
  const file = path.join(os.tmpdir(), `fake-kimi-adapter-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('execKimi reports timeout with diagnostics', () => {
  const fakeKimi = fakeKimiScript(`
if (process.argv.includes('--version')) {
  console.log('kimi, version fake');
  process.exit(0);
}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
`);
  const prevBin = process.env.BUDDY_KIMI_BIN;
  try {
    process.env.BUDDY_KIMI_BIN = fakeKimi;
    const r = execKimi('prompt', { projectDir: '/tmp', timeoutMs: 20 });
    assert.equal(r.exitCode, -1);
    assert.equal(r.errorCode, 'kimi-timeout');
    assert.equal(r.timeoutMs, 20);
    assert.equal(r.bin, fakeKimi);
    assert.equal(r.cwd, '/tmp');
    assert.match(r.spawnError, /ETIMEDOUT/);
  } finally {
    if (prevBin === undefined) delete process.env.BUDDY_KIMI_BIN;
    else process.env.BUDDY_KIMI_BIN = prevBin;
    fs.rmSync(fakeKimi, { force: true });
  }
});

test('execKimi classifies permission errors from stderr', () => {
  const fakeKimi = fakeKimiScript(`
if (process.argv.includes('--version')) {
  console.log('kimi, version fake');
  process.exit(0);
}
console.error("PermissionError: [Errno 1] Operation not permitted: '/Users/me/.kimi/logs/kimi.log'");
process.exit(1);
`);
  const prevBin = process.env.BUDDY_KIMI_BIN;
  try {
    process.env.BUDDY_KIMI_BIN = fakeKimi;
    const r = execKimi('prompt', { projectDir: '/tmp', timeoutMs: 5000 });
    assert.equal(r.exitCode, 1);
    assert.equal(r.errorCode, 'kimi-permission');
    assert.match(r.stderrTail, /Operation not permitted/);
    assert.equal(r.bin, fakeKimi);
    assert.equal(r.cwd, '/tmp');
  } finally {
    if (prevBin === undefined) delete process.env.BUDDY_KIMI_BIN;
    else process.env.BUDDY_KIMI_BIN = prevBin;
    fs.rmSync(fakeKimi, { force: true });
  }
});
