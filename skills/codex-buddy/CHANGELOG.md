# CHANGELOG

迭代日志：每轮 Claude + Codex 协作改进记录。

---

## v3.3.0 — 2026-05-03 Replayable active-buddy evals

### Content
- **`reply-assessor.mjs` / `buddy-runtime.mjs`**：新增 `--action assess-reply`，可检查 V-level header、probe 触发、低侵扰 sandbox recovery、未验证标注等协议遵守情况。
- **`evals/replay-evals.mjs`**：新增可回放 eval runner，读取 `evals.json` 的 machine-checkable `assertions`，输出 total/asserted/pass/fail/skip/failures。
- **`evals.json`**：为 5 条高价值用例补 `assertions` 和 `expected_reply`，覆盖工具属性和 active buddy 关键风险。
- **`verify-repo.sh`**：新增 replay evals gate，防止 evals 只停留在自然语言期望。
- **`buddy-runtime.mjs`**：`--project-dir` 缺省时自动使用当前工作目录，减少主 agent/其他 AI 工具因少传参数产生的无意义阻塞。

### 架构决策
- active buddy 先做“策略注入 + advisory hook + 可回放审计”，不做强制后台拦截。
- 旧 eval 用例保持兼容；没有 `assertions` 的用例会被 runner 计入 skipped，不阻塞。
- 先覆盖最关键行为：V-level、该 probe 时 probe、不该 probe 时不 probe、V1 未验证标注、sandbox 低侵扰恢复。

---

## v3.2.2 — 2026-05-03 Low-intrusion probe recovery

### Content
- **`SKILL.md` / references**：默认 evidence 通道改为 file-first；`--evidence-stdin` 只允许同命令真实 pipe/heredoc，TTY/empty stdin 明确视为提示设计失败并提示 file-first 恢复。
- **`buddy-runtime.mjs`**：probe/followup/annotate/log-synthesis/log-reply 的 session audit 写入改为 best-effort；probe/followup/local 的 summary audit `logs.jsonl` 也改为 best-effort 并输出 `audit_logged`；审计日志失败只输出 warning，不阻塞主结果。
- **`codex-adapter.mjs`**：识别 `approval-required` / `sandbox-permission` 类 Codex exec 错误，返回 recoverable recovery hint，优先引导 local/file evidence 或 read-only 证据包。
- **`evals.json`**：新增 sandbox approval 低侵扰恢复用例，防止后续提示回退到静默升权或反复打扰用户。

### 架构决策
- Codex probe 默认保持 `read-only` + `approval never`；遇授权阻塞返回 recoverable recovery hint，引导调用侧改用 local/file evidence 或缩小只读证据包，只有用户目标确实需要写/联网/破坏性权限时才一次性请求授权。
- AI 工具对接中的提示、输入、provider、沙箱/授权、日志落盘摩擦都属于本项目兜底范围；默认引导到 file-first/local/read-only 证据路径，不能把阻塞转嫁给客户。
- `~/.buddy/sessions/<sid>.jsonl` 与 `~/.buddy/logs.jsonl` 是审计/replay 辅助通道，不是主通信路径；审计不可用不得阻塞 review。

---

## v3.2.1 — 2026-05-02 Kimi provider fail-closed hardening

### Content
- **`kimi-wire-client.mjs`**：Wire prompt 返回空 final output 时直接 `kimi-empty-output` fail-closed；timeout 继续发送 `cancel` 且不降级 exec。
- **`providers.mjs`**：Kimi Wire 成功标记 `degraded:false`；legacy exec / Wire-to-exec fallback 标记 `degraded:true`。
- **`buddy-runtime.mjs`**：Kimi final text 本地归一为 `GO` / `NO-GO` / `INCONCLUSIVE`，并输出 `review_status: passed|blocked|inconclusive`。
- **测试**：新增 Wire 空输出、Wire timeout 不 fallback、legacy degraded、Kimi verdict normalization 覆盖。
- **文档**：同步 Kimi 架构参考、运行参考和 README，消除旧 exec-first 描述。

### 架构决策
- Kimi 是受控 provider transport，不再把 legacy CLI transcript 当成稳定 review API。
- 除 Wire 启动/协议不支持外，Kimi 错误不做静默 fallback；空输出、timeout、权限错误、非 0 exit 都不能算通过。
- 未按约定输出 verdict 的 Kimi 回复只作为审计文本保留，机器判定为 `INCONCLUSIVE`。

---

## v3.2.0 — 2026-04-30 Kimi CLI 接入（按需路由）

### Content
- **新增 `scripts/lib/kimi-adapter.mjs`**：Kimi CLI exec 调用（`kimi --print --afk -p`）+ preflight 检测
- **新增 `scripts/lib/parsers/kimi-repr-v1.mjs`**：Kimi `--print` 输出事件流解析器（ThinkPart/TextPart/SessionId）；全程不抛异常；parseStatus ok/partial/failed 三态
- **`scripts/buddy-runtime.mjs`**：`--buddy-model kimi` 顶层路由分叉；Codex 三条路径零改动；三处现有 appendLog 调用补 `model:'codex'`
- **`scripts/lib/audit.mjs`**：appendLog 新增可选字段 `model` / `parse_status` / `fallback`
- **新增 `scripts/lib/__tests__/kimi-repr-v1.test.mjs`**：14 个 parser 单测（含 partial/failed 用例，全部不抛）
- **新增 `references/kimi-cli.md`**：Kimi CLI 运行时参考 + 文档链接
- **新增 `docs/kimi-reference.md`**：架构决策说明 + 已知限制 + 文档链接
- **`SKILL.md`**：注意事项第 9 条（Kimi 路由说明）
- **`STATUS.md`**：架构边界声明（2 个 buddy model 边界，第三个需重构为 registry）

### 架构决策
- Option A（顶层路由分叉）：Codex 路径零改动，Kimi 走独立分支
- 解析双层：adapter（执行）+ parser（解析），解析器可独立替换
- ThinkPart → 审计日志，TextPart → 综合输出；parseStatus 失败时 fallback 到 raw stdout
- 已知技术债：2 模型硬编码，第三模型需 registry 重构

### 文档引用
- Kimi CLI: https://moonshotai.github.io/kimi-cli/
- GitHub: https://github.com/MoonshotAI/kimi-cli
- Agent Skills: https://agentskills.io/home

---

## Stage 6c — 2026-04-30 broker 健壮性 + W-015 + SESSION_HANDOFF 迁移

### Content
- **`buddy-broker-process.mjs`**：SIGTERM/SIGINT 加 3s hard-exit timeout；`server.on('error')` 处理 EADDRINUSE；`writePidFile` 移到 `'listening'` 回调防 bind 失败留孤立 pid；Usage 文件名修正
- **`buddy-broker.mjs`**：`isBrokerAlive` 删除 PID fallback（OS PID 复用导致误判 alive）；删除孤儿函数 `isProcessAlive`
- **`buddy-broker.test.mjs`**：C2 并发测试改为 `Promise.allSettled`，真正验证 BROKER_BUSY 路径
- **`hooks/pre-tool` + `hooks.json`**：W-015 PreToolUse advisory hook — 破坏性 Bash 操作（rm -rf/DROP/force-push/reset --hard）自动注入 codex-buddy 验证提醒
- **`hooks/session-start`**：SESSION_HANDOFF 读路径改为 `~/.buddy/handoff-<cwdHash8>.md`（主），legacy `docs/SESSION_HANDOFF.md` 作迁移 fallback
- **`docs/SESSION_HANDOFF.md`**：git rm --cached；加入 .gitignore（不再 git 跟踪）
- **`scripts/verify-repo.sh`**：移除 `docs/SESSION_HANDOFF.md` 必需文件检查

### Codex probe 记录
- broker hardening + 整体质量 review：2 轮 probe（vtask-mol4pjvv, vtask-mol6xf82）发现 stale PID reuse / C2 test sequential / W-017 STATUS 漂移
- W-015/SESSION_HANDOFF 决策：verdict=stop，两项均为 v3.1.0 merge 阻断项
- 合并就绪评估：verdict=stop，6 处问题（verify 失败/CHANGELOG/SKILL.md/STATUS 漂移/decision docs 收口/sync 策略）

