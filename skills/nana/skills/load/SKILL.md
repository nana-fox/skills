---
name: load
description: >
  Load session handoff context from previous session.
  Invoke with: /nana:load
disable-model-invocation: true
---

# nana:load

从 `.claude/handoff.md` 恢复上一个会话的上下文。

## 执行步骤

### 1. 读取 handoff 文件

用 Read 工具读取 `.claude/handoff.md`。

若文件不存在：
```
✗ 未找到 .claude/handoff.md
  请先在旧会话执行 /nana:save
```
停止执行。

### 2. 呈现上下文，准备继续

将 handoff 内容整合入当前对话，输出：

```
✓ 上下文已恢复

[展示 handoff 内容]

准备继续——有什么需要推进的？
```
