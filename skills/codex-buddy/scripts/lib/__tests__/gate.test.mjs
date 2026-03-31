import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkFloorRules } from '../gate.mjs';

describe('gate — floor rules', () => {
  // Rule 1: destructive/irreversible operations
  test('rule 1: detects rm -rf', () => {
    const result = checkFloorRules('rm -rf /var/data');
    assert.equal(result.triggered, true);
    assert.equal(result.rule, 'floor:destructive');
  });

  test('rule 1: detects DROP TABLE', () => {
    const result = checkFloorRules('DROP TABLE users;');
    assert.equal(result.triggered, true);
    assert.equal(result.rule, 'floor:destructive');
  });

  test('rule 1: detects git push --force', () => {
    const result = checkFloorRules('git push --force origin main');
    assert.equal(result.triggered, true);
    assert.equal(result.rule, 'floor:destructive');
  });

  test('rule 1: detects git reset --hard', () => {
    const result = checkFloorRules('git reset --hard HEAD~3');
    assert.equal(result.triggered, true);
  });

  test('rule 1: detects migration keywords', () => {
    const result = checkFloorRules('ALTER TABLE users ADD COLUMN email');
    assert.equal(result.triggered, true);
    assert.equal(result.rule, 'floor:destructive');
  });

  test('rule 1: detects deploy', () => {
    const result = checkFloorRules('deploy to production');
    assert.equal(result.triggered, true);
  });

  // Rule 2: approval moments
  test('rule 2: detects approval questions in Chinese', () => {
    const result = checkFloorRules('能删掉这个文件吗？');
    assert.equal(result.triggered, true);
    assert.equal(result.rule, 'floor:approval');
  });

  test('rule 2: detects "is X safe"', () => {
    const result = checkFloorRules('Is this migration safe to run?');
    assert.equal(result.triggered, true);
    assert.equal(result.rule, 'floor:approval');
  });

  test('rule 2: detects confirmation pattern', () => {
    const result = checkFloorRules('确认可以执行吗？');
    assert.equal(result.triggered, true);
    assert.equal(result.rule, 'floor:approval');
  });

  // Rule 3: unverified correctness claims
  test('rule 3: detects "tests will pass"', () => {
    const result = checkFloorRules('测试会过', { ranTestsThisTurn: false });
    assert.equal(result.triggered, true);
    assert.equal(result.rule, 'floor:correctness');
  });

  test('rule 3: detects "no side effects"', () => {
    const result = checkFloorRules('没有副作用', { ranTestsThisTurn: false });
    assert.equal(result.triggered, true);
    assert.equal(result.rule, 'floor:correctness');
  });

  test('rule 3: does NOT trigger if tests were run', () => {
    const result = checkFloorRules('测试会过', { ranTestsThisTurn: true });
    assert.equal(result.triggered, false);
  });

  // No trigger
  test('safe content does not trigger', () => {
    const result = checkFloorRules('请帮我看看这段代码的逻辑');
    assert.equal(result.triggered, false);
    assert.equal(result.rule, null);
  });
});
