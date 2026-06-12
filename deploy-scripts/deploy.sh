#!/usr/bin/env bash
# =============================================================================
# deploy.sh — copilot-gateway PROD 部署. 用法: ./deploy.sh <RFC3339时间戳>
#   <时间戳> = 部署前的"迁移前锚点", 由飞马生成后发给建军, 同一个值用于 rollback.sh
#   例: ./deploy.sh 2026-06-12T14:20:00Z
# 吸取 2026-06-11 事故: 破坏性 migration 0028 重建 api_keys; 回滚靠这个时间戳
#   time-travel 到迁移前; 必须真实 completion 验证(非 schema 查询).
# =============================================================================
set -euo pipefail

TS="${1:?用法: ./deploy.sh <RFC3339时间戳, 如 2026-06-12T14:20:00Z>}"
DB_NAME="copilot-db"
DB_ID="0f5eeb05-be0b-49b2-814a-3712767da571"
PROD_BASE="https://copilot.codetrek.work"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKUP_DIR="${HOME}/d1-backups"
cd "${REPO_ROOT}"; mkdir -p "${BACKUP_DIR}"
die() { printf '\n\033[1;31m✘ %s\033[0m\n' "$*" >&2; echo "回滚: ./deploy-scripts/rollback.sh ${TS}"; exit 1; }
log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

log "STEP 0: 时间戳锚点 = ${TS}  (回滚用同一个值: ./rollback.sh ${TS})"
# 校验时间戳在迁移前就能解析到 bookmark(确保它是有效的回滚锚点)
npx wrangler d1 time-travel info "${DB_NAME}" --timestamp "${TS}" >/dev/null 2>&1 \
  || die "时间戳 ${TS} 无法解析到 bookmark, 中止(格式须 RFC3339, 且在过去30天内)"
echo "  ✓ 时间戳可解析为有效回滚锚点"

log "STEP 1: 静态断言 wrangler.jsonc 关键项"
grep -q '"/azure-api.codex/\*"' wrangler.jsonc || die "缺 /azure-api.codex/* 白名单"
grep -q '"nodejs_compat"' wrangler.jsonc || die "缺 nodejs_compat flag"
grep -q "${DB_ID}" wrangler.jsonc || die "缺 prod database_id"
echo "  ✓ 白名单 + nodejs_compat + prod db_id 都在"

log "STEP 2: 备份 prod DB (SQL dump, 灾难兜底)"
DUMP="${BACKUP_DIR}/${DB_NAME}-PRE-${TS//[:]/}.sql"
npx wrangler d1 export "${DB_NAME}" --remote --output "${DUMP}" || die "备份失败"
echo "  ✓ ${DUMP} ($(du -h "${DUMP}" | cut -f1))"

log "STEP 3: 应用 prod migration (--remote)"
npx wrangler d1 migrations list "${DB_NAME}" --remote 2>&1 | sed 's/^/    /'
read -r -p "  确认应用以上 migration 到 PROD? 输入 yes: " C; [ "$C" = "yes" ] || die "用户取消"
npx wrangler d1 migrations apply "${DB_NAME}" --remote || die "migration 失败"
echo "  ✓ migration 完成"

log "STEP 4: 构建 + 部署 prod worker"
pnpm install --frozen-lockfile || die "pnpm install 失败"
npx jiti scripts/check-bindings.ts || die "check-bindings 失败"
pnpm run build:web || die "build:web 失败"
npx wrangler deploy || die "wrangler deploy 失败"
echo "  ✓ 部署完成"

log "STEP 5: prod 真实验证 (需 PROD_KEY 环境变量)"
sleep 3
[ -n "${PROD_KEY:-}" ] || die "未设 PROD_KEY, 无法真实验证"
A="$(curl -sS -m 30 -X POST "${PROD_BASE}/v1/chat/completions" -H "Authorization: Bearer ${PROD_KEY}" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"What is 17*23? Reply only the number"}],"max_tokens":15}')"
echo "$A" | grep -q '"content":"391"' || die "completion 未返回 391: $A"
echo "  ✓ [5a] completion 返回 391"
B="$(curl -sS -m 30 -X POST "${PROD_BASE}/v1/chat/completions" -H "Authorization: Bearer ${PROD_KEY}" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"What is 17*23? Reply only the number"}],"max_tokens":15}')"
echo "$B" | grep -q '"content":"391"' || die "第2次 completion 失败(token usage 写入崩?): $B"
echo "  ✓ [5b] 第2次正常, token usage 写入不崩"
C="$(curl -sS -m 30 -X POST "${PROD_BASE}/azure-api.codex/responses" -H "Authorization: Bearer ${PROD_KEY}" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","input":"Reply only: codex-ok","stream":false}')"
echo "$C" | grep -q 'codex-ok' || die "codex HTTP 失败: $C"
echo "  ✓ [5c] codex HTTP 返回 codex-ok"

log "✅ PROD 部署 + 验证全部通过"
echo "  codex WS 手动验: node deploy-scripts/ws_test_prod.js"
echo "  如需回滚: ./deploy-scripts/rollback.sh ${TS}"
