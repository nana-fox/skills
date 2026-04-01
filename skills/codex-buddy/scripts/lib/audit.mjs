import fs from 'node:fs';
import path from 'node:path';

// No hard budget limit. Audit tracks call count for observability only.
// Soft guidance in SKILL.md: max 2 Codex calls per decision (probe + follow-up).

export function appendLog(logFile, envelope, sessionId, workspace, latencyMs) {
  const dir = path.dirname(logFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const entry = {
    ...envelope,
    session_id: sessionId,
    workspace,
    timestamp: new Date().toISOString(),
  };
  if (latencyMs !== undefined) {
    entry.latency_ms = latencyMs;
  }

  fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
}

export function getCallCount(logFile, sessionId) {
  if (!fs.existsSync(logFile)) return 0;

  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  return lines.reduce((count, line) => {
    const entry = JSON.parse(line);
    if (entry.session_id === sessionId && (entry.route === 'codex' || entry.route === 'both')) {
      return count + 1;
    }
    return count;
  }, 0);
}

export function getCallCount_session(logFile, sessionId) {
  return getCallCount(logFile, sessionId);
}
