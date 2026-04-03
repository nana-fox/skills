---
name: save
description: >
  Save current session context as a structured handoff snapshot.
  Invoke with: /nana:save
disable-model-invocation: true
---

# nana:save

从当前对话上下文生成结构化 handoff，写入 `.claude/handoff.md`，供新会话恢复使用。

## 执行步骤

### 1. 从对话上下文生成 handoff 内容

直接根据**当前会话中明确出现过的信息**生成以下结构，**不读任何文件，不运行任何命令，不补充猜测**。

规则：
- 只写会影响新 session 接手的内容，忽略低价值历史细节
- 如果信息不确定，明确写"未确认 / 待验证"，不要写成事实
- 如果某项在对话中没有明确出现，写 `- 无`
- `关键文件` 仅列对话里明确提到过的路径，不要推断
- `当前目标` 写"新 session 打开后要继续推进的事项"，不要写成项目总结
- `重要上下文` 优先保留：设计原则、关键约束、已接受 trade-off、当前风险/异常
  （若对话中存在设计原则或使用场景，不得省略）

```
## 当前目标
<一句话，描述新 session 打开后要继续推进的事项>

## 已完成
- <仅列对下一会话有帮助的已完成事项>

## 未完成 / 下一步
- <按优先级列 1-3 条，优先写待验证项/阻塞项>

## 关键文件
- <path>: <仅在对话中明确提到过时才写，否则写 `- 无`>

## 重要上下文
- <设计原则 / 使用场景>
- <关键约束>
- <已接受的 trade-off>
- <待验证风险或异常>
```

### 2. 写入文件

用 Write 工具将内容写入 `.claude/handoff.md`。

### 3. 确认输出

```
✓ 已保存到 .claude/handoff.md
  在新会话运行 /nana:load 恢复上下文
```
