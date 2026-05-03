# docs/WORKFLOW.md

完整迭代手册。被 `CLAUDE.md` 引用，按需读取。

> **官方参考：**
> - Skill 开发：[The Complete Guide to Building Skills for Claude](../../../doc/The-Complete-Guide-to-Building-Skill-for-Claude.pdf)
> - Codex CLI：https://developers.openai.com/codex/cli
>
> 这两份文档会持续更新，本文件应跟随官方迭代同步。

---

## skill-creator 规范（每次改 SKILL.md 必读）

本项目使用 `skill-creator` skill 作为质量标准。

### SKILL.md 结构规范

```
codex-buddy/
├── SKILL.md          ← 必须，含 YAML frontmatter（文件名大小写敏感）
├── references/       ← 详细参考文档（按需加载，不自动载入上下文）
├── scripts/          ← 可执行脚本（确定性/重复任务）
└── assets/           ← 输出用文件（模板、图标等）
```

**命名规则（官方要求）：**
- 目录名：kebab-case（`codex-buddy` ✅，`Codex_Buddy` ❌）
- SKILL.md 必须精确拼写（不接受 `SKILL.MD`、`skill.md`）
- skill 目录内**不放 README.md**（所有文档进 SKILL.md 或 references/）
- name 字段不能含 "claude" 或 "anthropic"（保留字）

### 三级加载系统（Progressive Disclosure）

| 级别 | 内容 | 自动加载 | 大小限制 |
|------|------|---------|---------|
| 1 | frontmatter（name + description） | 始终在系统 prompt | ~100 词 |
| 2 | SKILL.md body | skill 触发时 | **< 150 行** |
| 3 | references/ scripts/ | Claude 按需读取 | 无限制 |

**关键原则：** 详细 CLI 示例、大型参考文档放 `references/`，body 只保留核心概念和最精简示例。SKILL.md 建议不超过 5000 词。

### description 规范

- **description 是唯一的触发机制**，所有"何时使用"信息放这里，不放 body
- 必须包含：skill 做什么 + 具体触发场景（用户会说的话）
- < 1024 字符，不含 XML 标签（`<` `>`）
- 适度"pushy"：Claude 倾向于少触发，description 要明确推动触发
- body 里**不要**重复 description 中已有的触发条件

**好的 description 示例（来自官方指南）：**
```yaml
# 具体且可操作
description: Analyzes Figma design files and generates developer handoff
  documentation. Use when user uploads .fig files, asks for "design specs",
  "component documentation", or "design-to-code handoff".
```

**差的 description 示例：**
```yaml
# 太模糊
description: Helps with projects.

# 缺触发短语
description: Creates sophisticated multi-page documentation systems.
```

**过度触发时的修复方法：**
1. 加否定触发：`Do NOT use for simple data exploration (use data-viz skill instead).`
2. 收窄范围：`Processes PDF legal documents for contract review`（而非 `Processes documents`）
3. 明确边界：`specifically for online payment workflows, not for general financial queries`

### 每次改 SKILL.md 后的验证清单

- [ ] `wc -l SKILL.md` < 150 行
- [ ] description 包含所有触发场景，body 不重复
- [ ] description < 1024 字符，无 XML 标签
- [ ] 详细 CLI 示例在 `references/`，body 只有简化版
- [ ] `bash scripts/sync-skill.sh` 已执行
- [ ] **Reload 验证（必须执行，每次不得跳过）**：

  ```bash
  bash scripts/verify-install.sh
  ```

  验证通过条件：verify-install.sh 全部 PASSED。

### 使用 skill-creator 优化 description

当 description 可能不够准确时，运行描述优化：

```bash
# 在 skill-creator 所在目录运行
python -m scripts.run_loop \
  --eval-set evals/evals.json \
  --skill-path /path/to/codex-buddy \
  --model claude-sonnet-4-6 \
  --max-iterations 5
```

触发 eval 测试用例见 `evals/evals.json`。

### 可回放 evals（W-018）

`evals/evals.json` 支持可选 `assertions` 和 `expected_reply`。`expected_output` 继续给人读，`assertions` 给机器检查：

