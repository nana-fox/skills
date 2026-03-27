# 讨论：失败模式记录机制

**日期：** 2026-03-20 | **模式：** Mode C（3 轮） | **结果：** 分歧收敛，混合方案

---

## 话题

codex-buddy 每次运行后什么都不留下。无法知道：这次触发有没有价值？谁的判断更接近真相？哪种 Mode 在什么场景下系统性失效？

没有记录，skill 永远是"流程习惯"，无法成长为"误差画像系统"。

---

## 第一轮：各自开场

**Claude：**
> 我认为不需要外部日志系统。在 skill 收尾阶段强制 Claude 回答三个问题就够了：触发模式是否合适？最大分歧是什么？有没有该做但没做的执行验证？答案嵌在对话里，零基础设施。

**Codex：**
> 先确认目标：你想要轻量运行日志、评估分析系统、还是可追踪的发布级产物？我推荐轻量优先。

*（注：Codex 没有直接给方案，而是先问目标。Claude 直接给方案——两者思维方式的差异在这里就出现了。）*

Claude 选择 **轻量优先**，Codex 给出具体方案——

**Codex 方案：**
> `logs/runs/YYYY-MM.ndjson`（每次一行，追加写）+ `logs/incidents/`（专题复盘）
>
> 最小字段：`ts` / `task_digest` / `trigger_reason` / `mode` / `claude_claim_digest` / `codex_claim_digest` / `relation` / `resolution` / `resolution_basis` / `usefulness` / `followup_needed`
>
> 原则：90% 自动记录，10% 事后补标签。`resolution` 和 `usefulness` 不补也没关系，先记 `unresolved`。

---

## 第二轮：Claude 质疑

**Claude：**
> 你的核心矛盾：`resolution`（谁对了）和 `usefulness`（有没有价值）是最有用的两个字段，却恰恰没法自动填。用户不补，日志就是空壳。你说"先记 unresolved 也没关系"——但如果大部分都是 unresolved，这套机制能产生什么真实洞察？

**Codex：**
> 你的质疑是对的。纯日志方案最多是底座，不该被误称为核心机制。
>
> 我重新评估两个方向：
> - 纯日志方案：可积累可统计，但最有价值的字段依赖人工补录，极易空心化
> - 你的收尾三问方案：零额外基础设施，强制每次产出结构化反思，能立刻暴露问题
>
> **我支持你的方向。** 但我不建议完全放弃持久化——更合理的是：收尾四问作为主机制，只在高价值案例才落 incident 文件。

---

## 第三轮：Codex 反提升三问→四问

**Codex：**
> 你的三问能告诉我们"哪里有问题"，但还不能回答"这次触发带来了多少增量价值"。
>
> 我建议加第四问：**Learning Signal**
> 可选值：`none` / `confidence_check` / `found_assumption_gap` / `found_mode_error` / `found_fact_risk`
>
> 这样才能逐渐区分：只是重复确认、真正发现盲点、模式选错导致浪费。

**Claude：**
> 采纳。第四问解决了我原来方案里"无法衡量价值"的问题。

---

## 共识与分歧

| 点 | Claude | Codex | 结论 |
|----|--------|-------|------|
| 记录形式 | 对话内问答，无文件 | ndjson 日志文件 | **主机制用对话，有信号才落文件** |
| 问题数量 | 三问 | 四问（加 Learning Signal） | **采用四问**（Codex 的改进更完整） |
| 持久化 | 不需要 | 需要 | **有条件持久化**（信号触发才写 incident） |
| Codex 先反问 | 直接给方案 | 先问目标方向 | 思维方式差异，均有合理性 |

**Codex 独立发现（Claude 未想到）：**
- 三问无法衡量增量价值，需要第四问 Learning Signal
- ndjson 作为可选底层不是主机制，这个纠正很关键

---

## 对 SKILL.md 的改动

新增"收尾四问"章节，定义：
- Q1 Mode Fit / Q2 Key Divergence / Q3 Verification Gap / Q4 Learning Signal
- 触发持久化记录的具体信号
- `logs/incidents/` 作为可选层，不强制每次写
