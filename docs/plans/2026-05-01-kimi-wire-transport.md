# Kimi Wire Transport Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `kimi --wire` the target transport for the codex-buddy Kimi provider, with exec retained only as fallback.

**Architecture:** Add a Kimi Wire JSON-RPC client that spawns `kimi --wire`, performs optional `initialize`, sends `prompt`, collects `event` notifications into provider events, rejects unsupported agent requests, and uses protocol `cancel` before killing a timed-out process. Provider routing defaults to Wire and falls back to exec only for Wire startup/protocol failures.

**Tech Stack:** Node.js stdlib only (`child_process`, `readline`, `crypto`, `node:test`), existing `providers.mjs` provider contract, existing buddy-runtime audit/event shape.

---

### Task 1: Kimi Wire Client

**Files:**
- Create: `skills/codex-buddy/scripts/lib/kimi-wire-client.mjs`
- Test: `skills/codex-buddy/scripts/lib/__tests__/kimi-wire-client.test.mjs`

**Step 1: Write failing tests**

Cover:
- successful Wire turn collects `ContentPart` text and returns `finalMessage`
- `initialize` method-not-found falls back to no-handshake prompt
- Wire `request` messages receive safe reject/error responses
- timeout sends `cancel` before process kill and reports `kimi-wire-timeout`

**Step 2: Verify RED**

Run: `node --test skills/codex-buddy/scripts/lib/__tests__/kimi-wire-client.test.mjs`

Expected: FAIL because `kimi-wire-client.mjs` does not exist.

**Step 3: Implement minimal Wire client**

Implement:
- `runKimiWireTurn(prompt, opts)`
- `spawnKimiWire(projectDir)`
- line-oriented JSON-RPC handling
- request/response map
- notification handling for `event`
- safe request response helpers
- protocol cancel on timeout

**Step 4: Verify GREEN**

Run: `node --test skills/codex-buddy/scripts/lib/__tests__/kimi-wire-client.test.mjs`

Expected: PASS.

### Task 2: Provider Routing

**Files:**
- Modify: `skills/codex-buddy/scripts/lib/providers.mjs`
- Test: `skills/codex-buddy/scripts/lib/__tests__/providers.test.mjs`

**Step 1: Write failing tests**

Cover:
- Kimi capabilities expose `wire` before `exec`
- `startTurn` uses Wire by default when fake Wire CLI succeeds
- Wire startup/protocol failures fall back to exec

**Step 2: Verify RED**

Run: `node --test skills/codex-buddy/scripts/lib/__tests__/providers.test.mjs`

Expected: FAIL because Kimi currently exposes only `exec`.

**Step 3: Implement provider integration**

Update Kimi capabilities:
- `transports: ['wire', 'exec']`
- `supportsCancel: true`
- `supportsStreaming: true`
- `outputMode: 'events'`

Route `startKimiTurn` through `runKimiWireTurn` by default, with `BUDDY_KIMI_TRANSPORT=exec` fallback override.

**Step 4: Verify GREEN**

Run: `node --test skills/codex-buddy/scripts/lib/__tests__/providers.test.mjs`

Expected: PASS.

### Task 3: Runtime and Docs

**Files:**
- Modify: `skills/codex-buddy/scripts/buddy-runtime.mjs`
- Modify: `skills/codex-buddy/references/kimi-cli.md`
- Modify: `skills/codex-buddy/README.md`
- Test: `skills/codex-buddy/scripts/__tests__/buddy-runtime.test.mjs`

**Step 1: Write failing tests**

Cover:
- runtime output shows Kimi transport `wire`
- provider events from Wire are included in audit rows
- explicit `BUDDY_KIMI_TRANSPORT=exec` remains compatible

**Step 2: Verify RED**

Run: `node --test skills/codex-buddy/scripts/__tests__/buddy-runtime.test.mjs`

Expected: FAIL until provider output includes Wire details.

**Step 3: Implement runtime/doc updates**

Map Wire metadata into existing output fields and document:
- Wire is the target Kimi transport
- exec is fallback only
- `--quiet` is legacy compatibility
- timeout behavior uses protocol cancel first

**Step 4: Full verification**

Run: `node --test skills/codex-buddy/scripts/**/*.test.mjs`

Expected: PASS.
