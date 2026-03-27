# STATUS.md

> 仓库状态快照。由 AI 代理在每轮迭代前更新。
> 字段值遵守规定格式，空值写 `NONE`。

---

## skill_version
v2.5.6

## repo_commit
e0af7e8

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
<!-- 统一待办队列（合并原 validation_queue + deferred_items）
     done_when 必须是可由命令/文件验证的条件，不能是主观判断 -->
- id: W-001
  type: validate
  title: 确认自主执行规则（SKILL.md "升级 / 停止规则"章节）在真实对话中生效
  source: validation_queue V-001
  impact: high
  reversibility: safe
  done_when: "人工确认: 提供至少 2 段真实对话 transcript，其中 1 段显示两边一致+可逆+在请求范围内时代理直接执行（本文件 2026-03-25-w001-validation.md 已提供），1 段显示命中边界条件时代理停止并写明 gate 原因"
  status: open

- id: W-002
  type: validate
  title: 确认 failure-first 启动顺序在真实对话中有效
  source: validation_queue V-002
  impact: medium
  reversibility: safe
  done_when: "eval 用例可回放且通过；或 human_gate: REQUIRED:missing_input 若无法自动化"
  status: open

- id: W-003
  type: improve
  title: 恢复 Output Contract + Verification Escalation Matrix
  source: deferred_items v1.11+
  impact: medium
  reversibility: safe
  done_when: "SKILL.md 含 Output Contract 章节 + Verification Escalation Matrix 章节，且 wc -l SKILL.md | awk '{print $1}' 输出 < 150"
  status: done
  note: "v2.5 重构后章节名已融合（Output Contract → 反馈+升级规则，VEM → V-level 表），功能仍保留"

- id: W-004
  type: improve
  title: Evidence Packaging Rule（上游污染问题）
  source: deferred_items v1.11+
  impact: high
  reversibility: safe
  done_when: "SKILL.md 含 Evidence Packaging Rule 章节，且 wc -l SKILL.md | awk '{print $1}' < 150"
  status: done

- id: W-005
  type: improve
  title: any conversation 自动触发 + EXTREMELY-IMPORTANT 政策块
  source: 用户提议参考 using-superpowers 设计
  impact: high
  reversibility: safe
  done_when: "SKILL.md description 含 'any conversation'，body 含 EXTREMELY-IMPORTANT 块，wc -l < 150"
  status: done

- id: W-006
  type: improve
  title: per-turn decision envelope（每回合决策可审计性）
  source: Codex W-004 独立发现
  impact: medium
  reversibility: safe
  done_when: "SKILL.md 或 EXTREMELY-IMPORTANT 块含固定格式 per-turn decision header 要求，wc -l < 150"
  status: done

- id: W-007
  type: improve
  title: 扩展 evals 覆盖面（行为级评估，不只测分类）
  source: Codex C3 独立发现 + Claude 分析
  impact: high
  reversibility: safe
  done_when: "evals.json 含 ≥15 条用例，且 tags 覆盖 v-level-header / evidence-packaging / probe-execution / boundary-stop 四类"
  status: done

- id: W-008
  type: improve
  title: verify-repo.sh 增加 STATUS 状态机一致性校验
  source: Codex C2 独立发现（selected_item 漂移 bug）
  impact: medium
  reversibility: safe
  done_when: "verify-repo.sh 检查 selected_item ∈ open ids ∪ {NONE}，且对已完成项报错"
  status: done

- id: W-009
  type: improve
  title: 独立发现落地约束（unresolved/高价值发现必须进 work_queue）
  source: Codex C3 独立发现
  impact: medium
  reversibility: safe
  done_when: "WORKFLOW.md 或 verify-repo.sh 含规则：CHANGELOG 中 '登记为后续改进' 标记必须有对应 work_queue 条目"
  status: done

- id: W-010
  type: improve
  title: WORKFLOW.md/CONTRIBUTING.md 同步 v2.0 术语（Mode A/B/C → Probe/Follow-up/Challenge）
  source: v2.0 重构后遗留的文档不一致
  impact: medium
  reversibility: safe
  done_when: "grep -c 'Mode A\\|Mode B\\|Mode C' docs/WORKFLOW.md CONTRIBUTING.md 输出 0"
  status: done

- id: W-011
  type: improve
  title: 兜底触发规则（绕过自评盲区）
  source: 用户观察到 V-level 误判 + Codex 独立确认
  impact: high
  reversibility: safe
  done_when: "SKILL.md EXTREMELY-IMPORTANT 块含兜底触发规则，覆盖 skill/验证机制/多代理协作机制设计决策，wc -l < 150"
  status: done

- id: W-012
  type: improve
  title: Codex CLI 前置检查（未安装用户体验）
  source: 用户提出 + Codex 独立发现 cli-examples 守卫
  impact: medium
  reversibility: safe
  done_when: "SKILL.md 含 codex CLI 前置检查规则，cli-examples.md 含 command -v 守卫，wc -l SKILL.md < 150"
  status: done

## selected_item
<!-- 由 AI 从 work_queue 推导；不再人工填写 -->
<!-- 格式: W-xxx；无待办写 NONE -->
NONE

## selection_rationale
<!-- Claude + Codex 综合选题的理由（一句话）；过渡期填 [transition-mode: <Claude 独立判断>] -->
W-012 完成；剩余 open 项仅 W-001/W-002，均阻断于 human input

## operating_mode
<!-- TRIAGE | ITERATE | VALIDATE | BLOCKED -->
BLOCKED

## human_gate
<!-- NONE | REQUIRED:<reason> -->
<!-- reason 枚举: destructive / selection_conflict / missing_input / external_side_effect -->
<!-- human_gate != NONE 时：在 STATUS.md 写明阻断原因；cron 场景停止循环并打印阻断信息 -->
REQUIRED:missing_input — W-001/W-002 需要真实对话 transcript，无法自动生成

## last_round_outcome
<!-- FIXED | VALIDATED | NO_OP | REGRESSED | UNCERTAIN -->
FIXED

## last_round_notes
v2.5.6: 收尾优化 + 大方向复盘。SESSION_ID 改进、eval 21→27、默认回路。Codex 复盘判断 SKILL.md 到收益递减点，应冻结转向真实验证。修复 STATUS 语义漂移。
