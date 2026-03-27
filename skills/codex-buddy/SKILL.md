---
name: codex-buddy
description: >
  Use when the user asks for optimization priorities, next-step recommendations,
  updates to development guides based on official docs, evaluation of rules/skills/workflows,
  or any judgment about whether a conclusion should be independently verified with Codex.
  Typical prompts: "接下来应该做哪方面的优化", "先优化什么", "根据官方文档更新开发指南",
  "这个结论需要验证吗", "要不要调 Codex", "这个 skill 的设计是否合理".
  Loads the session verification policy, assigns a V-level, and decides whether Codex should be consulted.
---

# codex-buddy

让 Claude 与 Codex 对话，打破单模型闭环自洽。不是"让 Codex 审查 Claude"，而是两个模型真正交流。

**两模型一致 ≠ 正确。真值来自执行验证，不来自模型共识。**

**默认回路：** 判 V-level → 打包证据 → Probe（独立双判）→ 综合 → 标注置信度。

<EXTREMELY-IMPORTANT>
加载此 skill ≠ 执行 codex exec。加载建立会话级验证政策；执行按验证级别条件触发。

每个回合，回答之前先判断（不得跳过，"只是讨论"不是豁免条件）：
1. 当前任务的验证级别？（V0 / V1 / V2 / V3）
2. 该级别需要调 Codex 吗？

判断结果写在回复开头，格式：`V{0-3} | {理由}`
示例：`V0 | 机械格式化任务` 或 `V2 | 架构选型需独立第二判断`

V0 不调 | V1 可选（跳过标 `[未验证]`）| V2 提出方先验证 | V3 必须人工/外部验证

漏触发红旗——这些念头意味着你在合理化跳过：
"这只是讨论" / "答案很清晰" / "我在解释为什么没触发" / "这是关于 skill 自身的评估"

兜底触发（绕过自评盲区）：
讨论本 skill、验证机制或 Claude-Codex/多代理协作机制的设计决策、取舍或规则修改 → 最低 V2；仅查现状/原文/行号除外。
</EXTREMELY-IMPORTANT>

---

## 触发：何时需要 Codex

| 级别 | 场景 | 默认动作 |
|------|------|---------|
| V0 | 低风险/机械任务 | 不调 Codex |
| V1 | 文档/源码可核对的事实 | 可选 `read-only` 核对 |
| V2 | 需要独立第二判断的决策 | Probe 先验证，必要时 `workspace-write` |
| V3 | 破坏性/不可逆操作 | 必须人工/外部验证 |

V2/V3 无 `[已验证]` → 不给可执行结论。

---

## 格式：证据打包

传原始证据包，不传足以替 Codex 预判答案的叙事。

发送前检查：
1. **task_to_judge**：一句话描述要判断什么，不写结论或倾向
2. **原始证据**：代码片段 / 原始报错 / 命令输出 / 文档摘录（不传解释、归因、摘要）
3. **known_omissions**：没传但可能影响判断的上下文；无写 `none`
4. **污染清理**：删除推理过程、方案推荐、倾向性形容词

若 prompt 读起来像"答案草稿"而非"证据包" → 退回重写。

---

## 交流：对话协议

已决定调用 Codex 后，对话自然流转，不预选模式。

**Probe（默认首步）：**
不传 Claude 结论。Claude 独立分析 + Codex 独立回答，完成后综合。
首次 Probe 后记录 `SESSION_ID`，供后续 Follow-up 使用。

**Follow-up（按需）：**
Codex 回复中包含疑问或标注信息不足时，通过 `exec resume <SESSION_ID>` 补充原始证据回应。仅单一活跃会话时可用 `--last`。仍不传 Claude 结论。

**Challenge（按需）：**
Claude 先将提取的核心主张编号为 `C1/C2/...`。
有具体分歧时，只针对编号 claim 提出反证或补证，不重写整篇答案。

**裁决：**
- 分歧可用文档/代码/命令验证 → 直接验证，不辩论
- 无法验证 → 标 `[unresolved]`，交给用户
- 最多 2 次 Codex 调用（1 Probe + 1 Follow-up/Challenge），未收敛就停

**Claude 侧解析（弱约束 + 强适配）：**
Codex 是外部工具，不保证遵守格式。Claude 收到回复后自行提取：
- 核心主张（claims）→ 编号 C1/C2/...
- 未解决的疑问（questions）
- 建议验证的事项（tests）
提取不出结构 → 标 `unstructured`，整体作为独立意见参考。
综合时不预设 Claude 的判断优先。

完整 CLI 模板见 [`references/cli-examples.md`](./references/cli-examples.md)

---

## 反馈：学习闭环

关键结论标注：`[已验证]` / `[假设]` / `[未验证]`
无 `[已验证]` 且影响高风险决策 → 置信度不得标 `high`。

Codex 改变了 Claude 的判断 → 记录改变了什么、为什么。
Codex 没有新发现 → 写 `no-op`，不编造。

项目反馈与跨会话记忆规则见仓库 `docs/WORKFLOW.md`（开发资产，仅开发者可用）。

---

## 升级 / 停止规则

- 有分歧但可验证 → 验证，不辩论
- 涉及不可逆操作 → 不以模型共识收尾，必须外部验证
- 两边一致 + 在请求范围内 + 可逆 + 不违反验证级别 → 直接执行
- 该验证但未验证 → 标 `[未验证]`，不自动执行
- 必须停下问用户：超出原请求 / 缺关键输入 / 不可逆 / 外部副作用
- 未执行 → 写明阻断原因

---

## 注意事项

1. 分歧 ≠ Codex 对，是"需要人工判断"的信号
2. 禁止递归：Codex 结论不再交给 Codex 验证
3. 沙盒：默认 `read-only`；升 `workspace-write` 前须告知用户
4. 前置检查：首次调用前运行 `command -v codex`；失败 → `V{N} | [blocked: codex unavailable]`，指引用户安装，本轮仅给 `[未验证]` 结论
5. 证据脱敏：传原始证据前去除 secret/token/credential/cookie
