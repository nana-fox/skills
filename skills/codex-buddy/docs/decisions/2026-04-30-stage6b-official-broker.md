# Stage6b: 官方 broker 实现替换

**日期：** 2026-04-30
**分支：** feat/ux-stage1
**commit：** b421277

---

## 背景

stage6a 对齐了基座路径，但 `buddy-broker-process.mjs` 仍是自研实现，使用旧的 `turn/run`（同步包装），没有流式输出，且 auth token 问题会在长时间 broker 存活后出现。

用户指令：**"底层协议尽量按照官方的实现，不行就直接拷贝源码"**

---

## 问题根因

```
旧链路（W8 自研）:
  Claude → buddy-broker.mjs(sendCommand turn/run)
         → buddy-broker-process.mjs(turn/run handler)
           → runTurn() → turn/start + 等 turn/completed
           → 一次性返回 { finalMessage, threadId }
  ❌ 用户看不到任何中间输出（黑盒等待 30-80s）

官方链路：
  Claude → buddy-broker.mjs(runBrokerTurn → turn/start)
         → buddy-broker-process.mjs(官方 app-server-broker.mjs)
           → routeNotification → 实时转发 item/completed
  ✅ 每条 agentMessage 实时出现在 stderr
```

---

## 实施内容

### 直接复制官方文件

| 文件 | 来源 |
|------|------|
| `scripts/lib/app-server.mjs` | `openai/codex-plugin-cc/plugins/codex/scripts/lib/app-server.mjs` |
| `scripts/lib/args.mjs` | `openai/codex-plugin-cc/plugins/codex/scripts/lib/args.mjs` |
| `scripts/lib/broker-endpoint.mjs` | `openai/codex-plugin-cc/plugins/codex/scripts/lib/broker-endpoint.mjs` |
| `scripts/buddy-broker-process.mjs` | `openai/codex-plugin-cc/plugins/codex/scripts/app-server-broker.mjs` |

### 适配改动（最小化）

1. `app-server.mjs`：
   - `broker-lifecycle.mjs` → `broker-lifecycle-stub.mjs`（disableBroker:true，不调用）
   - `terminateProcessTree` → `this.proc.kill("SIGTERM")`（去掉 process.mjs 依赖）
   - 加 `BUDDY_BROKER_CODEX_BIN` env 支持（测试注入 stub）

2. `buddy-broker-process.mjs`：
   - 加 lazy connect（`ensureAppClient()`）：broker 先启动，codex app-server 在第一次 request 才 spawn

3. `buddy-broker.mjs`：
   - 新增 `runBrokerTurn()`：实现 `initialize → thread/start → turn/start → streaming notifications → turn/completed`
   - 实时 stderr：`[buddy] Codex > <agent message preview>...`

4. `buddy-runtime.mjs`：
   - 用 `runBrokerTurn` 替代 `brokerSendCommand(turn/run)`

### 测试更新

- `buddy-broker.test.mjs` W8 suite：`sendCommand(turn/run)` → `runBrokerTurn()`
- `spawn → ping → shutdown` → `spawn → initialize → shutdown`（官方不支持 `ping` 方法）
- 删除 `status` 测试（官方不支持 `status` 方法）

---

## 验证

- **112/112 测试通过**（-1 因删除 status 测试）
- **broker 手动验证**：`node buddy-broker-process.mjs serve --endpoint unix:/tmp/test.sock --cwd /tmp` → socket 1s 内建立 ✅
- **verify-repo.sh：PASSED**
- **sync 到 `~/.claude/skills/codex-buddy`：done**

---

## 用户可见变化

**以前：**
```
[buddy] probe started, runtime=broker, sid=..., ETA 30-80s
████████████████████░░░░░░░░░░  (黑盒 65s)
{完整结果}
```

**现在：**
```
[buddy] probe started, runtime=broker, sid=..., ETA 30-80s
[buddy] Codex > Reading the diff, I see three areas of concern...
[buddy] Codex > First, the broker lifecycle is correct but...
[buddy] probe completed in 65432ms, verdict=caution
{完整结果}
```

---

## 无 Codex probe 记录

本次改动是直接技术决策（复制官方实现），没有经过 Codex review 流程——改动本身就是"对齐官方"，无需独立审查。
