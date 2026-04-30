// Stub: only used when disableBroker is false (broker-mode).
// codex-buddy always uses disableBroker:true (direct spawn).
export function ensureBrokerSession() { throw new Error('broker-lifecycle not supported'); }
export function loadBrokerSession() { return null; }
