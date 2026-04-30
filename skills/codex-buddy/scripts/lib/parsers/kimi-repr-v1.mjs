/**
 * kimi-repr-v1.mjs — Parser for Kimi CLI --print output format
 *
 * Legacy Kimi --print emitted a Python-repr-style event stream:
 *   TurnBegin(user_input='...')
 *   ThinkPart(type='think', think='...', encrypted=None)
 *   TextPart(type='text', text='...')
 *   StatusUpdate(context_usage=..., ...)
 *   TurnEnd()
 *   To resume this session: kimi -r <uuid>
 *
 * This is NOT a public contract — format may change across Kimi versions.
 * All parsing is best-effort. Never throws; all errors → parseStatus:'failed'.
 *
 * Contract: { version, match(raw), parse(raw) }
 *   parse returns: { think: string[], text: string[], sessionId: string|null,
 *                    parseStatus: 'ok'|'partial'|'failed' }
 *   'ok'      = both think and text extracted
 *   'partial' = text extracted but think missing (or vice versa)
 *   'failed'  = no text extracted
 */

export const version = 'kimi-repr-v1';

/**
 * Returns true if the raw string looks like Kimi --print output.
 * Never throws.
 */
export function match(raw) {
  if (!raw || typeof raw !== 'string') return false;
  try {
    return /^(?:TextPart|ThinkPart|TurnBegin|TurnEnd|StepBegin|StatusUpdate)\(/m.test(raw);
  } catch {
    return false;
  }
}

/**
 * Parse Kimi --print stdout into structured fields.
 * Never throws — all errors return parseStatus:'failed' with raw preserved by caller.
 */
export function parse(raw) {
  const empty = { think: [], text: [], sessionId: null, parseStatus: 'failed' };
  if (!raw || typeof raw !== 'string') return empty;

  try {
    const thinks = [];
    const texts = [];
    let sessionId = null;

    // ── ThinkPart: extract think='...' ──────────────────────────────────────
    // Handles multiline think content and escaped single quotes.
    // Pattern: \bthink='(content)' where content = any chars except unescaped '
    const thinkRe = /\bthink='((?:[^'\\]|\\.)*)'/gs;
    let m;
    while ((m = thinkRe.exec(raw)) !== null) {
      thinks.push(unescapeRepr(m[1]));
    }

    // ── TextPart: extract text='...' only from inside TextPart(...) blocks ──
    // We find each TextPart( block, then extract text= from within it.
    // Using [^]*? (non-greedy dotAll) to match block content.
    const textBlockRe = /TextPart\([^]*?(?:\btext='((?:[^'\\]|\\.)*)')/gs;
    while ((m = textBlockRe.exec(raw)) !== null) {
      if (m[1] !== undefined) texts.push(unescapeRepr(m[1]));
    }

    // ── Session ID ───────────────────────────────────────────────────────────
    const sessionM = raw.match(/To resume this session:\s*kimi\s+-r\s+(\S+)/);
    if (sessionM) sessionId = sessionM[1].trim();

    // ── Status ──────────────────────────────────────────────────────────────
    const parseStatus =
      texts.length > 0 && thinks.length > 0 ? 'ok' :
      texts.length > 0 ? 'partial' :
      'failed';

    return { think: thinks, text: texts, sessionId, parseStatus };
  } catch {
    return empty;
  }
}

// Unescape Python repr single-quoted string escapes.
function unescapeRepr(s) {
  if (!s) return s;
  return s.replace(/\\'/g, "'").replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
}
