# Codex CLI 完整示例

> **文档来源：** https://developers.openai.com/codex/cli — Codex CLI 会持续升级，参数和行为以官方文档为准。

> **v3 Note:** 在 v3 中，`buddy-runtime.mjs` 自动生成和执行这些命令。Claude 应通过 `--action probe|local|followup|preflight|annotate|metrics` 调用 runtime，而非手搓命令。以下示例记录 runtime 内部行为，供理解和调试参考。

## buddy-runtime 调用速查

`--project-dir` 可省略，runtime 会默认使用当前工作目录；在多 worktree、跨目录调用或审计需要明确归属时仍建议显式传 `--project-dir "$PWD"`。

```bash
# Provider preflight（默认 codex；kimi 默认 Wire，exec 仅作 fallback）
node "<SKILL_DIR>/scripts/buddy-runtime.mjs" --action preflight --buddy-model codex
node "<SKILL_DIR>/scripts/buddy-runtime.mjs" --action preflight --buddy-model kimi

# 默认形式：file-first 传 evidence（推荐给大模型执行，避免裸 stdin 误用）
mkdir -p .omc/state
EVIDENCE_FILE=".omc/state/buddy-evidence-$(date +%s).txt"
cat > "$EVIDENCE_FILE" <<'BUDDY_EVIDENCE_END'
task_to_judge: ...
[证据] ...
[omissions] none
BUDDY_EVIDENCE_END
node "<SKILL_DIR>/scripts/buddy-runtime.mjs" --action probe \
  --evidence "$EVIDENCE_FILE" --project-dir "$PWD"

# stdin 形式：只在同一个命令中明确提供 pipe/heredoc 输入时使用
cat "$EVIDENCE_FILE" | node "<SKILL_DIR>/scripts/buddy-runtime.mjs" --action probe \
  --evidence-stdin --project-dir "$PWD"

# Probe 多轮共享上下文（同一 verification task 内连续追问）
node "<SKILL_DIR>/scripts/buddy-runtime.mjs" --action probe \
  --evidence "$EVIDENCE_FILE" --project-dir "$PWD" --session-policy conversation

# Follow-up（独立动作，与 conversation 互补）
node "<SKILL_DIR>/scripts/buddy-runtime.mjs" --action followup \
  --evidence "$EVIDENCE_FILE" --project-dir "$PWD"

# Annotate（每次 probe 综合后必须）
# 注意：
# - 多次部分 annotate 会按字段累积（先 --probe-found-new true，后 --user-adopted true 都保留）
# - 不传 --verification-task-id 时取该 buddy session 最近一次 probe/followup；并发或多 worktree 共享 buddy session 时建议**显式传 task id**
# - 老 logs.jsonl（pre-v2 / 无 verification_task_id 且无 session-log）无法补 annotate
node "<SKILL_DIR>/scripts/buddy-runtime.mjs" --action annotate \
  --probe-found-new true --user-adopted true \
  --verification-task-id <task-id-from-probe-output>

# Synthesis 也写入会话日志（可选）
echo "$SYNTHESIS_TEXT" | node "<SKILL_DIR>/scripts/buddy-runtime.mjs" \
  --action log-synthesis --content-stdin --verification-task-id <task-id>

# Replay 一次 buddy 会话的事件流
node "<SKILL_DIR>/scripts/buddy-runtime.mjs" --action replay --session-id buddy-xxxxxx
```

**Provider / transport 语义：**
- `--buddy-model codex`（默认）：支持 `broker | app-server | exec`。broker 默认启用，走官方 app-server 事件协议；启动失败会回退 exec；`BUDDY_USE_LEGACY_EXEC=1` 或 `BUDDY_USE_BROKER=0` 可强制 exec。
- `--buddy-model kimi`：默认走 Wire transport（`kimi --wire`，流式 JSON-RPC，有 async timeout + cancel-before-kill）；Wire 失败时自动 fallback 到 exec。**不要直接调用 `kimi --quiet -p "..."`** — 无 timeout 保护，大 prompt 会挂死。详见 [`references/kimi-cli.md`](./kimi-cli.md)。不支持 `--fresh-thread` 或 Codex broker thread。
- `buddy_session_id` 是审计 ID；`codex_session_id` 是 exec resume ID；broker `threadId` 属于 app-server namespace，不写入 exec session pointer。

