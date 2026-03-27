# W-012: Codex CLI 前置检查（未安装用户体验）

**日期**: 2026-03-27
**参与**: Claude + Codex (SESSION_ID: 019d2ce9-2807-7da3-a39f-0720fd3f988b)

## 背景

用户指出：未安装 codex CLI 的用户使用 codex-buddy skill 时，没有任何检测或提示，调用会直接报错。

## Probe 阶段

**Claude 独立判断**: 在 SKILL.md 行为层加首次调用前检测。
**Codex 独立判断**: SKILL.md + cli-examples.md 双层处理。

### Codex Claims
- C1: 处理层面选"SKILL.md + 示例守卫"，不靠脚本做运行时修复
- C2: 提示文案短、指向 README，不在 skill 里复制安装命令
- C3: 区分"未安装"和"版本过旧"按能力检测，不硬编码 semver
- C4: cli-examples.md 的 `which codex` 改成守卫式写法（独立发现）
- C5: 不要把安装信息塞进 description frontmatter

### 共识
全部一致，无分歧。Codex 方案更完整（补了 cli-examples.md 守卫）。

## 落地

1. SKILL.md 注意事项第 5 条：前置检查规则（+1 行，134→135）
2. cli-examples.md：`which codex` → 守卫式 `command -v codex` + 错误提示（+1 行）
