# 讨论：安装说明 — 多平台安装方式

**日期：** 2026-03-20 | **模式：** Mode B（并行独立） | **结果：** 快速收敛，Codex 额外发现 description 问题

---

## 话题

README 安装章节只覆盖了 Claude Code 的基础场景，缺口明显：Codex CLI 的安装方式、符号链接 vs 复制的说明、验证步骤、更新方式、以及 Claude.ai 的说明是否准确。

---

## 第一轮：各自开场

**Claude：**
> 安装说明的四个缺口：
> 1. Codex CLI 安装路径（`~/.codex/skills/`）没有提
> 2. 没有验证步骤，用户不知道装完是否生效
> 3. 没有更新说明
> 4. symlink vs cp 的适用场景没说清楚
>
> 改动范围：README，SKILL.md 本身不动。

**Codex：**
> 缺口分析更细致，直接定位到具体行号：
>
> - README 只有 `npm install` 但没说明 skill 目录不存在时要先 `mkdir -p`
> - Claude Code 安装步骤假设当前目录名是 `codex-buddy`，容易在错误路径执行
> - **Codex CLI 被埋在"其他平台"**——但这个 skill 本身就是围绕 Codex CLI 设计的，这个分组会让用户误判主支持面
> - Claude.ai 的 `.skill` 文件说法：**仓库里根本没有 `.skill` 产物**，这条是未经验证的占位说明，应该删掉或降级
> - 整个安装章节缺"验证安装"闭环

---

## 共识与分歧

| 点 | Claude | Codex | 结论 |
|----|--------|-------|------|
| Codex CLI 应单独成章 | 是 | 是（且指出分组错误更严重） | ✅ 升为独立章节 |
| 需要验证步骤 | 是 | 是 | ✅ 新增验证安装 |
| symlink vs cp 说明 | 需要说明 | 建议用 `"$(pwd)"` 替代 `$(pwd)/xxx` | ✅ 采用 Codex 的写法 |
| Claude.ai `.skill` 说法 | 未特别指出 | 明确说"仓库无此产物，应删除" | ✅ 删除，改为通用说明 |
| mkdir -p 防护 | 未提 | 明确指出缺失 | ✅ 补上 |

---

## Codex 超出本轮主题的发现（重要，纳入下轮 Agenda）

> 我最担心的不是安装，而是这个 skill 现在把三件事混在一起了：触发策略、交互协议、CLI 操作手册。
>
> 最明显的信号在 SKILL.md description frontmatter。按 `writing-skills` 的约束，description 应该只描述"何时使用"；但现在它写成了长篇触发规则加行为说明，还用了强烈启发式语言。这个 frontmatter 约 750 字符，workflow 信息泄漏到 description 里，容易让模型"看描述就自以为懂了"，不认真读正文。这会直接削弱 skill 的可发现性和可执行性。
>
> 建议：把 description 压缩成一句纯触发条件，把策略规则留在正文，再把正文拆成"触发 / 模式选择 / CLI 模板 / 事后复盘"四段。

**Claude 的判断：** Codex 说得对。description 750 字符且包含 workflow 说明，违反了 skill-creator 规范。这是独立且重要的改进点，纳入下一轮。

---

## 对项目的改动（v1.4）

**README.md 安装章节重写：**
- 通用前置条件独立一节，统一 clone 路径
- Claude Code 安装：`mkdir -p` + 符号链接（推荐）/ 直接复制两选一，说明区别
- Codex CLI：升为独立章节，完整命令
- 其他环境：明确最小必要文件，删除未验证的 `.skill` 说法
- 新增"验证安装"章节（两行 `ls` 命令 + 重启提示）
- 新增"更新"章节

**SKILL.md：** 本轮不动。
