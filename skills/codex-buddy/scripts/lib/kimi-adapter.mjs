/**
 * kimi-adapter.mjs — Kimi CLI execution adapter for codex-buddy
 *
 * Legacy Kimi exec fallback. The default provider transport is implemented in
 * kimi-wire-client.mjs via `kimi --wire`.
 * Invocation: kimi --quiet -p "<prompt>"
 * Output:     final assistant message on stdout (preferred), with legacy
 *             --print repr parsing retained as best-effort fallback.
 *
 * Returns: { raw, stderr, parsed: {think, text, sessionId}, parseStatus,
 *            parserVersion, model: 'kimi', exitCode }
 */

import { spawnSync } from 'node:child_process';
import { parse, version as parserVersion } from './parsers/kimi-repr-v1.mjs';

export const MODEL = 'kimi';

/**
 * Build kimi CLI argument list for a one-shot probe.
 * @param {string} prompt — the full evidence+task prompt
 * @param {object} [opts]
 * @param {string} [opts.model]        — override kimi model (not passed by default)
 * @param {string} [opts.workDir]      — working directory override
 * @returns {string[]}
 */
export function buildProbeArgs(prompt, opts = {}) {
  const args = ['--quiet', '-p', prompt];
  if (opts.model) args.unshift('-m', opts.model);
  return args;
}

/**
 * Execute kimi one-shot probe.
 * @param {string} prompt
 * @param {object} opts
 * @param {string} [opts.projectDir]   — cwd for kimi invocation
 * @param {string} [opts.model]        — optional model override (user-requested only)
 * @param {number} [opts.timeoutMs]    — spawn timeout (default 120s)
 * @returns {{ exitCode: number, raw: string, stderr: string, parsed: object,
 *             parseStatus: string, parserVersion: string, model: 'kimi' }}
 */
export function execKimi(prompt, opts = {}) {
  const args = buildProbeArgs(prompt, { model: opts.model });
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const bin = process.env.BUDDY_KIMI_BIN || 'kimi';
  const cwd = opts.projectDir || process.cwd();

  let result;
  try {
    result = spawnSync(bin, args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10 MiB
    });
  } catch (spawnErr) {
    const raw = spawnErr.message || 'kimi spawn failed';
    return { exitCode: -1, raw, stderr: raw, stderrTail: tail(raw), parsed: { think: [], text: [], sessionId: null },
             parseStatus: 'failed', parserVersion, model: MODEL, bin, cwd, timeoutMs,
             errorCode: classifyKimiError(raw, null), spawnError: raw };
  }

  // Handle system-level spawn errors (e.g. ENOENT — kimi not installed)
  if (result.error) {
    const spawnError = result.error.message;
    const errorCode = result.error.code === 'ETIMEDOUT'
      ? 'kimi-timeout'
      : classifyKimiError(`${result.stderr || ''}\n${spawnError}`, result.error.code);
    return { exitCode: -1, raw: result.error.message,
             stderr: result.stderr || result.error.message,
             stderrTail: tail(result.stderr || result.error.message),
             parsed: { think: [], text: [], sessionId: null },
             parseStatus: 'failed', parserVersion, model: MODEL,
             spawnError, errorCode, bin, cwd, timeoutMs };
  }

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const errorCode = classifyKimiError(stderr || stdout, null);
  const stderrTail = tail(stderr || stdout);
  const parsed = parse(stdout);
  const quietText = stdout.trim();
  if (quietText && parsed.parseStatus === 'failed') {
    return {
      exitCode: result.status ?? -1,
      raw: stdout,
      stderr,
      parsed: { think: [], text: [quietText], sessionId: null },
      parseStatus: 'ok',
      parserVersion: 'kimi-quiet-v1',
      model: MODEL,
      errorCode,
      stderrTail,
      bin,
      cwd,
      timeoutMs,
    };
  }

  return {
    exitCode: result.status ?? -1,
    raw: stdout,
    stderr,
    parsed,
    parseStatus: parsed.parseStatus,
    parserVersion,
    model: MODEL,
    errorCode,
    stderrTail,
    bin,
    cwd,
    timeoutMs,
  };
}

function tail(text) {
  return String(text || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ');
}

function classifyKimiError(text, spawnCode) {
  const value = String(text || '');
  if (spawnCode === 'ETIMEDOUT' || /\bETIMEDOUT\b/i.test(value)) return 'kimi-timeout';
  if (/PermissionError|Operation not permitted|EACCES|EPERM/i.test(value)) return 'kimi-permission';
  return null;
}

/**
 * Preflight check: verify kimi CLI is installed and functional.
 * @returns {{ ok: boolean, version: string|null, error: string|null }}
 */
export function preflight() {
  try {
    const r = spawnSync(process.env.BUDDY_KIMI_BIN || 'kimi', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (r.status === 0) {
      const versionLine = (r.stdout || '').trim().split('\n')[0] || '';
      return { ok: true, version: versionLine || null, error: null };
    }
    return { ok: false, version: null,
             error: `kimi --version exited ${r.status}: ${(r.stderr || '').slice(0, 200)}` };
  } catch (e) {
    return { ok: false, version: null, error: e.message || 'kimi not found' };
  }
}
