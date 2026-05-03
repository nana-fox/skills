# Kimi CLI Reference

> Runtime reference for codex-buddy's Kimi integration (`--buddy-model kimi`).
> See also: [Kimi CLI official docs](https://moonshotai.github.io/kimi-cli/) · [GitHub](https://github.com/MoonshotAI/kimi-cli)

---

## Quick Start

```bash
# Run Kimi probe (instead of default Codex)
mkdir -p .omc/state
EVIDENCE_FILE=".omc/state/buddy-kimi-evidence-$(date +%s).txt"
cat > "$EVIDENCE_FILE" <<'BUDDY_EVIDENCE_END'
task_to_judge: ...
raw_evidence: ...
known_omissions: none
BUDDY_EVIDENCE_END
node "<SKILL_DIR>/scripts/buddy-runtime.mjs" \
  --action probe --buddy-model kimi --evidence "$EVIDENCE_FILE" --project-dir "$PWD"

# Preflight check (verify Kimi is available)
node "<SKILL_DIR>/scripts/buddy-runtime.mjs" --action preflight --buddy-model kimi

# Default Codex preflight (unchanged)
node "<SKILL_DIR>/scripts/buddy-runtime.mjs" --action preflight
```

### 多行证据传递（file-first 注意事项）

大模型/自动化默认先写 evidence 文件，再用 `--evidence "$EVIDENCE_FILE"`。只有在同一个命令中明确 pipe 文件内容时，才使用 `--evidence-stdin`。

当证据包含多行内容或需要 shell 变量展开时，使用不加引号的 heredoc 分隔符写入文件：

```bash
# 正确：不加引号的 EOF，$() 和变量会展开；probe 使用 file-first
EVIDENCE_FILE=$(mktemp)
cat > "$EVIDENCE_FILE" << EOF
task_to_judge: $(your_task_description)
$(cat /path/to/diff.txt)
known_omissions: none
EOF
node "<SKILL_DIR>/scripts/buddy-runtime.mjs" \
  --action probe --buddy-model kimi --evidence "$EVIDENCE_FILE" --project-dir "$PWD"

# 也可用 stdin，但必须同命令真实 pipe，不允许裸跑 --evidence-stdin
cat "$EVIDENCE_FILE" | node "<SKILL_DIR>/scripts/buddy-runtime.mjs" \
  --action probe --buddy-model kimi --evidence-stdin --project-dir "$PWD"

# 错误：加引号的 'EOF'，$() 不展开，Kimi 收到字面量路径然后试图执行 shell 命令
cat > "$EVIDENCE_FILE" << 'EOF'
$(cat /path/to/diff.txt)   # ← Kimi 看到的是这个字面量，不是内容
EOF
```

---

## How Kimi Is Invoked

buddy-runtime defaults to Wire mode:
```
kimi --wire
```

The runtime sends JSON-RPC over stdio:

| Method | Purpose |
|--------|---------|
| `initialize` | Best-effort handshake; method-not-found is tolerated for compatibility |
| `prompt` | Start a Kimi turn with the evidence prompt |
| `cancel` | Protocol-level cancellation before process kill on timeout |
| `event` | Kimi notifications normalized into `probe.provider_event` rows |
| `request` | Rejected by default in review mode; codex-buddy does not grant tool actions through Kimi |

Tests can override the executable with `BUDDY_KIMI_BIN=/path/to/fake-kimi`.
Set `BUDDY_KIMI_TRANSPORT=exec` to force the legacy path.

---

## Output Format

Primary path: `kimi --wire` streams JSON-RPC events and returns the final prompt
result. buddy-runtime uses the final prompt text as synthesis content and records:

| Field | Value |
|-------|-------|
| `transport` | `wire` |
| `runtime` | `wire` |
| `fallback` | `none` |
| `degraded` | `false` |
| `events_count` | provider events emitted by Wire |
| `verdict` | `GO` / `NO-GO` / `INCONCLUSIVE` after local normalization |
| `review_status` | `passed` / `blocked` / `inconclusive` |

Legacy path: `kimi --quiet -p` prints the final assistant message to stdout.
buddy-runtime treats non-empty stdout as the synthesis content and records
`transport: exec`, `parser_version: kimi-quiet-v1`, and `degraded: true`.

Legacy compatibility: the old `--print` Python-repr parser remains in
`scripts/lib/parsers/kimi-repr-v1.mjs` for fixtures and older integrations. That
format looked like:

```
TurnBegin(user_input='...')
StepBegin(n=1)
ThinkPart(
    type='think',
    think='<reasoning content>',
    encrypted=None
)
TextPart(type='text', text='<final answer>')
StatusUpdate(context_usage=..., token_usage=TokenUsage(...), message_id='...', ...)
TurnEnd()

To resume this session: kimi -r <uuid>
```

**buddy-runtime handling:**
- Wire final prompt text → used as synthesis content (equivalent to Codex final message)
- Wire `event` notifications → written to `~/.buddy/sessions/<sid>.jsonl` as `probe.provider_event`
- Wire timeout / empty final output / permission failure → fail-closed; not a passed review
- Legacy quiet stdout → used as synthesis content when `BUDDY_KIMI_TRANSPORT=exec` or Wire falls back
- Legacy `ThinkPart.think` → written to `~/.buddy/sessions/<sid>.jsonl` as `probe.provider_think` event (audit, not shown in synthesis)
- Legacy `TextPart.text` → used as synthesis content when quiet final output is not available
- Legacy session ID → extracted from resume line, stored in session log

Kimi verdict normalization is intentionally strict. The first non-empty line must
start with `GO`, `NO-GO`, or `INCONCLUSIVE`; otherwise the runtime reports
`verdict: INCONCLUSIVE` and `review_status: inconclusive` while preserving the
raw text in audit history.

---

## Parser Status

Kimi provider parsing is best-effort:

| `parseStatus` | Meaning | Synthesis source |
|--------------|---------|-----------------|
| `ok` | Quiet stdout found, or legacy text extracted | final message / `TextPart.text` |
| `partial` | Legacy text extracted, think missing | `TextPart.text` |
| `failed` | No usable text extracted | raw stdout (fallback) |

`fallback: 'none'` when parseStatus is ok/partial; `fallback: 'raw'` when failed.
Both `parse_status` and `fallback` are written to the audit log row. Exec
transport is always treated as degraded because it is retained only for legacy
compatibility and startup fallback.

---

## Session Resume

Kimi supports session resumption but **resume is not implemented in this version**:
- The legacy session ID can be parsed from `To resume this session: kimi -r <uuid>`
- It is stored in `~/.buddy/sessions/<sid>.jsonl` as `provider_session_id`
- `kimi -r <uuid>` for manual resume if needed

---

## Environment Variables

| Variable | Effect |
|---------|--------|
| `BUDDY_USE_LEGACY_EXEC=1` | Force Codex exec path (does NOT affect Kimi routing) |
| `BUDDY_USE_BROKER=0` | Same as above |
| `BUDDY_KIMI_BIN=/path/to/kimi` | Override Kimi executable; mainly for tests |
| `BUDDY_KIMI_TRANSPORT=exec` | Force legacy Kimi exec path instead of Wire |
| `KIMI_CLI_NO_AUTO_UPDATE=1` | Disabled by default in Wire child process to avoid startup prompts |
| (activation flag) | Use `--buddy-model kimi` arg to activate |

---

## Useful Links

- **Kimi CLI official docs**: https://moonshotai.github.io/kimi-cli/
- **LLM-friendly docs**: https://moonshotai.github.io/kimi-cli/llms.txt
- **GitHub**: https://github.com/MoonshotAI/kimi-cli
- **Agent Skills spec** (context for cross-agent skills): https://agentskills.io/home
