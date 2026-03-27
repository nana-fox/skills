# codex-buddy

> Claude-Codex cross-model verification skill.

单一 AI 模型最危险的失效模式不是"不知道"，而是**系统性地、流畅地把错误合理化**。
codex-buddy 通过引入 Codex 作为独立审计者，打破 Claude 的闭环自洽。

**核心原则：两模型一致 ≠ 正确。真值来自执行验证，不来自模型共识。**

---

## 安装

### 方式一：通过插件市场安装（推荐）

```bash
# 在 Claude Code 中执行
/plugin marketplace add ddnio/skills
/plugin install buddy-skills@buddy-skills
```

### 方式二：手动安装

**前置条件**

```bash
# 安装 Codex CLI
npm install -g @openai/codex
codex --version
```

**Claude Code**

```bash
git clone https://github.com/ddnio/skills.git
cd skills

# 推荐：符号链接（git pull 后自动生效）
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skills/codex-buddy" ~/.claude/skills/codex-buddy

# 或：脚本同步（更新时需重新运行）
bash skills/codex-buddy/scripts/sync-skill.sh
```

**Codex CLI**

```bash
# 符号链接
mkdir -p ~/.codex/skills
ln -s "$(pwd)/skills/codex-buddy" ~/.codex/skills/codex-buddy

# 或：脚本同步
bash skills/codex-buddy/scripts/sync-skill.sh --host codex
```

**其他环境**

将以下运行时文件复制到宿主的 skills 路径下：

```
codex-buddy/
├── SKILL.md
└── references/
    └── cli-examples.md
```

### 验证安装

```bash
# 检查 Codex CLI
codex --version

# 验证 skill 安装状态
bash skills/codex-buddy/scripts/verify-install.sh            # Claude Code
bash skills/codex-buddy/scripts/verify-install.sh --host codex  # Codex CLI
```

> 已打开的会话需重启后才能加载新 skill。

### 更新

```bash
# 插件市场安装：自动更新
# 手动安装（符号链接方式）：
cd skills && git pull
# 手动安装（脚本同步方式）：重新运行 sync-skill.sh
```

---

## 使用

安装后，skill 在每次对话开始时自动加载，建立会话级验证政策。**加载 ≠ 自动调用 Codex**，而是让 Claude 每个回合判断是否需要跨模型验证。

### 验证级别（V0–V3）

每个回合，Claude 会在回复开头标注验证级别：

| 级别 | 场景 | 动作 |
|------|------|------|
| V0 | 低风险/机械任务 | 不调 Codex |
| V1 | 文档/源码可核对的事实 | 可选核对，跳过标 `[未验证]` |
| V2 | 需要独立第二判断的决策 | 必须先验证再给结论 |
| V3 | 破坏性/不可逆操作 | 必须人工/外部验证 |

### 对话协议

需要调用 Codex 时，对话按以下协议自然流转：

```
Probe（默认首步）— 不传 Claude 结论，两模型独立回答，综合共识与分歧
  ↓ Codex 有疑问或信息不足
Follow-up — 补充原始证据回应 Codex 追问，仍不传 Claude 结论
  ↓ 有具体分歧且可被证据裁决
Challenge — 针对编号 claim (C1/C2/...) 提出反证，不重写整篇答案
```

**裁决规则：** 分歧可验证 → 直接验证，不辩论。无法验证 → 标 `[unresolved]`，交给用户。最多 2 次 Codex 调用，未收敛就停。

详细 CLI 用法见 [`references/cli-examples.md`](./references/cli-examples.md)。

---

## 设计哲学

- **受控异质性**：不同训练路径产生真正不同的视角
- **证据打包**：传原始证据，不传 Claude 的推理过程和倾向性措辞，避免锚定效应
- **渐进升级**：Probe → Follow-up → Challenge 是按需升级路径，不是平行选择
- **真值来源**：运行代码 > 查文档 > 模型共识

设计演进过程见 [`discussions/`](./discussions/)。

---

## 目录结构

```
codex-buddy/
├── SKILL.md              # skill 主体（运行时，AI 读取此文件）
├── references/
│   └── cli-examples.md   # 完整 Codex CLI 用法示例（运行时）
├── docs/
│   └── WORKFLOW.md       # 开发者迭代流程手册（开发资产）
├── scripts/
│   ├── sync-skill.sh     # 同步到本地 skill 路径（支持 --host）
│   ├── verify-repo.sh    # 仓库健康检查（CI 友好，不依赖本地环境）
│   └── verify-install.sh # 本地安装状态检查（支持 --host）
├── discussions/          # Claude+Codex 协作讨论记录（开发资产）
├── evals/
│   └── evals.json        # 触发判断测试用例（开发资产）
├── STATUS.md             # 该 skill 状态快照
└── CHANGELOG.md          # 版本变更记录
```

---

## Contributing

见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
