#!/usr/bin/env bash
# =============================================================================
# Upstream Sync 回滚脚本 (prod / staging 通用, 默认 prod)
# 验证: 2026-06-11 在 staging 实测通过 —— Time Travel 干净还原破坏性 migration
#
# 关键教训: wrangler d1 export 的备份只有 CREATE TABLE(无 DROP), 直接 --file
#   重放到迁移后的库会冲突, 且不清除新表(users/sessions/proxies)。
#   => 数据回滚主路径用 Time Travel(D1 原生时间点恢复, 处理破坏性 migration),
#      export 备份仅作离线归档/第二保险。
#
# 用法:
#   bash ROLLBACK-upstream-sync-0611.sh prod    <迁移前RFC3339时间戳>
#   bash ROLLBACK-upstream-sync-0611.sh staging <迁移前RFC3339时间戳>
#   bash ROLLBACK-upstream-sync-0611.sh prod --code-only
# 迁移前时间戳: 看部署脚本 STEP 1 备份开始的时间, 取它之前 30 秒
# =============================================================================
set -euo pipefail

TARGET="${1:-}"
ARG2="${2:-}"

case "$TARGET" in
  prod)    ENV_FLAG="";               DB_NAME="copilot-db" ;;
  staging) ENV_FLAG="--env staging";  DB_NAME="copilot-db-staging" ;;
  *) echo "FATAL: 第一个参数必须是 prod 或 staging"; exit 1 ;;
esac

test -f wrangler.jsonc || { echo "FATAL: 当前目录无 wrangler.jsonc"; exit 1; }
command -v wrangler >/dev/null 2>&1 || { echo "FATAL: wrangler 不在 PATH"; exit 1; }

echo "=== STEP A: 代码回滚 ($TARGET Workers 上一版本) ==="
# shellcheck disable=SC2086
wrangler rollback $ENV_FLAG --message "rollback upstream-sync-0611 ($TARGET)" || \
  echo "WARN: rollback 失败/取消. 手动: wrangler deployments list $ENV_FLAG"

if [ "$ARG2" = "--code-only" ]; then
  echo "✅ 仅代码回滚完成 ($TARGET)."
  echo "⚠️ 若 migration 已跑, DB 仍是新 schema. 需数据回滚则重跑带时间戳。"
  exit 0
fi

TS_BEFORE="$ARG2"
test -n "$TS_BEFORE" || { echo "FATAL: 缺迁移前时间戳。用法: bash $0 $TARGET <RFC3339时间戳>"; exit 1; }

echo "=== STEP B: 数据回滚 —— Time Travel 还原到迁移前 ==="
echo "目标时间点: $TS_BEFORE"
# 先查该时间点对应的 bookmark
# shellcheck disable=SC2086
BOOKMARK=$(wrangler d1 time-travel info "$DB_NAME" $ENV_FLAG --timestamp "$TS_BEFORE" 2>&1 \
  | grep -oE "bookmark '[0-9a-f-]+'" | grep -oE "[0-9a-f-]{20,}" | head -1)
test -n "$BOOKMARK" || { echo "FATAL: 取不到 $TS_BEFORE 对应 bookmark(超出30天?时间戳错?)"; exit 1; }
echo "对应 bookmark: $BOOKMARK"
echo "⚠️ 这会覆盖 $DB_NAME 全部数据到该时间点。10 秒后开始, Ctrl-C 取消..."
sleep 10
# shellcheck disable=SC2086
wrangler d1 time-travel restore "$DB_NAME" $ENV_FLAG --bookmark="$BOOKMARK"

echo "=== STEP B-验证: 确认回到迁移前 ==="
# shellcheck disable=SC2086
wrangler d1 execute "$DB_NAME" $ENV_FLAG --remote --command \
  "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 2;"
# shellcheck disable=SC2086
wrangler d1 execute "$DB_NAME" $ENV_FLAG --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' AND name='users';"
echo "  (users 表为空结果 = 已回到迁移前; 有结果 = 仍是新 schema, 检查时间戳)"

echo "=== ✅ 回滚完成 ($TARGET, 代码 + 数据) ==="
cat <<NOTE

--- 第二保险: export 备份(离线) ---
若 Time Travel 不可用(>30天), 用部署脚本 STEP1 导出的 .sql:
  1. 手动 DROP 当前所有表 (export 备份不含 DROP)
  2. wrangler d1 execute $DB_NAME $ENV_FLAG --remote --file <备份.sql>
--- 撤销本次回滚 ---
restore 后 wrangler 会打印 "undo" bookmark, 可再 restore 回去。
NOTE
