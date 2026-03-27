# 讨论：开发机制重构——verify-repo.sh + STATUS.md + CLAUDE.md bootstrap

**日期：** 2026-03-21 | **模式：** Mode B（Claude 先写计划，Codex 独立 review） | **结果：** 收敛，Codex 发现 3 个 P0 架构漏洞

---

## 话题

AI-only 开发的仓库需要确定性裁判机制。当前痛点：
- 没有机器可读的项目状态（依赖人读 CHANGELOG.md）
- 没有 invariant 检查（静默漂移无法被发现）
- CLAUDE.md 太重（348 行），AI 读完再开工已经有认知损耗
- 强制要求"Codex 发现了什么不能写无"系统性制造假进度

---

## 第一轮：Claude 独立方案

**Claude（独立分析）：**

> 需要三样东西：
>
> 1. **scripts/verify-repo.sh**：引用检查 + SKILL.md invariant + git diff 预览，失败退出码非 0
> 2. **STATUS.md**：固定 schema 快照（当前版本/开放根因/最近失败/待验证/暂缓/下一步）
> 3. **CLAUDE.md 重构**：压缩至 ~80 行 bootstrap，完整流程迁入 references/WORKFLOW.md，迭代入口改为 failure-first，修复已知失效引用，允许 no-op 轮次

---

## 第二轮：Codex 独立 Review

**Codex（独立 review，原始输出摘录）：**

> 结论：方向对，但这版计划还没闭环。最大问题不是"检查项太少"，而是还没定义单一真相源，以及 `verify-repo.sh` 失败后自动迭代该怎么继续；不补这两点，failure-first 很容易退化成 failure-stop，silent fallback 也仍会从文档漂移和 stale install 进来。
>
> **P0 — 没解决单一真相源。** 现在迭代入口仍明确绑定 `CHANGELOG.md` 的 Agenda，而计划又引入 `STATUS.md` 承载失败/下一步；如果 Agenda 继续留在 `CHANGELOG.md`，就会出现两套调度源。
>
> **P0 — `verify-repo.sh` 的非 0 退出码需要配套"失败分支语义"。** 否则 cron/脚本会直接停住，而不是进入 triage。建议明确：`verify` 失败 = 进入 `STATUS.md` 驱动的修复回合，不是终止整个迭代。
>
> **P0 — 计划漏了"已安装 skill 与仓库 SKILL 的漂移"检查。** 当前流程把 reload 验证当硬要求，但新计划的 `verify-repo.sh` 没保留这一点；这正是 silent fallback 的主要来源之一。
>
> **P1 — README.md 还在说 fluency 是触发条件、Mode A 是默认**，但当前 SKILL.md 已是 Mode B 默认、fluency 只是 red flag。
>
> **P1 — CLAUDE.md 内部有互相冲突的硬规则**：`< 500 行` 和 `< 150 行` 同时存在。
>
> **P1 — 允许 no-op 是对的，但必须一起改 discussion 模板**。现在还要求"Codex 发现了什么不能写无"；如果只改 bootstrap 不改模板，代理会被激励去编造增量发现。
>
> **P0 for verify-repo.sh — 引用检查范围太窄**，只查 CONTRIBUTING.md 不够，需覆盖 README.md、CLAUDE.md、SKILL.md。
>
> **P0 for verify-repo.sh — SKILL.md 结构不应只查字符串存在**，要检查关键段落各只出现一次。
>
> **P0 for STATUS.md — 字段名偏人类总结，不够机器判定**。需要稳定顺序、ID、状态和值域；`当前版本` 很容易和 CHANGELOG.md 漂移。
>
> **P0 for CLAUDE.md — bootstrap 压到 80 行可以，但 failure-first 入口、verify gate、no-op 允许、source-of-truth 优先级这些不能下沉到 WORKFLOW.md**；否则代理很可能只读 bootstrap 就开工。
>
> 如果只改一件事，我会先补这条：定义 `verify` 失败后的行为。否则这套 failure-first 机制最容易从"优先处理失败"变成"第一处失败就停机"。

---

## 共识与分歧

| 点 | Claude | Codex | 结论 |
|----|--------|-------|------|
| 总体方向 | 正确 | 方向对但没闭环 | 共识 |
| verify 失败行为 | 未定义 | P0：必须定义为 triage 而非 stop | 采纳 Codex |
| Skill 漂移检查 | 漏写 | P0：最主要的 silent fallback 来源 | 采纳 Codex |
| 单一真相源 | 未明确 | P0：CHANGELOG 和 STATUS 双轨是冲突 | 采纳 Codex |
| README 漂移 | 未提 | P1：Mode A/fluency 旧描述仍在 | 纳入本轮 |
| discussion 模板修复 | 未提 | P1：改 no-op 规则必须同时改模板 | 纳入本轮 |
| sync-skill.sh 可移植性 | 未提 | P1：硬编码 /Users/nio 路径 | 纳入本轮 |

---

## 对文件的改动

1. **新增 `scripts/verify-repo.sh`**：含 Codex 的 P0 补充（skill 漂移、更广引用检查、结构检查、失败行为说明）
2. **新增 `STATUS.md`**：机器可读的固定 schema，含 confirmed_failures/root_cause/validation_queue/next_safe_step/health_status
3. **新增 `references/WORKFLOW.md`**：从 CLAUDE.md 迁入完整迭代手册
4. **重写 `CLAUDE.md`**：压缩至 bootstrap 层，明确启动顺序 + 单一真相源 + 失败行为 + no-op 允许
5. **修复 `scripts/sync-skill.sh`**：去除硬编码绝对路径
6. **修复 `CONTRIBUTING.md`**：删除对不存在的 docs/automation.md 的引用
7. **修复 `README.md`**：Mode B 改为默认，fluency 从触发条件改为 red flag

---

## 独立性验证

- [x] Codex 在 Claude 给出计划后才被调用（Claude 写计划 → Codex 独立 review）
- **Codex 发现了 Claude 没有提出的什么：**
  1. "failure-first 退化成 failure-stop"的架构诊断——verify 失败分支语义缺失，是整个机制能否运转的关键
  2. skill 漂移检查的遗漏——identified as the "最主要的 silent fallback 来源之一"
  3. 单一真相源冲突（CHANGELOG Agenda vs STATUS.md 调度），这是比加功能更根本的设计问题
  4. no-op 改动必须与 discussion 模板联动（否则只改一处，产生新的规则冲突）
- **Claude 因为 Codex 的输出改变了什么：** 将 verify-repo.sh 的失败行为从"退出码非 0"升级为"明确打印 triage 指令"；将 STATUS.md schema 从自由字段改为有 ID、值域的机器可读格式；将 CHANGELOG.md 明确标注为"只读历史记录，不作调度源"
- **本轮对话是否真实有效：** 是。Codex 的三个 P0 发现都导致了实质设计改变，不是措辞调整。
