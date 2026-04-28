/**
 * redact.mjs — minimal regex-based payload sanitizer for session-log raw payload.
 *
 * Default behavior: redact common secrets before writing to ~/.buddy/sessions/*.jsonl.
 * Set BUDDY_AUDIT_RAW=1 to bypass redaction and write raw payload (debug only).
 */

const REDACTION_POLICY_VERSION = '1';

const PATTERNS = [
  // OpenAI keys (incl. sk-proj-, sk-svcacct-, sk-admin-...) — match before bare sk-
  [/\bsk-(?:proj|svcacct|admin|None)-[a-zA-Z0-9_-]{20,}\b/g, '[REDACTED:openai-key]'],
  [/\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g, '[REDACTED:anthropic-key]'],
  [/\bsk-[a-zA-Z0-9]{20,}\b/g, '[REDACTED:openai-key]'],
  // GitHub tokens — classic ghp_/gho_/ghu_/ghs_/ghr_ + new fine-grained github_pat_
  [/\bgh[pousr]_[a-zA-Z0-9]{30,}\b/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[a-zA-Z0-9_]{50,}\b/g, '[REDACTED:github-token]'],
  // Slack / Stripe / common high-entropy tokens
  [/\bxox[abprs]-[a-zA-Z0-9-]{10,}\b/g, '[REDACTED:slack-token]'],
  [/\b(?:rk|sk)_(?:live|test)_[a-zA-Z0-9]{20,}\b/g, '[REDACTED:stripe-key]'],
  // AWS keys
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-access-key]'],
  // JWT-ish
  [/\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\b/g, '[REDACTED:jwt]'],
  // Authorization: Bearer <opaque-token>  (header-style; pure opaque tokens have no prefix)
  [/\b(Authorization|Proxy-Authorization)\s*:\s*(Bearer|Basic|Token)\s+[A-Za-z0-9+/=._~-]{16,}/gi,
   (_m, h, scheme) => `${h}: ${scheme} [REDACTED:bearer]`],
  // generic key=value secrets in env-style strings or JSON
  [/(["']?(?:api[_-]?key|api_secret|secret|token|password|passwd|authorization|cookie|set-cookie|bearer|access[_-]?token|refresh[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?)([^"'\s,;}]{6,})(["']?)/gi,
   (_m, p1, _p2, p3) => `${p1}[REDACTED:secret]${p3}`],
];

export function redact(text) {
  if (typeof text !== 'string' || !text.length) return text;
  let out = text;
  for (const [re, replacement] of PATTERNS) {
    out = typeof replacement === 'function' ? out.replace(re, replacement) : out.replace(re, replacement);
  }
  return out;
}

export function shouldWriteRaw() {
  return process.env.BUDDY_AUDIT_RAW === '1';
}

export { REDACTION_POLICY_VERSION };
