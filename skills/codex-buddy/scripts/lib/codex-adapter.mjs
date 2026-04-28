import { execSync, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';

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

export function execCodex({ bin, args }, options = {}) {
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

/**
 * Save the codex_session_id bound to a buddy session for `conversation` policy.
 * Subsequent conversation-mode probes resume this codex session.
 */
export function saveConversationSession(buddySessionId, codexSessionId) {
  const dir = `${process.env.HOME}/.buddy`;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    `${dir}/conv-${buddySessionId}.json`,
    JSON.stringify({ codex_session_id: codexSessionId, updated: new Date().toISOString() }),
  );
}

export function loadConversationSession(buddySessionId) {
  const file = `${process.env.HOME}/.buddy/conv-${buddySessionId}.json`;
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).codex_session_id || null;
  } catch {
    return null;
  }
}
