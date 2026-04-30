#!/bin/bash
# verify-repo.sh — codex-buddy 仓库健康检查
#
# 用途：每轮迭代前运行，检测已知失败模式
# 失败时：打印所有问题后以退出码 1 退出（= 进入 triage 模式，不是终止迭代）
# 成功时：退出码 0

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
FAIL=0

fail() { echo "  ✗ $1"; FAIL=1; }
pass() { echo "  ✓ $1"; }

echo "=== verify-repo.sh ==="
echo "skill_dir: $SKILL_DIR"
echo "repo_root: $REPO_ROOT"
echo ""

# ── 1. 关键文件存在性 ────────────────────────────────────────
echo "── 关键文件（skill 级）──"
for f in \
  SKILL.md \
  CHANGELOG.md \
  CONTRIBUTING.md \
  README.md \
  STATUS.md \
  references/cli-examples.md \
  docs/WORKFLOW.md \
  scripts/sync-skill.sh \
  scripts/verify-repo.sh \
  scripts/verify-install.sh \
  hooks/hooks.json \
  hooks/run-hook.cmd \
  hooks/session-start; do
  if [ -f "$SKILL_DIR/$f" ]; then
    pass "$f"
  else
    fail "$f MISSING"
  fi
done

echo "── 关键文件（仓库级）──"
for f in \
  CLAUDE.md \
  README.md \
  .claude-plugin/marketplace.json; do
  if [ -f "$REPO_ROOT/$f" ]; then
    pass "(root) $f"
  else
    fail "(root) $f MISSING"
  fi
done
echo ""

# ── 2. SKILL.md 结构チェック ─────────────────────────────────
echo "── SKILL.md 结构 ──"
SKILL="$SKILL_DIR/SKILL.md"
SKILL_LINES=$(wc -l < "$SKILL")

if [ "$SKILL_LINES" -lt 150 ]; then
  pass "SKILL.md 行数 ${SKILL_LINES} < 150"
else
  fail "SKILL.md 行数 ${SKILL_LINES} >= 150（规范上限）"
fi

# frontmatter
if head -5 "$SKILL" | grep -q "name: codex-buddy"; then
  pass "SKILL.md frontmatter 含 name: codex-buddy"
else
  fail "SKILL.md frontmatter 缺少 name: codex-buddy"
fi

# 关键段落各出现至少一次
for section in "Probe" "Follow-up" "Challenge" "证据打包" "停止规则"; do
  count=$(grep -c "$section" "$SKILL" 2>/dev/null || true)
  if [ "$count" -ge 1 ]; then
    pass "SKILL.md 含段落 '$section'"
  else
    fail "SKILL.md 缺少段落 '$section'"
  fi
done
echo ""

# ── 3. 已知失效引用检查 ──────────────────────────────────────
echo "── 失效引用 ──"

# CONTRIBUTING.md: docs/automation.md 不存在
if grep -q "docs/automation\.md" "$SKILL_DIR/CONTRIBUTING.md" 2>/dev/null; then
  fail "CONTRIBUTING.md 引用了不存在的 docs/automation.md"
else
  pass "CONTRIBUTING.md: 无 docs/automation.md 引用"
fi

# CLAUDE.md: evals/trigger-evals.json 不存在（正确文件是 evals/evals.json）
if grep -q "trigger-evals\.json" "$REPO_ROOT/CLAUDE.md" 2>/dev/null; then
  fail "CLAUDE.md 引用了不存在的 evals/trigger-evals.json（正确: evals/evals.json）"
else
  pass "CLAUDE.md: 无 trigger-evals.json 引用"
fi

# SKILL.md 引用 references/cli-examples.md
if grep -q "references/cli-examples\.md" "$SKILL" 2>/dev/null; then
  if [ -f "$SKILL_DIR/references/cli-examples.md" ]; then
    pass "SKILL.md 引用的 references/cli-examples.md 存在"
  else
    fail "SKILL.md 引用了不存在的 references/cli-examples.md"
  fi
fi
echo ""

