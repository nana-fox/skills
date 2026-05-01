# codex-buddy

> Cross-model verification skill with pluggable buddy providers.

单一 AI 模型最危险的失效模式不是"不知道"，而是**系统性地、流畅地把错误合理化**。
codex-buddy 通过引入独立 buddy provider（默认 Codex，也可切换 Kimi）作为第二判断者，打破主 Agent 的闭环自洽。

**核心原则：两模型一致 ≠ 正确。真值来自执行验证，不来自模型共识。**

---

## 安装

### 方式一：通过插件市场安装（推荐）

```bash
# 在 Claude Code 中执行
/plugin marketplace add nana-fox/skills
/plugin install codex-buddy@nanafox-skills
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
git clone https://github.com/nana-fox/skills.git
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

## 当前架构

优化后的运行链路是“主 Agent 决策 + provider registry 调度 + 审计历史落盘”：

```
Main Agent
  ├─ 判定 V-level / floor rules
  ├─ 打包原始 evidence（stdin）
  └─ buddy-runtime.mjs
       ├─ 共享流程：load evidence / session log / envelope / JSON output
       └─ providers.mjs:getProvider(...).startTurn(...)
            ├─ codex provider
            │    ├─ broker（默认）：常驻 codex app-server，复用 thread
            │    ├─ app-server：官方事件协议
            │    └─ exec：legacy / fallback，保留 output file
            └─ kimi provider
                 ├─ wire（默认）：kimi --wire，JSON-RPC events/actions
                 └─ exec（fallback）：kimi --quiet -p，legacy final message
```

关键边界：

- `buddy-runtime.mjs` 只处理公共编排：证据读取、审计日志、输出 envelope、错误收敛。
- `providers.mjs` 是扩展点：每个 provider 暴露 `preflight()`、`startTurn()`、`capabilities`。
- Codex broker/app-server 使用事件协议返回 `provider_event`；Kimi 默认使用 Wire JSON-RPC 事件，也被归一化为同一套 provider event。
- `~/.buddy/sessions/<sid>.jsonl` 是审计/回放历史，不是 Agent 间实时通信通道。
- 输入默认走 stdin；只有 Codex exec fallback 仍使用临时 output file，因为 Codex CLI 需要 `-o` 输出文件。

Provider 能力：

| Provider | Transport | Thread/Resume | 说明 |
|----------|-----------|---------------|------|
| Codex | `broker` / `app-server` / `exec` | broker thread / exec resume | 默认 provider，broker 启动失败自动 fallback exec |
| Kimi | `wire` / `exec` | Wire session metadata / exec 暂不支持 | 默认 `kimi --wire`；exec 只作 legacy fallback；非 0 exit 或空输出 fail-closed |

新增 provider 时不要在 runtime 里加分支；实现 provider contract 并注册到 `providers.mjs`。

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
├── .claude-plugin/
│   └── plugin.json       # 插件元数据（marketplace 安装必需）
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
