---
name: load
description: >
  Load session handoff context from previous session.
  Trigger on: /nana:load, 'load handoff', 'restore session', '恢复会话', '加载上下文', '恢复上下文'.
---

# nana:load

从 `.claude/handoff.md` 恢复上一个会话的上下文。

## 执行步骤

### 1. 检测重复加载

读取 `.claude/handoff.loaded` 文件，获取上次已加载的 save_id。再读取 `.claude/handoff.md` 中的 `save_id` 字段，若两者一致则表示本次会话已加载过：

```
⚠ 本次会话已加载过 handoff（save_id: <id>）
  若需要重新加载，请执行 /nana:load --force
```
停止执行，除非用户传入 `--force` 参数。若 `.claude/handoff.loaded` 不存在或 save_id 不一致，继续执行。

### 2. 读取 handoff 文件

用 Read 工具读取 `.claude/handoff.md`。

若文件不存在：
```
✗ 未找到 .claude/handoff.md
  请先在旧会话执行 /nana:save
```
停止执行。

### 3. 3 层恢复协议

解析 handoff 内容，按以下三层结构输出：

---

**[Recovered facts]** — 已确认信息，直接作为上下文使用

- 任务目标：<当前目标>
- 已完成：<已完成列表>
- 关键文件：<关键文件列表>
- 保存时间：<created_at>，分支：<branch>

---

**[Open work]** — 未完成项，继续推进

- <未完成列表>
- 下一步：<下一步列表>

---

**[Need revalidation]** ⚠ — **在继续任何工作前，必须先确认这些项**

> 以下内容来自上次会话，当前状态未知。继续工作前必须重新验证，不得直接继承为已知事实。

- <待验证列表>
- 风险提示：<风险列表>

---

### 4. 写入哨兵文件并确认

将本次加载的 save_id 写入 `.claude/handoff.loaded`（覆盖）：

```bash
echo "<save_id>" > .claude/handoff.loaded
```

输出：
```
✓ 上下文已恢复（save_id: <id>）

⚠ 注意：[Need revalidation] 中的项目必须在继续工作前重新确认。
```
