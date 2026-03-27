# 影子调度测试（层级 3 验收）

**日期：** 2026-03-23
**目的：** 验证 WORKFLOW.md Step 1 自主选题机制——Claude 和 Codex 不接收任何外部主题提示，只读 STATUS.work_queue，独立产生 top 3 排序，Phase 1C 综合出 selected_item。

---

## Phase 1A — Claude 独立排序

输入：STATUS.md work_queue（4 个 open 条目）+ SKILL.md 现状

排序结果：
1. **W-004**（Evidence Packaging Rule）— impact: high，上游污染问题影响所有 Mode，修复后直接提升异质性质量
2. **W-001**（自主执行规则验证）— impact: high，validate 类，是本轮自主化的直接闭环验证
3. **W-003**（Output Contract + VEM 恢复）— medium impact，long overdue，SKILL.md 结构缺口

---

## Phase 1B — Codex 独立排序

排序结果：
1. **W-001**（自主执行规则验证）— 直接验证"AI 自主迭代"核心目标是否在真实对话中生效；failure severity + validation value + autonomy gain 三项最高
2. **W-002**（failure-first 启动验证）— 全局性高严重度，启动总开关是否遵守
3. **W-003**（Output Contract + VEM 恢复）— 明确从无到有的结构缺口，输出一致性收益大

Codex 将 W-004 排第 4，理由：核心思想已以"传原始证据，不传加工过的叙事"存在于 SKILL.md，边际收益小于前三项。

---

## Phase 1C — 综合

| | Claude | Codex |
|-|--------|-------|
| Top 1 | W-004 | W-001 |
| Top 2 | W-001 | W-002 |
| Top 3 | W-003 | W-003 |

**Top 1 不同** → 触发"top 1 不同但有共同 id"规则
共同 id：W-001（Claude #2，Codex #1）、W-003（双方 #3）
选共同 id 中优先级最高者 → **`selected_item: W-001`**

---

## 测试结论

```
Claude top 1: W-004
Codex top 1: W-001
结论: PARTIAL（top 1 id 不同，但 Phase 1C 机制正常运作，收敛到共同 id W-001）
```

**测试发现：**
- Phase 1C 的"共同 id 回退"机制在真实排序分歧中生效
- Claude 倾向于优先修结构缺陷（W-004），Codex 优先验证核心目标是否真实落地（W-001）
- 分歧反映了两模型的视角差异，Phase 1C 正确地选择了双方均认可的高价值项
- W-003 双方均列 top 3，说明它是稳定的次优先项

**机制有效性评估：** 层级 3 自主选题机制按设计运作，Phase 1A/B/C 三阶段均正常执行，Phase 1C 在分歧情况下通过共同 id 收敛到确定结论，无需人工介入。