**输入通道规则：**
- 大模型/自动化默认用 file-first：先写 evidence 文件，再传 `--evidence "$EVIDENCE_FILE"`。
- `--evidence-stdin` 只能和同命令 pipe/heredoc 一起出现；不要把 evidence 写在上一条消息或“想象中的 stdin”里。
- 出现 `stdin is a TTY` 或 `stdin produced empty evidence` 时，修正提示/调用为 file-first，不把失败归咎给用户。

**会话事件日志：** runtime 自动把每次交互写入 `~/.buddy/sessions/<buddy-session-id>.jsonl`：
- `probe.start` / `probe.provider_event` / `probe.provider_output` / `probe.synthesis` / `annotate` / `*.error`
- 每行含 `payload`（默认 redacted）+ `payload_sha256` + `payload_bytes` + `redaction_policy`
- 大于 256KiB 的 payload 转 `payload_ref`（外部文件，路径 `~/.buddy/sessions/<sid>.payloads/`）
- 文件日志只做审计和 replay；agent 间实时交流优先走 provider 协议/CLI stdout，不通过文件轮询。审计写入失败应降级为 warning，不阻塞 probe 主结果。

**敏感信息 / Redaction**：
- 默认 redact 模式覆盖：OpenAI sk-/sk-proj-/sk-svcacct-、Anthropic sk-ant-、GitHub ghp_/gho_/github_pat_、AWS AKIA、Slack xox[abprs]-、Stripe rk_/sk_、JWT、`Authorization: Bearer/Basic/Token`、env-style key=value（api_key/token/password/access_token/refresh_token/client_secret 等）
- 写入 session log 前才 redact；runtime 传给 codex 的 prompt **不脱敏**（脱敏是审计层，不影响推理质量）
- `BUDDY_AUDIT_RAW=1`：写 raw payload 到 session log（仅本地调试用，回归后须 unset）

**App-server 模式与 followup**（`BUDDY_USE_APP_SERVER=1` 时）：
- Phase A 当前实现：app-server probe 拿到的 `threadId`（写入 session log 的 `codex_session_id`）尚未做端到端 e2e 跨协议 resume 验证
- 期待：app-server 产生的 thread 在 ephemeral=false 时会落盘到 `~/.codex/sessions/.../rollout-*.jsonl`，与 exec 模式的 session 文件同形态，理论上 `codex exec resume <thread-id>` 应可接续
- **未验证之前推荐做法**：app-server 模式下需要追问，使用 `--session-policy conversation`（probe 自身复用 thread/resume），不要直接换到 followup（避免 PHA→exec 不兼容的边缘情况）
- Phase B（broker 长持）会把 thread/resume 直接走 app-server 协议，届时跨协议依赖可彻底消除

**Heredoc 边界条件**（用 `cat <<'EOF' | runtime` 传 evidence 时）：
- 若 evidence 内容里独立一行恰好就是 `EOF`，shell 会提前截断 → 用更长且不可能撞的标记，比如 `BUDDY_EVIDENCE_END`
- 用 `<<'XXX'`（带引号）禁用 `$var`/backtick 展开，避免 evidence 里的 `$1`、反引号被 shell 解释
- evidence 含大量 binary/non-UTF8 时考虑 file 形式（`--evidence <path>`）而非 stdin

**Session Policy 选择：**
- `isolated`（默认）— 每次 probe 独立，无上下文，不被前次结论污染
- `conversation` — 同一 buddy session 内自动 resume，保留 Codex 上下文，省启动成本
- 跨 verification task 不要用 conversation；单决策追问用 follow-up，多决策连续探索才用 conversation

## 常用参数速查

### 全局参数（所有命令通用）

> ⚠️ **参数位置重要**：`-a` 和 `-m` 是**顶层参数**，必须放在 `exec` **之前**。错误位置会报错。

