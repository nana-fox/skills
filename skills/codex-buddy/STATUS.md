# STATUS.md

> 仓库状态快照。由 AI 代理在每轮迭代前更新。
> 字段值遵守规定格式，空值写 `NONE`。

---

## skill_version
v3.0.1

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
  status: open

## selected_item
<!-- 由 AI 从 work_queue 推导；不再人工填写 -->
W-014

## selection_rationale
<!-- Claude + Codex 综合选题的理由（一句话） -->
v3.0 just shipped — runtime validation is the immediate priority

## operating_mode
<!-- TRIAGE | ITERATE | VALIDATE | BLOCKED -->
VALIDATE

## human_gate
<!-- NONE | REQUIRED:<reason> -->
NONE

## last_round_outcome
<!-- FIXED | VALIDATED | NO_OP | REGRESSED | UNCERTAIN -->
VALIDATED

## last_round_notes
v3.0.1: W-014 e2e validation passed (5/5). Fixed 3 bugs found during validation: execFileSync→async spawn+5min watchdog (ETIMEDOUT fix), SKILL.md CLAUDE_PLUGIN_ROOT→SKILL_DIR placeholder, parseArgs empty checks handling. Codex review confirmed watchdog necessity.
