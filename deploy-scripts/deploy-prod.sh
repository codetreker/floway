#!/usr/bin/env bash
# =============================================================================
# deploy-prod.sh — copilot-gateway PROD 部署脚本（sync-0612）
# =============================================================================
# 吸取 2026-06-11 prod 事故教训重写：
#   1. 破坏性 migration 0028 重建 api_keys（user_id NOT NULL）。回滚只回代码
#      不回 DB 会全 502 → 本脚本在动任何 prod 资源前，先取 D1 time-travel
#      bookmark 并生成「硬编码该 bookmark」的可执行回滚脚本写到磁盘。
#   2. wrangler.jsonc 必须含 /azure-api.codex/* 白名单 + nodejs_compat flag
#      （已在 wrangler.jsonc 固化，本脚本部署前做静态断言再确认一次）。
#   3. 部署后必须跑「真实 completion + codex」验证，schema 查询不算通过。
#   4. 回滚命令在部署「之前」就落盘，不在事后临时拼。
# -----------------------------------------------------------------------------
# 用法：
#   PROD_KEY=<prod-api-key> ./deploy-prod.sh
# 前置：
#   - 已在 staging 完整演练通过（4 项 E2E）。
#   - 必须显式不带 --env（prod 是默认 env），migration 必须 --remote。
# =============================================================================
set -euo pipefail

# --- 配置（prod） ------------------------------------------------------------
PROD_DB_NAME="copilot-db"
PROD_DB_ID="0f5eeb05-be0b-49b2-814a-3712767da571"
PROD_BASE="https://copilot.codetrek.work"
BACKUP_DIR="${HOME}/d1-backups"
TS="$(date -u +%Y%m%d-%H%M%SZ)"
ROLLBACK_SCRIPT="${BACKUP_DIR}/ROLLBACK-NOW-${TS}.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"
mkdir -p "${BACKUP_DIR}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

# =============================================================================
# STEP 0 — 安全断言：确认在正确目录 + wrangler.jsonc 关键定制存在
# =============================================================================
log "STEP 0: 静态断言 wrangler.jsonc 关键项"
[ -f wrangler.jsonc ] || die "wrangler.jsonc 不存在"
grep -q '"/azure-api.codex/\*"' wrangler.jsonc \
  || die "wrangler.jsonc 缺少 /azure-api.codex/* 白名单（codex WS 会挂）"
grep -q '"nodejs_compat"' wrangler.jsonc \
  || die "wrangler.jsonc 缺少 nodejs_compat flag（proxy 构建/运行会挂）"
grep -q "${PROD_DB_ID}" wrangler.jsonc \
  || die "wrangler.jsonc 缺少 prod database_id ${PROD_DB_ID}"
echo "  ✓ /azure-api.codex/* 白名单存在"
echo "  ✓ nodejs_compat flag 存在"
echo "  ✓ prod database_id 存在"

: "${PROD_KEY:?需要设置 PROD_KEY 环境变量（prod api key）用于部署后真实验证}"

# =============================================================================
# STEP 1 — 备份：SQL dump（人类可读，灾难兜底）
# =============================================================================
log "STEP 1: 备份 prod DB（SQL dump）"
PROD_DUMP="${BACKUP_DIR}/${PROD_DB_NAME}-PRE-deploy-${TS}.sql"
npx wrangler d1 export "${PROD_DB_NAME}" --remote --output "${PROD_DUMP}" \
  || die "SQL dump 失败，中止部署"
echo "  ✓ dump 写入 ${PROD_DUMP} ($(du -h "${PROD_DUMP}" | cut -f1))"

# =============================================================================
# STEP 2 — 取 time-travel bookmark + 生成硬编码回滚脚本（动 prod 之前！）
# =============================================================================
# 关键：用 bookmark（确定值），不用时间戳（4.81 时间戳格式坑多）。
# 注意：time-travel info 不能带 --remote（4.81 不支持）。
log "STEP 2: 取迁移前 time-travel bookmark 并落盘回滚脚本"
BOOKMARK="$(npx wrangler d1 time-travel info "${PROD_DB_NAME}" --json 2>/dev/null \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["bookmark"])')" \
  || die "取 bookmark 失败"
[ -n "${BOOKMARK}" ] || die "bookmark 为空，中止"
echo "  ✓ 迁移前 bookmark: ${BOOKMARK}"

# 记录当前 prod worker version（代码回滚参照）
CUR_VERSION="$(npx wrangler versions list --json 2>/dev/null \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d[0]["id"] if isinstance(d,list) and d else "")' 2>/dev/null || true)"

# ---- 生成回滚脚本：代码 + 数据原子回滚，绝不只回代码 ----
cat > "${ROLLBACK_SCRIPT}" <<ROLLBACK_EOF
#!/usr/bin/env bash
# =============================================================================
# 自动生成于 ${TS} — copilot-gateway PROD 回滚脚本
# 由 deploy-prod.sh 在「破坏性 migration 之前」生成，bookmark 为硬编码确定值。
# =============================================================================
# 回滚策略：DATA 先回（time-travel 到迁移前 bookmark）→ CODE 回到迁移前版本。
# 破坏性 migration 0028 重建了 api_keys，**只回代码不回数据必崩**，所以这里
# 数据和代码一起回，不留半截态。**不提供 --code-only 这种危险选项。**
# -----------------------------------------------------------------------------
set -euo pipefail

DB_NAME="${PROD_DB_NAME}"
BOOKMARK="${BOOKMARK}"