# ── 4. 可移植性：scripts/ 不含私有绝对路径 ──────────────────
echo "── 可移植性 ──"
if grep -qn "/Users/" "$SKILL_DIR/scripts/sync-skill.sh" 2>/dev/null; then
  fail "scripts/sync-skill.sh 含硬编码绝对路径 /Users/..."
else
  pass "scripts/sync-skill.sh: 无硬编码绝对路径"
fi
echo ""

# ── 5. Git diff 预览（SKILL.md 和控制文件） ──────────────────
echo "── 近期改动预览 ──"
TRACKED_CHANGES=$(git -C "$REPO_ROOT" diff --name-only -- "skills/codex-buddy/SKILL.md" "CLAUDE.md" "skills/codex-buddy/STATUS.md" "skills/codex-buddy/docs/WORKFLOW.md" 2>/dev/null)
if [ -z "$TRACKED_CHANGES" ]; then
  echo "  (SKILL.md 等核心文件无未提交改动)"
else
  echo "  已修改: $TRACKED_CHANGES"
  git -C "$REPO_ROOT" diff --stat -- "skills/codex-buddy/SKILL.md" "CLAUDE.md" "skills/codex-buddy/STATUS.md" "skills/codex-buddy/docs/WORKFLOW.md" 2>/dev/null
fi
echo ""

# ── 6. CHANGELOG 引用完整性 ────────────────────────────────────
echo "── CHANGELOG 引用完整性 ──"
while IFS= read -r f; do
  if [ -f "$SKILL_DIR/$f" ]; then
    pass "引用存在: $f"
  else
    fail "CHANGELOG 引用了不存在的文件: $f"
  fi
done < <(grep -oE 'discussions/[a-z0-9_-]+\.md' "$SKILL_DIR/CHANGELOG.md" | sort -u)
echo ""

# ── 7. evals.json id 连续性 ───────────────────────────────────
echo "── evals.json id 连续性 ──"
if command -v jq &>/dev/null; then
  MAX=$(jq '[.evals[].id] | max' "$SKILL_DIR/evals/evals.json")
  COUNT=$(jq '.evals | length' "$SKILL_DIR/evals/evals.json")
  if [ "$MAX" = "$COUNT" ]; then
    pass "evals.json id 连续 (1..$COUNT)"
  else
    fail "evals.json id 不连续: max=$MAX, count=$COUNT"
  fi
else
  pass "evals.json id 检查跳过（jq 不可用）"
fi
echo ""

# ── 8. STATUS 状态机一致性 ──────────────────────────────────────
echo "── STATUS 状态机一致性 ──"
STATUS_FILE="$SKILL_DIR/STATUS.md"

# 提取 selected_item 的值（跳过注释行）
SELECTED=$(sed -n '/^## selected_item/,/^## /{ /^#/d; /^$/d; /^<!--/d; p; }' "$STATUS_FILE" | head -1 | tr -d '[:space:]')

if [ -n "$SELECTED" ] && [ "$SELECTED" != "NONE" ]; then
  # 检查 selected_item 对应的 status
  ITEM_STATUS=$(grep -A10 "id: $SELECTED" "$STATUS_FILE" | grep "status:" | head -1 | awk '{print $2}')
  if [ "$ITEM_STATUS" = "done" ]; then
    fail "selected_item ($SELECTED) 指向已完成的工作项（状态漂移）"
  elif [ "$ITEM_STATUS" = "open" ]; then
    pass "selected_item ($SELECTED) 指向 open 工作项"
  elif [ -z "$ITEM_STATUS" ]; then
    fail "selected_item ($SELECTED) 在 work_queue 中不存在"
  else
    pass "selected_item ($SELECTED) 状态: $ITEM_STATUS"
  fi
else
  pass "selected_item 为 NONE（无选中项）"
fi

# 检查 human_gate 与 operating_mode 一致性
HUMAN_GATE=$(sed -n '/^## human_gate/,/^## /{ /^#/d; /^$/d; /^<!--/d; p; }' "$STATUS_FILE" | head -1 | tr -d '[:space:]')
OP_MODE=$(sed -n '/^## operating_mode/,/^## /{ /^#/d; /^$/d; /^<!--/d; p; }' "$STATUS_FILE" | head -1 | tr -d '[:space:]')

