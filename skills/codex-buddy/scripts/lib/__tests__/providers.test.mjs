import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getProvider,
  listProviders,
  normalizeProviderName,
  shouldFallbackFromBrokerError,
} from '../providers.mjs';

describe('providers', () => {
  test('normalizes missing provider to codex', () => {
    assert.equal(normalizeProviderName(undefined), 'codex');
    assert.equal(normalizeProviderName(''), 'codex');
  });

  test('describes codex as broker-capable and kimi as exec-only', () => {
    const codex = getProvider('codex');
    const kimi = getProvider('kimi');

    assert.equal(codex.name, 'codex');
    assert.deepEqual(codex.transports, ['broker', 'app-server', 'exec']);
    assert.equal(codex.supportsFreshThread, true);

    assert.equal(kimi.name, 'kimi');
    assert.deepEqual(kimi.transports, ['exec']);
    assert.equal(kimi.supportsFreshThread, false);
  });

  test('registry exposes provider contract entrypoints', () => {
    assert.deepEqual(listProviders().sort(), ['codex', 'kimi']);
    for (const name of listProviders()) {
      const provider = getProvider(name);
      assert.equal(typeof provider.preflight, 'function');
      assert.equal(typeof provider.startTurn, 'function');
      assert.ok(provider.capabilities);
      assert.equal(provider.capabilities.name, name);
      assert.ok(Array.isArray(provider.capabilities.transports));
    }
  });

  test('rejects unknown buddy providers', () => {
    assert.throws(() => getProvider('gemini'), /Unsupported buddy model/);
  });

  test('classifies broker startup failures that can fall back to exec', () => {
    assert.equal(shouldFallbackFromBrokerError(new Error('listen EPERM: operation not permitted /tmp/x.sock')), true);
    assert.equal(shouldFallbackFromBrokerError(new Error('bind EACCES: permission denied /tmp/x.sock')), true);
    assert.equal(shouldFallbackFromBrokerError(new Error('spawnBroker: broker did not become reachable within 5000ms')), true);
    assert.equal(shouldFallbackFromBrokerError(new Error('turn/start failed: operation not permitted reading fixture')), false);
    assert.equal(shouldFallbackFromBrokerError(new Error('turn failed: model refused')), false);
  });
});
