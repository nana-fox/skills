import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractKeywords, jaccardSimilarity, checkTopicDrift } from '../topic-drift.mjs';

describe('topic-drift', () => {
  describe('extractKeywords', () => {
    test('lower-cases and removes stopwords', () => {
      const kw = extractKeywords('Is this migration safe for production?');
      assert.ok(kw.has('migration'));
      assert.ok(kw.has('safe'));
      assert.ok(kw.has('production'));
      assert.ok(!kw.has('is'));
      assert.ok(!kw.has('for'));
    });

    test('returns empty set for empty input', () => {
      assert.equal(extractKeywords('').size, 0);
      assert.equal(extractKeywords(null).size, 0);
    });

    test('only uses first line', () => {
      const kw = extractKeywords('authentication security\ncompletely different topic here');
      assert.ok(kw.has('authentication'));
      assert.ok(kw.has('security'));
      // second line should not contribute
      assert.ok(!kw.has('completely'));
    });
  });

  describe('jaccardSimilarity', () => {
    test('identical sets → 1', () => {
      const s = new Set(['a', 'b', 'c']);
      assert.equal(jaccardSimilarity(s, s), 1);
    });

    test('disjoint sets → 0', () => {
      assert.equal(jaccardSimilarity(new Set(['a', 'b']), new Set(['c', 'd'])), 0);
    });

    test('partial overlap', () => {
      const j = jaccardSimilarity(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']));
      assert.ok(j > 0 && j < 1);
    });

    test('two empty sets → 1 (no signal)', () => {
      assert.equal(jaccardSimilarity(new Set(), new Set()), 1);
    });
  });

  describe('checkTopicDrift', () => {
    test('high-similarity tasks → no warning', () => {
      const prev = 'Is this database migration safe for the production schema?';
      const curr = 'Check if the migration rollback script is safe for production schema';
      const { warning } = checkTopicDrift(prev, curr);
      assert.equal(warning, null, `expected no warning for similar tasks, got: ${warning}`);
    });

    test('low-similarity tasks → warning with Jaccard info', () => {
      const prev = 'Is this database migration safe?';
      const curr = 'Does the authentication token expire correctly for mobile users?';
      const { warning, jaccard } = checkTopicDrift(prev, curr);
      assert.ok(warning !== null, 'expected drift warning for unrelated topics');
      assert.match(warning, /topic-drift detected/);
      assert.match(warning, /Jaccard=/);
      assert.match(warning, /--fresh-thread/);
      assert.ok(jaccard < 0.15);
    });

    test('null/empty inputs → no warning', () => {
      assert.equal(checkTopicDrift(null, 'something').warning, null);
      assert.equal(checkTopicDrift('something', null).warning, null);
      assert.equal(checkTopicDrift('', '').warning, null);
    });

    test('custom threshold respected', () => {
      // Set threshold to 1.0 → always warns unless identical
      const prev = 'database migration safety check';
      const curr = 'database migration safety check'; // identical
      const { warning } = checkTopicDrift(prev, curr, 1.0);
      // Jaccard=1.0 is NOT < 1.0, so no warning
      assert.equal(warning, null);
    });
  });
});
