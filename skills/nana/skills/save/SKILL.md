---
name: save
description: >
  Save current session context as a structured handoff snapshot.
  Trigger on: /nana:save, 'save session', 'save handoff', '保存会话', '保存上下文', '接力保存'.
---

# nana:save

将当前会话上下文保存为结构化 handoff，供新会话恢复使用。

## 执行步骤

### 1. 收集 metadata

运行以下命令收集 metadata（失败项留空，不中断）：

```bash
git branch --show-current 2>/dev/null || echo "unknown"
git remote get-url origin 2>/dev/null || echo "unknown"
basename $(git rev-parse --show-toplevel 2>/dev/null) || basename "$PWD"
date -u +"%Y-%m-%dT%H:%M:%SZ"
```

project-slug 规则：从 git remote URL 提取 `owner_repo`，例：
- `git@github.com:nana-fox/skills.git` → `nana-fox_skills`
- `https://github.com/nana-fox/skills` → `nana-fox_skills`
- 无 remote → 使用目录名

save_id 规则：`<timestamp-seconds>-<random-4chars>`，例：`1743000000-a3f2`

### 2. 生成 handoff 内容

根据当前会话，按以下模板生成（**不得自由发挥字段**）：

```
## metadata
- created_at: <ISO8601>
- branch: <branch>
- task_type: <debug|feature|refactor|other>
- status: <active|blocked|done|abandoned>
- project_root: <绝对路径>
- save_id: <id>

## 当前目标
<一句话描述>

## 已完成
- <item>

## 未完成
- <item>

## 关键文件
- <path>: <一句话说明>

## 待验证
- <item>  ← 这些在 load 时会提升为行为约束

## 下一步
1. <step>

## 风险
- <item>
```

### 3. 写本地 handoff 文件

将完整 handoff 内容写入 `.claude/handoff.md`（覆盖）：

```bash
mkdir -p .claude
```

然后用 Write 工具将 handoff 内容写入 `.claude/handoff.md`。

### 4. 追加全局日志

构造 JSONL 条目（单行 JSON），追加到 `~/.claude/session-handoff/<slug>/logs.jsonl`：

```bash
mkdir -p ~/.claude/session-handoff/<slug>
```

使用 python3 将所有字段编码为合法 JSON，追加到日志文件：

```bash
python3 -c "
import json
entry = {
    'save_id': '$SAVE_ID',
    'created_at': '$CREATED_AT',
    'branch': '$BRANCH',
    'task_type': '$TASK_TYPE',
    'status': '$STATUS',
    'project_root': '$PROJECT_ROOT',
    'slug': '$SLUG',
    'handoff': open('.claude/handoff.md').read()
}
print(json.dumps(entry, ensure_ascii=False))
" >> ~/.claude/session-handoff/$SLUG/logs.jsonl
```

（将上面的变量替换为实际值后执行。）

### 5. 确认输出

输出：
```
✓ Handoff saved
  本地: .claude/handoff.md
  日志: ~/.claude/session-handoff/<slug>/logs.jsonl (<N> 条记录)
  save_id: <id>

可在新会话运行 /nana:load 恢复上下文。
```
