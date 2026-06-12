#!/usr/bin/env bash
# =============================================================================
# STAGING 演练 —— Upstream Sync 部署脚本 (copilot-staging)
# 目的: 在 staging 把 备份->migration->deploy->验证 完整跑一遍, 验证流程可行
#       再上 prod。0028 破坏性 migration 在 staging 也会 DROP+重建 api_keys。
# 规则: set -euo pipefail, 失败即停, 全程原子, 不手动逐条。
# 注意: staging 的 deploy/migrate 必须显式 --env staging + staging db name,
#       不能用 pnpm run deploy(那个写死 prod)。
# 用法: 在 worktree 根目录(已 merge upstream)执行:
#   bash STAGING-DRILL-upstream-sync-0611.sh
# =============================================================================
set -euo pipefail

ENVV="staging"
DB_NAME="copilot-db-staging"
DB_ID="fd6eef68-ddee-402d-adbf-3b525418fa64"
WORKER="copilot-staging"
TS="$(date -u +%Y%m%d-%H%M%SZ)"
BACKUP_DIR="$HOME/d1-backups"
BACKUP_FILE="${BACKUP_DIR}/${DB_NAME}-PRE-sync-${TS}.sql"

echo "=== STEP 0: 前置检查 (staging) ==="
command -v wrangler >/dev/null 2>&1 || { echo "FATAL: wrangler 不在 PATH"; exit 1; }
test -f wrangler.jsonc || { echo "FATAL: 当前目录无 wrangler.jsonc"; exit 1; }
mkdir -p "$BACKUP_DIR"
echo "ENV=$ENVV DB=$DB_NAME WORKER=$WORKER  backup -> $BACKUP_FILE"

echo "=== STEP 1: 备份 staging D1 (export --remote) ==="
wrangler d1 export "$DB_NAME" --env "$ENVV" --remote --output "$BACKUP_FILE"

echo "=== STEP 2: 验证备份非空 ==="
test -s "$BACKUP_FILE" || { echo "FATAL: 备份为空"; exit 1; }
BYTES=$(wc -c < "$BACKUP_FILE")
echo "OK: 备份 ${BYTES} 字节"
grep -qiE "CREATE TABLE.*api_keys" "$BACKUP_FILE" || echo "WARN: 备份里没找到 api_keys 表(staging 可能数据少, 不阻断演练)"

echo "=== STEP 2b: 记录 Time Travel 时间点(回滚锚点) ==="
# time-travel 本身只作用于 remote, 不接受 --remote flag
# 记录"现在"= 迁移前的时间点, 回滚时用 --timestamp 这个值即可
MIGRATE_BEFORE_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "迁移前时间点(回滚用): $MIGRATE_BEFORE_TS" | tee "${BACKUP_DIR}/${DB_NAME}-timetravel-${TS}.txt"
wrangler d1 time-travel info "$DB_NAME" --env "$ENVV" | tee -a "${BACKUP_DIR}/${DB_NAME}-timetravel-${TS}.txt" || echo "WARN: time-travel info 取不到"
sleep 2  # 留出时间间隔, 确保 migration 在此时间点之后

echo "=== STEP 3: 跑 migration (staging remote, 0018->0030) ==="
# staging DB 在 env.staging 下, 必须 --env staging 才能解析
wrangler d1 migrations apply "$DB_NAME" --env "$ENVV" --remote

echo "=== STEP 4: deploy (build:web + wrangler deploy --env staging) ==="
pnpm run build:web
wrangler deploy --env "$ENVV"

echo "=== STEP 5: 验证表结构 + 数据保留 ==="
wrangler d1 execute "$DB_NAME" --env "$ENVV" --remote --command "SELECT id, username, is_admin FROM users WHERE id=1;"
wrangler d1 execute "$DB_NAME" --env "$ENVV" --remote --command "SELECT COUNT(*) AS api_key_count FROM api_keys;"
wrangler d1 execute "$DB_NAME" --env "$ENVV" --remote --command "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 4;"

echo "=== ✅ STAGING 演练完成. 备份: $BACKUP_FILE ==="
echo "    回滚演练: bash STAGING-ROLLBACK-upstream-sync-0611.sh '$BACKUP_FILE'"
