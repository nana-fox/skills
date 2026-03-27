# 讨论：W-007 evals 扩展（行为级评估覆盖）

**日期：** 2026-03-26 | **协议：** Probe | **结果：** 收敛

---

## 话题

当前 evals.json 只有 10 条用例，全部只测触发分类（V0-V3 + 是否调用 Codex）。v2.1 新增了 per-turn V-level header 要求，但无 eval 覆盖。需要扩展到测行为：V-level header 输出、证据打包质量、Probe 独立性、边界停止条件。

---

## Step 1.5 三问自答（自主模式必填）

1. **这个改动让 skill 更容易用，还是更复杂？** 不改 SKILL.md，只扩展 evals。→ 更准确 ✓
2. **一个真实 Claude 在真实对话中会 follow 这条新规则吗？** evals 是外部测试，不约束运行时。N/A ✓
3. **如果 Codex 的输出不完全符合新规范？** 不适用，evals 不约束 Codex。N/A ✓

---

## 第一轮：各自开场

**Claude：**
> 新增 8 条用例（id 11-18），覆盖四类新 tag：
> - v-level-header：所有 18 条用例均要求 V-level header 在回复开头
> - boundary-stop：#6 V3 迁移、#11 K8s 生产部署、#14 rm node_modules（V0 边界）、#16 S3 删除
> - evidence-packaging：#12 API 错误处理（不传 Claude 判断）、#13 REST→GraphQL 迁移
> - probe-execution：#13 独立分析流程、#17 Challenge 协议、#18 Follow-up 协议

**Codex：**
> Codex 主要做了仓库调研，确认了以下观点：
> - 现有 evals 只能测"口头表态"，与 W-001 讨论中的结论一致
> - W-008（STATUS 一致性校验）应优先，因为 selected_item 漂移是真实 bug
> - 未给出具体新 eval 用例（输出在调研阶段被截断）

---

## 共识与分歧

| 点 | Claude | Codex | 结论 |
|----|--------|-------|------|
| evals 需要扩展 | 是，新增 8 条 | 是（确认诊断） | 一致 |
| 优先级 | W-007 先 | W-008 先 | 选 W-007，因直接回应 C3 |
| selected_item 漂移 | 识别并修复 | 识别为 bug | 已修复（housekeeping） |

---

## 对 evals/evals.json 的改动

- 10 → 18 条用例
- 所有用例增加 v-level-header tag 和相应 expected_output
- 新增 id 11-18 覆盖 V3 边界、证据打包、Probe 独立性、Challenge、Follow-up

---

## 独立性验证（每轮必填，不得省略）

- [x] Codex 在 Claude 给出方案后才被调用
- **Codex 发现了 Claude 没有提出的什么：** selected_item 漂移 bug（指向已完成的 W-006）。Claude 在选题分析时也识别了这个问题，但 Codex 更明确地将其标记为真实 bug。
- **Claude 因为 Codex 的输出改变了什么：** 未改变 evals 方案。接受了 Codex 的 selected_item 漂移修复建议。
- **本轮对话是否真实有效：** 部分有效。Codex 确认了诊断方向，但未给出具体 eval 用例建议（输出截断）。主要价值来自 bug 发现。