---

## Stage 6b — 2026-04-30 官方 broker 实现替换

### Background
Stage6a 对齐了基座路径，但 broker 进程仍是自研实现，使用 `turn/run`（同步包装），没有流式输出。用户在等待 30-80s 期间看不到任何中间输出。Auth token 在长时间 broker 存活后也会过期（broker 持有旧 token）。

用户方向：**"底层协议直接按照官方的实现，不行就直接拷贝源码"**

### Content
- **官方文件直接复制**：`app-server.mjs`, `args.mjs`, `broker-endpoint.mjs`（来自 `openai/codex-plugin-cc`）
- **`buddy-broker-process.mjs`** 替换为官方 `app-server-broker.mjs`，加 lazy connect（W7 pattern）
- **`app-server.mjs`** 适配：`broker-lifecycle-stub.mjs` + `SIGTERM` 替换 + `BUDDY_BROKER_CODEX_BIN` 测试注入
- **`runBrokerTurn()`** 新增：实现官方 `turn/start` + streaming notification 协议，实时写 stderr
- **`buddy-runtime.mjs`**：用 `runBrokerTurn` 替代旧 `brokerSendCommand(turn/run)`
- 测试：W8 suite 全面更新，112/112 通过

### 用户可见变化
```
以前: [buddy] probe started... (黑盒 65s) → 完整结果
现在: [buddy] probe started...
      [buddy] Codex > Reading the diff, I see three areas...
      [buddy] probe completed in 65432ms
```

### 无 Codex probe
直接技术决策（复制官方实现），无需独立审查。

---

## Stage 6a — 2026-04-30 基座对齐官方 codex-plugin-cc

### Content
- **`scripts/lib/paths.mjs`** 重写：`resolveWorkspaceRoot` (git root) + `resolveStateDir` (`CLAUDE_PLUGIN_DATA` + slug-hash16) + `resolveBuddySessionFile`
- **`codex-adapter.mjs`**：`saveBuddySession` 用新路径，3 层 fallback（stage6a → stage5e legacy → global legacy）
- **`hooks/session-start`**：内联 CJS 改为官方路径模式（git root + realpathSync + CLAUDE_PLUGIN_DATA + slug-hash16）；sed → Node.js JSON 解析（C3）
- **`hooks/session-end`**：Node.js JSON 解析 cwd；明确标注不清学习数据
- **`buddy-broker.mjs`**：`getWorktreeHash` 改用 `resolveWorkspaceRoot` + `realpathSync`（C1 overall review）
- **`buddy-runtime.mjs`**：`actionReplay` 传 `{cwd}` 到 `loadBuddySession`（C2 overall review）
- **新增 `scripts/lib/__tests__/paths.test.mjs`**：13 个测试
- **新增 `docs/decisions/2026-04-30-stage6a-official-base-alignment.md`**

### L3 验证
`CLAUDE_PLUGIN_DATA/state/ux-stage1-194a7521b31c7040/buddy-session.json` 写入确认 ✅

### Codex probe 记录
- gap 优先级（vtask-mokxjk5k）：caution — C2 session-start 已存在但实现不完整
- 分层架构（vtask-mokziebh）：caution — C2 teardown 不能清学习数据，C7 HANDOFF 污染风险
- code review（vtask-mol0z8oq）：caution — C1 session-start 旧路径、C2 replay 无 cwd
- overall review（vtask-mol1gd35）：caution — C1 broker hash 不一致、C2 replay race、C3 sed

---

## Stage 5e — 2026-04-30 Per-worktree session isolation + handoff injection

### Background
Reported bug: two concurrent Claude sessions in different worktrees both saw the same `buddy_session_id` (e.g. `buddy-0eafec6c`) because `~/.buddy/buddy-session.json` is a global mutable pointer overwritten by whichever SessionStart hook fires last. Stats got polluted across worktrees; not a functional break but a real architectural smell.

### Codex framing
"Global storage is OK; global mutable *current pointer* is not." Reference: Git keeps repo state shared but `HEAD`/`index`/`config.worktree` per-worktree. Terraform: `.terraform/`+`TF_DATA_DIR` per working dir. The minimal fix is to remove the global pointer and key routing by `(session_id, cwd)`.

### Content
- **Per-worktree state file** (`~/.buddy/state/by-cwd/<sha256(cwd)[:8]>.json`):
  - `saveBuddySession(sid, { cwd })` writes here as primary; legacy `~/.buddy/buddy-session.json` still updated for back-compat with older code paths.
  - `loadBuddySession({ cwd })` prefers per-cwd, falls back to legacy global file when missing → no breakage on machines with pre-stage5e data.
- **`getOrCreateBuddySessionId(argsSessionId, cwd)`** in buddy-runtime: 6 call sites updated to pass `args['project-dir']` so each worktree gets its own sid.
- **SessionStart hook** rewritten:
  - Parses `cwd` from hook stdin (Claude Code passes it in JSON envelope).
  - Computes `cwd_hash` and writes the per-cwd state file (primary) + legacy file (compat).
  - Reads `<cwd>/docs/SESSION_HANDOFF.md` if present and prepends as `<SESSION_HANDOFF>...</SESSION_HANDOFF>` block in `additionalContext` BEFORE the SKILL.md block. Capped at 8KB.
- **`docs/SESSION_HANDOFF.md`** is the convention file. Update at end of working session; next Claude session auto-reads it. This file ALSO lives in tracked git history so the worktree itself carries handoff state across machines/branches.
- **`scripts/lib/__tests__/buddy-session.test.mjs`**: 7 new tests cover save/load round-trip, two-worktree isolation, per-cwd file location, legacy fallback chain.
- **verify-repo.sh** now checks `docs/SESSION_HANDOFF.md` exists.

### Tests
94 → 101 (+7 buddy-session tests). All pass. Hook smoke test: handoff injection works; 3 different cwds → 3 different state files (no collision).

