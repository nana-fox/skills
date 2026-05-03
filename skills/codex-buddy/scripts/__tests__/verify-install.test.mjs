import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_SKILL = path.resolve(__dirname, '..', '..');

function writeFile(file, content = `${path.basename(file)}\n`) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function copyFile(srcRel, dstRoot) {
  writeFile(path.join(dstRoot, srcRel), fs.readFileSync(path.join(SOURCE_SKILL, srcRel), 'utf8'));
}

function makeSkillFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-install-skill-'));
  for (const rel of ['scripts/verify-install.sh', 'scripts/sync-skill.sh']) {
    copyFile(rel, root);
  }
  for (const rel of [
    'SKILL.md',
    'STATUS.md',
    'CHANGELOG.md',
    'references/cli-examples.md',
    'scripts/buddy-runtime.mjs',
    'scripts/lib/providers.mjs',
    'schemas/envelope.schema.json',
    'hooks/session-start',
    'evals/evals.json',
  ]) {
    writeFile(path.join(root, rel), `source ${rel}\n`);
  }
  return root;
}

function installFixture(skillRoot, homeRoot) {
  const installRoot = path.join(homeRoot, '.codex', 'skills', 'codex-buddy');
  for (const rel of [
    'SKILL.md',
    'STATUS.md',
    'CHANGELOG.md',
    'references/cli-examples.md',
    'scripts/buddy-runtime.mjs',
    'scripts/lib/providers.mjs',
    'scripts/sync-skill.sh',
    'scripts/verify-install.sh',
    'schemas/envelope.schema.json',
    'hooks/session-start',
    'evals/evals.json',
  ]) {
    writeFile(path.join(installRoot, rel), fs.readFileSync(path.join(skillRoot, rel), 'utf8'));
  }
  return installRoot;
}

test('verify-install checks managed runtime assets for codex host', () => {
  const skillRoot = makeSkillFixture();
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-install-home-'));
  try {
    installFixture(skillRoot, homeRoot);
    const r = spawnSync(
      'bash',
      [path.join(skillRoot, 'scripts', 'verify-install.sh'), '--host', 'codex'],
      { encoding: 'utf8', env: { ...process.env, HOME: homeRoot } },
    );
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /scripts\/buddy-runtime\.mjs 一致/);
    assert.match(r.stdout, /schemas\/envelope\.schema\.json 一致/);
    assert.match(r.stdout, /hooks\/session-start 一致/);
    assert.match(r.stdout, /evals\/evals\.json 一致/);
    assert.match(r.stdout, /STATUS\.md 一致/);
    assert.match(r.stdout, /CHANGELOG\.md 一致/);
  } finally {
    fs.rmSync(skillRoot, { recursive: true, force: true });
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('verify-install fails on stale and residual managed runtime assets', () => {
  const skillRoot = makeSkillFixture();
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-install-home-'));
  try {
    const installRoot = installFixture(skillRoot, homeRoot);
    writeFile(path.join(installRoot, 'scripts', 'buddy-runtime.mjs'), 'stale runtime\n');
    writeFile(path.join(installRoot, 'schemas', 'old.schema.json'), 'residual\n');

    const r = spawnSync(
      'bash',
      [path.join(skillRoot, 'scripts', 'verify-install.sh'), '--host', 'codex'],
      { encoding: 'utf8', env: { ...process.env, HOME: homeRoot } },
    );
    assert.notEqual(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /scripts\/buddy-runtime\.mjs 不一致/);
    assert.match(r.stdout, /schemas\/old\.schema\.json 是残留文件/);
  } finally {
    fs.rmSync(skillRoot, { recursive: true, force: true });
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});
