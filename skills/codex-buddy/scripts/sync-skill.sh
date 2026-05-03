#!/bin/bash
set -e
# 将 skill 运行时资产同步到本地 skill 路径
#
# 用法：
#   bash scripts/sync-skill.sh              # 同步到 Claude Code 路径
#   bash scripts/sync-skill.sh --host codex  # 同步到 Codex CLI 路径

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOST="claude"

# 解析参数
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    *) echo "Usage: $0 [--host claude|codex]"; exit 1 ;;
  esac
done

# 确定目标路径
case "$HOST" in
  claude) SKILL_DST="$HOME/.claude/skills/codex-buddy" ;;
  codex)  SKILL_DST="$HOME/.codex/skills/codex-buddy" ;;
  *)      echo "Unknown host: $HOST (use claude or codex)"; exit 1 ;;
esac

# 如果目标是符号链接，跳过同步（已经指向源）
if [ -L "$SKILL_DST" ]; then
  echo "[sync-skill] $SKILL_DST is a symlink — no sync needed"
  echo "  target: $(readlink "$SKILL_DST")"
  exit 0
fi

mkdir -p "$SKILL_DST/references" "$SKILL_DST/scripts/lib" "$SKILL_DST/schemas" "$SKILL_DST/hooks" "$SKILL_DST/evals"

# 同步运行时文件（rsync --delete 清理已删除文件）
if command -v rsync &>/dev/null; then
  rsync -a --delete "$SKILL_DIR/references/" "$SKILL_DST/references/"
  rsync -a --delete "$SKILL_DIR/scripts/" "$SKILL_DST/scripts/"
  rsync -a --delete "$SKILL_DIR/schemas/" "$SKILL_DST/schemas/"
  rsync -a --delete "$SKILL_DIR/hooks/" "$SKILL_DST/hooks/"
  rsync -a --delete "$SKILL_DIR/evals/" "$SKILL_DST/evals/"
  cp "$SKILL_DIR/SKILL.md" "$SKILL_DST/"
  cp "$SKILL_DIR/STATUS.md" "$SKILL_DST/"
  cp "$SKILL_DIR/CHANGELOG.md" "$SKILL_DST/"
else
  # fallback: 先清空再复制
  rm -rf "$SKILL_DST/references" "$SKILL_DST/scripts" "$SKILL_DST/schemas" "$SKILL_DST/hooks" "$SKILL_DST/evals"
  cp -R "$SKILL_DIR/references" "$SKILL_DST/"
  cp -R "$SKILL_DIR/scripts" "$SKILL_DST/"
  cp -R "$SKILL_DIR/schemas" "$SKILL_DST/"
  cp -R "$SKILL_DIR/hooks" "$SKILL_DST/"
  cp -R "$SKILL_DIR/evals" "$SKILL_DST/"
  cp "$SKILL_DIR/SKILL.md" "$SKILL_DST/"
  cp "$SKILL_DIR/STATUS.md" "$SKILL_DST/"
  cp "$SKILL_DIR/CHANGELOG.md" "$SKILL_DST/"
fi

# hooks 同步到 plugin cache（hooks 由插件系统加载，不在 skills 目录）
if [ "$HOST" = "claude" ]; then
  PLUGIN_CACHE_DIR=$(find "$HOME/.claude/plugins/cache/nanafox-skills/codex-buddy" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -1)
  if [ -n "$PLUGIN_CACHE_DIR" ] && [ -d "$SKILL_DIR/hooks" ]; then
    mkdir -p "$PLUGIN_CACHE_DIR/hooks"
    cp "$SKILL_DIR/hooks/"* "$PLUGIN_CACHE_DIR/hooks/" 2>/dev/null
    chmod +x "$PLUGIN_CACHE_DIR/hooks/session-start" "$PLUGIN_CACHE_DIR/hooks/run-hook.cmd" 2>/dev/null
    echo "[sync-skill] Hooks synced to plugin cache: $PLUGIN_CACHE_DIR/hooks/"
  fi
fi

echo "[sync-skill] Synced: $SKILL_DIR -> $SKILL_DST (host: $HOST)"
echo "  SKILL.md + STATUS.md + CHANGELOG.md + references/ + scripts/ + schemas/ + hooks/ + evals/"