if [ -n "$HUMAN_GATE" ] && [ "$HUMAN_GATE" != "NONE" ] && [ "$OP_MODE" != "BLOCKED" ]; then
  fail "human_gate=$HUMAN_GATE 但 operating_mode=$OP_MODE（应为 BLOCKED）"
elif [ "$HUMAN_GATE" = "NONE" ] || [ -z "$HUMAN_GATE" ]; then
  pass "human_gate 与 operating_mode 一致"
else
  pass "human_gate=$HUMAN_GATE, operating_mode=$OP_MODE 一致"
fi
echo ""

# ── 9. 独立发现落地检查 ───────────────────────────────────────
echo "── 独立发现落地检查 ──"
# CHANGELOG 中"登记为后续改进"或"unresolved"的标记，必须有对应 work_queue 条目或已关闭
UNRESOLVED_COUNT=$(grep -c 'unresolved' "$SKILL_DIR/CHANGELOG.md" 2>/dev/null || true)
DEFERRED_COUNT=$(grep -c '登记为后续改进' "$SKILL_DIR/CHANGELOG.md" 2>/dev/null || true)

DEFERRED_TOTAL=$((DEFERRED_COUNT + UNRESOLVED_COUNT))
if [ "$DEFERRED_TOTAL" -eq 0 ]; then
  pass "CHANGELOG 无未落地的独立发现标记"
else
  # 检查每个"登记为后续改进"是否在 work_queue 或 discussions 中有对应
  ORPHAN=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # 从标记行提取关键词，在 STATUS.md work_queue 中搜索
    KEYWORDS=$(echo "$line" | grep -oP '登记为后续改进' 2>/dev/null || true)
    if [ -n "$KEYWORDS" ]; then
      # 提取标记前的描述文字作为搜索词
      DESC=$(echo "$line" | sed 's/（登记为后续改进）//' | sed 's/.*[：:]//' | tr -d '*' | xargs)
      # 在 work_queue 中搜索（宽松匹配：标题包含关键词的前几个字）
      FIRST_WORDS=$(echo "$DESC" | awk '{print $1}')
      if grep -q "$FIRST_WORDS" "$SKILL_DIR/STATUS.md" 2>/dev/null; then
        pass "独立发现已落地: $DESC"
      else
        fail "CHANGELOG 标记'登记为后续改进'但 work_queue 无对应: $DESC"
        ORPHAN=$((ORPHAN + 1))
      fi
    fi
  done < <(grep '登记为后续改进' "$SKILL_DIR/CHANGELOG.md")

  if [ "$ORPHAN" -eq 0 ] && [ "$UNRESOLVED_COUNT" -eq 0 ]; then
    pass "所有独立发现标记均已落地"
  elif [ "$UNRESOLVED_COUNT" -gt 0 ]; then
    # unresolved 只警告，不阻断（可能是历史记录）
    pass "CHANGELOG 含 $UNRESOLVED_COUNT 处 unresolved 标记（仅供参考）"
  fi
fi
echo ""

# ── 10. done_when 主观词汇检查 ───────────────────────────────
echo "── done_when 主观词汇检查 ──"
if grep -q "done_when" "$SKILL_DIR/STATUS.md"; then
  if grep -A1 "done_when" "$SKILL_DIR/STATUS.md" | grep -qE 'AI 判断|感觉|认为|满意|觉得'; then
    fail "STATUS.md 的 done_when 包含主观词汇（AI 判断/感觉/认为/满意/觉得）"
  else
    pass "done_when 无主观词汇"
  fi
else
  pass "done_when 检查跳过（STATUS.md 中无 done_when 字段）"
fi
echo ""

