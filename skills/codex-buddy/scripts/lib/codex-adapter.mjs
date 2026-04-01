import { execSync, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';

/**
 * Build args array for `codex exec` probe.
 * Returns { bin, args } for use with spawn (no shell interpretation).
 */
export function buildProbeArgs({ projectDir, outputFile, prompt, json = false, outputSchema = null, sandbox = 'read-only' }) {
  const args = [
    'exec',
    '-C', projectDir,
    '-s', sandbox,
    '--skip-git-repo-check',
    '-o', outputFile,
  ];

  if (json) args.push('--json');
  if (outputSchema) args.push('--output-schema', outputSchema);

  // Prompt goes last as a single argument — no shell escaping needed
  args.push(prompt);

  return { bin: 'codex', args };
}

/**
 * Build args array for `codex exec resume` (follow-up/challenge).
 * Returns { bin, args } for use with spawn.
 */
export function buildResumeArgs({ sessionId, outputFile, prompt }) {
  return {
    bin: 'codex',
    args: ['exec', 'resume', sessionId, '-o', outputFile, prompt],
  };
}

/**
 * Execute a codex command using async spawn (non-blocking).
 * Watchdog timeout defaults to 5 minutes — generous enough for slow API
 * responses but prevents indefinite hangs from stuck processes.
 * Returns a Promise that resolves to stdout string.
 */
const DEFAULT_WATCHDOG_MS = 5 * 60 * 1000; // 5 minutes

export function execCodex({ bin, args }, options = {}) {
  const watchdogMs = options.timeout ?? DEFAULT_WATCHDOG_MS;

  return new Promise((resolve, reject) => {
    const child = nodeSpawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const watchdog = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      reject(new Error(`codex watchdog timeout after ${watchdogMs / 1000}s`));
    }, watchdogMs);

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      clearTimeout(watchdog);
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
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });

    child.on('error', (err) => {
      clearTimeout(watchdog);
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
 */
export function parseSessionId(output) {
  const match = output.match(/session\s+id:\s+([0-9a-f-]+)/i);
  return match ? match[1] : null;
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
  const dir = `${process.env.HOME}/.buddy`;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/session.json`, JSON.stringify({ session_id: sessionId, updated: new Date().toISOString() }));
}

/**
 * Load last session ID from ~/.buddy/session.json
 */
export function loadSession() {
  const file = `${process.env.HOME}/.buddy/session.json`;
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).session_id;
  } catch {
    return null;
  }
}

/**
 * Save buddy session ID (distinct from Codex session ID).
 * Used for budget tracking across calls within one Claude session.
 */
export function saveBuddySession(buddySessionId) {
  const dir = `${process.env.HOME}/.buddy`;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/buddy-session.json`, JSON.stringify({ buddy_session_id: buddySessionId, updated: new Date().toISOString() }));
}

/**
 * Load buddy session ID for budget tracking.
 */
export function loadBuddySession() {
  const file = `${process.env.HOME}/.buddy/buddy-session.json`;
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).buddy_session_id;
  } catch {
    return null;
  }
}
