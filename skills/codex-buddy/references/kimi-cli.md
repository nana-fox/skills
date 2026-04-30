# Kimi CLI Reference

> Runtime reference for codex-buddy's Kimi integration (`--buddy-model kimi`).
> See also: [Kimi CLI official docs](https://moonshotai.github.io/kimi-cli/) · [GitHub](https://github.com/MoonshotAI/kimi-cli)

---

## Quick Start

```bash
# Run Kimi probe (instead of default Codex)
echo "$EVIDENCE" | node "<SKILL_DIR>/scripts/buddy-runtime.mjs" \
  --action probe --buddy-model kimi --evidence-stdin --project-dir "$PWD"

# Preflight check (verify Kimi is available)
node "<SKILL_DIR>/scripts/buddy-runtime.mjs" --action preflight --buddy-model kimi

# Default Codex preflight (unchanged)
node "<SKILL_DIR>/scripts/buddy-runtime.mjs" --action preflight
```

### 多行证据传递（heredoc 注意事项）

当证据包含多行内容或需要 shell 变量展开时，使用**不加引号**的 heredoc 分隔符：

```bash
# ✅ 正确：不加引号的 EOF，$() 和变量会展开
EVIDENCE_FILE=$(mktemp)
cat > "$EVIDENCE_FILE" << EOF
task_to_judge: $(your_task_description)
$(cat /path/to/diff.txt)
known_omissions: none
EOF
cat "$EVIDENCE_FILE" | node "<SKILL_DIR>/scripts/buddy-runtime.mjs" \
  --action probe --buddy-model kimi --evidence-stdin --project-dir "$PWD"

# ❌ 错误：加引号的 'EOF'，$() 不展开，Kimi 收到字面量路径然后试图执行 shell 命令
cat > "$EVIDENCE_FILE" << 'EOF'
$(cat /path/to/diff.txt)   # ← Kimi 看到的是这个字面量，不是内容
EOF
```

---

## How Kimi Is Invoked

buddy-runtime spawns:
```
kimi --quiet -p "<evidence+prompt>"
```

| Flag | Purpose |
|------|---------|
| `--quiet` | Non-interactive final-message output; used as the stable synthesis source |
| `-p`      | Prompt text (evidence + task) |

Tests can override the executable with `BUDDY_KIMI_BIN=/path/to/fake-kimi`.

---

## Output Format

Primary path: `kimi --quiet -p` prints the final assistant message to stdout.
buddy-runtime treats non-empty stdout as the synthesis content and records:

| Field | Value |
|-------|-------|
| `parse_status` | `ok` |
| `parser_version` | `kimi-quiet-v1` |
| `fallback` | `none` |

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
- Quiet stdout → used as synthesis content (equivalent to Codex final message)
- Legacy `ThinkPart.think` → written to `~/.buddy/sessions/<sid>.jsonl` as `probe.provider_think` event (audit, not shown in synthesis)
- Legacy `TextPart.text` → used as synthesis content when quiet final output is not available
- Legacy session ID → extracted from resume line, stored in session log

---

## Parser Status

Kimi provider parsing is best-effort:

| `parseStatus` | Meaning | Synthesis source |
|--------------|---------|-----------------|
| `ok` | Quiet stdout found, or legacy text extracted | final message / `TextPart.text` |
| `partial` | Legacy text extracted, think missing | `TextPart.text` |
| `failed` | No usable text extracted | raw stdout (fallback) |

`fallback: 'none'` when parseStatus is ok/partial; `fallback: 'raw'` when failed.
Both `parse_status` and `fallback` are written to the audit log row.

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
| (activation flag) | Use `--buddy-model kimi` arg to activate |

---

## Useful Links

- **Kimi CLI official docs**: https://moonshotai.github.io/kimi-cli/
- **LLM-friendly docs**: https://moonshotai.github.io/kimi-cli/llms.txt
- **GitHub**: https://github.com/MoonshotAI/kimi-cli
- **Agent Skills spec** (context for cross-agent skills): https://agentskills.io/home
