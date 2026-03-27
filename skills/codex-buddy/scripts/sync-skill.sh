#!/bin/bash
# 将项目 SKILL.md 同步到实际 Claude Code skill 路径（实现 reload）
SKILL_SRC="$(cd "$(dirname "$0")/.." && pwd)/SKILL.md"
SKILL_DST="$HOME/.claude/skills/codex-buddy/SKILL.md"

cp "$SKILL_SRC" "$SKILL_DST"
echo "[sync-skill] Synced: $SKILL_SRC -> $SKILL_DST"
