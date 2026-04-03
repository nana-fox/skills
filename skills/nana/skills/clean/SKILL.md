---
name: clean
description: >
  Clean up nana session handoff logs.
  Trigger on: /nana:clean, 'clean handoff logs', '清理接力日志', '清理 nana 日志'.
---

# nana:clean

清理 `~/.claude/session-handoff/<slug>/logs.jsonl` 中的历史记录。

## 执行步骤

### 1. 解析参数

支持以下参数：
- `--before <YYYY-MM-DD>`：删除该日期之前的记录
- `--keep <N>`：只保留最新 N 条记录
- 无参数：显示当前日志统计后等待用户确认操作

### 2. 无参数时：显示统计

获取 project-slug（同 save 逻辑：从 git remote URL 提取 owner_repo），读取 `~/.claude/session-handoff/<slug>/logs.jsonl`。

输出：
```
当前项目日志（<slug>）：
  总条数：<N>
  最早：<date>
  最新：<date>
  文件大小：<size>

用法：
  /nana:clean --keep 20           保留最新 20 条
  /nana:clean --before 2026-01-01  删除该日期前的记录
```

### 3. 有参数时：执行清理

用 Bash 读取 JSONL，按条件过滤，写回文件。操作前显示预览并等待确认：

```
将删除 <M> 条记录，保留 <N> 条。确认继续？(y/N)
```

等待用户确认后执行。

### 4. 完成输出

```
✓ 清理完成：删除 <M> 条，剩余 <N> 条
```
