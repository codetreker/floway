#!/usr/bin/env bash
# =============================================================================
# STAGING 回滚演练 —— Upstream Sync (copilot-staging)
# 验证回滚脚本在 staging 真能跑通, 再信任它用于 prod。
# 用法:
#   bash STAGING-ROLLBACK-upstream-sync-0611.sh <备份sql路径>   # 代码+数据
#   bash STAGING-ROLLBACK-upstream-sync-0611.sh --code-only     # 仅代码
# =============================================================================
set -euo pipefail

ENVV="staging"
DB_NAME="copilot-db-staging"
WORKER="copilot-staging"
MODE="${1:-}"

test -f wrangler.jsonc || { echo "FATAL: 当前目录无 wrangler.jsonc"; exit 1; }
command -v wrangler >/dev/null 2>&1 || { echo "FATAL: wrangler 不在 PATH"; exit 1; }

echo "=== STEP A: 代码回滚 (staging Workers 上一版本) ==="
wrangler rollback --env "$ENVV" --message "rollback staging upstream-sync-0611" || \
  echo "WARN: rollback 失败/取消. 手动: wrangler deployments list --env staging"

if [ "$MODE" = "--code-only" ]; then
  echo "✅ 仅代码回滚完成 (staging)."
  exit 0
fi

BACKUP_FILE="$MODE"
test -n "$BACKUP_FILE" || { echo "FATAL: 未传备份路径。用法见脚本头"; exit 1; }
test -s "$BACKUP_FILE" || { echo "FATAL: 备份不存在/为空: $BACKUP_FILE"; exit 1; }

echo "=== STEP B: 数据回滚 —— 从备份恢复 (staging) ==="
echo "⚠️ 用备份覆盖 staging 数据。10 秒后开始, Ctrl-C 取消..."
sleep 10
wrangler d1 execute "$DB_NAME" --remote --file "$BACKUP_FILE"

echo "=== STEP B-验证 ==="
wrangler d1 execute "$DB_NAME" --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('api_keys','users');"
wrangler d1 execute "$DB_NAME" --remote --command "SELECT COUNT(*) AS api_key_count FROM api_keys;"

echo "=== ✅ STAGING 回滚演练完成 ==="
cat <<'NOTE'
--- 备选: Time Travel ---
wrangler d1 time-travel info copilot-db-staging --remote
wrangler d1 time-travel restore copilot-db-staging --remote --timestamp <RFC3339>
NOTE
