#!/bin/bash
# 将 skill 运行时资产同步到本地 Claude Code skill 路径
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_DST="$HOME/.claude/skills/codex-buddy"

mkdir -p "$SKILL_DST"
cp "$SKILL_DIR/SKILL.md" "$SKILL_DST/"
cp -R "$SKILL_DIR/references" "$SKILL_DST/"
echo "[sync-skill] Synced: $SKILL_DIR -> $SKILL_DST (SKILL.md + references/)"
