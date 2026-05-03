# STATUS.md

> 仓库状态快照。由 AI 代理在每轮迭代前更新。
> 字段值遵守规定格式，空值写 `NONE`。

---

## skill_version
v3.3.2

## health_status
<!-- HEALTHY | NEEDS_TRIAGE | BLOCKED -->
HEALTHY

## confirmed_failures
<!-- 格式: [F-ID] 描述 | 证据: <文件:行或讨论链接> | 状态: OPEN|FIXED -->
[F-001] Kimi legacy/print-style review could produce empty output or protocol transcript that looked like a completed review | 证据: user screenshot 2026-05-02; skills/codex-buddy/scripts/lib/__tests__/kimi-wire-client.test.mjs | 状态: FIXED
[F-002] Kimi Wire can stream thousands of non-text events for 120s while producing no review text, making the host agent appear blocked | 证据: ~/.buddy/sessions/buddy-a492dd94.jsonl vtask-mophbony-ac3a06af/vtask-mopgvkxk-cfc35552; skills/codex-buddy/scripts/lib/__tests__/kimi-wire-client.test.mjs | 状态: FIXED

## root_cause_hypotheses
<!-- 格式: [H-ID] 假设 | 对应失败: <F-ID> -->
[H-001] Kimi CLI legacy output is not a stable review transport; empty final output and noisy transcript must be classified before runtime can claim review success | 对应失败: F-001
[H-002] Kimi Wire no-text event streams are provider no-progress failures; waiting for total timeout hides the actual state and creates avoidable customer friction | 对应失败: F-002

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
  status: done

- id: W-019
  type: fix
  title: trigger hardening state consistency
  source: user feedback 2026-05-03: future updates must only increment patch version; do not leave known tooling friction unresolved
  impact: high
  reversibility: safe
  done_when: "verify-repo fails on STATUS/CHANGELOG version drift and enforces patch-only version increments"
  status: done

- id: W-020
  type: fix
  title: Kimi wire no-progress recovery
  source: user screenshot/logs 2026-05-03: Kimi wire probe streamed events for 120s with chunks=0 chars=0 and then timed out
  impact: high
  reversibility: safe
  done_when: "fake Kimi wire streams non-text ContentPart events; runtime returns kimi-wire-no-progress with recoverable recovery_hint before total timeout; provider does not fallback to exec; default no-content timeout is at least 90000ms"
  status: done

## selected_item
<!-- 由 AI 从 work_queue 推导；不再人工填写 -->
NONE

## 架构边界

本方案当前支持 **2 个 buddy model**：`codex`（默认）、`kimi`（`--buddy-model kimi`）。
- provider registry 已落地：`codex` / `kimi` 都通过统一 `startTurn()` contract 接入，禁止在 runtime 主流程继续追加模型分支
- Codex provider 默认走官方 app-server/broker 事件协议，exec 只作为 fallback/degraded transport
- Kimi provider 默认走 Wire transport，exec 仅作 fallback；Wire events 映射为 provider events，legacy repr parser 仅作兼容参考
- Kimi session resume 未实现（session ID 已记录在 audit log，可手动 `kimi -r <id>`）

## external_docs

- Kimi CLI: https://moonshotai.github.io/kimi-cli/
- Kimi GitHub: https://github.com/MoonshotAI/kimi-cli
- Agent Skills spec: https://agentskills.io/home

## selection_rationale
<!-- Claude + Codex 综合选题的理由（一句话） -->
W-020 directly fixes the observed Kimi timeout/no-content failure path and turns it into a fast, diagnosable, recoverable provider result.

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
v3.3.2: W-020 Kimi wire no-progress recovery landed. Kimi Wire now cancels and returns kimi-wire-no-progress when provider events arrive without review text for 90s, preserving fail-closed semantics while giving the host recoverable diagnostics and recovery_hint.
