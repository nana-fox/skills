---
name: refine
description: >
  Optimize and clarify a vague or rough prompt before execution.
  Parses user intent, produces a single optimized version with explanation, then asks for confirmation.
  Invoke with: /nana:refine <your rough instruction>
disable-model-invocation: true
argument-hint: <your rough instruction>
---

# nana:refine

将用户的粗糙指令优化为清晰可执行的提示词，确认后再继续。

## 执行步骤

### 1. 接收原始输入

原始输入：`$ARGUMENTS`

若 `$ARGUMENTS` 为空，输出：
```
✗ 请提供需要优化的指令，例如：
  /nana:refine 帮我把登录页改好看点
```
停止执行。

### 2. 解析意图

分析原始输入，识别：
- **目标**：用户想要达成什么
- **约束**：已知的限制或要求（没有则写"未指定"）
- **输出形式**：期望的产出是什么（没有则写"未指定"）
- **模糊点**：哪些信息不明确或缺失

### 3. 判断是否存在高层意图分叉

若存在真实的策略级歧义（如"直接执行"vs"先给方案"、"保守改动"vs"大幅重构"），输出两个方向选项，让用户选择后再生成优化版本。

否则跳过此步，直接进入下一步。

### 4. 输出优化结果

按以下格式展示：

```
原始输入：
  <用户的原始文字>

我理解你的意图是：
  目标：<解析出的目标>
  约束：<约束条件>
  输出形式：<期望产出>

优化后的指令：
  <清晰、具体、可执行的优化版本>

本次优化做了：
  - <改动点1>
  - <改动点2>

回复：
  y = 使用这个版本继续
  e = 我来修改后再执行
  n = 取消，用原始输入
  ? = 解释为什么这样优化
```

### 5. 处理用户回复

- **y**：按优化后的指令继续执行任务
- **e**：提示用户输入修改后的版本，收到后直接执行
- **n**：取消，按原始输入 `$ARGUMENTS` 继续执行
- **?**：逐条解释优化理由，解释完后重新展示确认选项
- **其他**：将用户回复视为对优化版本的补充或修正，整合后重新生成优化版本并展示