# ── 11. marketplace.json 一致性 ──────────────────────────────
echo "── marketplace.json 一致性 ──"
MARKETPLACE="$REPO_ROOT/.claude-plugin/marketplace.json"
if [ -f "$MARKETPLACE" ]; then
  if command -v jq &>/dev/null; then
    SOURCE=$(jq -r '.plugins[0].source' "$MARKETPLACE")
    MARKETPLACE_NAME=$(jq -r '.plugins[0].name' "$MARKETPLACE")

    # source 路径存在
    if [ -d "$REPO_ROOT/$SOURCE" ]; then
      pass "marketplace source 路径存在: $SOURCE"
    else
      fail "marketplace source 路径不存在: $SOURCE"
    fi

    # SKILL.md 存在
    if [ -f "$REPO_ROOT/$SOURCE/SKILL.md" ]; then
      pass "marketplace source 目录含 SKILL.md"
    else
      fail "marketplace source 目录缺少 SKILL.md"
    fi

    # plugin.json 存在
    PLUGIN_JSON="$REPO_ROOT/$SOURCE/.claude-plugin/plugin.json"
    if [ -f "$PLUGIN_JSON" ]; then
      pass "plugin.json 存在: $SOURCE/.claude-plugin/plugin.json"

      # plugin.json name 与 marketplace.json name 一致
      PLUGIN_NAME=$(jq -r '.name' "$PLUGIN_JSON")
      if [ "$PLUGIN_NAME" = "$MARKETPLACE_NAME" ]; then
        pass "plugin.json name ($PLUGIN_NAME) 与 marketplace.json 一致"
      else
        fail "plugin.json name ($PLUGIN_NAME) ≠ marketplace.json name ($MARKETPLACE_NAME)"
      fi
    else
      fail "缺少 plugin.json: $SOURCE/.claude-plugin/plugin.json（安装后会导致重复注册）"
    fi

    # marketplace entry 不能含 skills 字段（与 plugin.json 冲突）
    HAS_SKILLS=$(jq -r '.plugins[0] | has("skills")' "$MARKETPLACE")
    if [ "$HAS_SKILLS" = "true" ]; then
      fail "marketplace entry 含 skills 字段（会与 plugin.json 冲突导致 Plugin Errors）"
    else
      pass "marketplace entry 无 skills 字段冲突"
    fi
  else
    pass "marketplace.json 检查跳过（jq 不可用）"
  fi
fi
echo ""

# ── 12. v3 Runtime 文件存在性 ─────────────────────────────────
echo "── v3 Runtime 文件 ──"
V3_FILES=(
  "scripts/buddy-runtime.mjs"
  "scripts/lib/codex-adapter.mjs"
  "scripts/lib/local-evidence.mjs"
  "scripts/lib/gate.mjs"
  "scripts/lib/envelope.mjs"
  "scripts/lib/audit.mjs"
  "scripts/lib/annotations.mjs"
  "schemas/envelope.schema.json"
  "schemas/audit-row-v2.schema.json"
)
for f in "${V3_FILES[@]}"; do
  if [ -f "$SKILL_DIR/$f" ]; then
    pass "$f"
  else
    fail "$f MISSING"
  fi
done

# schema files are valid JSON
for schema_file in envelope.schema.json audit-row-v2.schema.json; do
  if [ -f "$SKILL_DIR/schemas/$schema_file" ]; then
    if command -v node &>/dev/null && node -e "JSON.parse(require('fs').readFileSync('$SKILL_DIR/schemas/$schema_file','utf8'))" 2>/dev/null; then
      pass "$schema_file is valid JSON"
    else
      fail "$schema_file is not valid JSON"
    fi
  fi
done
echo ""

# ── 最终结果 ─────────────────────────────────────────────────
if [ "$FAIL" -eq 0 ]; then
  echo "✅ PASSED — 仓库健康，可以继续迭代"
  exit 0
else
  echo "❌ FAILED — 发现问题，进入 triage 模式"
  echo "   → 下一步：读 STATUS.md，修复上方列出的 ✗ 项，再重新运行 verify-repo.sh"
  echo "   → verify 失败 = triage，不是终止迭代"
  exit 1
fi
