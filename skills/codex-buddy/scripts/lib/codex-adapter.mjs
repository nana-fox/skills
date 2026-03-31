import { execSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Build a `codex exec` probe command string.
 * Fixed template — Claude never hand-crafts codex commands.
 */
export function buildProbeCommand({ projectDir, outputFile, prompt, json = false, outputSchema = null, sandbox = 'read-only' }) {
  const parts = [
    'codex exec',
    `-C "${projectDir}"`,
    `-s ${sandbox}`,
    '--skip-git-repo-check',
    `-o "${outputFile}"`,
  ];

  if (json) parts.push('--json');
  if (outputSchema) parts.push(`--output-schema "${outputSchema}"`);

  // Prompt goes last, quoted
  parts.push(`"${prompt.replace(/"/g, '\\"')}"`);

  return parts.join(' ');
}

/**
 * Build a `codex exec resume` command for follow-up/challenge.
 */
export function buildResumeCommand({ sessionId, outputFile, prompt }) {
  const parts = [
    `codex exec resume "${sessionId}"`,
    `-o "${outputFile}"`,
    `"${prompt.replace(/"/g, '\\"')}"`,
  ];

  return parts.join(' ');
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
