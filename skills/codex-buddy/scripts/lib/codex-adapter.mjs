import { execSync, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getBuddyHome, resolveBuddySessionFile } from './paths.mjs';

/** Max prompt size sent to Codex (chars). Larger prompts slow inference significantly. */
const MAX_PROMPT_CHARS = 12000;

/**
 * Trim prompt to MAX_PROMPT_CHARS by cutting the middle.
 * Keeps the beginning (task description) and end ([omissions] etc.) intact.
 */
export function trimPrompt(prompt, maxChars = MAX_PROMPT_CHARS) {
  if (prompt.length <= maxChars) return prompt;
  const cutNote = '\n\n[... 证据已裁剪，原文过长 ...]\n\n';
  const keepEnd = Math.min(800, Math.floor(maxChars * 0.15));
  const keepStart = Math.max(200, maxChars - keepEnd - cutNote.length);
  return prompt.slice(0, keepStart) + cutNote + prompt.slice(-keepEnd);
}

/**
 * Build args array for `codex exec` probe.
 * Returns { bin, args } for use with spawn (no shell interpretation).
 *
 * Key perf flags (confirmed with Codex CLI 0.118.0):
 *   -a never      — top-level flag, skip approval (safe in read-only sandbox)
 *   --ephemeral   — skip session file persistence (no resume, but faster)
 *   -c mcp_servers={} — skip MCP server init
 */
export function buildProbeArgs({ projectDir, outputFile, prompt, json = false, outputSchema = null, sandbox = 'read-only', model = null, ephemeral = true }) {
  const trimmed = trimPrompt(prompt);
  // -a is a TOP-LEVEL flag, must come BEFORE the 'exec' subcommand
  const args = [
    '-a', 'never',
    'exec',
    '-C', projectDir,
    '-s', sandbox,
    '--skip-git-repo-check',
    '-c', 'mcp_servers={}',
    '-o', outputFile,
  ];

  if (ephemeral) args.splice(args.indexOf('exec') + 1, 0, '--ephemeral');
  if (model) args.splice(args.indexOf('exec'), 0, '-m', model);
  if (json) args.push('--json');
  if (outputSchema) args.push('--output-schema', outputSchema);

  args.push(trimmed);

  return { bin: 'codex', args };
}

/**
 * Build args array for `codex exec resume` (follow-up/challenge).
 * -a never at top level for consistency. No --ephemeral (needs persisted session).
 */
export function buildResumeArgs({ sessionId, outputFile, prompt }) {
  const trimmed = trimPrompt(prompt);
  return {
    bin: 'codex',
    args: ['-a', 'never', 'exec', 'resume', sessionId, '-c', 'mcp_servers={}', '-o', outputFile, trimmed],
  };
}

/**
 * Execute a codex command using async spawn (non-blocking).
 * Watchdog timeout defaults to 5 minutes — generous enough for slow API
 * responses but prevents indefinite hangs from stuck processes.
 * Returns a Promise that resolves to stdout string.
 */
const DEFAULT_WATCHDOG_MS = 10 * 60 * 1000; // 10 minutes — complex probes with project reading can take 5min+

export function classifyCodexExecError(error) {
  const raw = String(error?.message || error || '');
  if (/\bapproval\b.*\b(required|denied|needed|request)|user confirmation|requires approval/i.test(raw)) {
    return {
      kind: 'approval-required',
      recoverable: true,
      message: 'Codex requested approval. Prefer a less invasive evidence path first: read-only inspection, file-first evidence, or local evidence. Only ask the user once when the requested task truly requires writes/network/destructive access.',
    };
  }
  if (/\b(sandbox|permission|EPERM|EACCES|Operation not permitted|Permission denied)\b/i.test(raw)) {
    return {
      kind: 'sandbox-permission',
      recoverable: true,
      message: 'Codex hit a sandbox/permission blocker. Keep the default read-only path when possible; reduce the probe to source/log evidence or ask for one scoped approval only if the user-requested verification cannot be done read-only.',
    };
  }
  return { kind: 'unknown', recoverable: false, message: raw };
}

