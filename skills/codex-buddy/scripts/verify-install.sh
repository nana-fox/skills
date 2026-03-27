#!/bin/bash
# verify-install.sh — codex-buddy 本地安装状态检查
#
# 用途：验证本地安装的 skill 文件与仓库一致
# 与 verify-repo.sh 分离：repo 检查不依赖本地环境，install 检查不影响 CI
#
# 用法：
#   bash scripts/verify-install.sh              # 检查 Claude Code 路径
#   bash scripts/verify-install.sh --host codex  # 检查 Codex CLI 路径

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
HOST="claude"

# 解析参数
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    *) echo "Usage: $0 [--host claude|codex]"; exit 1 ;;
  esac
done

# 确定安装路径
case "$HOST" in
  claude) INSTALL_DIR="$HOME/.claude/skills/codex-buddy" ;;
  codex)  INSTALL_DIR="$HOME/.codex/skills/codex-buddy" ;;
  *)      echo "Unknown host: $HOST (use claude or codex)"; exit 1 ;;
esac

SYNC_CMD="bash scripts/sync-skill.sh --host $HOST"

fail() { echo "  ✗ $1"; FAIL=1; }
pass() { echo "  ✓ $1"; }

echo "=== verify-install.sh (host: $HOST) ==="
echo "skill_dir: $SKILL_DIR"
echo "install_dir: $INSTALL_DIR"
echo ""

# ── 1. 安装目录存在性 ──────────────────────────────────────────
echo "── 安装目录 ──"
if [ -L "$INSTALL_DIR" ] || [ -d "$INSTALL_DIR" ]; then
  pass "安装目录存在: $INSTALL_DIR"
else
  fail "安装目录不存在: $INSTALL_DIR"
  echo ""
  echo "❌ 未安装 — 运行: $SYNC_CMD"
  exit 1
fi
echo ""

# ── 2. 符号链接检查（如果是 symlink 安装）──────────────────────
echo "── 安装方式 ──"
if [ -L "$INSTALL_DIR" ]; then
  LINK_TARGET=$(readlink "$INSTALL_DIR")
  echo "  (符号链接安装: $INSTALL_DIR -> $LINK_TARGET)"
  # 解析绝对路径检查目标存在性
  if [ -d "$INSTALL_DIR" ]; then
    pass "符号链接目标可达"
  else
    fail "符号链接目标不可达: $LINK_TARGET"
  fi
  # symlink 安装不需要文件级 diff，直接通过
  echo ""
  if [ "$FAIL" -eq 0 ]; then
    echo "✅ PASSED — 安装状态健康 (host: $HOST, symlink)"
    exit 0
  else
    echo "❌ FAILED — 符号链接异常"
    exit 1
  fi
elif [ -L "$INSTALL_DIR/SKILL.md" ]; then
  echo "  (文件级符号链接安装)"
  pass "检测到文件级符号链接"
else
  echo "  (复制安装)"
fi
echo ""

# ── 3. SKILL.md 一致性 ─────────────────────────────────────────
echo "── SKILL.md 一致性 ──"
if [ -f "$INSTALL_DIR/SKILL.md" ]; then
  if diff -q "$SKILL_DIR/SKILL.md" "$INSTALL_DIR/SKILL.md" > /dev/null 2>&1; then
    pass "SKILL.md 一致"
  else
    fail "SKILL.md 不一致 → 运行: $SYNC_CMD"
  fi
else
  fail "SKILL.md 不存在"
fi
echo ""

# ── 4. references/ 一致性 ──────────────────────────────────────
echo "── references/ 一致性 ──"
if [ -d "$INSTALL_DIR/references" ]; then
  for f in "$SKILL_DIR"/references/*.md; do
    [ -f "$f" ] || continue
    BASENAME=$(basename "$f")
    if [ -f "$INSTALL_DIR/references/$BASENAME" ]; then
      if diff -q "$f" "$INSTALL_DIR/references/$BASENAME" > /dev/null 2>&1; then
        pass "references/$BASENAME 一致"
      else
        fail "references/$BASENAME 不一致"
      fi
    else
      fail "references/$BASENAME 缺失"
    fi
  done

  # 检查安装目录中是否有多余文件（源已删除但安装副本残留）
  for f in "$INSTALL_DIR"/references/*.md; do
    [ -f "$f" ] || continue
    BASENAME=$(basename "$f")
    if [ ! -f "$SKILL_DIR/references/$BASENAME" ]; then
      fail "references/$BASENAME 是残留文件（源已删除）"
    fi
  done
else
  fail "references/ 目录缺失"
fi
echo ""

# ── 最终结果 ─────────────────────────────────────────────────
if [ "$FAIL" -eq 0 ]; then
  echo "✅ PASSED — 安装状态健康 (host: $HOST)"
  exit 0
else
  echo "❌ FAILED — 安装状态异常"
  echo "   → 运行: $SYNC_CMD"
  exit 1
fi