```bash
node evals/replay-evals.mjs --eval-set evals/evals.json
```

输出包含 `total/asserted/passed/failed/skipped/failures`。`verify-repo.sh` 会运行 replay evals，并要求至少有一条 assertion 被执行。

### 测试三层方法论（来自官方指南）

| 层 | 目标 | 方法 |
|----|------|------|
| **Triggering** | skill 在正确时机加载 | 跑 10-20 条 query，统计自动触发率（目标 ≥90%） |
| **Functional** | 产出正确结果 | 验证输出、API 调用成功、边界条件覆盖 |
| **Performance** | 比无 skill 更好 | 对比 token 消耗、来回轮次、失败率 |

**调试触发问题：** 问 Claude `"When would you use the codex-buddy skill?"` — Claude 会复述 description，据此调整。

### 迭代反馈信号

| 信号 | 含义 | 修复方向 |
|------|------|---------|
| skill 不加载 | 欠触发 | description 加关键词和触发短语 |
| 无关 query 也触发 | 过触发 | 加否定触发、收窄范围 |
| 加载了但不遵循指令 | 指令问题 | 关键指令提前、用编号列表、移详细内容到 references/ |
| 响应变慢 / 质量下降 | 上下文过大 | 缩减 SKILL.md、移内容到 references/ |

---

## 工具使用

### 1. Codex CLI

> **完整参数见** `references/cli-examples.md`，以下为常用速查。
> **官方文档** https://developers.openai.com/codex/cli — Codex 会持续升级，行为以官方为准。

调用方式：

```bash
CODEX_BIN=$(command -v codex || true)
[ -n "$CODEX_BIN" ] || { echo "Codex CLI not found. npm i -g @openai/codex"; exit 1; }
OUTPUT_FILE="/tmp/codex-$(date +%s).txt"

$CODEX_BIN exec \
  -C <工作目录> \
  -s read-only \
  --skip-git-repo-check \
  -o "$OUTPUT_FILE" \
  "<prompt>"

cat "$OUTPUT_FILE"
```

关键参数：

| 参数 | 用途 |
|------|------|
| `-C <DIR>` | 工作目录，必须指定 |
| `-s read-only` | 只读沙盒（默认） |
| `-s workspace-write` | 允许 Codex 写文件（需告知用户） |
| `--add-dir <PATH>` | 额外授权写入目录（比 danger-full-access 更安全） |
| `--skip-git-repo-check` | 非 git 目录也能运行 |
| `-o <FILE>` | 将最后一条消息写入文件（避免终端颜色码干扰） |
| `--ephemeral` | 不持久化会话 |
| `-m <MODEL>` | 指定模型（GPT-5.4, GPT-5.3-Codex 等） |
| `--search` | 启用 web 搜索 |
| `--full-auto` | 等价于 `-a on-request -s workspace-write` |

恢复 / 分叉会话：

```bash
# 恢复会话
$CODEX_BIN exec resume --last -o "$OUTPUT_FILE" "<继续的 prompt>"
$CODEX_BIN exec resume <SESSION_ID> -o "$OUTPUT_FILE" "<prompt>"

# 分叉会话（从某次会话分支出新线程）
$CODEX_BIN fork --last
$CODEX_BIN fork <SESSION_ID>
```

**Prompt 独立性原则（重要）：**
- Probe / Challenge 第一轮：不传 Claude 的答案，只传原始问题 + 客观证据
- Follow-up：补充原始证据回应 Codex 追问，仍不传 Claude 结论
- 禁止传入：Claude 的推理过程、定性结论、倾向性措辞

### 2. sync-skill.sh

每次修改 `SKILL.md` 后必须执行，将文件同步到本地 skill 安装路径（即 reload）：

```bash
bash scripts/sync-skill.sh
# 效果：复制 ./SKILL.md → ~/.claude/skills/codex-buddy/SKILL.md
```

### 3. git 工作流

```bash
# 每轮迭代完成后
git add -A
git commit -m "feat: v<版本号> - <主题关键词> (Claude+Codex 第N轮迭代)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
git push
```

