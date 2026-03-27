# STATUS.md

> 仓库状态快照。由 AI 代理在每轮迭代前更新。
> 字段值遵守规定格式，空值写 `NONE`。

---

## skill_version
v2.6.0

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
<!-- 已完成项（W-003 ~ W-012）已归档，见 CHANGELOG.md 对应版本记录 -->

- id: W-001
  type: validate
  title: 确认自主执行规则在真实对话中生效
  source: validation_queue V-001
  impact: high
  reversibility: safe
  done_when: "提供至少 2 段真实对话 transcript：1 段两边一致+可逆时直接执行，1 段命中边界条件时停止并写明 gate 原因"
  status: open

- id: W-002
  type: validate
  title: 确认 failure-first 启动顺序在真实对话中有效
  source: validation_queue V-002
  impact: medium
  reversibility: safe
  done_when: "eval 用例可回放且通过；或 human_gate: REQUIRED:missing_input 若无法自动化"
  status: open

- id: W-013
  type: improve
  title: marketplace 发布端到端验证
  source: 连续 3 个发布 bug（命令写反、缺 plugin.json、manifest 冲突）
  impact: high
  reversibility: safe
  done_when: "verify-repo.sh 检查 plugin.json 存在 + 与 marketplace.json name 一致；在无缓存环境执行 /plugin marketplace add ddnio/skills && /plugin install codex-buddy@ddnio-skills 后只注册一个 /codex-buddy"
  status: open

## selected_item
<!-- 由 AI 从 work_queue 推导；不再人工填写 -->
<!-- 格式: W-xxx；无待办写 NONE -->
W-013

## selection_rationale
<!-- Claude + Codex 综合选题的理由（一句话） -->
W-013 可自动推进且阻断发布质量；W-001/W-002 继续阻断于 human input

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
v2.6.0: 删除 repo_commit 字段、精简 work_queue、新增 W-013 发布验证。verify-repo.sh 增加 plugin.json 校验。CLAUDE.md/README 同步 plugin.json 结构。Codex Probe 确认方案并补充遗漏（脚本门禁、STATUS 重算、README 同步）。