### Codex Interaction
- One probe (caution → 3 high-confidence findings, all confirming Claude's framing).
- Codex's specific contribution beyond Claude's draft: pointed out that Claude Code's hook stdin already provides `session_id` + `cwd` + `transcript_path`, and `additionalContext` is the documented handoff channel — so we don't need extra plumbing. Codex also explicitly identified the antipattern: not "global storage" but "global mutable current pointer".

### Skipped (intentional)
- **Deleting legacy `buddy-session.json`**: kept for back-compat read; will retire after a few weeks of v2 usage.
- **Migrating existing `~/.buddy/sessions/<sid>.jsonl`** data: untouched (Codex F3: existing event streams stay valid; new index sits beside).
- **Hashing by `(session_id, cwd)` jointly**: cwd alone is sufficient for the reported bug (different worktrees). Adding session_id would isolate concurrent Claude sessions in the SAME cwd — rare and not currently a concern.

---

## Stage 5d — 2026-04-30 Strict v2 audit-row contract + shared annotation policy

### Content
After Codex re-reviewed stage5c (verdict=caution, 6 findings) and gave a prescriptive plan with verdict=proceed, applied the full prescription:

- **F3 — Schema split (CloudEvents/OTel-style envelope vs persisted record)**:
  - `schemas/envelope.schema.json` is now the **bare** decision envelope (turn/level/rule/triggered/route/evidence/conclusion + optional confidence/unverified). No persistence metadata.
  - New `schemas/audit-row-v2.schema.json` — **strict** persisted v2 row contract. v2 metadata (`schema_version`/`ts`/`buddy_session_id`/`verification_task_id`/`workspace`/`action`) is REQUIRED. `verification_task_id` is a non-nullable string (legacy rows are not v2 rows).
- **F2 — `appendLog` strict options-object signature**:
  - Old: `appendLog(logFile, envelope, sid, ws, latencyMs, extra)` with open-ended spreads.
  - New: `appendLog(logFile, { envelope, buddySessionId, workspace, action, verificationTaskId, latencyMs?, message? })`.
  - Envelope filtered to `ENVELOPE_KEYS` whitelist; aliases (`session_id`/`timestamp`) and arbitrary unknown keys silently dropped (no longer just shadowed).
  - Throws `TypeError` on missing required options or unknown action.
- **F4 — Hand-rolled validator upgraded (no ajv dep)**:
  - `audit-row-schema.test.mjs` exports `assertValidAuditRowV2()` — checks required, type, enum, const, **minimum, format:date-time, minLength, array item types, additionalProperties:false**.
  - +5 negative tests: rejects rows with negative turn / malformed ts / non-string evidence items / bogus action enum / wrong schema_version const / null verification_task_id.
  - Decision: stay all-Node-stdlib (codex-buddy is single-skill, no package.json; ajv adds packaging surface for marginal gain).
- **F6 — Default annotate now targets `probe.codex_output` only**:
  - Followups can still be annotated explicitly via `--verification-task-id`.
  - Rationale: metrics computes annotation rates over PROBES; defaulting to followup silently dropped the metric. New regression test in `metrics.test.mjs` proves probe→followup→annotate(no-id)→metrics counts the probe.
- **F5 — Shared annotation module `lib/annotations.mjs`**:
  - Single source of truth: `ANNOTATION_FIELDS`, `ANNOTATION_FLAG_MAP`, `parseAnnotationFlags`, `mergeAnnotation`.
  - `buddy-runtime.mjs:actionAnnotate` and `metrics.mjs:buildAnnotationLookup` both import from here. No more drift if a new field is added.
- **verify-repo.sh** updated to check both schema files and the new annotations module.

### Tests
86 → 94 (+8): audit options-signature tests + drop-unknown-keys, F6 regression, 5 schema negative tests, plus existing accumulation tests still green.

### Codex Interaction
- Probe 1 (review): caution, 6 findings (F1 confirmed prior fixes; F2/F3/F4/F5/F6 new concerns).
- Probe 2 (prescription): proceed verdict, ordered fix plan citing CloudEvents and OpenTelemetry conventions.
- Followup attempt failed (probe was ephemeral); re-issued as fresh probe within decision budget.
- Codex's strongest contribution: argued F3 should be FIRST because contract definition (what is "valid") makes F2/F4 tractable. Claude originally ranked F5/F2 first by cost; Codex's framing won.

### Skipped (intentional)
- ajv/zod dependency: not worth packaging cost for single-skill marketplace tool.
- File rename `logs.jsonl` → `decisions.jsonl`: still risk > benefit on existing 421KB legacy data.

---

## Stage 5c — 2026-04-30 Stage 5b post-review fixes

### Content
Codex review of f28d261 returned verdict=caution; 2 high/medium-confidence findings were validated and fixed:

- **C1 [high] Annotate field accumulation regression**: previous `annotateLastEntry` did `{...old, ...fields}` merge. Stage 5b moved annotation to session-log events but `metrics.buildAnnotationLookup` kept "last event wins" per task — so partial annotates (e.g. `--probe-found-new true` then `--user-adopted true`) would lose the earlier field. Fixed by per-field merge across multiple annotate events for the same task.
- **C2 [medium] Canonical field shadowing in appendLog**: caller-provided `envelope` and `extra` could overwrite `schema_version` / `ts` / `buddy_session_id` / `workspace`. Canonical fields are now written LAST so they win regardless of caller input.
- **C3 [medium] envelope.schema.json was stale**: still documented `session_id` / `timestamp` with `additionalProperties: false`; new v2 entries failed external validation. Schema rewritten for v2; new `envelope-schema.test.mjs` validates real `appendLog` output against schema (catches future drift).
- **C4+C5 [medium] CLI doc caveats**: `references/cli-examples.md` annotate section now documents per-field accumulation, the wrong-task risk in concurrent / multi-worktree scenarios (recommend explicit `--verification-task-id`), and the "legacy logs.jsonl entries cannot be retroactively annotated" limitation.

### Test additions
- `metrics.test.mjs` (new): C1 regression + per-field last-wins + legacy fallback (3 tests)
- `audit.test.mjs`: shadowing protection (1 test)
- `envelope-schema.test.mjs` (new): hand-rolled minimal validator catches schema/writer drift (2 tests)
- Total: 80 → 86 tests, all passing; verify-repo PASSED; smoke OK

### Codex Interaction
- Probe (after 1 timeout retry, broker runtime): Codex independently reviewed f28d261 with no Claude-side leading conclusions
- 5 findings total (1 high + 4 medium); 2 confirmed via code-tracing before fixing; 3 medium addressed via docs/refactor
- C1 was a real semantic regression that Stage 5b's unit tests didn't catch — Codex's "review of own work" caught what self-review missed

---

## Stage 5b — 2026-04-29 Audit/decision-stream schema v2

### Content
- **Schema unification (audit.mjs:appendLog)**: rename `session_id` → `buddy_session_id`, `timestamp` → `ts`, add `verification_task_id` and `schema_version: 2`. Now joinable with session-log events on the same keys.
- **Remove dangerous mutation (audit.mjs:annotateLastEntry)**: the function read the entire log, located the last matching entry, and rewrote the whole file. This broke JSONL append-only semantics, slowed down with file growth, and could lose data under concurrent writes. Annotation now only appends an `annotate` event to `~/.buddy/sessions/<sid>.jsonl` — append-only, idempotent, race-safe.
- **metrics.mjs cross-stream join**: reads decisions stream, joins to session-log annotate events by `(buddy_session_id, verification_task_id)`. Falls back to legacy in-place mutated fields for pre-v2 entries. Backward compatible with the existing 421KB of historical data.
- **buddy-runtime.mjs**: passes `verification_task_id` at all 3 `appendLog` call sites (local/probe/followup). Local actions get a synthesized id via `newVerificationTaskId()` for join uniformity.
- **Tests**: audit.test.mjs +2 tests (schema v2 fields, legacy fallback). 80/80 pass.

### Codex Interaction
- Probe (after 3 retries due to upstream `chatgpt.com/backend-api` TLS failures): asked Codex to judge dual-stream logging design with no Claude-side leading.
- Codex `verdict: caution`, 6 high-confidence findings.
- Critical finding Claude missed: `annotateLastEntry` is the most dangerous code in the data layer (read-modify-rewrite breaks JSONL append-only). This drove the `annotate` rewrite.
- Codex suggested: prioritize unifying schema + adding cross-stream key (`verification_task_id`) over physically merging files. Done.
- Skipped per Codex suggestion: file rename `logs.jsonl` → `decisions.jsonl` — risk vs benefit on existing data not justified at this stage.

---

## v3.0.2 — 2026-04-01 Protocol Communication Performance

### Content
- **Perf: `-a never` before `exec`** — approval flag is top-level, was previously missing. Eliminates approval overhead in read-only sandbox.
- **Perf: `--ephemeral` for probes** — skip session file persistence for one-shot probes (default on). Follow-up probes still persist sessions.
- **Perf: prompt trimming** — new `trimPrompt()` caps evidence at 12000 chars, preserving task/omissions structure. Large prompts are the main cause of slow Codex inference.
- **Perf: `-a never` for resume** — follow-up calls also skip approval.
- **Fix: duplicate `call_count`** — buddy-runtime.mjs had duplicate key in local action output.
- **Docs: cli-examples.md** — updated parameter table with perf flags, correct `-a` position, recommended fast combinations.

### Codex Interaction
- Probe: Asked Codex about CLI-side acceleration flags (7 questions)
- Key finding: 30-80s latency is primarily model inference, not CLI startup. `-a never` and `--ephemeral` provide marginal but real improvement.
- Codex confirmed: no `--no-project-doc` flag exists in 0.118.0; `-C` to smaller directory is the only way to reduce project doc scanning
- Codex suggested: `codex-mini-latest` model for faster inference, long-lived process architecture for fundamental speedup

---

## v3.0.1 — 2026-04-01 E2E Validation + Bug Fixes

### Content
- **Fix: async spawn + watchdog** — replaced `execFileSync` (120s hard timeout → ETIMEDOUT) with async `spawn` + 5-minute watchdog timer. Prevents both false timeouts and indefinite hangs.
- **Fix: SKILL.md path placeholder** — changed `${CLAUDE_PLUGIN_ROOT}` to `<SKILL_DIR>` in code templates, since `CLAUDE_PLUGIN_ROOT` is only available in hook context, not conversation context.
- **Fix: parseArgs empty checks** — `--checks ''` no longer parsed as value `'true'`; empty/missing checks correctly trigger S4 skip path.
- **Validated: W-014** — full e2e validation passed (SessionStart hook, local evidence, Codex probe, budget lifecycle, floor rules 28/28).

### Codex Interaction
- Probe: Codex identified gate.mjs Chinese coverage gap (correctness patterns too narrow)
- Review: Codex caught missing watchdog regression — "removing timeout is not a fix, use a larger watchdog"
- Codex changed Claude's approach: async spawn alone insufficient, watchdog timer added per Codex recommendation

---

## v3.0.0 — 2026-03-31 Verification Runtime

### Content
- **Architecture: Soft-first with Advisory Hooks** — SKILL.md is "brain" (V-level + floor rules + dialogue), Node.js scripts are "muscle" (commands + logs + budget + envelopes)
- **SKILL.md rewrite** (136 lines): added 3 floor rules (destructive/approval/correctness-claim), buddy-runtime.mjs call pattern, Evidence Router priority (local first → Codex if needed); removed hand-crafted codex exec templates and "最小合法命令" rules
- **New: scripts/buddy-runtime.mjs** — entry point with 4 actions: preflight, local, probe, followup
- **New: scripts/lib/codex-adapter.mjs** — fixed codex exec command templates, session management
- **New: scripts/lib/local-evidence.mjs** — grep/test/lint/diff/file-exists checks
- **New: scripts/lib/gate.mjs** — 3 floor rules engine (pattern matching)
- **New: scripts/lib/envelope.mjs** — decision envelope generator
- **New: scripts/lib/audit.mjs** — JSONL audit log + per-session budget tracking (4 Codex calls max)
- **New: schemas/envelope.schema.json** — decision envelope JSON schema
- **Updated: hooks/session-start** — preflight check + ~/.buddy init
- **Updated: references/cli-examples.md** — runtime context note

### Background
Four-round Claude-Codex brainstorm (2026-03-31) established that buddy's differentiation is intelligence (when to verify, how to avoid anchoring), not tooling. Decision to self-build everything, not fork official openai/codex-plugin-cc. codex exec wrapper chosen over app-server protocol for low-frequency verification use case.

### Codex Interaction
- Brainstorm: 4 rounds of strategic direction exploration
- Architecture review: Codex identified 6 blocking issues in initial spec, all resolved
- Final verification: Codex approved spec with "可以开始实现"
- Spec: docs/superpowers/specs/2026-03-31-buddy-v3-verification-runtime-design.md

---

## v2.8.0 — 2026-03-28 V-level 触发机制重写（self-gating 修复）

### 内容
- SKILL.md L28-41：V-level 判定规则重写（135→141 行）
  - 新增第一步"后果判断"：先问"用户会不会按这个走错"，再判级别
  - V1 收窄为 fact-only：原文/代码/命令/行号/现状转述，不给建议
  - V2 明确为四类带 TYPE 短码：V2[METHOD] / V2[META] / V2[DECISION] / V2[FACT→V2]
  - 默认方向倒置：拿不准 → V2，不是 V1
  - header 格式升级：`V{level}[TYPE] | 理由`，增加可审计性

### 背景
连续 3 次跨 2 个会话漏触发（case A/B/C），Claude+Codex 双 Probe 确认为 self-gating 结构性缺陷：分类轴按"文体"而非"后果"，V1 是过宽逃生口，红旗/兜底是自律协议不是外部约束。

### Codex 交互
- Probe 1（SESSION: 019d318f）：问题定性 — self-gating false-negative，分类轴错误
- Probe 2（SESSION: 019d3193）：优化方案 — 方案 A（收窄 V1）为主，方案 B（hook 保险丝）为辅
- 两轮结论一致，已验证

---

## v2.5.6 — 2026-03-27 收尾优化 + 大方向复盘

### 内容
- cli-examples.md: SESSION_ID 记录从 `ls -t ~/.codex/sessions/` 改为按日期目录 + UUID 提取
- evals 21→27 条：新增 V1 跳过标未验证、共识直接执行、污染检查、unstructured 返回、workspace-write 告知、missing_input 停止
- SKILL.md 顶部新增默认回路一行概览（125 行）
- README eval 数量同步

### Codex 交互
- 大方向复盘 Probe：Codex 判断 SKILL.md 已到收益递减点，应冻结主体转向真实使用验证
- 根本性发现：项目把文档质量当系统正确性代理指标，治理同步落后于实际改动
- 建议：冻结 SKILL.md + 补真实 transcript + CHANGELOG/STATUS 同步硬门
- 讨论记录: [discussions/2026-03-27-v256-retrospective.md](discussions/2026-03-27-v256-retrospective.md)

---

## v2.5.5 — 2026-03-27 Codex 全面 Review 驱动重构

### 内容
- V2 定义修正："需要本地执行验证的判断" → "需要独立第二判断的决策"
- 项目反馈 + 跨会话记忆下放到 WORKFLOW.md（SKILL.md 135→123 行，回收 12 行）
- blocked 路径统一要求 V-header：`V{N} | [blocked: codex unavailable]`
- 注意事项新增证据脱敏规则、workspace-write 告知义务
- 规则去重：合并重复的"不传结论"和"不可逆验证"
- STATUS.md W-003 加 note 说明章节名融合
- README eval 数量 18→21

### Codex 交互
- Probe: Codex 全面 review 提出 10 个 Claims（3 高 / 4 中 / 2 低）
- 独立发现: V2 定义脱节（C1）、治理信息挤占运行时注意力（C2）、证据脱敏缺口（C7）
- 本轮落地 7/10 claims，3 个留后续
- 讨论记录: [discussions/2026-03-27-v255-comprehensive-review.md](discussions/2026-03-27-v255-comprehensive-review.md)

---

## v2.5.4 — 2026-03-27 补 eval 覆盖 W-011/W-012 边界（Review 驱动）

### 内容
- evals 18→21 条：新增 #19（兜底规则例外：查原文→V0/V1）、#20（兜底规则命中：讨论改规则→V2）、#21（codex 不可用→blocked）
- 覆盖 floor-rule-exception / floor-rule-hit / preflight-check 三个新 tag

### Codex 交互
- Review Probe: Codex 独立发现缺 eval 覆盖（Low severity），Claude 未注意到
- 无分歧，直接落地

---

## v2.5.3 — 2026-03-27 Codex CLI 前置检查（W-012）

### 内容
- SKILL.md 注意事项新增第 5 条：首次调用前检测 codex CLI 可用性，不可用时回复 `[blocked: codex unavailable]` 并指引安装
- cli-examples.md：`which codex` → 守卫式 `command -v codex` + 错误提示

### Codex 交互
- Probe: Codex 独立提出双层处理（SKILL.md + cli-examples 守卫），Claude 只想到 SKILL.md 层
- 独立发现: cli-examples.md 守卫式写法（C4），被采纳
- 无分歧，1 次 Probe 收敛
- 讨论记录: [discussions/2026-03-27-w012-codex-cli-preflight.md](discussions/2026-03-27-w012-codex-cli-preflight.md)

---

## v2.5.2 — 2026-03-27 兜底触发规则（W-011）

### 内容
- SKILL.md EXTREMELY-IMPORTANT 块新增兜底触发规则：讨论 skill/验证机制/多代理协作机制的设计决策 → 最低 V2
- 解决自评盲区：红旗列表拦"合理化跳过"但拦不住"误分类"
- 131→134 行，不压缩现有段落

### Codex 交互
- Probe: Codex 独立提出"自评主导+模式匹配兜底"混合制（C1），与 Claude 一致
- Follow-up: 收敛两个微分歧（枚举 vs 泛化原则；是否压缩段落）
- 独立发现: Codex 建议扩范围覆盖"多代理协作机制"，被采纳
- 讨论记录: [discussions/2026-03-27-w011-auto-trigger-floor.md](discussions/2026-03-27-w011-auto-trigger-floor.md)

---

## v2.5.1 — 2026-03-26 README.md 对齐 v2.5 设计

### 内容
- README.md：Mode A/B/C → Probe/Follow-up/Challenge 对话协议
- README.md：新增 V0–V3 验证级别表，替代旧的触发场景表
- README.md：设计哲学更新（证据打包、渐进升级）
- README.md：项目结构补全（verify-repo.sh、WORKFLOW.md、STATUS.md 等）
- GPT-4o 硬编码移除，改为通用 Codex 描述

### 版本规则
- 自本版本起，迭代使用小版本号（2.5.1, 2.5.2, ...）
- 大版本号变更需人工确认对齐后使用

---

## v2.5.0 — 2026-03-26 文档术语同步（W-010）

### 内容
- WORKFLOW.md：5 处 Mode A/B/C 引用更新为 Probe/Follow-up/Challenge
- CONTRIBUTING.md：1 处"三种模式的升级链路关系"更新为"对话协议和升级流程"
- 消除 v2.0 重构后遗留的术语不一致

### 设计决策记录
- 用 [transition-mode] 跳过 Codex Probe（纯文档术语替换，无设计决策）

---

## v2.4.0 — 2026-03-26 独立发现落地约束（W-009）

### 内容
- verify-repo.sh 新增 Section 10：独立发现落地检查
- 扫描 CHANGELOG 中的"登记为后续改进"标记，验证 work_queue 中有对应条目
- 扫描 CHANGELOG 中的"unresolved"标记（仅警告不阻断）
- 防止高价值 Codex 独立发现停留在叙事层而不进入 work_queue

### 来源
Codex C3 独立发现（v2.1.0 轮次）

### 设计决策记录
- 用 [transition-mode] 跳过 Codex Probe（纯工具链改动，与 W-008 同类）
- "unresolved" 标记只警告不阻断，因为可能是历史记录中的合理状态

---

## v2.3.0 — 2026-03-26 STATUS 状态机一致性校验（W-008）

### 内容
- verify-repo.sh 新增 Section 9：STATUS 状态机一致性检查
- 校验 1：selected_item 必须指向 open 工作项或 NONE，指向 done 项则报错
- 校验 2：human_gate != NONE 时 operating_mode 必须为 BLOCKED
- 修复上轮遗留的 selected_item 漂移（W-007 已 done 但仍被选中）

### 来源
上轮 Codex C2 独立发现：selected_item 漂移是真实 bug

### 设计决策记录
- 用 [transition-mode] 跳过 Codex Probe，因为上轮已达成共识且是纯工具链改动
- 不依赖 jq，用 grep/sed/awk 实现，保持可移植性

---

## v2.2.0 — 2026-03-26 evals 扩展（W-007 行为级评估覆盖）

### 内容
- evals.json 从 10 条扩展到 18 条
- 所有现有用例更新为要求 V-level header 在回复开头
- 新增 8 条用例覆盖：V3 边界停止（#11, #16）、证据打包质量（#12, #13）、Probe 独立性（#13, #17）、Follow-up 协议（#18）、V0 边界判断（#14, #15）
- 四类新 tags 全部覆盖：v-level-header / evidence-packaging / probe-execution / boundary-stop
- 新增 W-008（STATUS 状态机校验）、W-009（独立发现落地约束）到 work_queue

### 来源讨论
`discussions/2026-03-26-w007-evals-expansion.md` — Probe

### Codex 独立发现（Claude 未提出）
- 确认"当前 evals 只测表态不测行为"的诊断与仓库既有分析一致
- 建议 W-008（STATUS 一致性校验）优先于 W-007，因为 selected_item 漂移是真实 bug

### 设计决策记录
- 选 W-007 先于 W-008，因为 evals 扩展直接回应上轮 Codex C3（可回放评估闭环）
- 新用例设计覆盖三种对话协议（Probe/Follow-up/Challenge）而非只测分类

---

## v2.1.0 — 2026-03-26 per-turn decision envelope（W-006）

### 内容
- EXTREMELY-IMPORTANT 块新增 per-turn V-level header 要求：每回合回复开头标注 `V{0-3} | {理由}`
- 使每回合的验证级别决策可审计，从内部推理外显为用户可见痕迹
- 行数：128 → 131（< 150 ✓）

### 来源讨论
`discussions/2026-03-26-w006-per-turn-decision-envelope.md` — Probe

### Codex 独立发现（Claude 未提出）
- **可回放评估闭环**：最大系统性缺陷不是审计痕迹缺失，而是缺少可回放的评估机制来检验触发是否正确、验证是否真的提升了决策质量（登记为后续改进）

### 设计决策记录
- Codex 的具体改动建议引用了旧版 SKILL.md 结构（Mode A/B/C），不可直接采纳
- 采用 Claude 的极简方案（+3 行），不采用 Codex 的 Output Contract 重写方案

---

## v2.0.0 — 2026-03-26 对话协议重构（Mode A/B/C → Probe/Follow-up/Challenge）

### 内容
- **Mode A/B/C 整体移除**，替换为自然对话协议：Probe（独立初判）→ Follow-up（双向追问）→ Challenge（定点争议）
- **双向交流**：Codex 可以表达不确定/追问，Claude 通过 `exec resume <SESSION_ID>` 回应
- **Claude 侧容错解析**：不要求 Codex 遵守格式，Claude 自行提取 claims/questions/tests
- **反馈三层**：本次对话 Output Contract + 项目级 incident/eval/discussion + 跨会话记忆晋升
- **恢复丢失项**：漏触发红旗回归 EXTREMELY-IMPORTANT 块、"可验证"执行门槛、项目级反馈闭环
- references/cli-examples.md 同步改为 Probe/Follow-up/Challenge/Verify 四段
- CLAUDE.md 放松 Mode A/B/C 约束，改为对话协议约束
- 行数：133 → 128（< 150 ✓）

### 来源讨论
`discussions/2026-03-26-v2-direction-rethink.md` — Mode B → Mode C（四轮）

### Codex 独立发现（Claude 未提出）
- **V0 vs Probe 自相矛盾**：草案写"Probe 每次必做"但 V0 说不调 Codex，逻辑冲突
- **resume --last 脆弱性**：多会话时接错线程，应改为显式 SESSION_ID
- **Challenge 编号步骤缺失**：要求针对编号 claim 争论但没定义编号步骤
- **项目级反馈丢失**：v1.15 的 learning_signal → incident/eval 被整段删掉了
- **"弱约束+强适配"原则**：不应要求外部 Codex CLI 遵守固定格式

### 设计决策记录
- 用户明确选择方向 B（重构），放松 CLAUDE.md 中 Mode A/B/C 不可破坏的约束
- Codex 第一轮提出 5 动作协议，第二轮自我修正为"保留 VEM + 内部动词"
- 最终方案：VEM 保留为外层闸门，Probe/Follow-up/Challenge 作为对话协议（非互斥模式）
- 默认单次 Probe，Follow-up/Challenge 按需升级，最多 2 次 Codex 调用

---

## v1.15.0 — 2026-03-26 Evidence Packaging Rule（上游污染操作化）

### 内容
- `## 传递原则` → `## Evidence Packaging Rule`：声明式禁令改为 4 步操作清单
- 新增 `task_to_judge`（中性问题框架）+ `known_omissions`（对抗选择偏差）+ 污染清理 + "答案草稿"自测
- 砍掉 Codex 提出的 `why_relevant`（Codex 自标为叙事污染风险）
- 行数：127 → 133（< 150 ✓）

### 来源讨论
`discussions/2026-03-26-w004-evidence-packaging-rule.md` — Mode B

### Codex 独立发现（Claude 未提出）
- **known_omissions**：Claude 识别了选择偏差但没给对策，Codex 给出显式申报机制
- **why_relevant 反向风险**：Codex 自己提出的步骤自己标了风险，触发砍掉决策
- **per-turn decision envelope**：skill 最大设计缺陷——缺少每回合的外显决策记录，已登记为 W-006

---

## v1.14.0 — 2026-03-26 any conversation 自动触发 + EXTREMELY-IMPORTANT 政策块

### 内容
- description 改为 `Use when starting any conversation — loads the verification policy for this session`
- body 顶部加 `<EXTREMELY-IMPORTANT>` 块：区分"每次必做（分类任务、建立政策）"vs"按 VEM 条件才执行 codex exec"
- Mode B/A/C inline bash 模板移出，替换为引用 `references/cli-examples.md`（节省 ~16 行）
- 行数：144 → 127（< 150 ✓）

### 来源讨论
`discussions/2026-03-26-w005-any-conversation-trigger.md` — Mode B

### Codex 独立发现（Claude 未提出）
- **自我门控失败**：当前条件触发要求模型在没有 skill 的情况下正确判断是否需要 skill，而这恰好是 skill 要防止的单模型自洽点
- **CLI 模板下沉**：any conversation 常驻 skill 应只保留 policy，降低常驻成本
- **规则疲劳 + 学习信号变脏**：两个 Claude 未识别的副作用

---

## v1.0.0 — 2026-03-20 初始版本

### 内容
- 建立三种工作模式：Mode A（Review）、Mode B（Parallel）、Mode C（Debate）
- 触发判断矩阵
- CLI 参数快速参考

### 来源讨论
Claude + Codex 在 2026-03-20 的首轮 Mode B 分析，两个模型对以下核心设计达成共识：

**已确认的核心洞察（Claude + Codex 双方一致）：**
1. 核心问题是"顺畅陷阱"——越流畅越可能是系统性错误，不是随机噪声
2. N-version programming 类比成立：承认主代理不可信但可用
3. Codex CLI 的执行能力（真实跑命令）比纯语言比较有更高验证价值

**Codex 独立发现的关键缺陷（Claude 未充分强调）：**
1. 多模型一致性 ≠ 正确性，只是共享训练分布
2. Mode A 应审查假设和未验证部分，不只是最终答案
3. 三种模式应建立升级路径（A → B → C），而非平铺并列
4. Mode C 需要"证据类型约束"，防止修辞循环
5. 需要失败模式记录机制，让 skill 从"流程习惯"变成"误差画像系统"

**v1.0 已完成（→ v1.1）：**
- [x] 触发条件从主观感觉改为风险分级规则
- [x] Mode A prompt 模板加入假设/未验证部分审查
- [x] 三种模式改为升级链路设计（A→B→C）
- [x] Mode C 证据类型标注规范

完整讨论记录见 [discussions/2026-03-20-design-philosophy.md](./discussions/2026-03-20-design-philosophy.md)

---

## v1.1.0 — 2026-03-20

### 改进内容
- 触发判断：从"感觉类"改为6项风险分级规则
- 三种模式：升级链路设计（A→B→C），不再平行并列
- Mode A：prompt 增加假设和未验证部分审查
- Mode C：加入4种证据类型标注系统
- 终止规则：无新增证据则提前终止，不强制跑满3轮
- 明确注意事项：两模型一致 ≠ 正确
- references/cli-examples.md：修正 exec resume 语法，补充完整参数速查

### 下轮 Agenda
- [ ] 失败模式记录机制：记录触发原因、发现的问题、哪种模式最有效
- [x] Prompt 独立性规范：明确"传什么/不传什么"以避免锚定效应 → v1.2
- [ ] 安装说明：补充多平台安装方式（Claude Code / Claude.ai / Codex CLI）
- [ ] evals：运行触发判断测试，基于结果优化 description

---

## v1.2.0 — 2026-03-20

**主题：Prompt 独立性规范**
**讨论模式：** Mode B Parallel（Claude + Codex 独立分析后综合）
**完整讨论：** [discussions/2026-03-20-prompt-independence-contract.md](./discussions/2026-03-20-prompt-independence-contract.md)

### 改进内容
- **新增章节 `Prompt 独立性协议`**：四层传递规则 + 五条硬性协议
- **Mode A prompt 重写**：字段隔离结构 + 要求 Codex 先独立重建判断 + Output Contract
- **Mode B prompt 重写**：结构化模板（任务/硬约束/证据/输出要求）
- **Mode C 重设计**：C1（双方独立陈述）→ C2（交换反驳），硬性上限改为 2 轮
- **Abort Rule**：证据不足时先返回"证据不足"，不给结论

### Codex 独立贡献（Claude 未独立发现）
- Mode C 的"反方审稿模式"问题：现在设计是被动反驳，不是真正 Debate
- Abort Rule：Codex 建议的关键缺失，Claude 未想到
- Context Budget 25% 的量化边界

### 下轮 Agenda
- [x] 失败模式记录机制 → v1.3（收尾四问）
- [x] 安装说明：补充多平台安装方式 → v1.4
- [ ] evals：运行触发判断测试，基于结果优化 description
- [ ] Output Contract 模板：为 Codex 输出定义标准格式（事实/假设/建议/未验证）

---

## v1.3.0 — 2026-03-20

**主题：失败模式记录机制**
**讨论模式：** Mode C（3轮，Claude 与 Codex 分歧后收敛）
**完整讨论：** [discussions/2026-03-20-failure-mode-recording.md](./discussions/2026-03-20-failure-mode-recording.md)

### 改进内容
- 新增"收尾四问"章节：Q1 Mode Fit / Q2 Key Divergence / Q3 Verification Gap / Q4 Learning Signal
- 明确触发持久化记录的条件（只在发现真实问题时写 incident 文件）

### Codex 独立贡献
- 三问升四问：加入 Learning Signal，能区分"确认信心"与"真正发现盲点"

---

## v1.4.0 — 2026-03-20

**主题：安装说明多平台**
**讨论模式：** Mode B（并行独立）
**完整讨论：** [discussions/2026-03-20-install-multiplatform.md](./discussions/2026-03-20-install-multiplatform.md)

### 改进内容（README.md）
- Codex CLI 从"其他平台"升为独立安装章节
- 统一 clone 路径，补 `mkdir -p`，用 `"$(pwd)"` 替代拼接路径
- 符号链接 vs 直接复制：说明区别和适用场景
- 新增"验证安装"章节
- 新增"更新"章节
- 删除未经验证的 Claude.ai `.skill` 说法

### Codex 独立发现（纳入下轮）
- description frontmatter 约 750 字符且混入 workflow 说明，违反 skill-creator 规范。应压缩为一句纯触发条件，详细规则留正文

### 下轮 Agenda
- [x] description 瘦身：压缩 frontmatter 为一句触发条件，正文重新分段 → v1.5
- [ ] evals：运行触发判断测试，基于结果优化 description
- [ ] Output Contract 模板：为 Codex 输出定义标准格式（事实/假设/建议/未验证）

---

## v1.5.0 — 2026-03-20

**主题：description 瘦身**
**讨论模式：** Mode A（Claude 先独立方案，Codex 独立审查）
**完整讨论：** [discussions/2026-03-20-description-trim.md](./discussions/2026-03-20-description-trim.md)

### 改进内容
- description 从 ~750 字符压缩至 ~280 字符，删除 workflow 解释
- 保留 5 个核心触发信号：代码审查 / 架构决策 / 知识截止点 / 破坏性操作 / 流畅度警告
- 措辞改为 action-oriented："reviewing code you just wrote"（不是"code you just wrote and want reviewed"）
- 符合 skill-creator 规范：description 只描述"何时触发"，策略规则留正文

### Codex 独立发现（纳入下轮）
- Body 缺少 **Output Contract**：各 Mode 的 Codex 输出没有统一格式约定，是当前最大设计缺口
- 建议定义：独立结论 / 与 Claude 一致点 / 分歧点 / 已验证 / 未验证

### 下轮 Agenda
- [x] **Output Contract 模板**：为 Codex 输出定义标准格式 → v1.6
- [ ] evals：运行触发判断测试，基于结果优化 description
- [ ] body 结构优化：按 skill-creator 推荐的「触发/模式选择/CLI 模板/事后复盘」重新分段

---

## v1.6.0 — 2026-03-20

**主题：Output Contract 标准输出模板**
**讨论模式：** Mode A（Claude 先独立方案，Codex 独立审查）
**完整讨论：** [discussions/2026-03-20-output-contract.md](./discussions/2026-03-20-output-contract.md)

### 改进内容
- **新增 `## Output Contract（标准输出模板）`**：7 字段结构（结论/事实/已验证/假设/建议/未验证/与Claude对比）+ 6 条约束 + 缓冲条款
- **新增 `## Claude 提取规则`**：字段映射关系，防止 Claude 从自由文本猜结论
- **`五条硬规则`**：Output Contract 从抽象原则改为指向具体模板章节
- **Mode A/B/C prompt 更新**：各追加 Output Contract 使用要求，Mode B/C 首轮明确禁止 [与 Claude 对比] 字段
- SKILL.md 行数：119 → 149 行（+30 行）

### Codex 独立发现（纳入下轮）
- **验证责任定义太虚**：当前 skill 没有回答"谁来执行验证、何时升级沙盒、何时允许停在未验证"，容易被用成"再问一次另一个模型"而不是真正的异质性校验。需要 `Verification Escalation Matrix`。

### 下轮 Agenda
- [x] **Verification Escalation Matrix** → v1.7
- [ ] evals：运行触发判断测试，基于结果优化 description
- [ ] body 结构优化：按 skill-creator 推荐的四段式重新分段

---

## v1.7.0 — 2026-03-20

**主题：Verification Escalation Matrix（验证责任矩阵）**
**讨论模式：** Mode A（Claude 先独立方案，Codex 独立审查）
**完整讨论：** [discussions/2026-03-20-verification-escalation-matrix.md](./discussions/2026-03-20-verification-escalation-matrix.md)

### 改进内容
- **新增 `## Verification Escalation Matrix`**：V0-V3 四级验证矩阵 + 3 条责任规则
- **工作模式入口**：加"先按验证矩阵确定验证级别，再选 Mode"提示（防止 skill 退化为纯语言模型对比）
- **六条硬规则**：新增 `Verification First`（先定验证级别，再选 Mode）
- **Output Contract 模板**：顶部加 `[验证级别][验证责任][升级决策]` 三字段
- **约束 ⑥**：V2/V3 且无 `已验证` 时 `升级决策` 不得为 `stay-read-only`
- **沙盒说明**：从提示升级为规则，V3 明确转交人工
- SKILL.md 行数：149 → 169 行（+20 行）

### Codex 独立发现（纳入下轮）
- **Mode A 默认值的锚定风险**：只要 Claude 的结论已进 prompt，Codex 独立性就会被削弱，skill 容易运行成"受控的复述与补充"。应该先判定验证级别，再决定是否用 Mode A。

### 下轮 Agenda
- [x] **Mode A 锚定风险** → v1.8
- [ ] evals：运行触发判断测试，基于结果优化 description
- [ ] body 结构优化：按 skill-creator 推荐的四段式重新分段

---

## v1.8.0 — 2026-03-20

**主题：Mode A 锚定风险**
**讨论模式：** Mode A（Claude 先独立方案，Codex 独立审查）
**完整讨论：** [discussions/2026-03-20-mode-a-anchoring.md](./discussions/2026-03-20-mode-a-anchoring.md)

### 改进内容
- **工作模式入口**：升级链路改为 Mode 选择器决策表，V2/V3 明确禁用 Mode A 作首轮
- **Mode A**：`Review（默认）` → `Review（受限，非默认）`，加禁用场景（V2/V3 首轮、方案探索、执行决策前独立判断）
- **Mode B**：`Parallel（独立并行）` → `Parallel（默认独立模式）`，明确优先使用场景
- **七条硬规则**：新增 `Mode-A Boundary`（任务目标是获得独立判断时禁用 Mode A；V2/V3 禁用）
- **Verification Matrix**：末尾加 Mode 约束注释
- SKILL.md 行数：169 → 177 行（+8 行）

### Codex 独立发现（纳入下轮）
- **Evidence Packaging Rule（证据打包规则）**：Claude 控制哪些证据传给 Codex，这是比 Mode A 更上游的锚定问题。代码片段 > 代码解释，原始报错 > 错误归因，命令输出 > 结论摘要。即使用了 Mode B，如果传的是"处理过的证据叙事"，异质性还是假的。

### 下轮 Agenda
- [x] **description 主轴重写 + 收尾四问改条件触发 + Red Flags** → v1.9
- [ ] **Evidence Packaging Rule**：证据打包规则（Codex 指出这是所有 Mode 都面临的上游污染问题，比 Mode A 降级更根本）
- [ ] evals：运行触发判断测试，验证新 description 在 meta 场景的召回率
- [ ] body 结构优化：按 skill-creator 推荐的四段式重新分段

---

## v1.9.0 — 2026-03-21

**主题：description 主轴重写 + 收尾改为条件触发 + Red Flags**
**讨论模式：** Mode B × 2（触发失败根因分析 + superpowers 设计对比）
**完整讨论：** [discussions/2026-03-21-description-trigger-redesign.md](./discussions/2026-03-21-description-trigger-redesign.md)

### 改进内容
- **description 主轴改变**：从"内省信号"（before trusting your own answer / fluency）改为"任务信号"（needs independent second-model verification）
- **meta 场景显式化**：加入"when asked to assess this skill itself or explain why it did or did not trigger"，覆盖之前两次漏触发的盲区
- **fluency 从 description 降级**：不再作为触发条件（后验信号，触发时刻根本不可用）；设计哲学保留在正文
- **收尾四问 → 条件触发**：三项均无（判断未变/无验证缺口/无污染风险）则跳过，避免模板式填空
- **新增 Red Flags 章节**：4 条合理化借口 + 对应现实，防止执行层漏触发

### Codex 独立贡献（Claude 未独立发现）
- "后验 vs 前验"的诊断：`fluency` 在 description 匹配时刻根本不存在，是架构层面错误不只是措辞问题
- "封闭枚举"问题：枚举越强，未枚举的近邻场景越容易漏
- `"If being wrong would be costly"` 总兜底公式

### 下轮 Agenda
- [x] **开发机制重构**：verify-repo.sh + STATUS.md + CLAUDE.md bootstrap → v1.10
- [ ] **Evidence Packaging Rule**：证据打包规则
- [ ] evals：验证新 description 在 meta 场景、隐式 paraphrase 场景的召回率

---

## v1.10.0 — 2026-03-21

**主题：开发机制重构——确定性裁判 + failure-first 迭代入口 + CLAUDE.md bootstrap**
**讨论模式：** Mode B（Claude 写计划，Codex 独立 review，2 轮收敛）
**完整讨论：** [discussions/2026-03-21-dev-mechanism-refactor.md](./discussions/2026-03-21-dev-mechanism-refactor.md)

### 改进内容
- **新增 `scripts/verify-repo.sh`**：引用检查（所有关键文档）+ SKILL.md 结构检查 + 已安装 skill 漂移检查 + 可移植性检查 + 失败行为说明（triage 模式，不是终止）
- **新增 `STATUS.md`**：机器可读的固定 schema（skill_version / health_status / confirmed_failures / root_cause_hypotheses / validation_queue / deferred_items / next_safe_step）
- **新增 `references/WORKFLOW.md`**：从 CLAUDE.md 迁入完整迭代手册（工具、流程、格式规范、安全边界）
- **重写 `CLAUDE.md`**：压缩至 bootstrap 层（~85 行），明确启动顺序 + 单一真相源 + verify 失败语义 + no-op 允许
- **修复 `scripts/sync-skill.sh`**：去除硬编码 `/Users/nio` 绝对路径，改用 `$HOME` 和相对路径
- **修复 `CONTRIBUTING.md`**：删除对不存在的 `docs/automation.md` 的引用，改为 `references/WORKFLOW.md`
- **修复 `README.md`**：Mode B 改为默认（升级链路顺序更新），fluency 从触发条件改为 red flag，新增 meta 场景触发

### Codex 独立贡献（Claude 未独立发现）
- "failure-first 退化成 failure-stop"的架构诊断：verify 失败分支语义缺失是整个机制的致命漏洞
- skill 漂移检查是 silent fallback 的主要来源，原计划完全漏掉
- STATUS.md 的 CHANGELOG.md 双轨调度冲突：必须明确 CHANGELOG 降级为只读历史
- no-op 修复必须与 discussion 模板联动（不然规则对齐但模板还在强制编造发现）

### 下轮 Agenda
- [x] **description 重写**：加 consequential judgment 上位类 + 讨论/迭代场景 → v1.11
- [x] **自主执行规则**：收敛后直接执行，不追问用户 → v1.11
- [x] evals：增加 meta/paraphrase/discussion 回归测试用例（id 7-10）→ v1.11
- [ ] **Evidence Packaging Rule**：证据打包规则（上游污染问题，比 Mode A 降级更根本）
- [ ] 恢复 Output Contract + Verification Escalation Matrix（v1.8→v1.9 hard reset 时丢失）

---

## v1.11.0 — 2026-03-23

**主题：触发覆盖补全 + 收敛后自主执行规则**
**讨论模式：** Mode B × 2（两个独立问题各跑一轮，双模型收敛后直接实施）
**完整讨论：** discussions/2026-03-23-trigger-coverage-and-autonomy.md

### 改进内容
- **description 重写**：加入 `consequential judgment` 上位类，显式覆盖 `workflow / strategy / iteration tradeoffs`，解决"讨论类"场景漏触发的枚举漏洞
- **自主执行规则**：在"升级 / 停止规则"末尾加 3 条——两边一致且下一步可逆/在范围内 → 直接执行；必须问用户的边界条件（超出原请求/不可逆/外部副作用）；阻断时写收尾
- **evals 扩充**：新增 id 7-10，覆盖 discussion/path-choice/meta 场景
- SKILL.md 行数：133 → 137 行

### Codex 独立贡献（Claude 未独立发现）
- **description 是"唯一触发机制"**：Red Flags 在触发后才读，无法补救首轮匹配——这是机制层面问题，不是执行层问题
- **"综合结论"≠"确认检查点"**：缺失规则导致综合后仍然停下问用户，是设计漏洞而非执行习惯
- **宁可误触发，不要漏 consequential judgment**：cost 不对称决定了 description 应偏保守

### 下轮 Agenda
- [ ] **Evidence Packaging Rule**：证据打包规则（上游污染问题，比 Mode A 降级更根本）
- [ ] 恢复 Output Contract + Verification Escalation Matrix（v1.8→v1.9 hard reset 时丢失）

---

## v1.12.0 — 2026-03-23

**主题：自主迭代机制——状态机调度 + 双模型选题 + verify-repo.sh 语义增强**
**讨论模式：** Mode B（Claude+Codex 综合分析，brainstorming + codex-buddy 协作设计）
**完整讨论：** discussions/2026-03-23-shadow-scheduling-test.md

### 改进内容

**层级 1：修复"叙事先于证据"**
- **verify-repo.sh 语义增强**：新增 CHANGELOG 引用完整性检查（引用的 discussions/ 文件必须真实存在）、evals.json id 连续性检查（jq-based）、done_when 主观词汇检查（AI判断/感觉/认为/满意/觉得）
- **补写缺失的 v1.11 讨论文件**：`discussions/2026-03-23-trigger-coverage-and-autonomy.md`

**层级 2：STATUS.md → 显式状态机**
- 合并原 `validation_queue` + `deferred_items` + `next_safe_step` 为统一 `work_queue`（含 done_when 验收条件）
- 新增字段：`selected_item` / `selection_rationale` / `operating_mode` / `human_gate` / `last_round_outcome`
- `next_safe_step` 删除，方向选择从人工指令变为状态推导

**层级 3：WORKFLOW.md Step 1 → 双模型自主选题**
- Step 1 重写为 Phase 1A（Claude 独立排序）+ Phase 1B（Codex 独立排序，Mode B）+ Phase 1C（综合收敛）
- Phase 1C 规则：top 1 id 相同则直接选；不同但有共同 id 则选最高优先级共同项；完全分歧则 human_gate
- Step 1.5 补充自主模式衔接：三问由 AI 自答，写入 discussion 文件，任一否则 NO_OP

### Codex 独立贡献（Claude 未独立发现）
- "叙事先于证据"比"还不够自主"更根本：系统允许 CHANGELOG 声称完成但证据缺失，verify-repo.sh 不会发现——这是放开自主提交前必须先修的基础
- STATUS.md 需要显式状态机而不是自然语言提醒：只有引入 `done_when` 可验证条件，AI 才能自主判断"做完了"
- 影子调度测试中 Codex top 1=W-001，Claude top 1=W-004，Phase 1C 通过共同 id 收敛到 W-001，双模型视角差异（"验证真实落地"vs"修结构缺陷"）在机制内被正确处理

### 下轮 Agenda
- [ ] **W-001：确认自主执行规则在真实对话中生效**（selected_item，最高优先级）
- [ ] W-003：恢复 Output Contract + Verification Escalation Matrix
- [ ] W-004：Evidence Packaging Rule（上游污染问题）

---

## v1.12.1 — 2026-03-25

**主题：W-001 验证——done_when 结构性修复 + 自主执行路径存档**
**讨论模式：** Mode B（不传 Claude 结论，Codex 独立分析）
**完整讨论：** [discussions/2026-03-25-w001-validation.md](./discussions/2026-03-25-w001-validation.md)

### 改进内容

- **W-001 done_when 重写**：修复结构性错误（原 done_when 将 `human_gate` 运行时状态混入完成条件）；改为可达的人工验收格式：2 段 transcript（直接执行路径 + 边界阻断路径）
- **W-001 title 精确化**：明确"自主执行规则"指 SKILL.md L109-114 升级/停止规则，而非泛指 WORKFLOW.md 迭代机制
- **human_gate 设置**：`REQUIRED:missing_input` — 已有直接执行路径证据（本轮讨论文件），缺"边界条件触发 gate"的真实对话记录

### Codex 独立发现（Claude 未独立识别）

- done_when 的结构性错误：`human_gate` 是运行时阻断状态，不是验收完成条件，两者必须分离（Claude 只提出"以 discussion 作证据"，未识别这个设计缺陷）
- "自主执行规则"定义更精确：核心是 SKILL.md 的"收敛后直接执行，不追问"（v1.11 引入），不是 WORKFLOW.md 的迭代自主化机制
- W-003（VEM 恢复）比 W-001 更根本：无验证责任契约，自主执行只会将不可审计的结论更快地执行出去；建议 human_gate 等待期间优先推进 W-003

### 下轮 Agenda
- [x] **W-003：恢复 Output Contract + Verification Escalation Matrix** → v1.13
- [ ] W-001：待人工提供"边界阻断"transcript 后关闭
- [ ] W-004：Evidence Packaging Rule

---

## v1.13.0 — 2026-03-25

**主题：W-003 恢复 Verification Escalation Matrix + Output Contract**
**讨论模式：** Mode B（不传 Claude 结论，Codex 独立分析）
**完整讨论：** [discussions/2026-03-25-w003-vem-output-contract.md](./discussions/2026-03-25-w003-vem-output-contract.md)

### 改进内容

- **`快速开始` → `## Verification Escalation Matrix`**：删除与 Mode B 高度重复的快速开始，替换为 V0-V3 四级验证矩阵；将"先定验证级别再选 Mode"的决策顺序置于文档最前
- **新增 `## Output Contract`**（传递原则之后）：`[已验证]`/`[假设]`/`[未验证]` 标注约定 + Mode A/B/C 的 `[与 Claude 对比]` 规则 + 置信度约束
- **Mode 入口文字更新**："先定验证级别（见上方矩阵），再选 Mode"
- **Mode B/A prompt 结尾更新**：强制引用 Output Contract + 各 Mode 比对规则

SKILL.md 行数：138 → 144（净增 6 行，< 150）

### Codex 独立发现（Claude 未独立提出）

- **删除 `快速开始` 而非 `注意事项`**：快速开始与 Mode B 高度重复，是信息密度最低的腾行目标（Claude 计划删注意事项 items 3&4）
- **VEM 前置而非后置**：替换快速开始位置强制改变心智模型；Claude 计划放在传递原则后，改变力度不够
- **决策顺序是根本缺陷**：当前先 Mode 再验证天然退化为"再问一次"，这比"缺章节"更根本

### 下轮 Agenda
- [ ] **W-004：Evidence Packaging Rule（上游污染问题）** — 双模型均认可的高价值改进
- [ ] W-001：待人工提供"边界阻断"transcript 后关闭