提交规范：
- `feat:` 改进 SKILL.md 内容
- `docs:` 改进文档（README、CLAUDE.md、discussions 等）
- `iter:` cron 自动触发的迭代提交

### 4. 30 分钟迭代 Cron（session-only）

Cron 在 Claude Code 会话中运行，退出后消失。每轮自动执行完整迭代流程（见下方）。

重建 cron 时告诉 Claude："帮我重启 codex-buddy 的 30 分钟迭代 cron"，它会读取 CLAUDE.md 中的迭代流程规范并按此设置。

---

## 项目反馈与跨会话记忆（从 SKILL.md 下放）

### 项目反馈

若出现 `unresolved`、高风险漏触发、或重要偏差，必须三选一落地：
`incident` / `eval` / `discussion`，并写明原因。

### 跨会话记忆

只在满足以下条件时存入 memory（memory 只存稳定规则，不替代项目记录）：
- 同类错误重复出现（≥2 次）
- 单次代价很高（不可逆后果）
- 规则可泛化（跨项目通用）

---

## 迭代流程（每轮标准步骤）

### Step 0：启动检查（必须，见 CLAUDE.md）

按 CLAUDE.md 的启动顺序执行：读 STATUS.md → 运行 verify-repo.sh → verify 失败进 triage，verify 通过继续。

### Step 1：自主选题（双模型方向决策）

**Phase 1A — Claude 独立排序：**
读 `STATUS.work_queue`（仅 status: open 的条目）+ `SKILL.md`，独立列出 top 3 候选 id，每项写：选它的理由 + 如果不选的风险。

**Phase 1B — Codex 独立排序（Probe，不传 Claude 的排序结果）：**

    CODEX_BIN=$(command -v codex)
    OUTPUT_FILE="/tmp/codex-direction-$(date +%s).txt"
    REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

    $CODEX_BIN exec \
      -C "$REPO_DIR" \
      -s read-only \
      --skip-git-repo-check \
      -o "$OUTPUT_FILE" \
      "[任务] 从以下 work_queue 中选出最高价值的 top 3 改进项，给出 id 排序和理由
    [约束] 排序标准：failure severity > validation value > autonomy gain > reversibility > effort
    [证据]
    $(cat STATUS.md)
    $(cat SKILL.md)"

    cat "$OUTPUT_FILE"

**Phase 1C — 综合，写入 STATUS.md：**

| 情况 | 行为 |
|------|------|
| 两边 top 1 id 相同 | 写入 `selected_item: W-xxx` |
| top 1 不同但有共同 id | 选共同 id 中优先级最高者 |
| 完全分歧（无共同 id） | `human_gate: REQUIRED:selection_conflict`，停止本轮 |

**过渡期（Phase 1B 未就绪时）：** Phase 1B 可跳过，Phase 1A 单独决定，`selection_rationale` 标注 `[transition-mode]`。

### Step 1.5：改动前必答三问（不能跳过）

在 Step 2 开始前，必须明确回答：

1. **这个改动让 skill 更容易用，还是更复杂？** 只有"更容易"或"同等复杂但更准确"才继续。
2. **一个真实 Claude 在真实对话中会 follow 这条新规则吗？** 如果不确定，不加。
3. **如果 Codex 的输出不完全符合新规范，用户还能从中提取有用信息吗？** 如果不能，这条规则是脆的，不加。

三问有任何一个答案是"不"→ 重新考虑主题，或缩小改动范围。

**自主模式下：** 三问由 AI 自答，答案必须写入本轮 discussion 文件（不能只停留在对话上下文）。任一问答"否" → 写 `last_round_outcome: NO_OP`，停止本轮，不执行改动。

### Step 2：Claude 独立分析

针对该主题，Claude 先给出具体方案（写清楚 SKILL.md 应改哪里、怎么改）。**不要先看 Codex 的答案。**

### Step 3：Codex 独立分析

不传 Claude 的方案，调用 Codex：

