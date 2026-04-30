// Validates that what appendLog writes actually conforms to envelope.schema.json.
// Catches the C3 regression class: schema drifted from writer.
//
// Hand-rolled minimal validator (no ajv dep) — checks required fields, type,
// enum, and additionalProperties:false. Sufficient for our schema shape.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

import { appendLog } from '../audit.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../../../schemas/envelope.schema.json');

function loadSchema() {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

function typeOK(val, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  for (const t of types) {
    if (t === 'null' && val === null) return true;
    if (t === 'string' && typeof val === 'string') return true;
    if (t === 'integer' && Number.isInteger(val)) return true;
    if (t === 'number' && typeof val === 'number') return true;
    if (t === 'boolean' && typeof val === 'boolean') return true;
    if (t === 'array' && Array.isArray(val)) return true;
    if (t === 'object' && val && typeof val === 'object' && !Array.isArray(val)) return true;
  }
  return false;
}

function validate(entry, schema) {
  const errors = [];
  for (const req of schema.required || []) {
    if (!(req in entry)) errors.push(`missing required: ${req}`);
  }
  for (const [k, v] of Object.entries(entry)) {
    const prop = schema.properties[k];
    if (!prop) {
      if (schema.additionalProperties === false) errors.push(`unknown field: ${k}`);
      continue;
    }
    if (prop.type && !typeOK(v, prop.type)) errors.push(`${k} type mismatch: expected ${prop.type}, got ${typeof v}`);
    if (prop.enum && !prop.enum.includes(v)) errors.push(`${k} enum mismatch: ${v} not in ${prop.enum}`);
    if (prop.const !== undefined && v !== prop.const) errors.push(`${k} const mismatch: expected ${prop.const}, got ${v}`);
  }
  return errors;
}

describe('envelope.schema.json conformance', () => {
  let tmpDir;
  let logFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-schema-'));
    logFile = path.join(tmpDir, 'logs.jsonl');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  test('appendLog output validates against schema (C3: schema must track writer)', () => {
    const envelope = {
      turn: 1, level: 'V2', rule: 'r', triggered: true,
      route: 'codex', evidence: ['ok'], conclusion: 'proceed',
    };
    appendLog(logFile, envelope, 'buddy-001', '/tmp', 1234, {
      action: 'probe',
      verification_task_id: 'vtask-x',
    });
    const entry = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
    const schema = loadSchema();
    const errors = validate(entry, schema);
    assert.deepEqual(errors, [], `entry must conform to schema; got: ${errors.join('; ')}`);
  });

  test('local action entry validates', () => {
    const envelope = {
      turn: 0, level: 'V2', rule: 'manual', triggered: true,
      route: 'local', evidence: [], conclusion: 'proceed',
    };
    appendLog(logFile, envelope, 'buddy-002', '/tmp', 1, {
      action: 'local',
      verification_task_id: 'vtask-local-1',
    });
    const entry = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
    const errors = validate(entry, loadSchema());
    assert.deepEqual(errors, [], `local entry must conform; got: ${errors.join('; ')}`);
  });
});