| 参数 | 说明 |
|------|------|
| `-a, --ask-for-approval` | 审批模式：`untrusted`（默认）/ `on-request` / `never`。**必须在 `exec` 前** |
| `-m, --model <MODEL>` | 指定模型（**默认不传**；`codex-mini-latest` 更快但推理能力降低） |
| `-C, --cd <DIR>` | 工作目录（推荐总是指定；指向最小子目录可减少 project doc 扫描范围） |
| `-s, --sandbox <MODE>` | 沙盒模式：`read-only`（默认，推荐）/ `workspace-write` / `danger-full-access` |
| `--add-dir <PATH>` | 额外授权写入目录（比 danger-full-access 更安全的替代方案） |
| `--skip-git-repo-check` | 允许在非 Git 目录运行 |
| `-p, --profile <NAME>` | 加载 config.toml 中的配置 profile |
| `--full-auto` | 低摩擦自动模式（等价于 `-a on-request -s workspace-write`） |
| `-i, --image <PATH>` | 附加图片文件到初始 prompt |
| `--search` | 启用实时 web 搜索 |
| `--oss` | 使用本地开源模型（需 Ollama） |

### exec 专用参数

| 参数 | 说明 |
|------|------|
| `-o <FILE>` | 将最后一条消息写入文件（避免解析终端颜色码） |
| `--ephemeral` | 不持久化会话文件（提速，但无法 resume；probe 默认开启） |
| `--json` | 输出 JSONL 格式（适合程序解析） |
| `--color` | 控制 ANSI 颜色输出（always / never / auto） |
| `--output-schema <PATH>` | 用 JSON Schema 校验最终响应 |

### 性能优化组合（probe 场景推荐）

```bash
# 最快 one-shot probe：-a never 在 exec 前，--ephemeral 跳过 session 持久化
codex -a never exec -C "$DIR" -s read-only --ephemeral --skip-git-repo-check \
  -c 'mcp_servers={}' -o "$OUTPUT" "$PROMPT"

# 需要 follow-up 的 probe：去掉 --ephemeral 以保留 session
codex -a never exec -C "$DIR" -s read-only --skip-git-repo-check \
  -c 'mcp_servers={}' -o "$OUTPUT" "$PROMPT"
```

> **证据大小限制**：runtime 自动裁剪超过 12000 字符的 prompt，保留首尾结构。大 prompt 是 Codex 推理变慢的主因。

---

## Probe — 独立初判（默认首步）

不传 Claude 结论，让 Codex 独立回答。

> ⚠️ **默认不传 `--model`**：省略时沿用配置模型或 Codex 推荐默认模型。仅在用户明确要求某具体模型，或需复现特定模型行为时才传。

```bash
CODEX_BIN="$(command -v codex || true)"
[ -n "$CODEX_BIN" ] || { echo "Codex CLI not found. See README install section."; exit 1; }
PROJECT_DIR="/your/project/path"
OUTPUT_FILE="/tmp/codex-probe-$(date +%s).txt"

# -a never 必须在 exec 前（顶层参数）；--ephemeral 跳过 session 持久化
$CODEX_BIN -a never exec \
  -C "$PROJECT_DIR" \
  -s read-only \
  --ephemeral \
  --skip-git-repo-check \
  -c 'mcp_servers={}' \
  -o "$OUTPUT_FILE" \
  "[任务] <一句话描述要判断什么>
[证据] <代码片段 / 原始报错 / 命令输出>
[omissions] <没传但可能影响判断的上下文；无写 none>

给出独立结论，标出：最不确定的地方、关键假设、建议验证什么。"

# --ephemeral 模式下无 SESSION_ID，不支持 follow-up
# 需要 follow-up 时，去掉 --ephemeral 并从 stdout 提取 "session id:" 行

cat "$OUTPUT_FILE"
```

Claude 同时独立作答，完成后综合两个视角：标出共识、分歧、采用哪个及原因。

---

## Follow-up — 双向追问（按需）

Codex 回复中包含疑问或信息不足时，补充原始证据回应。
**前提：** Probe 时未使用 `--ephemeral`，且记录了 SESSION_ID。

```bash
# 使用 Probe 时记录的 SESSION_ID（需非 ephemeral 模式的 probe）
$CODEX_BIN -a never exec resume "$SESSION_ID" \
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
$CODEX_BIN -a never exec resume "$SESSION_ID" \
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
