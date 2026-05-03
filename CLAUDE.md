# CLAUDE.md

> AI 代理入口。本仓库是 nanafox-skills 插件市场。

---

## 仓库目标

维护并分发 buddy 系列 skills —— 跨模型验证协作的 Claude Code 插件集合。

**当前 skills：**
- `codex-buddy` — Claude 与 Codex/Kimi 跨模型验证（`--buddy-model kimi` 按需切换）

**外部文档参考：**
- Kimi CLI: https://moonshotai.github.io/kimi-cli/ · [GitHub](https://github.com/MoonshotAI/kimi-cli)
- Agent Skills 规范: https://agentskills.io/home

---

## 仓库结构

```
skills/                           ← 插件市场根目录
├── .claude-plugin/marketplace.json
├── skills/
│   └── codex-buddy/              ← 各 skill 独立目录
│       ├── .claude-plugin/plugin.json  ← 插件元数据（安装必需）
│       ├── SKILL.md              ← skill 主体（运行时）
│       ├── references/           ← CLI 示例等参考文档（运行时）
│       ├── docs/                 ← 开发文档（WORKFLOW.md 等，开发资产）
│       ├── scripts/              ← 同步/校验脚本（verify-repo + verify-install）
│       ├── discussions/          ← 讨论记录（开发资产）
│       ├── evals/                ← 触发测试（开发资产）
│       ├── STATUS.md             ← 该 skill 状态
│       └── CHANGELOG.md          ← 该 skill 变更历史
└── README.md
```

---

## 治理规则

### 根级（marketplace）
- marketplace.json 的 plugins/skills 路径必须与实际目录一致
- 新增 skill 必须同时更新 marketplace.json 和 README.md

### Skill 级（各 skill 独立治理）
- 每个 skill 目录有自己的 STATUS.md、CHANGELOG.md
- 每个 skill 目录必须含 `.claude-plugin/plugin.json`（name 与 marketplace.json 一致）
- SKILL.md 体积 < 150 行
- description 是唯一触发入口，body 不重复触发条件
- 修改 SKILL.md 后必须做 reload 验证

### 发布验证
- push 前运行 `bash scripts/verify-repo.sh`（根级入口，当前转调 `skills/codex-buddy/scripts/verify-repo.sh`），全部 PASSED 才可 push
- 发布新版本后必须从零环境验证：`/plugin marketplace add nana-fox/skills` → `/plugin install codex-buddy@nanafox-skills` → 确认只注册一个 skill、无 Plugin Errors

---

## 硬性约束

- `discussions/` 里的原始输出不可裁剪或删改
- 对话协议（Probe / Follow-up / Challenge）和升级流程不可破坏
- 传递原则：不传 Claude 的推理过程和倾向性措辞
