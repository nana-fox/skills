# codex-buddy ROADMAP

> 跟踪已完成 / 进行中 / 待规划的开发阶段。每个阶段：worktree 隔离开发 → 全量验证 → 用户确认 → 才合 main。

---

## 已完成（feat/ux-stage1 worktree，未合 main）

### Stage 1 — Session Policy + 输出纪律 ✅
- `--session-policy isolated|conversation`（probe）
- conversation 模式 codex_session_id 持久化 + 自动 resume
- SKILL.md "输出纪律"：probe 启动后不 narrate "准备证据/调用脚本"
- session id 解析 fallback（`--output-schema` 模式 banner 被抑制时扫 `~/.codex/sessions/`）

### Stage 2 — Stdin Evidence + Session JSONL 审计日志 ✅
- `--evidence-stdin` 取代 `/tmp` 临时文件 transport（旧 `--evidence <file>` 仍可用）
- `~/.buddy/sessions/<buddy-session-id>.jsonl` 事件流：probe.start / codex_output / synthesis / annotate / *.error
- payload 字段含 sha256 / bytes / redaction_policy；>256KiB 转 payload_ref
- `lib/redact.mjs` 默认脱敏（OpenAI / Anthropic / GitHub / AWS / Slack / Stripe / JWT / Bearer / env-style）
- `BUDDY_AUDIT_RAW=1` 跳过 redaction（调试）
- `--action log-synthesis` / `--action replay`

### Stage 3-A — Codex App-Server JSON-RPC Adapter（实验性 opt-in）✅
- `BUDDY_USE_APP_SERVER=1` 路由 probe 到 `codex app-server` JSON-RPC
- 协议：initialize → thread/start → turn/start → notification stream → finalMessage
- spawn-per-call（无 broker），适配官方 v2 schema
- threadId 提取 + outputSchema 作为 JSON 对象传递
- session log 含 `runtime: app-server | exec` 字段

### Audit 必修 ✅
- `audit.test.mjs` 修 import（去除已移除的 BUDGET_LIMIT 引用）→ 全量 51/51 测试通过（之前漏跑 5 个测试文件）
- `app-server` 客户端补 `error` listener + threadId 过滤 + `error` notification 处理
- `outputFile` 加 4-byte 随机后缀（防同毫秒并发碰撞）
- annotate 自动取最近 probe 的 `verification_task_id`
- followup 优先 `--verification-task-id` 从 session log 解析 codex_session_id（不再依赖全局 ~/.buddy/session.json）
- redact 加 sk-proj/github_pat/Bearer/Slack/Stripe 等 pattern
- 文档：heredoc EOF 风险 / app-server+followup 限制 / BUDDY_AUDIT_RAW

---

### Stage 5 — Broker（feat/ux-stage1 worktree）✅ 未合 main

W10: cleanup/gitignore/stub-bypass/hook-timing
W7: broker lifecycle（Unix socket, PID, stale-lock, broker-cli, session-end hook）
W8: turn/run forwarding + thread persistence + actionProbe wiring + BUDDY_USE_LEGACY_EXEC fallback
W9 #1-2: execCodex stderr first_byte fix + broker turn first_byte
W6.5: topic-drift Jaccard tripwire（soft warning on cross-topic reuse）
W11: broker 改为默认 runtime（BUDDY_USE_LEGACY_EXEC=1 / BUDDY_USE_BROKER=0 回退）
C1-C5: Codex 审计 5 个 correctness bug 全修