echo "⚠️  即将把 prod DB ${PROD_DB_NAME} 回滚到迁移前 bookmark：${BOOKMARK}"
echo "⚠️  这会丢弃 bookmark 之后的所有 prod 数据写入。确认请输入 ROLLBACK："
read -r CONFIRM
[ "\${CONFIRM}" = "ROLLBACK" ] || { echo "已取消"; exit 1; }

# --- STEP A: 数据回滚（time-travel restore，确定 bookmark）---
echo "==> 数据回滚：time-travel restore 到 \${BOOKMARK}"
npx wrangler d1 time-travel restore "\${DB_NAME}" --bookmark="\${BOOKMARK}"

# --- STEP B: 代码回滚 ---
# 把工作区切回迁移前的 deploy 基线（5aed8a9d）再重新部署。
# 迁移前 prod worker version（参照，用于 versions rollback 也可）：
#   ${CUR_VERSION:-<未取到，用 git 基线重部署>}
echo "==> 代码回滚：checkout deploy 基线 5aed8a9d 并重新部署"
echo "    cd ${REPO_ROOT}"
echo "    git checkout 5aed8a9d -- ."
echo "    pnpm install --frozen-lockfile && pnpm run build:web"
echo "    npx wrangler deploy   # 不带 --env，prod 默认 env"
echo ""
echo "（代码部分需人工执行上面 4 行——避免脚本自动改动工作区造成二次事故）"

echo "✅ 数据已回滚。请按上面提示完成代码回滚，然后做真实 completion 验证。"
ROLLBACK_EOF
chmod +x "${ROLLBACK_SCRIPT}"
echo "  ✓ 回滚脚本已落盘：${ROLLBACK_SCRIPT}"
echo ""
echo "  ========================== 复制保存以下回滚命令 =========================="
echo "  数据回滚：npx wrangler d1 time-travel restore ${PROD_DB_NAME} --bookmark=${BOOKMARK}"
echo "  完整回滚：bash ${ROLLBACK_SCRIPT}"
echo "  ========================================================================="
echo ""

# =============================================================================
# STEP 3 — Migration（prod，--remote）
# =============================================================================
log "STEP 3: 应用 prod migration（--remote）"
echo "  待应用迁移："
npx wrangler d1 migrations list "${PROD_DB_NAME}" --remote 2>&1 | sed 's/^/    /'
read -r -p "  确认应用以上 migration 到 PROD？输入 yes： " MIG_CONFIRM
[ "${MIG_CONFIRM}" = "yes" ] || die "用户取消 migration"
npx wrangler d1 migrations apply "${PROD_DB_NAME}" --remote \
  || die "migration 失败！立即执行回滚：bash ${ROLLBACK_SCRIPT}"
echo "  ✓ migration 完成"

# =============================================================================
# STEP 4 — 构建 + 部署 prod
# =============================================================================
log "STEP 4: 构建并部署 prod worker"
pnpm install --frozen-lockfile || die "pnpm install 失败"
npx jiti scripts/check-bindings.ts || die "check-bindings 失败"
pnpm run build:web || die "build:web 失败"
npx wrangler deploy \
  || die "wrangler deploy 失败！数据已迁移，执行回滚：bash ${ROLLBACK_SCRIPT}"
echo "  ✓ prod 部署完成"

# =============================================================================
# STEP 5 — 真实验证（不是 schema 查询，是真打 completion + codex）
# =============================================================================
log "STEP 5: prod 真实 E2E 验证"
sleep 3  # 等 worker 全球生效

# 5a: 真实 completion，必须 200 且答案 391
echo "  [5a] 真实 completion 17*23..."
RESP_A="$(curl -sS -m 30 -X POST "${PROD_BASE}/v1/chat/completions" \
  -H "Authorization: Bearer ${PROD_KEY}" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"What is 17*23? Reply only the number"}],"max_tokens":15}')"
echo "${RESP_A}" | grep -q '"content":"391"' \
  || die "completion 验证失败（未返回 391）。响应：${RESP_A}。执行回滚：bash ${ROLLBACK_SCRIPT}"
echo "       ✓ completion 返回 391"

# 5b: 连发第 2 次，确认 recordTokenUsage 写入不崩（事故根因点）
echo "  [5b] 第 2 次 completion（验 token usage 写入不崩）..."
RESP_B="$(curl -sS -m 30 -X POST "${PROD_BASE}/v1/chat/completions" \
  -H "Authorization: Bearer ${PROD_KEY}" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"What is 17*23? Reply only the number"}],"max_tokens":15}')"
echo "${RESP_B}" | grep -q '"content":"391"' \
  || die "第 2 次 completion 失败（token usage 写入可能崩）。响应：${RESP_B}。回滚：bash ${ROLLBACK_SCRIPT}"
echo "       ✓ 第 2 次 completion 正常，token usage 写入未崩"

# 5c: codex HTTP
echo "  [5c] codex HTTP /azure-api.codex/responses..."
RESP_C="$(curl -sS -m 30 -X POST "${PROD_BASE}/azure-api.codex/responses" \
  -H "Authorization: Bearer ${PROD_KEY}" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","input":"Reply only: codex-ok","stream":false}')"
echo "${RESP_C}" | grep -q 'codex-ok' \
  || die "codex HTTP 验证失败。响应：${RESP_C}。回滚：bash ${ROLLBACK_SCRIPT}"
echo "       ✓ codex HTTP 返回 codex-ok"

echo ""
echo "  ⚠️  codex WS 验证请手动跑（改 ws_test.js 的 URL 为 wss://copilot.codetrek.work/...）："
echo "       node deploy-scripts/ws_test_prod.js"
echo ""
log "✅ PROD 部署 + 验证全部通过"
echo "回滚脚本（保留）：${ROLLBACK_SCRIPT}"
echo "迁移前 bookmark：${BOOKMARK}"
