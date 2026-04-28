/**
 * paths.mjs — central buddy home resolver.
 *
 * Honors BUDDY_HOME env (used by tests + CI to isolate from user's real ~/.buddy).
 * Falls back to ~/.buddy.
 */
import path from 'node:path';

export function getBuddyHome() {
  return process.env.BUDDY_HOME || path.join(process.env.HOME || '/tmp', '.buddy');
}
