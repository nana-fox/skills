#!/usr/bin/env node
import fs from 'node:fs';
import { assessReply } from '../scripts/lib/reply-assessor.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = 'true';
    }
  }
  return args;
}

function readJson(file, fallback = null) {
  if (!file) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function runReplayEvals({ evalSet, replies = {} }) {
  const evals = Array.isArray(evalSet?.evals) ? evalSet.evals : [];
  const failures = [];
  let passed = 0;
  let skipped = 0;

  for (const item of evals) {
    if (!item.assertions || !Object.keys(item.assertions).length) {
      skipped++;
      continue;
    }
    const reply = replies[String(item.id)] || item.expected_reply || '';
    const result = assessReply({
      prompt: item.prompt || '',
      reply,
      assertions: item.assertions,
    });
    if (result.status === 'ok') {
      passed++;
    } else {
      failures.push({
        id: item.id,
        prompt: item.prompt,
        violations: result.violations,
        warnings: result.warnings,
      });
    }
  }

  return {
    status: failures.length ? 'failed' : 'ok',
    total: evals.length,
    asserted: evals.length - skipped,
    passed,
    failed: failures.length,
    skipped,
    failures,
  };
}

if (process.argv[1] && process.argv[1].endsWith('replay-evals.mjs')) {
  const args = parseArgs(process.argv);
  if (!args['eval-set']) {
    process.stdout.write(JSON.stringify({ status: 'error', message: 'Missing --eval-set <file>' }, null, 2) + '\n');
    process.exit(1);
  }
  try {
    const evalSet = readJson(args['eval-set']);
    const replies = readJson(args.replies, {});
    const result = runReplayEvals({ evalSet, replies });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.failed ? 1 : 0);
  } catch (e) {
    process.stdout.write(JSON.stringify({ status: 'error', message: e.message }, null, 2) + '\n');
    process.exit(1);
  }
}
