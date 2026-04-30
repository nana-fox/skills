# STATUS.md

> 仓库状态快照。由 AI 代理在每轮迭代前更新。
> 字段值遵守规定格式，空值写 `NONE`。

---

## skill_version
v3.2.0

## health_status
<!-- HEALTHY | NEEDS_TRIAGE | BLOCKED -->
HEALTHY

## confirmed_failures
<!-- 格式: [F-ID] 描述 | 证据: <文件:行或讨论链接> | 状态: OPEN|FIXED -->
NONE

## root_cause_hypotheses
<!-- 格式: [H-ID] 假设 | 对应失败: <F-ID> -->
NONE

## work_queue
<!-- 统一待办队列。done_when 必须是可由命令/文件验证的条件，不能是主观判断 -->

- id: W-014
  type: validate
  title: v3 runtime end-to-end validation
  source: v3.0.0 release
  impact: high
  reversibility: safe
  done_when: "buddy-runtime.mjs --action preflight returns ok; --action local with file-exists check returns verified; all unit tests pass"
  status: done

- id: W-015
  type: improve
  title: PreToolUse advisory hook for destructive operations
  source: spec §8.2
  impact: medium
  reversibility: safe
  done_when: "hooks.json includes PreToolUse matcher; hook intercepts rm -rf and injects advisory reminder"
  status: done

- id: W-017
  type: fix
  title: align broker path hashing to git-root (C1 from stage6a Codex review)
  source: Codex review vtask-mol0z8oq-6f45f140
  impact: medium
  reversibility: safe
  done_when: "getBrokerPaths() uses resolveWorkspaceRoot(projectRoot) instead of path.resolve(projectRoot); SessionEnd stops broker correctly when hook cwd != project-dir"
  status: done

- id: W-016
  type: improve
  title: Codex protocol communication performance optimization
  source: user feedback (2026-04-01)
  impact: high
  reversibility: safe
  done_when: "codex-adapter.mjs uses -a never before exec, --ephemeral for probes, trimPrompt caps at 12000 chars; smoke test passes"
  status: done

- id: W-018
  type: improve
  title: 可回放评估闭环
  source: CHANGELOG: 最大系统性缺陷不是审计痕迹缺失，而是缺少可回放的评估机制来检验触发是否正确、验证是否真的提升了决策质量
  impact: high
  reversibility: safe
  done_when: "evals include replayable trigger/verification-quality cases; command output reports pass/fail counts for those cases"
  status: open

## selected_item
<!-- 由 AI 从 work_queue 推导；不再人工填写 -->
NONE

## 架构边界

本方案当前支持 **2 个 buddy model**：`codex`（默认）、`kimi`（`--buddy-model kimi`）。
- provider registry 已落地：`codex` / `kimi` 都通过统一 `startTurn()` contract 接入，禁止在 runtime 主流程继续追加模型分支
- Codex provider 默认走官方 app-server/broker 事件协议，exec 只作为 fallback/degraded transport
- Kimi provider 当前为 exec-only，使用 final-message 输出并映射为 provider events；legacy repr parser 仅作兼容参考
- Kimi session resume 未实现（session ID 已记录在 audit log，可手动 `kimi -r <id>`）

## external_docs

- Kimi CLI: https://moonshotai.github.io/kimi-cli/
- Kimi GitHub: https://github.com/MoonshotAI/kimi-cli
- Agent Skills spec: https://agentskills.io/home

## selection_rationale
<!-- Claude + Codex 综合选题的理由（一句话） -->
W-018 remains queued as the next evaluation-system improvement; current PR does not implement it.

## operating_mode
<!-- TRIAGE | ITERATE | VALIDATE | BLOCKED -->
ITERATE

## human_gate
<!-- NONE | REQUIRED:<reason> -->
NONE

## last_round_outcome
<!-- FIXED | VALIDATED | NO_OP | REGRESSED | UNCERTAIN -->
FIXED

## last_round_notes
v3.1.0: broker hardening (SIGTERM timeout, server.on('error'), writePidFile ordering); isBrokerAlive PID fallback removed (OS reuse risk); C2 concurrent test fixed (Promise.allSettled); W-015 PreToolUse advisory hook implemented; SESSION_HANDOFF.md migrated to ~/.buddy/handoff-<hash>.md (out of git). 112/112 tests pass.