**78/78 tests, verify-repo PASSED, synced 到 ~/.claude/skills/codex-buddy/**
**累积 9 commits（ce0c037 → bcc4a1e），未合 main**
**红线：未完成 L3 行为验证 + L5 evals 且未得用户点头，不合 main**

---

## 待合 main（user 决定时机）

Stage 5 所有代码层工作已完成。合 main 前需：
1. 跑若干次真实 broker probe（自然积累）
2. 运行 `node scripts/buddy-bench.mjs --mode broker-startup-delta`（需有 broker session 数据）
3. 用户点头

## Stage 5b — 2026-04-29 audit schema v2 ✅

经 Codex probe 重新校准（原 P0 描述"字段全为空"不准确，实际是命名分歧+annotate 破坏 append-only）：

- ✅ audit.mjs:appendLog 写 `ts` / `buddy_session_id` / `verification_task_id` / `schema_version: 2`
- ✅ 移除 `annotateLastEntry`（破坏 JSONL append-only 的 read-modify-rewrite）
- ✅ 三个 appendLog 调用点都带上 `verification_task_id`
- ✅ metrics.mjs 跨流 join：从 session-log 读 annotate 事件，legacy 数据 fallback 到入口 mutated 字段
- ✅ 80/80 tests, verify-repo PASSED, smoke test passed
- 跳过：`logs.jsonl` → `decisions.jsonl` 重命名（风险大于收益，保留旧文件名）

## 下一 session 起点（待续）

**优先级 P1 — SKILL.md Session Policy 澄清（~15min）：**
- Session Policy（`--session-policy isolated|conversation`）是 codex exec 的 session resume 策略
- Broker thread（`--fresh-thread`）是 codex app-server 的 thread 复用策略
- 两者是独立的两层，当前 SKILL.md 把 "isolated 默认" 说法用于描述 broker 场景，会造成误解
- 更新 SKILL.md 中 "Session Policy" 段，区分两层概念

---

## 下一阶段（按优先级排序）

### Stage 3-B — Codex App-Server Broker（持久 daemon，**真实 latency 改善**）
**前置**：Stage 3-A 经过若干周真实使用，确认协议稳定。
**目标**：起一个常驻 broker 进程，Unix socket 暴露 JSON-RPC，多次 probe 复用同一个 codex app-server，省 5-10s/次启动 + prompt cache 命中。
**改动量**：~400-600 LoC（lib/buddy-broker.mjs + lifecycle + lock + 多 worktree 容错）
**保留条件**：连续 10 次 probe 平均 latency 比 Stage 3-A 降 ≥30%。
**丢弃条件**：daemon 复杂度（孤儿进程 / lock 失效）频繁导致用户介入。

### Stage 3-C — 跨协议 followup e2e 验证
**前置**：可独立做。
**目标**：app-server 写入的 thread（ephemeral=false）能被 `codex exec resume <thread-id>` 接续。
**改动**：新增 1 个 e2e smoke（双 worktree？）；如不兼容，文档 / 代码二选一锁住 followup 必须 app-server resume。

### Stage 4 — 跨家族 Buddy（Kimi / Gemini / Hermes provider）
**前置**：Stage 3-A/B 落地后有足够 Codex baseline 数据。
**目标**：抽 codex-app-server / codex-adapter 为 `BaseProvider` 接口，新增 KimiProvider 走 `kimi-cli --print --output-format stream-json` 或类似。
**先重构后接入**：第一步只改接口（Codex 实现照旧），第二步真正接入 Kimi。
**保留条件**：跨家族分歧率 > 20% 且分歧有判断价值。

### Stage 5 — 流式输出（实时进度 UX）
**前置**：Stage 3 任一稳定。
**目标**：probe 期间 runtime 把 codex 的中间 reasoning items 流式打到 stderr 或独立通道，让 Claude 启动 probe 后能感知"还在思考"vs"卡住了"。
**注意**：与 Phase 3-B (broker) 互补——broker 改启动开销，streaming 改主观等待感。

---

## 长期未规划（占位）

- Provider 切换到 `@openai/codex-sdk`（待 SDK surface 覆盖 app-server 全部语义）
- Conversation policy + app-server thread/resume 端到端打通
- session-log 落盘失败的优雅降级
- payload_ref 文件的轮转 / cleanup 策略

---

## 治理流程（每 stage 通用）

1. 在 worktree 开发（branch `feat/<stage-name>`）
2. 单元测试 + 集成 smoke
3. 同步本地 install（`cp` 到 `~/.claude/skills/codex-buddy/`）
4. 真实 probe 验证关键路径
5. **每完成一项 audit 必修立即 commit + sync + 测试**
6. 全量 stage 完成后请 codex-buddy 整体审计
7. 用户重启 session 跑 L3 行为验证 + L5 evals
8. 用户明确点头 → 才合 main

**红线**：未经过 (7)+(8) 不可合 main，记录在
`/Users/nio/.claude/projects/-Users-nio-project-nanafox-skills/memory/feedback_no_premature_merge.md`。
