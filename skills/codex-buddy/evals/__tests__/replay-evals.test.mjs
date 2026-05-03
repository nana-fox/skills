import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(__dirname, '..', 'replay-evals.mjs');

describe('replay evals runner', () => {
  test('fails an eval when supplied reply violates assertions', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-replay-evals-'));
    const evalSet = path.join(tmp, 'evals.json');
    const replies = path.join(tmp, 'replies.json');
    fs.writeFileSync(evalSet, JSON.stringify({
      skill_name: 'codex-buddy',
      evals: [{
        id: 1,
        prompt: '这个方案怎么选？',
        expected_output: 'V2 and probe',
        tags: ['should-trigger'],
        assertions: { vlevel_required: true, must_probe: true },
      }],
    }));
    fs.writeFileSync(replies, JSON.stringify({ '1': '我建议走 A。' }));
    try {
      const r = spawnSync(process.execPath, [RUNNER, '--eval-set', evalSet, '--replies', replies], {
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
      const json = JSON.parse(r.stdout);
      assert.equal(json.total, 1);
      assert.equal(json.failed, 1);
      assert.equal(json.failures[0].id, 1);
      assert.deepEqual(json.failures[0].violations.map(v => v.code), ['missing-vlevel-header', 'missing-probe']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('skips legacy evals without assertions', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-replay-evals-'));
    const evalSet = path.join(tmp, 'evals.json');
    fs.writeFileSync(evalSet, JSON.stringify({
      skill_name: 'codex-buddy',
      evals: [{ id: 1, prompt: 'format JSON', expected_output: 'direct', tags: [] }],
    }));
    try {
      const r = spawnSync(process.execPath, [RUNNER, '--eval-set', evalSet], {
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
      const json = JSON.parse(r.stdout);
      assert.equal(json.total, 1);
      assert.equal(json.skipped, 1);
      assert.equal(json.failed, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('uses expected_reply when replies fixture is omitted', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-replay-evals-'));
    const evalSet = path.join(tmp, 'evals.json');
    fs.writeFileSync(evalSet, JSON.stringify({
      skill_name: 'codex-buddy',
      evals: [{
        id: 1,
        prompt: 'Codex probe 因为 sandbox 需要授权卡住了，怎么继续？',
        expected_output: 'low intrusion recovery',
        expected_reply: 'V2[METHOD] | sandbox recovery.\n先使用 file-first evidence 和 read-only 证据包。',
        tags: ['sandbox-approval'],
        assertions: { vlevel_required: true, must_use_file_first: true },
      }],
    }));
    try {
      const r = spawnSync(process.execPath, [RUNNER, '--eval-set', evalSet], {
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
      const json = JSON.parse(r.stdout);
      assert.equal(json.asserted, 1);
      assert.equal(json.passed, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
