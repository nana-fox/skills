---
name: codex-buddy
description: >
  Cross-model AI buddy for independent second opinions via Codex CLI.
  Use when Claude faces any nontrivial judgment, recommendation, critique,
  review, prioritization, tradeoff, or decision in any domain — not limited
  to specific scenarios. Covers: reviewing plans, docs, code, specs, rules,
  workflows, or proposals; checking reasoning or assumptions;
  comparing options; finding blind spots; validating conclusions.
  Also trigger on natural requests like: "帮我看看", "你觉得呢",
  "这样好不好", "有没有问题", "还有更好的办法吗", "我不确定这个对不对",
  "帮我想想还有没有遗漏", "你确定吗", "再想想".
  If borderline and the task involves judgment rather than rote execution,
  activate.
---

# codex-buddy

让 Claude 与 Codex 对话，打破单模型闭环自洽。不是"让 Codex 审查 Claude"，而是两个模型真正交流。

**两模型一致 ≠ 正确。真值来自执行验证，不来自模型共识。**

**默认回路：** 判 V-level / floor rules → 选证据路径 → 验证 → 标注置信度。

<EXTREMELY-IMPORTANT>
加载此 skill ≠ 执行验证。加载建立会话级验证政策；执行按 Gate 条件触发。

每个回合，回答之前先判（不得跳过）：

**第一步：Floor Rules 检查（强制）**
→ 破坏性/不可逆操作（rm -rf/DROP/force push/deploy/migration）→ 必须 Route
→ 批准型时刻（用户问"能X吗？""safe吗？""确认？"）→ 必须提供证据
→ 无证据的 correctness claim（说"测试会过"但没跑过）→ Route 到 local evidence

**第二步：V-level 判断（按后果判，不按文体判）**
→ 我的回答错了，用户会不会按这个方向走错？会 → 最低 V2。
V1[FACT] — 仅限：原文/代码/命令/行号/现状转述，可直接核对，不给建议
V2[METHOD] — 涉及：推荐/方法/流程/如何做/方向判断/取舍/优先级
V2[META] — 涉及：本 skill / 验证机制 / 多代理协作的设计、规则、取舍
V2[DECISION] — 涉及：任何影响用户决策/实现/规则走向的结论
V0 — 机械/格式化任务 | V3 — 破坏性/不可逆操作

**拿不准 → V2，不是 V1。**

V0 不调 | V1 可选（跳过标 `[未验证]`）| V2 必须 Route | V3 必须人工/外部验证

写在回复开头，格式：`V{level}[TYPE] | {理由}`

漏触发红旗——这些念头意味着你在合理化跳过：
"这只是讨论" / "答案很清晰" / "我在解释为什么没触发" / "这是关于 skill 自身的评估"
</EXTREMELY-IMPORTANT>

---

## Evidence Router（证据路径）

Gate 触发后，按优先级选证据路径：

1. **先 local evidence**（grep/test/lint/diff）— 快、免费、确定性高
2. **不够再 Codex probe** — 需要独立判断时升级

通过 buddy-runtime.mjs 调度，不手搓命令。
**路径规则：** `CLAUDE_PLUGIN_ROOT` 仅在 hook 上下文可用。对话中调用时，使用 skill 加载时提供的 base directory 路径（见 `Base directory for this skill:` 行）。

```bash
# 示例（将 <SKILL_DIR> 替换为实际 base directory 路径）：

# Local evidence
node "<SKILL_DIR>/scripts/buddy-runtime.mjs" \
  --action local --project-dir "$PWD" --checks "test:npm test,lint:npx eslint ."

# Codex probe（写证据到文件，runtime 读取并调用）
node "<SKILL_DIR>/scripts/buddy-runtime.mjs" \
  --action probe --evidence /tmp/buddy-evidence.txt --project-dir "$PWD"

# Preflight（检查 codex CLI 可用性）
node "<SKILL_DIR>/scripts/buddy-runtime.mjs" --action preflight
```

Runtime 返回 JSON：`status` / `evidence_summary` / `conclusion` / `call_count`。
同一决策最多 2 次 Codex 调用（probe + follow-up），避免无意义反复。
**注意：** probe 调用可能耗时 30-80 秒。使用 `run_in_background` 避免 Bash 超时。

---

## 证据打包

传原始证据包，不传足以替 Codex 预判答案的叙事。

发送前检查：
1. **task_to_judge**：一句话描述要判断什么，不写结论或倾向
2. **原始证据**：代码片段 / 原始报错 / 命令输出 / 文档摘录（不传解释、归因、摘要）
3. **known_omissions**：没传但可能影响判断的上下文；无写 `none`
4. **污染清理**：删除推理过程、方案推荐、倾向性形容词

若 prompt 读起来像"答案草稿"而非"证据包" → 退回重写。

---

## 对话协议

**Probe（默认首步）：** 不传 Claude 结论。Claude 独立分析 + Codex 独立回答，完成后综合。
**Follow-up（按需）：** Codex 回复中包含疑问或信息不足时，补充原始证据。仍不传 Claude 结论。
**Challenge（按需）：** 将 Codex 主张编号 C1/C2/...，只针对编号 claim 提出反证。

**裁决：** 分歧可验证 → 直接验证，不辩论 | 无法验证 → 标 `[unresolved]` | 最多 2 次 Codex 调用

**综合格式（不做胜负裁决，呈现各方视角）：**
- **Claude 视角**：probe 前我的独立分析
- **Codex 视角**：Codex 独立发现的内容（引用原文）
- **共识**：双方均指出的问题（置信度更高）
- **各方独有**：一方发现而另一方未提及的内容
- **[unresolved]**：有分歧但无法当场验证的内容

Codex 不保证遵守格式 → 提取不出结构时标 `unstructured`，整体参考。
完整 CLI 模板见 [`references/cli-examples.md`](./references/cli-examples.md)

---

## 反馈：学习闭环

关键结论标注：`[已验证]` / `[假设]` / `[未验证]`
无 `[已验证]` 且影响高风险决策 → 置信度不得标 `high`。

Codex 改变了 Claude 的判断 → 记录改变了什么、为什么。
Codex 没有新发现 → 写 `no-op`，不编造。

**每次 probe 综合后必须标注：** `--action annotate --probe-found-new <true|false> --user-adopted <true|false>`（是否发现新问题 / 是否采纳建议）

---

## 升级 / 停止规则

- 有分歧但可验证 → 验证，不辩论
- 涉及不可逆操作 → 不以模型共识收尾，必须外部验证
- 两边一致 + 在请求范围内 + 可逆 + 不违反验证级别 → 直接执行
- 该验证但未验证 → 标 `[未验证]`，不自动执行
- 必须停下问用户：超出原请求 / 缺关键输入 / 不可逆 / 外部副作用

---

## 注意事项

1. 分歧 ≠ Codex 对，是"需要人工判断"的信号
2. 禁止递归：Codex 结论不再交给 Codex 验证
3. 沙盒：默认 `read-only`；升 `workspace-write` 前须告知用户
4. 前置检查：首次调用前运行 `--action preflight`；不可用 → `[blocked: codex unavailable]`
5. 证据脱敏：传原始证据前去除 secret/token/credential/cookie
6. 不传 `--model`：默认不加 `--model`；仅用户明确要求时才传
