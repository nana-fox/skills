# 讨论：W-005 将 codex-buddy 改为 "any conversation" 自动触发机制

**日期：** 2026-03-26 | **模式：** Mode B（不传 Claude 结论） | **结果：** 收敛，已实施

---

## 话题

using-superpowers 的设计模式：description = "any conversation" → 每次必加载 → body 成为 session 元规则。
讨论是否将 codex-buddy 改为同样机制，及如何在 body 顶部区分"每次必建立的规则"和"条件才执行 codex exec"。

---

## Step 1.5 三问自答（自主模式必填）

1. **这个改动让 skill 更容易用，还是更复杂？**
   description 变简单，但 body 顶部新增规则块。整体：加载时机更可靠，使用者判断负担降低。→ 更准确 ✓

2. **一个真实 Claude 在真实对话中会 follow 这条新规则吗？**
   EXTREMELY-IMPORTANT 块是 Claude Code skill 的强约束格式，已有 using-superpowers 作为成功案例。→ 是 ✓

3. **如果 Codex 的输出不完全符合新规范，用户还能从中提取有用信息吗？**
   规则是会话级政策，即使部分不遵守也有价值。→ 是 ✓

---

## 第一轮：各自开场

**Claude（独立分析）：**

> 当前条件触发的根本问题：模型必须在没有 skill 的情况下判断是否需要 skill。
> 这个判断本身就是单模型自洽点，正是 codex-buddy 要防止的那种判断。
>
> 改为 any conversation 解决 bootstrap 问题，但需要硬区分两件事：
> - 加载 skill = 建立 session 级验证政策（每次必做）
> - 执行 codex exec = 按 VEM 级别条件触发（不是每次）
>
> 副作用：evals.json 里的 should-not-trigger 用例语义需要调整；
> 噪声增加但可接受，因为规则疲劳比漏触发代价低。

**Codex（原始输出）：**

> `[已验证]` any conversation 风格的核心优点：解决当前的 bootstrap 问题——模型必须先自己判断
> "这是不是高后果判断"，而这恰好就是 skill 想防止的单模型自洽点。
>
> `[已验证]` 当前条件触发的根本缺点：把最难的判断留给 skill 加载之前去做，因此最容易漏掉真正该触发的情况。
>
> `[假设]` 顶部 EXTREMELY-IMPORTANT 块写法——关键是状态机清楚，区分 always load policy 和 sometimes run Codex：
> ```
> Loading this skill DOES NOT automatically require running `codex exec`.
> 1. Classify the task: V0/V1/V2/V3
> 2. Choose verification level BEFORE choosing Mode
> 3. V0: don't run Codex. V1-V3: follow VEM rules.
> ```
>
> `[假设]` 如果采用 any conversation，应把长 CLI 模板下沉到引用文档，skill 只保留
> policy + VEM + mode choice，否则常驻成本偏高。
>
> `[已验证]` 最大缺陷：把"会话级验证政策"和"具体执行 runbook"塞进了同一个、条件触发的 skill。
> 结果是最该被前置的元规则，反而依赖一次未受约束的先验判断才能加载。
> 更直接地说：这是"自我门控失败"。
>
> `[假设]` 与 using-superpowers 的职责重叠、规则疲劳、学习信号变脏是三个真实副作用，
> 但均可通过清晰的顶部区分和 CLI 模板下沉来缓解。
>
> `[未验证]` 误触发率、预算消耗和疲劳强度仍是行为推断，未做真实会话 A/B 实验。

---

## 共识与分歧

| 点 | Claude | Codex | 结论 |
|----|--------|-------|------|
| 是否改为 any conversation | 支持 | 支持 | **共识** |
| 根本缺陷表述 | "条件触发 = 先验判断没有 skill 保护" | "自我门控失败" | **采纳 Codex：更精确** |
| EXTREMELY-IMPORTANT 块结构 | always load / sometimes exec 二分 | 状态机清楚，policy vs execution 硬拆 | **采纳 Codex** |
| CLI 模板处理 | 未提 | 下沉到引用文档，降低常驻成本 | **采纳 Codex：独立发现** |
| 潜在副作用 | evals should-not-trigger 语义变 | 规则疲劳 + 学习信号变脏 + 职责重叠 | **Codex 更全面** |

---

## 对 SKILL.md 的改动（v1.14）

1. **description 改为 any conversation 风格**：`Use when starting any conversation — loads the verification policy for this session. Loading this skill does not automatically trigger codex exec; it establishes when and how to use it.`
2. **顶部加 EXTREMELY-IMPORTANT 块**：区分 always（分类任务、建立政策）vs conditional（按 VEM 级别才执行 codex exec）；含 Red Flags 提示
3. **Mode B/A/C bash 模板移出**：替换为一行引用 `references/cli-examples.md`，节省 ~24 行
4. **行数变化**：144 → ~135 行（净减少 9 行，< 150 ✓）

---

## 独立性验证（每轮必填，不得省略）

- [x] Codex 在 Claude 给出方案后才被调用（Step 2 先于 Step 3）
- **Codex 发现了 Claude 没有提出的什么：**
  - "自我门控失败"——比 Claude 的"先验判断没有保护"更精确，也更能说明问题的根本性
  - CLI 模板下沉建议——Claude 完全没有想到，但这对降低常驻成本至关重要
  - 与 using-superpowers 职责重叠作为真实副作用——Claude 只想到 evals 语义变化
  - 规则疲劳和学习信号变脏——两个 Claude 未识别的副作用
- **Claude 因为 Codex 的输出改变了什么：**
  - 改用"自我门控失败"作为核心缺陷的表述
  - 采纳 CLI 模板下沉（而不是在 skill 里保留 bash 块）
  - EXTREMELY-IMPORTANT 块写法采纳 Codex 的"状态机清楚"原则
- **本轮对话是否真实有效：** 有效——Codex 独立发现 CLI 模板下沉和"自我门控失败"，两者都改变了 Claude 的实施方案；Codex 的副作用分析比 Claude 更完整
