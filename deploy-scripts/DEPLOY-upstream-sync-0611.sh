#!/usr/bin/env bash
# =============================================================================
# Copilot-Gateway / Floway —— Upstream Sync 部署原子脚本
# 同步: upstream/main 7 commits (multi-user #49 + proxy #48 + fixes)
# 危险点: migration 0028 会 DROP+重建 api_keys 表, 0029 重建 2 张遥测表
# 规则: set -euo pipefail, 任何一步失败立即停, 不手动逐条执行
# 用法: 在 deploy 分支(已 merge upstream)的 worktree 根目录执行
#   bash DEPLOY-upstream-sync-0611.sh
# =============================================================================
set -euo pipefail

DB_NAME="copilot-db"
DB_ID="0f5eeb05-be0b-49b2-814a-3712767da571"
TS="$(date -u +%Y%m%d-%H%M%SZ)"
BACKUP_DIR="$HOME/d1-backups"
BACKUP_FILE="${BACKUP_DIR}/${DB_NAME}-PRE-sync-${TS}.sql"

echo "==========================================================="
echo " STEP 0: 前置检查"
echo "==========================================================="
command -v wrangler >/dev/null 2>&1 || { echo "FATAL: wrangler 不在 PATH"; exit 1; }
# 必须在含 wrangler.jsonc 的目录
test -f wrangler.jsonc || { echo "FATAL: 当前目录无 wrangler.jsonc, cd 到 worktree 根目录"; exit 1; }
mkdir -p "$BACKUP_DIR"
echo "DB=$DB_NAME ($DB_ID)  backup -> $BACKUP_FILE"

echo "==========================================================="
echo " STEP 1: 备份 prod D1 (全量 export, --remote)"
echo "==========================================================="
wrangler d1 export "$DB_NAME" --remote --output "$BACKUP_FILE"

echo "==========================================================="
echo " STEP 2: 验证备份非空 (含建表语句 + 体积 > 1KB)"
echo "==========================================================="
test -s "$BACKUP_FILE" || { echo "FATAL: 备份文件为空, 终止"; exit 1; }
BYTES=$(wc -c < "$BACKUP_FILE")
test "$BYTES" -gt 1024 || { echo "FATAL: 备份只有 ${BYTES}B, 太小, 终止"; exit 1; }
grep -qiE "CREATE TABLE.*api_keys" "$BACKUP_FILE" || { echo "FATAL: 备份里没有 api_keys 表定义, 终止"; exit 1; }
echo "OK: 备份 ${BYTES} 字节, 含 api_keys 表定义"

echo "==========================================================="
echo " STEP 2b: 记录 Time Travel 当前时间点 (第二层 rollback 保险)"
echo "==========================================================="
wrangler d1 time-travel info "$DB_NAME" --remote | tee "${BACKUP_DIR}/${DB_NAME}-timetravel-${TS}.txt" || \
  echo "WARN: time-travel info 取不到(不阻断, 已有 export 备份)"

echo "==========================================================="
echo " STEP 3: 跑 migration (remote, 0028/0029/0030)"
echo "==========================================================="
pnpm run db:migrate:remote

echo "==========================================================="
echo " STEP 4: deploy (check-bindings + build:web + wrangler deploy)"
echo "==========================================================="
pnpm run deploy

echo "==========================================================="
echo " STEP 5: 部署后验证表结构 + 数据保留"
echo "==========================================================="
echo "--- users 表存在 + admin(id=1) 在 ---"
wrangler d1 execute "$DB_NAME" --remote --command \
  "SELECT id, username, is_admin FROM users WHERE id=1;"
echo "--- api_keys 重建后行数 (应 = 迁移前 key 数) ---"
wrangler d1 execute "$DB_NAME" --remote --command \
  "SELECT COUNT(*) AS api_key_count FROM api_keys;"
echo "--- migration 记录到 0030 ---"
wrangler d1 execute "$DB_NAME" --remote --command \
  "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 4;"

echo "==========================================================="
echo " ✅ 部署完成. 备份: $BACKUP_FILE"
echo "    如需回滚: bash ROLLBACK-upstream-sync-0611.sh '$BACKUP_FILE'"
echo "==========================================================="
