# Contributing to codex-buddy

欢迎贡献！本项目接受以下类型的 PR：

## 可以贡献什么

- **改进 SKILL.md**：触发条件、模式设计、prompt 模板
- **新增 discussions/**：分享你用 codex-buddy 发现的有趣分歧案例
- **改进 evals/evals.json**：新增触发判断测试用例
- **改进 references/cli-examples.md**：更好的实际用法示例
- **文档改进**：安装说明、使用示例

## 改动 SKILL.md 的要求

1. 在 PR 描述中说明改动动机
2. 如果是基于某次 Claude+Codex 讨论产生的改动，在 `discussions/` 附上讨论记录
3. 同步更新 `CHANGELOG.md`（追加版本记录）
4. 不要破坏对话协议（Probe / Follow-up / Challenge）和升级流程

## 提交规范

```
feat: <简短描述>      # 新功能或改进
fix: <简短描述>       # 修复问题
docs: <简短描述>      # 文档改动
iter: <简短描述>      # Claude+Codex 协作迭代（自动提交格式）
```

## 开发环境

见 [`docs/WORKFLOW.md`](./docs/WORKFLOW.md) 了解本地迭代流程和开发机制。