export function execCodex({ bin, args }, options = {}) {
  // Test-only stub: short-circuit codex execution. Used by stderr/UX tests
  // to avoid spawning real codex (30-80s) in CI.
  if (process.env.BUDDY_STUB_CODEX === '1') {
    const mock = process.env.BUDDY_STUB_OUTPUT
      || '{"verdict":"proceed","findings":[],"questions":[]}';
    // Honor outputFile arg pattern (`-o <file>`) so callers reading the file see mock.
    const idx = args.indexOf('-o');
    if (idx >= 0 && args[idx + 1]) {
      try { fs.writeFileSync(args[idx + 1], mock); } catch {}
    }
    return Promise.resolve(mock);
  }

  const watchdogMs = options.timeout ?? DEFAULT_WATCHDOG_MS;

  return new Promise((resolve, reject) => {
    const child = nodeSpawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Close stdin immediately so Codex doesn't wait for additional input
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let killed = false;
    const spawnedAt = Date.now();
    let firstByteAt = null;

    const sigkillDelayMs = options.sigkillDelayMs ?? 5000;
    let sigkillTimer = null;
    const watchdog = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      sigkillTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, sigkillDelayMs);
      reject(new Error(`codex watchdog timeout after ${watchdogMs / 1000}s`));
    }, watchdogMs);

    // W9: first_byte tracks the first signal of activity. codex CLI emits the
    // version banner + reasoning items on stderr long before the final agent
    // message lands on stdout. Pre-W9 we measured stdout first-byte, which is
    // ~equal to total latency for short answers (伪指标). Use stderr instead.
    child.stderr.on('data', (data) => {
      if (firstByteAt === null) {
        firstByteAt = Date.now();
        if (typeof options.onFirstByte === 'function') {
          try { options.onFirstByte(firstByteAt - spawnedAt); } catch {}
        }
      }
      stderr += data.toString();
    });
    child.stdout.on('data', (data) => { stdout += data.toString(); });

    child.on('close', (code) => {
      clearTimeout(watchdog);
      clearTimeout(sigkillTimer);
      if (killed) return; // already rejected by watchdog
      if (code === 0) {
        resolve(stdout);
      } else {
        // Extract meaningful error from stderr (skip version banner, take last non-empty lines)
        const stderrLines = stderr.split('\n').filter(l => l.trim());
        const errorLines = stderrLines.filter(l =>
          /^(ERROR|error|Warning|fatal|FATAL|mcp.*failed)/i.test(l.trim())
        );
        const errorMsg = errorLines.length > 0
          ? errorLines.join(' | ')
          : stderrLines.slice(-3).join(' | ');
        const err = new Error(`codex exited with code ${code}: ${errorMsg}`);
        const classified = classifyCodexExecError(err);
        err.code = classified.kind === 'unknown' ? undefined : classified.kind;
        err.recoverable = classified.recoverable;
        err.recoveryHint = classified.message;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });

    child.on('error', (err) => {
      clearTimeout(watchdog);
      clearTimeout(sigkillTimer);
      if (killed) return;
      reject(new Error(`Failed to spawn codex: ${err.message}`));
    });
  });
}

/**
 * Backwards-compatible string builders for tests.
 * NOTE: These return display strings — do NOT pass to execSync.
 */
export function buildProbeCommand(opts) {
  const { bin, args } = buildProbeArgs(opts);
  return `${bin} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`;
}

export function buildResumeCommand(opts) {
  const { bin, args } = buildResumeArgs(opts);
  return `${bin} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`;
}

/**
 * Extract session ID from codex exec output.
 * Looks for "session id: <uuid>" line.
 * When --output-schema is enabled, codex suppresses the banner —
 * use parseSessionIdFromSessions() as a fallback in that case.
 */
export function parseSessionId(output) {
  const match = output.match(/session\s+id:\s+([0-9a-f-]+)/i);
  return match ? match[1] : null;
}

/**
 * Fallback: locate the most recent codex session rollout file by mtime
 * and extract the session UUID from its filename.
 * Filename pattern: rollout-YYYY-MM-DDTHH-MM-SS-<UUID>.jsonl
 * Used when stdout banner is suppressed (e.g., with --output-schema).
 */
