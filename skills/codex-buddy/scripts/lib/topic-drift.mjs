/**
 * topic-drift.mjs — W6.5 anti-contamination tripwire.
 *
 * Cheap Jaccard similarity between consecutive task_to_judge keyword sets.
 * Below threshold: emit a soft warning on stderr (never auto-fork or block).
 *
 * Usage:
 *   checkTopicDrift(prev, next)  → { jaccard, warning: string|null }
 *   extractKeywords(text)         → Set<string>
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'not', 'is', 'are', 'was', 'were', 'be',
  'has', 'have', 'had', 'do', 'does', 'did', 'of', 'in', 'on', 'at', 'to',
  'for', 'it', 'this', 'that', 'with', 'by', 'as', 'from', 'if', 'then',
  '的', '了', '是', '在', '有', '和', '与', '或', '但', '不', '也', '都',
]);

const DEFAULT_DRIFT_THRESHOLD = 0.15;

/**
 * Extract meaningful keyword tokens from a task_to_judge string.
 * Lower-cases, splits on non-word boundaries, removes stopwords and short tokens.
 */
export function extractKeywords(text) {
  if (!text || typeof text !== 'string') return new Set();
  // Extract first line (task_to_judge is typically a single sentence).
  const line = text.split('\n')[0].toLowerCase();
  const tokens = line.split(/[\s\p{P}]+/u).filter(Boolean);
  const words = tokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(words);
}

/**
 * Compute Jaccard similarity between two Sets.
 * Returns a number in [0, 1]. Empty intersection → 0. Identical → 1.
 */
export function jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 1; // both empty = same (no signal)
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}

/**
 * Check topic drift between the previous and current task_to_judge texts.
 *
 * Returns:
 *   { jaccard: number, warning: string|null }
 *
 * warning is non-null when Jaccard < threshold, signalling that the topic
 * has shifted significantly and --fresh-thread should be considered.
 * Never throws; if either text is empty the check is skipped (no warning).
 */
export function checkTopicDrift(prevTask, currentTask, threshold = DEFAULT_DRIFT_THRESHOLD) {
  if (!prevTask || !currentTask) return { jaccard: null, warning: null };
  const prevKw = extractKeywords(prevTask);
  const currKw = extractKeywords(currentTask);
  if (prevKw.size === 0 || currKw.size === 0) return { jaccard: null, warning: null };

  const jaccard = jaccardSimilarity(prevKw, currKw);
  if (jaccard < threshold) {
    const warning = `[buddy] topic-drift detected (Jaccard=${jaccard.toFixed(2)}), consider --fresh-thread`;
    return { jaccard, warning };
  }
  return { jaccard, warning: null };
}
