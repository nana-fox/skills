# 讨论：description 瘦身

**日期：** 2026-03-20 | **模式：** Mode A（Claude 先独立方案，Codex 独立审查） | **结果：** 快速收敛，Codex 发现额外结构性问题

---

## 话题

v1.4 的 CHANGELOG 中 Codex 独立指出：description frontmatter 约 750 字符，混入了 workflow 说明，违反 skill-creator 规范。description 应只描述"何时使用"，策略规则应留正文。本轮主题是压缩 description，同时评估正文结构是否需要调整。

---

## 第一轮：各自开场

**Claude：**

> 当前 description 的问题：
>
> 1. **体积问题**：约 750 字符，超过合理的 frontmatter 范围
> 2. **内容越界**：混入了 workflow 逻辑（"The more certain Claude feels..."），而不只是触发条件
> 3. **重复问题**：body 里也有触发场景表格，description 和 body 在重复同一件事
>
> 改动方案：
> - 保留：触发信号（代码审查、架构决策、流畅度警告、破坏性操作、知识截止点）
> - 删除：workflow 说明、详细解释、重复的触发场景
> - 结果：约 250-300 字符的纯触发描述
>
> 改动后 description：
> ```yaml
> description: >
>   Use to get an independent Codex (GPT-4o) check before trusting your own answer.
>   Trigger on: reviewing code you just wrote, high-stakes architecture choices with
>   multiple valid options, facts near your knowledge cutoff, and any destructive or
>   irreversible operation. If your answer feels unusually fluent, complete, or confident,
>   you should use this skill — fluency is the primary failure signal, not uncertainty.
> ```
>
> 正文结构暂时不动，因为本轮主题聚焦 description。

**Codex（原始输出）：**

> ## Proposed Change: Trim SKILL.md Description
>
> The description field is doing two jobs: trigger detection and workflow explanation. Per skill-creator conventions, description should only answer "when to invoke" — everything else belongs in the body.
>
> ### Before (≈750 chars):
> ```
> Use when you need independent cross-model validation via Codex CLI (GPT-4o).
> Trigger on: code you just wrote and want reviewed, high-stakes architecture decisions
> with multiple valid approaches, facts near your knowledge cutoff, destructive operations
> before execution, or any time your answer feels suspiciously smooth and confident.
> The more certain Claude feels, the more this skill should trigger — fluency is the
> primary failure signal, not uncertainty.
> ```
>
> ### After (≈280 chars):
> ```
> Use to get an independent Codex (GPT-4o) check before trusting your own answer.
> Trigger on: reviewing code you just wrote, high-stakes architecture choices with
> multiple valid options, facts near your knowledge cutoff, and any destructive or
> irreversible operation. If your answer feels unusually fluent, complete, or confident,
> you should use this skill — fluency is the primary failure signal, not uncertainty.
> ```
>
> ### Why this works:
> - Keeps all 5 trigger signals intact
> - Removes "The more certain Claude feels..." explanation (that's body-level reasoning)
> - Rewrites from vague ("code you just wrote and want reviewed") to action-oriented ("reviewing code you just wrote")
> - 280 chars is within the ~100-word guideline for description
>
> ### Additional finding beyond this PR's scope:
>
> The body currently lacks a standard **Output Contract** for what Codex should return.
> Mode A, B, C each have different implicit output expectations, but there's no explicit
> schema. This causes inconsistency: sometimes Codex returns a comparison table, sometimes
> free-form prose, sometimes a list. An Output Contract section would fix this.
>
> This is the **biggest current design gap** — more impactful than the description trim.
> Recommend adding to next iteration's agenda.

---

## 共识与分歧

| 点 | Claude | Codex | 结论 |
|----|--------|-------|------|
| description 需要瘦身 | 是 | 是 | ✅ 双方一致 |
| 保留 5 个触发信号 | 是 | 是 | ✅ 双方一致 |
| 目标长度 ~280 字符 | ~250-300 | ~280 | ✅ 基本一致，采用 Codex 更精确的措辞 |
| 改动范围本轮只限 description | 是（正文不动） | 是（但额外指出 Output Contract 缺失） | ✅ 本轮 description，Output Contract 列入下轮 |
| Output Contract 是最大设计缺口 | 未独立发现 | 明确指出 | ✅ 纳入下轮 Agenda 首位 |

---

## 对 SKILL.md 的改动（v1.5）

**description 字段**：从 ~750 字符压缩至 ~280 字符，删除 workflow 解释，保留 5 个触发信号和流畅度警告。

具体见 [SKILL.md](../SKILL.md) frontmatter。

---

## Codex 超出本轮主题的发现（纳入下轮 Agenda）

> The body currently lacks a standard **Output Contract** for what Codex should return.
> Mode A, B, C each have different implicit output expectations, but there's no explicit schema.
> This is the **biggest current design gap** — more impactful than the description trim.

**Claude 的判断：** Codex 说得对。当前各 Mode 的 Codex 输出没有统一格式约定，每次调用结果的结构取决于 prompt 措辞，不可预期。Output Contract 应该定义：独立结论 / 与 Claude 一致点 / 分歧点 / 已验证 / 未验证 / 最终方案。这会显著提升 skill 的可用性和结果的可解读性。
