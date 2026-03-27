# 讨论：description 主轴重写 + 触发失败根因分析

**日期：** 2026-03-21 | **模式：** Mode B × 2 | **结果：** 收敛，Codex 发现关键架构问题

---

## 话题

用户在真实对话中发现 codex-buddy 连续两次漏触发：
1. "skill 功能现在你们觉得怎么样"（评估性问题）
2. "为什么我上面这个问题都没有触发交流？"（meta 自省问题）

两次 Claude 都直接给出了流畅的答案而没有调用 codex-buddy。这暴露了 description 的根本设计问题。

---

## 第一轮：触发失败根因分析

**Claude（独立分析）：**
> 触发失败的原因是把问题归类为"聊天/讨论"而非"需要验证的判断"。description 里的触发示例是具体场景，Claude 隐式在 pattern-match 这些场景，而不是 apply 通用原则（fluency = 信号）。元对话是最容易漏触发的盲区。

**Codex（独立分析，原始输出）：**

> 根因偏 `description` 设计，不是单纯的 Claude 临场失误。更准确地说，是 `description` 把最重要的触发信号写成了 Claude 很难稳定执行的"内省条件"，所以在这两类 meta 对话里几乎天然容易漏触发。
>
> **为什么这两次都没触发：**
>
> 1. `"skill 功能现在你们觉得怎么样"` — 这句话不显式命中当前 description 里的 4 个外部场景。唯一可能兜住它的，只剩"如果我的答案会异常流畅就触发"。但这条规则的设计有根本问题：它要求 Claude 先察觉"我这段话太顺了"，再反过来决定要不要调用 skill。这个信号太内生了，不适合作为稳定的自动触发条件。
>
> 2. `"为什么我上面这个问题都没有触发交流？"` — 这其实更应该触发，因为它已经进入"让 Claude 解释自己为什么没用 codex-buddy"的闭环自证区了，正是这个 skill 想打破的模式。但 description 并没有把"当用户质疑你刚才为什么没触发 skill"写成显式触发场景，所以它又落回 Claude 自我解释，第二次继续漏。
>
> 一句话概括：你把"防止自洽自证"的安全阀，设计成了"由模型自己判断自己现在是不是太自洽"的规则。这和触发机制天然冲突。

---

## 第二轮：superpowers 设计对比

**Claude（独立分析）：**
> using-superpowers 的关键手法：Red Flags 表（驳回合理化借口）、1% 原则 + 零惩罚、description 极简。codex-buddy 依赖正向场景匹配，fluency 信号要求先生成答案才能感知。

**Codex（独立分析，原始输出）：**

> `using-superpowers` 真正防漏触发的核心，不是"语气更强硬"，而是它把触发点绑在一个几乎不会缺席、而且在触发时就可观察到的生命周期事件上：`starting any conversation`。
>
> **using-superpowers 用了、codex-buddy 没用好的手法：**
>
> 先说真正影响"首轮匹配"的：
> - 它用"流程阶段"做锚点，不用"任务细类"做锚点。
> - 它描述的是"触发当下就成立的条件"。而 `codex-buddy` 里 `before trusting your own answer` 和 `if your answer feels unusually fluent` 都偏后验，触发器在收到消息那一刻未必拿得到这个信号。
> - 它先给一个上位类别，再把后续规则留给正文。`codex-buddy` 现在更像封闭枚举：代码 review、架构选择、知识截止点、破坏性操作、流畅度。枚举越强，未被枚举的近邻场景越容易漏。
>
> **最该借鉴的不是把措辞改得更凶，而是改 3 个设计方向：**
> - 把 description 的主轴从"我现在是否信任自己的答案"改成"这个任务是否需要独立二次验证"。前者是内省信号，后者是任务信号。
> - 把触发条件改成"消息到达时可观察"的东西。
> - 用一个宽的上位类，再列代表场景；不要让枚举看起来像完整列表。
>
> **Codex 草案：**
> ```yaml
> Use when a task needs independent second-model verification rather than a single-model answer.
> Trigger when reviewing or approving code/logic, checking safety or correctness, choosing between
> consequential options, confirming current or version-specific facts, or before any destructive,
> irreversible, or production-facing action. If being wrong would be costly, use this skill.
> ```

---

## 共识与分歧

| 点 | Claude | Codex | 结论 |
|----|--------|-------|------|
| 根因 | 执行失误为主 | 设计问题为主，执行为辅 | 采纳 Codex |
| fluency 信号 | 难以识别 | **后验信号，触发时刻根本不存在** | Codex 更精准 |
| 枚举问题 | 列举限制泛化 | 封闭枚举让近邻场景漏触发 | 共识 |
| Red Flags | 建议加到 body | 同意，但更根本的是改 description 主轴 | 都做 |

---

## 对 SKILL.md 的改动

1. **description 主轴重写**：从"内省信号"改为"任务信号"，加入 meta 场景显式触发，加总兜底 `"If being wrong would be costly"`
2. **收尾四问 → 条件触发**：三项均无则跳过，不再强制填空
3. **新增 Red Flags 章节**：4 条合理化借口

---

## 独立性验证

- [x] Codex 在 Claude 给出分析后才被调用（Step 2 先于 Step 3）
- **Codex 发现了 Claude 没有提出的什么：** "后验 vs 前验"的架构诊断——`fluency` 在 description 匹配时刻根本不可用，是触发架构的根本错误，不是措辞问题。"封闭枚举"概念的清晰表达。`"If being wrong would be costly"` 总兜底公式。
- **Claude 因为 Codex 的输出改变了什么：** 将根因从"执行失误"改为"设计缺陷为主"；接受 fluency 从 description 降级而非只是重新措辞。
- **本轮对话是否真实有效：** 是。Codex 两次都提供了 Claude 未独立产出的角度，尤其是"后验信号"的诊断改变了实质设计决策。
