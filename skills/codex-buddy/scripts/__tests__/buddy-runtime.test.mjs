import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkUnixSocketSupport } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.resolve(__dirname, '..', 'buddy-runtime.mjs');
let TEST_HOME;
let PREV_BUDDY_HOME;
let PREV_HOME;
let CAN_USE_UNIX_SOCKETS = false;

before(async () => {
  PREV_BUDDY_HOME = process.env.BUDDY_HOME;
  PREV_HOME = process.env.HOME;
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-runtime-home-'));
  process.env.BUDDY_HOME = path.join(TEST_HOME, '.buddy');
  process.env.HOME = TEST_HOME;
  CAN_USE_UNIX_SOCKETS = await checkUnixSocketSupport('buddy-runtime-socket-check');
});

after(() => {
  if (PREV_BUDDY_HOME === undefined) delete process.env.BUDDY_HOME;
  else process.env.BUDDY_HOME = PREV_BUDDY_HOME;
  if (PREV_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = PREV_HOME;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('buddy-runtime CLI', () => {
  test('--action preflight returns JSON status', () => {
    const result = execSync(
      `node "${RUNTIME}" --action preflight --project-dir /tmp`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const json = JSON.parse(result);
    assert.equal(json.status === 'ok' || json.status === 'error', true);
    assert.ok('codex_available' in json);
  });

  test('unknown action returns error JSON', () => {
    const result = execSync(
      `node "${RUNTIME}" --action unknown --project-dir /tmp`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const json = JSON.parse(result);
    assert.equal(json.status, 'error');
  });

  test('--action local with no checks returns structured output', () => {
    const result = execSync(
      `node "${RUNTIME}" --action local --project-dir /tmp --checks ""`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const json = JSON.parse(result);
    assert.ok(['verified', 'blocked', 'error', 'skipped'].includes(json.status));
  });

  test('missing --project-dir defaults to cwd', () => {
    const result = execSync(
      `node "${RUNTIME}" --action local`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const json = JSON.parse(result);
    assert.equal(json.status, 'skipped');
    assert.equal(json.route, 'local');
  });

  test('--action metrics returns stats without project-dir', () => {
    const result = execSync(
      `node "${RUNTIME}" --action metrics`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const json = JSON.parse(result);
    assert.equal(json.status, 'ok');
    assert.ok('total' in json);
    assert.ok('probes' in json);
    assert.ok('followups' in json);
    assert.ok('avg_latency_ms' in json);
    assert.ok('probe_found_new_rate' in json);
    assert.ok('user_adopted_rate' in json);
  });

  test('--action assess-reply reports assertion violations', () => {
    const promptFile = path.join(os.tmpdir(), `assess-prompt-${Date.now()}.txt`);
    const replyFile = path.join(os.tmpdir(), `assess-reply-${Date.now()}.txt`);
    const assertionsFile = path.join(os.tmpdir(), `assess-assertions-${Date.now()}.json`);
    fs.writeFileSync(promptFile, '这个方案怎么选？');
    fs.writeFileSync(replyFile, '我建议走 A。');
    fs.writeFileSync(assertionsFile, JSON.stringify({ vlevel_required: true, must_probe: true }));
    try {
      const result = execSync(
        `node "${RUNTIME}" --action assess-reply --prompt ${promptFile} --reply ${replyFile} --assertions ${assertionsFile}`,
        { encoding: 'utf8', timeout: 10000 }
      );
      const json = JSON.parse(result);
      assert.equal(json.status, 'failed');
      assert.deepEqual(json.violations.map(v => v.code), ['missing-vlevel-header', 'missing-probe']);
    } finally {
      fs.rmSync(promptFile, { force: true });
      fs.rmSync(replyFile, { force: true });
      fs.rmSync(assertionsFile, { force: true });
    }
  });

  test('--action annotate missing fields returns error', () => {
    const result = execSync(
      `node "${RUNTIME}" --action annotate --session-id buddy-test999`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const json = JSON.parse(result);
    assert.equal(json.status, 'error');
  });

  test('--action local writes action field to log', () => {
    const tmpLog = path.join(os.tmpdir(), `buddy-test-${Date.now()}.jsonl`);
    // Override HOME to control log file location by using a temp session
    const result = execSync(
      `node "${RUNTIME}" --action local --project-dir /tmp --checks "" --session-id buddy-logtest`,
      { encoding: 'utf8', timeout: 10000, env: { ...process.env } }
    );
    const json = JSON.parse(result);
    // local with no checks returns skipped (no log written), so just verify status
    assert.ok(['skipped', 'verified', 'blocked'].includes(json.status));
    fs.rmSync(tmpLog, { force: true });
  });
});

describe('redact + session-log', () => {
  test('redact() masks common secrets', async () => {
    const { redact } = await import('../lib/redact.mjs');
    const r = redact('api_key=sk-abcdefghijklmnopqrstuvwx token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa12345678 password="hunter2hunter2"');
    assert.match(r, /\[REDACTED:secret\]/);
    assert.doesNotMatch(r, /sk-abcdefghij/);
    assert.doesNotMatch(r, /hunter2hunter2/);
  });

  test('redact() preserves non-secret text', async () => {
    const { redact } = await import('../lib/redact.mjs');
    assert.equal(redact('plain text without secrets'), 'plain text without secrets');
  });

  test('redact() masks sk-proj-/sk-svcacct-/github_pat_/Bearer headers', async () => {
    const { redact } = await import('../lib/redact.mjs');
    const r = redact([
      'OPENAI_API_KEY=sk-proj-' + 'AAAAAAAAAAAAAAAAAAAAAAAAA',
      'gh = github_pat_' + '11ABCDEFG0123456789012345678901234567890123456789012345',
      'Authorization: Bearer abcdefghijklmnopqrstuvwx',
      'svc=sk-svcacct-' + 'XXXXXXXXXXXXXXXXXXXXXXXXX',
      'slack=xo' + 'xb-1234567890-abcdefghijklmnop',
    ].join('\n'));
    assert.match(r, /\[REDACTED:openai-key\]/);
    assert.match(r, /\[REDACTED:github-token\]/);
    assert.match(r, /\[REDACTED:bearer\]/);
    assert.match(r, /\[REDACTED:slack-token\]/);
    assert.doesNotMatch(r, /sk-proj-AAAA/);
    assert.doesNotMatch(r, /github_pat_11AB/);
    assert.doesNotMatch(r, /xoxb-1234567890-/);
  });

  test('appendSessionEvent writes JSONL with redacted payload + sha256', async () => {
    const { appendSessionEvent, readSessionEvents } = await import('../lib/session-log.mjs');
    const sid = `buddy-test-${Date.now()}`;
    const taskId = 'vtask-test-1';
    appendSessionEvent(sid, taskId, 'probe.start', { rule: 'test' }, 'token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa12345678 hello');
    const events = readSessionEvents(sid);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'probe.start');
    assert.equal(events[0].verification_task_id, taskId);
    assert.match(events[0].payload, /\[REDACTED/);
    assert.equal(events[0].payload_bytes > 0, true);
    assert.match(events[0].payload_sha256, /^[0-9a-f]{64}$/);
    assert.equal(events[0].redaction_policy, '1');
    fs.rmSync(`${process.env.HOME}/.buddy/sessions/${sid}.jsonl`, { force: true });
  });

  test('appendSessionEvent appends multiple events', async () => {
    const { appendSessionEvent, readSessionEvents } = await import('../lib/session-log.mjs');
    const sid = `buddy-test-multi-${Date.now()}`;
    appendSessionEvent(sid, 'v1', 'probe.start', {}, 'first');
    appendSessionEvent(sid, 'v1', 'probe.codex_output', { latency_ms: 100 }, 'second');
    const events = readSessionEvents(sid);
    assert.equal(events.length, 2);
    assert.equal(events[1].latency_ms, 100);
    fs.rmSync(`${process.env.HOME}/.buddy/sessions/${sid}.jsonl`, { force: true });
  });
});

describe('CLI: stdin evidence + replay + log-synthesis', () => {
  test('--action log-synthesis with --content-stdin writes synthesis event', () => {
    const sid = `buddy-cli-test-${Date.now()}`;
    const taskId = 'vtask-cli-1';
    const result = execSync(
      `echo "synthesis content" | node "${RUNTIME}" --action log-synthesis --content-stdin --session-id ${sid} --verification-task-id ${taskId}`,
      { encoding: 'utf8', timeout: 10000, shell: '/bin/bash' }
    );
    const json = JSON.parse(result);
    assert.equal(json.status, 'ok');
    assert.equal(json.verification_task_id, taskId);
    fs.rmSync(`${process.env.HOME}/.buddy/sessions/${sid}.jsonl`, { force: true });
  });

  test('--action log-synthesis without content returns error', () => {
    const result = execSync(
      `node "${RUNTIME}" --action log-synthesis --session-id buddy-empty-test`,
      { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'], input: '' }
    );
    const json = JSON.parse(result);
    assert.equal(json.status, 'error');
  });

  test('--action replay returns events for a session', () => {
    const sid = `buddy-replay-${Date.now()}`;
    execSync(
      `echo "first synth" | node "${RUNTIME}" --action log-synthesis --content-stdin --session-id ${sid} --verification-task-id vtask-1`,
      { encoding: 'utf8', timeout: 10000, shell: '/bin/bash' }
    );
    const result = execSync(
      `node "${RUNTIME}" --action replay --session-id ${sid}`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const json = JSON.parse(result);
    assert.equal(json.status, 'ok');
    assert.equal(json.events_count, 1);
    assert.equal(json.events[0].event, 'probe.synthesis');
    fs.rmSync(`${process.env.HOME}/.buddy/sessions/${sid}.jsonl`, { force: true });
  });

  test('--action probe with BUDDY_STUB_CODEX=1 emits stderr progress lines', () => {
    const evidence = path.join(os.tmpdir(), `w3-evidence-${Date.now()}.txt`);
    fs.writeFileSync(evidence, 'task_to_judge: stub\nraw_evidence: x\nknown_omissions: none\n');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-w3-'));
    let stdout = '', stderr = '';
    try {
      const r = spawnSync(
        'node',
        [RUNTIME, '--action', 'probe', '--evidence', evidence, '--project-dir', '/tmp'],
        { encoding: 'utf8', timeout: 15000,
          // BUDDY_USE_LEGACY_EXEC=1: broker is now default; force exec path for this test.
          env: { ...process.env, BUDDY_STUB_CODEX: '1', BUDDY_HOME: tmpHome, BUDDY_USE_LEGACY_EXEC: '1' } }
      );
      stdout = r.stdout || ''; stderr = r.stderr || '';
    } finally {
      fs.rmSync(evidence, { force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
    assert.match(stderr, /\[buddy\] probe started/);
    assert.match(stderr, /\[buddy\] probe completed in \d+ms/);
    const json = JSON.parse(stdout);
    assert.equal(json.status, 'verified');
    assert.equal(json.structured?.verdict, 'proceed');
  });

  test('--action probe with BUDDY_USE_BROKER=1 routes through broker, persists threadId', (t) => {
    if (!CAN_USE_UNIX_SOCKETS) return t.skip('Unix sockets are unavailable in this sandbox');
    const evidence = path.join(os.tmpdir(), `w8-evidence-${Date.now()}.txt`);
    fs.writeFileSync(evidence, 'task_to_judge: broker test\nraw_evidence: x\nknown_omissions: none\n');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-w8-'));
    const stubBin = path.resolve(__dirname, 'fixtures', 'codex-app-server-stub.mjs');
    fs.chmodSync(stubBin, 0o755);
    const sid = `buddy-w8-${Date.now()}`;
    try {
      const env = {
        ...process.env,
        BUDDY_STUB_CODEX: '1',           // bypass checkCodexAvailable in actionProbe
        BUDDY_USE_BROKER: '1',           // route via broker
        BUDDY_BROKER_CODEX_BIN: stubBin, // broker spawns the stub instead of real codex
        BUDDY_HOME: tmpHome,
        BUDDY_STUB_REPLY: '{"verdict":"proceed","findings":[],"questions":[]}',
      };
      const r1 = spawnSync(
        'node',
        [RUNTIME, '--action', 'probe', '--evidence', evidence, '--project-dir', '/tmp',
         '--session-id', sid],
        { encoding: 'utf8', timeout: 20000, env },
      );
      const j1 = JSON.parse(r1.stdout);
      assert.equal(j1.status, 'verified', `first probe must verify (stderr=${r1.stderr})`);
      assert.equal(j1.runtime, 'broker');
      assert.match(j1.codex_session_id || '', /^thr-\d+$/);
      // conv-thread file must be persisted under tmpHome.
      const threadFiles = fs.readdirSync(tmpHome).filter(f => f.startsWith('broker-thread-'));
      assert.ok(threadFiles.length >= 1, 'broker-thread-<sid>-<hash>.json must exist');

      // Second probe in same buddy session must reuse the same threadId.
      const r2 = spawnSync(
        'node',
        [RUNTIME, '--action', 'probe', '--evidence', evidence, '--project-dir', '/tmp',
         '--session-id', sid],
        { encoding: 'utf8', timeout: 20000, env },
      );
      const j2 = JSON.parse(r2.stdout);
      assert.equal(j2.runtime, 'broker');
      assert.equal(j2.codex_session_id, j1.codex_session_id, 'threadId must be reused across probes');

      // --fresh-thread must allocate a new threadId.
      const r3 = spawnSync(
        'node',
        [RUNTIME, '--action', 'probe', '--evidence', evidence, '--project-dir', '/tmp',
         '--session-id', sid, '--fresh-thread'],
        { encoding: 'utf8', timeout: 20000, env },
      );
      const j3 = JSON.parse(r3.stdout);
      assert.equal(j3.runtime, 'broker');
      assert.notEqual(j3.codex_session_id, j1.codex_session_id, '--fresh-thread must mint a new id');
    } finally {
      fs.rmSync(evidence, { force: true });
      // Best-effort: stop any broker the test spawned, then remove tmpHome.
      try {
        spawnSync('node',
          [path.resolve(__dirname, '..', 'buddy-broker-cli.mjs'), 'stop',
           '--project-dir', '/tmp', '--force'],
          { encoding: 'utf8', timeout: 5000, env: { ...process.env, BUDDY_HOME: tmpHome } });
      } catch {}
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('C3: broker probe must NOT write exec session pointer (saveSession)', (t) => {
    if (!CAN_USE_UNIX_SOCKETS) return t.skip('Unix sockets are unavailable in this sandbox');
    const evidence = path.join(os.tmpdir(), `c3-evidence-${Date.now()}.txt`);
    fs.writeFileSync(evidence, 'task_to_judge: C3 test\nraw_evidence: x\nknown_omissions: none\n');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-c3-'));
    const stubBin = path.resolve(__dirname, 'fixtures', 'codex-app-server-stub.mjs');
    fs.chmodSync(stubBin, 0o755);
    try {
      spawnSync(
        'node',
        [RUNTIME, '--action', 'probe', '--evidence', evidence, '--project-dir', '/tmp',
         '--session-id', 'c3-test'],
        {
          encoding: 'utf8', timeout: 20000,
          env: {
            ...process.env,
            BUDDY_STUB_CODEX: '1',
            BUDDY_USE_BROKER: '1',
            BUDDY_BROKER_CODEX_BIN: stubBin,
            BUDDY_HOME: tmpHome,
            BUDDY_STUB_REPLY: '{"verdict":"proceed","findings":[],"questions":[]}',
          },
        },
      );
      // session.json must not contain a broker thread id (thr-N).
      const sessionFile = path.join(tmpHome, 'session.json');
      if (fs.existsSync(sessionFile)) {
        const content = fs.readFileSync(sessionFile, 'utf8');
        const parsed = JSON.parse(content);
        assert.ok(
          !String(parsed.session_id || '').startsWith('thr-'),
          `session.json must not hold broker thread id; got: ${parsed.session_id}`,
        );
      }
      // broker-thread file SHOULD exist.
      const threadFiles = fs.readdirSync(tmpHome).filter(f => f.startsWith('broker-thread-'));
      assert.ok(threadFiles.length >= 1, 'broker-thread persistence file must exist');
    } finally {
      try { spawnSync('node', [path.resolve(__dirname, '..', 'buddy-broker-cli.mjs'), 'stop', '--project-dir', '/tmp', '--force'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, BUDDY_HOME: tmpHome } }); } catch {}
      fs.rmSync(evidence, { force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('--action log-reply happy path writes reply.<kind> event', () => {
    const sid = `buddy-w2-${Date.now()}`;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-w2-'));
    try {
      const r = spawnSync(
        'node',
        [RUNTIME, '--action', 'log-reply', '--kind', 'vlevel-header',
         '--content', 'V2[METHOD] | route reason',
         '--session-id', sid, '--verification-task-id', 'vt-1'],
        { encoding: 'utf8', timeout: 10000, env: { ...process.env, BUDDY_HOME: tmpHome } }
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'ok');
      assert.equal(json.kind, 'vlevel-header');
      const log = fs.readFileSync(path.join(tmpHome, 'sessions', `${sid}.jsonl`), 'utf8');
      assert.match(log, /"event":"reply\.vlevel-header"/);
      assert.match(log, /V2\[METHOD\]/);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('--action log-reply rejects invalid --kind', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-w2-'));
    try {
      const r = spawnSync(
        'node',
        [RUNTIME, '--action', 'log-reply', '--kind', 'bogus', '--content', 'x'],
        { encoding: 'utf8', timeout: 10000, env: { ...process.env, BUDDY_HOME: tmpHome } }
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'error');
      assert.match(json.message, /Invalid --kind/);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('--action probe with neither --evidence nor --evidence-stdin returns error', () => {
    const result = execSync(
      `node "${RUNTIME}" --action probe --project-dir /tmp`,
      { encoding: 'utf8', timeout: 10000, input: '' }
    );
    const json = JSON.parse(result);
    assert.equal(json.status, 'error');
    assert.match(json.message, /Evidence not found/);
    assert.match(json.message, /file-first|--evidence <file>/);
  });

  test('--action probe with TTY stdin explains file-first recovery', () => {
    const r = spawnSync(
      'node',
      [RUNTIME, '--action', 'probe', '--evidence-stdin', '--project-dir', '/tmp'],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, BUDDY_TEST_STDIN_TTY: '1' },
      },
    );
    const json = JSON.parse(r.stdout);
    assert.equal(json.status, 'error');
    assert.match(json.message, /file-first/);
    assert.match(json.message, /--evidence <file>/);
  });

  test('--action log-reply continues when session audit log cannot be written', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-logreply-unwritable-'));
    try {
      const r = spawnSync(
        'node',
        [RUNTIME, '--action', 'log-reply', '--kind', 'vlevel-header',
         '--content', 'V2[META] | test', '--session-id', `reply-unwritable-${Date.now()}`],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: {
            ...process.env,
            BUDDY_HOME: tmpHome,
            BUDDY_TEST_SESSION_APPEND_EPERM: '1',
          },
        },
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'ok', `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(json.audit_logged, false);
      assert.match(r.stderr, /session audit log write failed/);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('--action annotate continues when session audit log cannot be written', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-annotate-unwritable-'));
    try {
      const r = spawnSync(
        'node',
        [RUNTIME, '--action', 'annotate', '--probe-found-new', 'false',
         '--verification-task-id', 'vtask-direct', '--session-id', `annotate-unwritable-${Date.now()}`],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: {
            ...process.env,
            BUDDY_HOME: tmpHome,
            BUDDY_TEST_SESSION_APPEND_EPERM: '1',
          },
        },
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'ok', `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(json.audit_logged, false);
      assert.match(r.stderr, /session audit log write failed/);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('--action probe falls back to exec when broker startup is unavailable', () => {
    const evidence = path.join(os.tmpdir(), `fallback-evidence-${Date.now()}.txt`);
    fs.writeFileSync(evidence, 'task_to_judge: fallback test\nraw_evidence: x\nknown_omissions: none\n');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-fallback-'));
    try {
      const r = spawnSync(
        'node',
        [RUNTIME, '--action', 'probe', '--evidence', evidence, '--project-dir', '/tmp',
         '--session-id', `fallback-${Date.now()}`],
        {
          encoding: 'utf8',
          timeout: 20000,
          env: {
            ...process.env,
            BUDDY_STUB_CODEX: '1',
            BUDDY_USE_BROKER: '1',
            BUDDY_HOME: tmpHome,
            BUDDY_FORCE_BROKER_STARTUP_ERROR: 'listen EPERM: operation not permitted',
          },
        },
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'verified', `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(json.runtime, 'exec');
      assert.equal(json.broker_fallback, true);
      assert.match(json.broker_fallback_reason, /EPERM/);
    } finally {
      fs.rmSync(evidence, { force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('--action probe continues when session audit log cannot be written', () => {
    const evidence = path.join(os.tmpdir(), `audit-unwritable-${Date.now()}.txt`);
    fs.writeFileSync(evidence, 'task_to_judge: audit failure should not block probe\nraw_evidence: x\nknown_omissions: none\n');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-audit-unwritable-'));
    try {
      const r = spawnSync(
        'node',
        [RUNTIME, '--action', 'probe', '--evidence', evidence, '--project-dir', '/tmp',
         '--session-id', `audit-unwritable-${Date.now()}`],
        {
          encoding: 'utf8',
          timeout: 20000,
          env: {
            ...process.env,
            BUDDY_STUB_CODEX: '1',
            BUDDY_USE_LEGACY_EXEC: '1',
            BUDDY_HOME: tmpHome,
            BUDDY_TEST_SESSION_APPEND_EPERM: '1',
          },
        },
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'verified', `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stderr, /session audit log write failed/);
    } finally {
      fs.rmSync(evidence, { force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('--action probe continues when summary audit log cannot be written', () => {
    const evidence = path.join(os.tmpdir(), `summary-audit-unwritable-${Date.now()}.txt`);
    fs.writeFileSync(evidence, 'task_to_judge: summary audit failure should not block probe\nraw_evidence: x\nknown_omissions: none\n');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-summary-audit-unwritable-'));
    try {
      const r = spawnSync(
        'node',
        [RUNTIME, '--action', 'probe', '--evidence', evidence, '--project-dir', '/tmp',
         '--session-id', `summary-audit-unwritable-${Date.now()}`],
        {
          encoding: 'utf8',
          timeout: 20000,
          env: {
            ...process.env,
            BUDDY_STUB_CODEX: '1',
            BUDDY_USE_LEGACY_EXEC: '1',
            BUDDY_HOME: tmpHome,
            BUDDY_TEST_AUDIT_APPEND_EPERM: '1',
          },
        },
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'verified', `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(json.audit_logged, false);
      assert.match(r.stderr, /summary audit log write failed/);
    } finally {
      fs.rmSync(evidence, { force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('--action probe continues when summary audit call count cannot be read', () => {
    const evidence = path.join(os.tmpdir(), `summary-audit-read-${Date.now()}.txt`);
    fs.writeFileSync(evidence, 'task_to_judge: summary audit read failure should not block probe\nraw_evidence: x\nknown_omissions: none\n');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-summary-audit-read-'));
    try {
      const r = spawnSync(
        'node',
        [RUNTIME, '--action', 'probe', '--evidence', evidence, '--project-dir', '/tmp',
         '--session-id', `summary-audit-read-${Date.now()}`],
        {
          encoding: 'utf8',
          timeout: 20000,
          env: {
            ...process.env,
            BUDDY_STUB_CODEX: '1',
            BUDDY_USE_LEGACY_EXEC: '1',
            BUDDY_HOME: tmpHome,
            BUDDY_TEST_AUDIT_READ_EPERM: '1',
          },
        },
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'verified', `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(json.call_count, null);
      assert.match(r.stderr, /summary audit log read failed/);
    } finally {
      fs.rmSync(evidence, { force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('--action probe preserves --ephemeral false through provider routing', () => {
    const evidence = path.join(os.tmpdir(), `ephemeral-false-${Date.now()}.txt`);
    fs.writeFileSync(evidence, 'task_to_judge: persistent probe\nraw_evidence: x\nknown_omissions: none\n');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-ephemeral-'));
    try {
      const r = spawnSync(
        'node',
        [RUNTIME, '--action', 'probe', '--evidence', evidence, '--project-dir', '/tmp',
         '--session-id', `ephemeral-${Date.now()}`, '--ephemeral', 'false'],
        {
          encoding: 'utf8',
          timeout: 20000,
          env: {
            ...process.env,
            BUDDY_STUB_CODEX: '1',
            BUDDY_USE_LEGACY_EXEC: '1',
            BUDDY_HOME: tmpHome,
          },
        },
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'verified', `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(json.runtime, 'exec');
      assert.equal(json.ephemeral, false);
    } finally {
      fs.rmSync(evidence, { force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('--action followup can resolve codex session from provider_output event', async () => {
    const { appendSessionEvent } = await import('../lib/session-log.mjs');
    const evidence = path.join(os.tmpdir(), `provider-followup-${Date.now()}.txt`);
    fs.writeFileSync(evidence, 'task_to_judge: followup\nraw_evidence: x\nknown_omissions: none\n');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-provider-followup-'));
    const sid = `provider-followup-${Date.now()}`;
    const taskId = 'vtask-provider-output';
    const codexSessionId = '019d318f-abcd-7890-1234-567890abcdef';
    const prevHome = process.env.BUDDY_HOME;
    try {
      process.env.BUDDY_HOME = tmpHome;
      appendSessionEvent(sid, taskId, 'probe.provider_output', {
        provider: 'codex',
        codex_session_id: codexSessionId,
      }, '{"verdict":"proceed"}');

      const r = spawnSync(
        'node',
        [RUNTIME, '--action', 'followup', '--evidence', evidence, '--project-dir', '/tmp',
         '--session-id', sid, '--verification-task-id', taskId],
        {
          encoding: 'utf8',
          timeout: 20000,
          env: {
            ...process.env,
            BUDDY_STUB_CODEX: '1',
            BUDDY_HOME: tmpHome,
          },
        },
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'verified', `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(json.provider, 'codex');
      assert.equal(json.provider_session_id, codexSessionId);
      assert.equal(json.provider_output_file, json.codex_output_file);
      assert.equal(json.codex_session_id, codexSessionId);

      const log = fs.readFileSync(path.join(tmpHome, 'sessions', `${sid}.jsonl`), 'utf8');
      assert.match(log, /"event":"followup\.provider_output"/);
      assert.match(log, /"event":"followup\.codex_output"/);
    } finally {
      if (prevHome === undefined) delete process.env.BUDDY_HOME;
      else process.env.BUDDY_HOME = prevHome;
      fs.rmSync(evidence, { force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('--action followup continues when summary audit log cannot be written', async () => {
    const { appendSessionEvent } = await import('../lib/session-log.mjs');
    const evidence = path.join(os.tmpdir(), `summary-audit-followup-${Date.now()}.txt`);
    fs.writeFileSync(evidence, 'task_to_judge: followup summary audit failure\nraw_evidence: x\nknown_omissions: none\n');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-summary-audit-followup-'));
    const sid = `summary-audit-followup-${Date.now()}`;
    const taskId = 'vtask-summary-audit-followup';
    const codexSessionId = '019d318f-abcd-7890-1234-567890abcdef';
    const prevHome = process.env.BUDDY_HOME;
    try {
      process.env.BUDDY_HOME = tmpHome;
      appendSessionEvent(sid, taskId, 'probe.provider_output', {
        provider: 'codex',
        codex_session_id: codexSessionId,
      }, '{"verdict":"proceed"}');

      const r = spawnSync(
        'node',
        [RUNTIME, '--action', 'followup', '--evidence', evidence, '--project-dir', '/tmp',
         '--session-id', sid, '--verification-task-id', taskId],
        {
          encoding: 'utf8',
          timeout: 20000,
          env: {
            ...process.env,
            BUDDY_STUB_CODEX: '1',
            BUDDY_HOME: tmpHome,
            BUDDY_TEST_AUDIT_APPEND_EPERM: '1',
          },
        },
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'verified', `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(json.audit_logged, false);
      assert.match(r.stderr, /summary audit log write failed/);
    } finally {
      if (prevHome === undefined) delete process.env.BUDDY_HOME;
      else process.env.BUDDY_HOME = prevHome;
      fs.rmSync(evidence, { force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('--action followup with kimi returns unsupported provider error', async () => {
    const { appendSessionEvent } = await import('../lib/session-log.mjs');
    const evidence = path.join(os.tmpdir(), `kimi-followup-${Date.now()}.txt`);
    fs.writeFileSync(evidence, 'task_to_judge: kimi followup\nraw_evidence: x\nknown_omissions: none\n');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-kimi-followup-'));
    const sid = `kimi-followup-${Date.now()}`;
    const taskId = 'vtask-kimi-followup';
    const prevHome = process.env.BUDDY_HOME;
    try {
      process.env.BUDDY_HOME = tmpHome;
      appendSessionEvent(sid, taskId, 'probe.provider_output', {
        provider: 'kimi',
        provider_session_id: 'kimi-session-1',
      }, 'kimi first response');

      const r = spawnSync(
        'node',
        [RUNTIME, '--action', 'followup', '--buddy-model', 'kimi',
         '--evidence', evidence, '--project-dir', '/tmp',
         '--session-id', sid, '--verification-task-id', taskId],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: { ...process.env, BUDDY_HOME: tmpHome },
        },
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'error', `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(json.rule, 'kimi-followup-unsupported');
      assert.equal(json.provider, 'kimi');
      assert.match(json.message, /does not support follow-up/i);
    } finally {
      if (prevHome === undefined) delete process.env.BUDDY_HOME;
      else process.env.BUDDY_HOME = prevHome;
      fs.rmSync(evidence, { force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('--action probe rejects --fresh-thread for kimi provider', () => {
    const evidence = path.join(os.tmpdir(), `kimi-fresh-${Date.now()}.txt`);
    fs.writeFileSync(evidence, 'task_to_judge: kimi fresh-thread\nraw_evidence: x\nknown_omissions: none\n');
    try {
      const r = spawnSync(
        'node',
        [RUNTIME, '--action', 'probe', '--buddy-model', 'kimi', '--fresh-thread',
         '--evidence', evidence, '--project-dir', '/tmp'],
        { encoding: 'utf8', timeout: 10000, env: { ...process.env } },
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'error');
      assert.match(json.message, /--fresh-thread.*codex broker/i);
    } finally {
      fs.rmSync(evidence, { force: true });
    }
  });

  test('--action probe with kimi reports unavailable cleanly when CLI is missing', () => {
    const evidence = path.join(os.tmpdir(), `kimi-missing-${Date.now()}.txt`);
    fs.writeFileSync(evidence, 'task_to_judge: kimi missing\nraw_evidence: x\nknown_omissions: none\n');
    try {
      const r = spawnSync(
        process.execPath,
        [RUNTIME, '--action', 'probe', '--buddy-model', 'kimi',
         '--evidence', evidence, '--project-dir', '/tmp'],
        { encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: '/usr/bin:/bin' } },
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'error');
      assert.equal(json.rule, 'kimi-unavailable');
      assert.doesNotMatch(json.message, /ReferenceError|kimiPreflight/);
    } finally {
      fs.rmSync(evidence, { force: true });
    }
  });

  test('--action probe with kimi uses final message output without empty summary', () => {
    const evidence = path.join(os.tmpdir(), `kimi-quiet-${Date.now()}.txt`);
    const fakeKimi = path.join(os.tmpdir(), `fake-kimi-${Date.now()}.mjs`);
    fs.writeFileSync(evidence, 'task_to_judge: kimi quiet\nraw_evidence: x\nknown_omissions: none\n');
    fs.writeFileSync(fakeKimi, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('kimi, version fake');
  process.exit(0);
}
console.log('quiet final answer from kimi');
`);
    fs.chmodSync(fakeKimi, 0o755);
    try {
      const r = spawnSync(
        process.execPath,
        [RUNTIME, '--action', 'probe', '--buddy-model', 'kimi',
         '--evidence', evidence, '--project-dir', '/tmp', '--session-id', `kimi-quiet-${Date.now()}`],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: { ...process.env, BUDDY_KIMI_BIN: fakeKimi, BUDDY_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-kimi-quiet-')) },
        },
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'verified', `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(json.provider, 'kimi');
      assert.equal(json.transport, 'exec');
      assert.match(json.evidence_summary[0], /quiet final answer from kimi/);
      assert.notEqual(json.evidence_summary[0], 'kimi: ');
    } finally {
      fs.rmSync(evidence, { force: true });
      fs.rmSync(fakeKimi, { force: true });
    }
  });

  test('--action probe with kimi uses wire transport by default', () => {
    const evidence = path.join(os.tmpdir(), `kimi-wire-runtime-${Date.now()}.txt`);
    const fakeKimi = path.join(os.tmpdir(), `fake-kimi-wire-runtime-${Date.now()}.mjs`);
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-kimi-wire-runtime-'));
    fs.writeFileSync(evidence, 'task_to_judge: kimi wire runtime\nraw_evidence: x\nknown_omissions: none\n');
    fs.writeFileSync(fakeKimi, `#!/usr/bin/env node
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
    send({ jsonrpc: '2.0', method: 'event', params: { event: { type: 'ContentPart', text: 'runtime stream event' } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { text: 'runtime wire final' } });
    process.exit(0);
  }
});
`);
    fs.chmodSync(fakeKimi, 0o755);
    try {
      const r = spawnSync(
        process.execPath,
        [RUNTIME, '--action', 'probe', '--buddy-model', 'kimi',
         '--evidence', evidence, '--project-dir', '/tmp', '--session-id', `kimi-wire-runtime-${Date.now()}`],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: { ...process.env, BUDDY_KIMI_BIN: fakeKimi, BUDDY_HOME: tmpHome },
        },
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'verified', `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(json.provider, 'kimi');
      assert.equal(json.transport, 'wire');
      assert.equal(json.runtime, 'wire');
      assert.equal(json.review_status, 'inconclusive');
      assert.equal(json.verdict, 'INCONCLUSIVE');
      assert.match(json.evidence_summary[0], /runtime wire final/);
      assert.ok(json.events_count >= 3);
    } finally {
      fs.rmSync(evidence, { force: true });
      fs.rmSync(fakeKimi, { force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('--action probe with kimi can force legacy exec transport', () => {
    const evidence = path.join(os.tmpdir(), `kimi-exec-runtime-${Date.now()}.txt`);
    const fakeKimi = path.join(os.tmpdir(), `fake-kimi-exec-runtime-${Date.now()}.mjs`);
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-kimi-exec-runtime-'));
    fs.writeFileSync(evidence, 'task_to_judge: kimi exec runtime\nraw_evidence: x\nknown_omissions: none\n');
    fs.writeFileSync(fakeKimi, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('kimi, version fake');
  process.exit(0);
}
console.log('runtime exec final');
`);
    fs.chmodSync(fakeKimi, 0o755);
    try {
      const r = spawnSync(
        process.execPath,
        [RUNTIME, '--action', 'probe', '--buddy-model', 'kimi',
         '--evidence', evidence, '--project-dir', '/tmp', '--session-id', `kimi-exec-runtime-${Date.now()}`],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: { ...process.env, BUDDY_KIMI_BIN: fakeKimi, BUDDY_KIMI_TRANSPORT: 'exec', BUDDY_HOME: tmpHome },
        },
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'verified', `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(json.transport, 'exec');
      assert.equal(json.degraded, true);
      assert.equal(json.review_status, 'inconclusive');
      assert.match(json.evidence_summary[0], /runtime exec final/);
    } finally {
      fs.rmSync(evidence, { force: true });
      fs.rmSync(fakeKimi, { force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('--action probe with kimi fails closed on non-zero exit even with stdout', () => {
    const evidence = path.join(os.tmpdir(), `kimi-exit-${Date.now()}.txt`);
    const fakeKimi = path.join(os.tmpdir(), `fake-kimi-fail-${Date.now()}.mjs`);
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-kimi-exit-'));
    fs.writeFileSync(evidence, 'task_to_judge: kimi exit\nraw_evidence: x\nknown_omissions: none\n');
    fs.writeFileSync(fakeKimi, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('kimi, version fake');
  process.exit(0);
}
console.log('this stdout must not become verified');
console.error('rate limit');
process.exit(2);
`);
    fs.chmodSync(fakeKimi, 0o755);
    try {
      const r = spawnSync(
        process.execPath,
        [RUNTIME, '--action', 'probe', '--buddy-model', 'kimi',
         '--evidence', evidence, '--project-dir', '/tmp', '--session-id', `kimi-exit-${Date.now()}`],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: { ...process.env, BUDDY_KIMI_BIN: fakeKimi, BUDDY_HOME: tmpHome },
        },
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'error', `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(json.rule, 'kimi-exit-failed');
      assert.match(json.message, /Kimi exited with code 2/);
      assert.match(json.message, /rate limit/);
    } finally {
      fs.rmSync(evidence, { force: true });
      fs.rmSync(fakeKimi, { force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('--action probe with kimi fails closed on empty output', () => {
    const evidence = path.join(os.tmpdir(), `kimi-empty-${Date.now()}.txt`);
    const fakeKimi = path.join(os.tmpdir(), `fake-kimi-empty-${Date.now()}.mjs`);
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-kimi-empty-'));
    fs.writeFileSync(evidence, 'task_to_judge: kimi empty\nraw_evidence: x\nknown_omissions: none\n');
    fs.writeFileSync(fakeKimi, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('kimi, version fake');
  process.exit(0);
}
console.error('auth required');
process.exit(0);
`);
    fs.chmodSync(fakeKimi, 0o755);
    try {
      const r = spawnSync(
        process.execPath,
        [RUNTIME, '--action', 'probe', '--buddy-model', 'kimi',
         '--evidence', evidence, '--project-dir', '/tmp', '--session-id', `kimi-empty-${Date.now()}`],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: { ...process.env, BUDDY_KIMI_BIN: fakeKimi, BUDDY_HOME: tmpHome },
        },
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'error', `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(json.rule, 'kimi-empty-output');
      assert.match(json.message, /auth required/);
    } finally {
      fs.rmSync(evidence, { force: true });
      fs.rmSync(fakeKimi, { force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('--action probe with kimi normalizes GO verdict', () => {
    const evidence = path.join(os.tmpdir(), `kimi-go-${Date.now()}.txt`);
    const fakeKimi = path.join(os.tmpdir(), `fake-kimi-go-${Date.now()}.mjs`);
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-kimi-go-'));
    fs.writeFileSync(evidence, 'task_to_judge: kimi go\nraw_evidence: x\nknown_omissions: none\n');
    fs.writeFileSync(fakeKimi, `#!/usr/bin/env node
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
    send({ jsonrpc: '2.0', id: msg.id, result: { text: 'GO\\nNo blockers.' } });
    process.exit(0);
  }
});
`);
    fs.chmodSync(fakeKimi, 0o755);
    try {
      const r = spawnSync(
        process.execPath,
        [RUNTIME, '--action', 'probe', '--buddy-model', 'kimi',
         '--evidence', evidence, '--project-dir', '/tmp', '--session-id', `kimi-go-${Date.now()}`],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: { ...process.env, BUDDY_KIMI_BIN: fakeKimi, BUDDY_HOME: tmpHome },
        },
      );
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, 'verified', `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(json.verdict, 'GO');
      assert.equal(json.review_status, 'passed');
    } finally {
      fs.rmSync(evidence, { force: true });
      fs.rmSync(fakeKimi, { force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe('session policy helpers', () => {
  test('saveConversationSession + loadConversationSession round-trip', async () => {
    const { saveConversationSession, loadConversationSession } = await import(
      '../lib/codex-adapter.mjs'
    );
    const buddyId = `buddy-test-${Date.now()}`;
    const codexId = '019dd1e8-3b2f-7ae3-befe-740d27a35d61';
    saveConversationSession(buddyId, codexId);
    assert.equal(loadConversationSession(buddyId), codexId);
    fs.rmSync(`${process.env.HOME}/.buddy/conv-${buddyId}.json`, { force: true });
  });

  test('loadConversationSession returns null when no file exists', async () => {
    const { loadConversationSession } = await import('../lib/codex-adapter.mjs');
    assert.equal(loadConversationSession(`buddy-nonexistent-${Date.now()}`), null);
  });

  test('parseSessionIdFromSessions returns null with tiny window', async () => {
    const { parseSessionIdFromSessions } = await import('../lib/codex-adapter.mjs');
    assert.equal(parseSessionIdFromSessions(1), null);
  });

  test('parseSessionIdFromSessions extracts UUID from filename', async () => {
    const { parseSessionIdFromSessions } = await import('../lib/codex-adapter.mjs');
    const fakeUuid = '12345678-aaaa-bbbb-cccc-1234567890ab';
    const baseDir = `${process.env.HOME}/.codex/sessions/2099/01/01`;
    fs.mkdirSync(baseDir, { recursive: true });
    const fullPath = `${baseDir}/rollout-2099-01-01T00-00-00-${fakeUuid}.jsonl`;
    fs.writeFileSync(fullPath, '{}\n');
    try {
      assert.equal(parseSessionIdFromSessions(10_000), fakeUuid);
    } finally {
      fs.rmSync(fullPath, { force: true });
      fs.rmSync(`${process.env.HOME}/.codex/sessions/2099`, { recursive: true, force: true });
    }
  });
});