```bash
CODEX_BIN=$(command -v codex)
TIMESTAMP=$(date +%Y%m%d-%H%M)
OUTPUT_FILE="/tmp/codex-iter-${TIMESTAMP}.txt"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"  # 或直接使用项目路径

$CODEX_BIN exec \
  -C "$REPO_DIR" \
  -s read-only \
  --skip-git-repo-check \
  -o "$OUTPUT_FILE" \
  "你是 codex-buddy skill 的协作设计者。

当前 SKILL.md 内容：
$(cat SKILL.md)

本轮主题：<主题>

请给出：
1. 针对这个主题，SKILL.md 具体应该改什么（改动前/改动后对比）
2. 这个改动可能引入的新问题
3. 你对当前 skill 最大设计缺陷的独立判断（不限于本轮主题）"

cat "$OUTPUT_FILE"
```

### Step 4：综合两个视角

对比 Claude 和 Codex 的方案：
- 共识点 → 直接采纳
- 分歧点 → 选择并说明理由
- Codex 独立发现的新问题 → 优先考虑纳入

### Step 5：更新文件

```bash
# 1. 修改 SKILL.md（用 Edit 工具）

# 2. 同步到 skill 路径
bash scripts/sync-skill.sh

# 3. Reload 验证（必须，不得跳过）
bash scripts/verify-install.sh

# 4. 写讨论记录（见下方格式规范）
# 文件名：discussions/YYYY-MM-DD-<topic-slug>.md

# 5. 更新 CHANGELOG.md（追加新版本，更新 Agenda 状态）

# 6. 更新 STATUS.md（skill_version + next_safe_step）
```

### Step 6：提交推送

```bash
git add -A
git commit -m "feat: v<版本> - <主题> (Claude+Codex 第N轮迭代)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
git push
```

---

## discussions/ 格式规范

文件名：`YYYY-MM-DD-<topic-slug>.md`

必须包含以下结构（参考已有文件）：

```markdown
# 讨论：<主题>

**日期：** | **协议：** Probe/Follow-up/Challenge | **结果：** 收敛/分歧

---

## 话题
<问题背景>

---

## 第一轮：各自开场

**Claude：**
> <Claude 的独立观点原文>

**Codex：**
> <Codex 的原始输出>

---

## 第N轮：<轮次描述>
...

---

## 共识与分歧

| 点 | Claude | Codex | 结论 |
|----|--------|-------|------|
...

---

## 对 SKILL.md 的改动
<具体改了什么>

---

## 独立性验证（每轮必填，不得省略）

- [ ] Codex 在 Claude 给出方案后才被调用（Step 2 先于 Step 3）
- **Codex 发现了 Claude 没有提出的什么：** [具体写；如果本轮 no-op，写"本轮 no-op，理由：XXX"]
- **Claude 因为 Codex 的输出改变了什么：** [具体写，或写"未改变，理由：XXX"]
- **本轮对话是否真实有效：** [Codex 回应是否包含 Claude 没想到的角度？如果 Codex 输出只是复述 Claude 的方案，标注为"低效对话"]
```

**关键要求：**
- Codex 原始输出必须完整保留，不可裁剪或意译
- 独立性验证节是判断本轮对话是否有价值的唯一标准
- **允许 no-op**：如果本轮 Codex 调用没有新发现，在"Codex 发现了什么"写 `本轮 no-op，理由：[具体理由]`。不需要编造增量发现

---

## 修改 SKILL.md 的禁区

不能破坏：
- 对话协议（Probe / Follow-up / Challenge）和升级流程
- 传递原则：不传 Claude 的推理过程和倾向性措辞
- description 的触发机制（description 是唯一触发入口）

不能做：
- 增加"规范层"而不验证实际可执行性
- 让 SKILL.md 超过 150 行（超过说明在加用不到的东西）

---

## 安全边界

- `SKILL.md` 里不写绝对路径，用 `$(command -v codex)` 代替硬编码
- `scripts/` 里不写私有绝对路径，用 `$HOME` 或相对路径
- 不提交私有环境信息、token、用户名
- `discussions/` 里的 Codex 原始输出不可删改
- 冲突时优先级：`SKILL.md` > `STATUS.md` > `CLAUDE.md` > `CHANGELOG.md`
