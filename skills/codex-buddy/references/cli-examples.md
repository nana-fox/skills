# Codex CLI 完整示例

> **文档来源：** https://developers.openai.com/codex/cli — Codex CLI 会持续升级，参数和行为以官方文档为准。

## 常用参数速查

### 全局参数（所有命令通用）

| 参数 | 说明 |
|------|------|
| `-C, --cd <DIR>` | 工作目录（推荐总是指定） |
| `-s, --sandbox read-only` | 只读沙盒（默认，推荐） |
| `-s workspace-write` | 可写工作区（Codex 可修改文件） |
| `-s danger-full-access` | 无沙盒（危险，慎用） |
| `--add-dir <PATH>` | 额外授权写入目录（比 danger-full-access 更安全的替代方案） |
| `--skip-git-repo-check` | 允许在非 Git 目录运行 |
| `-m, --model <MODEL>` | 指定模型（可选 GPT-5.4, GPT-5.3-Codex 等，以当前可用为准） |
| `-p, --profile <NAME>` | 加载 config.toml 中的配置 profile |
| `-a, --ask-for-approval` | 审批模式：`untrusted`（默认）/ `on-request` / `never` |
| `--full-auto` | 低摩擦自动模式（等价于 `-a on-request -s workspace-write`） |
| `-i, --image <PATH>` | 附加图片文件到初始 prompt |
| `--search` | 启用实时 web 搜索 |
| `--oss` | 使用本地开源模型（需 Ollama） |

### exec 专用参数

| 参数 | 说明 |
|------|------|
| `-o <FILE>` | 将最后一条消息写入文件（避免解析终端颜色码） |
| `--ephemeral` | 不持久化会话文件 |
| `--json` | 输出 JSONL 格式（适合程序解析） |
| `--color` | 控制 ANSI 颜色输出（always / never / auto） |
| `--output-schema <PATH>` | 用 JSON Schema 校验最终响应 |

---

## Probe — 独立初判（默认首步）

不传 Claude 结论，让 Codex 独立回答。

```bash
CODEX_BIN="$(command -v codex || true)"
[ -n "$CODEX_BIN" ] || { echo "Codex CLI not found. See README install section."; exit 1; }
PROJECT_DIR="/your/project/path"
OUTPUT_FILE="/tmp/codex-probe-$(date +%s).txt"

$CODEX_BIN exec \
  -C "$PROJECT_DIR" \
  -s read-only \
  --skip-git-repo-check \
  -o "$OUTPUT_FILE" \
  "[任务] <一句话描述要判断什么>
[证据] <代码片段 / 原始报错 / 命令输出>
[omissions] <没传但可能影响判断的上下文；无写 none>

给出独立结论，标出：最不确定的地方、关键假设、建议验证什么。"

# SESSION_ID：从 codex exec 启动日志的 "session id:" 行提取
# 仅单一活跃会话时，后续 Follow-up/Challenge 可直接用 --last 替代 SESSION_ID

cat "$OUTPUT_FILE"
```

Claude 同时独立作答，完成后综合两个视角：标出共识、分歧、采用哪个及原因。

---

## Follow-up — 双向追问（按需）

Codex 回复中包含疑问或信息不足时，补充原始证据回应。

```bash
# 使用 Probe 时记录的 SESSION_ID
$CODEX_BIN exec resume "$SESSION_ID" \
  -o /tmp/codex-followup-$(date +%s).txt \
  "你问到了 <Codex 的具体问题>。补充证据如下：

[证据] <原始代码/日志/命令输出>
[omissions] none

基于补充信息更新你的判断。"

# 仅在确认只有单一活跃会话时可用 --last 替代 SESSION_ID
```

注意：Follow-up 仍然不传 Claude 的结论或倾向。

---

## Challenge — 定点争议（按需）

有具体分歧时，只针对编号 claim 提出反证，不重写整篇答案。

```bash
$CODEX_BIN exec resume "$SESSION_ID" \
  -o /tmp/codex-challenge-$(date +%s).txt \
  "关于你的 C2（<Codex 的具体主张>），有以下反证：

[证据] <代码/文档/命令输出>

请针对 C2 更新判断。其他 claims 不变则不需要重复。"
```

---

## 执行验证（workspace-write）

需要 Codex 真正跑命令验证时（benchmark、测试），改用 workspace-write：

```bash
$CODEX_BIN exec \
  -C "$PROJECT_DIR" \
  -s workspace-write \
  --skip-git-repo-check \
  -o /tmp/codex-verify.txt \
  "请运行项目的测试套件，然后告诉我哪些测试失败了以及失败原因"
```

⚠️ workspace-write 允许 Codex 修改文件，使用前告知用户。

---

## 恢复会话

```bash
# 恢复指定会话（exec 模式）
$CODEX_BIN exec resume <SESSION_ID> \
  -o /tmp/codex-resume.txt \
  "你的提示"

# 恢复最近一次（仅单一活跃会话时）
$CODEX_BIN exec resume --last \
  -o /tmp/codex-resume.txt \
  "你的提示"

# 恢复指定会话（交互模式）
$CODEX_BIN resume <SESSION_ID>

# 分叉（fork）会话：从某次会话分支出新线程
$CODEX_BIN fork <SESSION_ID>
$CODEX_BIN fork --last
```

---

## 其他实用命令（参考，本项目主要使用 exec）

```bash
# 认证管理 — 首次使用或 token 过期时
$CODEX_BIN login                    # 通过 ChatGPT 账号或 API key 认证
$CODEX_BIN login --with-api-key     # 直接用 API key
$CODEX_BIN login status             # 查看认证状态
$CODEX_BIN logout                   # 清除凭据

# MCP 服务器管理 — 给 Codex 接入外部工具时
$CODEX_BIN mcp add <name> -- <command>   # 注册 MCP 服务器
$CODEX_BIN mcp list                      # 列出已注册的 MCP
$CODEX_BIN mcp remove <name>             # 移除 MCP

# Feature flags — 启用/禁用实验特性
$CODEX_BIN features list             # 查看可用特性
$CODEX_BIN features enable <flag>    # 启用
$CODEX_BIN features disable <flag>   # 禁用

# Cloud 任务 — 远程执行（需要环境配置，本项目暂未使用）
$CODEX_BIN cloud exec --env <ENV> "任务描述"
$CODEX_BIN cloud list --limit 10
$CODEX_BIN apply <TASK_ID>           # 应用 Cloud 任务的 diff 到本地

# 沙盒测试 — 验证沙盒策略行为
$CODEX_BIN sandbox <command>         # 在沙盒策略下执行命令
```