export function parseSessionIdFromSessions(sinceMs = 60_000) {
  const baseDir = `${process.env.HOME}/.codex/sessions`;
  if (!fs.existsSync(baseDir)) return null;
  const cutoff = Date.now() - sinceMs;
  const uuidRe = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

  const candidates = [];
  for (const year of safeReaddir(baseDir)) {
    for (const month of safeReaddir(`${baseDir}/${year}`)) {
      for (const day of safeReaddir(`${baseDir}/${year}/${month}`)) {
        const dayDir = `${baseDir}/${year}/${month}/${day}`;
        for (const f of safeReaddir(dayDir)) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
          const full = `${dayDir}/${f}`;
          try {
            const stat = fs.statSync(full);
            if (stat.mtimeMs >= cutoff) candidates.push({ mtime: stat.mtimeMs, name: f });
          } catch {}
        }
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  const m = candidates[0].name.match(uuidRe);
  return m ? m[1] : null;
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/**
 * Check if codex CLI is available on the system.
 */
export function checkCodexAvailable() {
  try {
    execSync('command -v codex', { encoding: 'utf8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and save session ID to ~/.buddy/session.json
 */
export function saveSession(sessionId) {
  const dir = getBuddyHome();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/session.json`, JSON.stringify({ session_id: sessionId, updated: new Date().toISOString() }));
}

/**
 * Load last session ID from ~/.buddy/session.json
 */
export function loadSession() {
  const file = `${getBuddyHome()}/session.json`;
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).session_id;
  } catch {
    return null;
  }
}

/**
 * Buddy session ID storage (stage6a — official path pattern):
 *   PRIMARY:  resolveStateDir(cwd)/buddy-session.json
 *             keyed by git root + realpathSync, follows official codex-plugin-cc pattern.
 *             Honors $CLAUDE_PLUGIN_DATA for plugin environment isolation.
 *   FALLBACK: ~/.buddy/state/by-cwd/<hash8>.json — stage5e legacy (back-compat read)
 *   FALLBACK: ~/.buddy/buddy-session.json — global legacy pointer (back-compat read)
 *
 * cwd is the worktree / project directory (passed via --project-dir, never inferred
 * from process.cwd() since runtime can be invoked from any sub-dir).
 */
export function saveBuddySession(buddySessionId, opts = {}) {
  const updated = new Date().toISOString();
  // Primary: official-pattern per-workspace state file.
  if (opts && opts.cwd) {
    const file = resolveBuddySessionFile(opts.cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      buddy_session_id: buddySessionId,
      cwd: opts.cwd,
      updated,
      trigger: opts.trigger || 'manual',
    }));
  }
  // Compat: legacy global pointer — kept so older installs can still read it.
  const legacyFile = path.join(getBuddyHome(), 'buddy-session.json');
  const legacyDir = path.dirname(legacyFile);
  if (!fs.existsSync(legacyDir)) fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(legacyFile, JSON.stringify({ buddy_session_id: buddySessionId, updated }));
}

export function loadBuddySession(opts = {}) {
  // 1. Official-pattern per-workspace state (stage6a+).
  if (opts && opts.cwd) {
    const file = resolveBuddySessionFile(opts.cwd);
    if (fs.existsSync(file)) {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')).buddy_session_id; } catch { /* fallthrough */ }
    }
    // 2. Legacy stage5e per-cwd file (~/.buddy/state/by-cwd/<hash8>.json).
    const legacyCwdFile = path.join(
      getBuddyHome(), 'state', 'by-cwd',
      `${crypto.createHash('sha256').update(String(opts.cwd)).digest('hex').slice(0, 8)}.json`,
    );
    if (fs.existsSync(legacyCwdFile)) {
      try { return JSON.parse(fs.readFileSync(legacyCwdFile, 'utf8')).buddy_session_id; } catch { /* fallthrough */ }
    }
  }
  // 3. Legacy global pointer (~/.buddy/buddy-session.json).
  const globalFile = path.join(getBuddyHome(), 'buddy-session.json');
  if (!fs.existsSync(globalFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(globalFile, 'utf8')).buddy_session_id;
  } catch {
    return null;
  }
}

/**
 * Save the codex_session_id bound to a buddy session for `conversation` policy.
 * Subsequent conversation-mode probes resume this codex session.
 */
export function saveConversationSession(buddySessionId, codexSessionId) {
  const dir = getBuddyHome();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    `${dir}/conv-${buddySessionId}.json`,
    JSON.stringify({ codex_session_id: codexSessionId, updated: new Date().toISOString() }),
  );
}

export function loadConversationSession(buddySessionId) {
  const file = `${getBuddyHome()}/conv-${buddySessionId}.json`;
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).codex_session_id || null;
  } catch {
    return null;
  }
}
