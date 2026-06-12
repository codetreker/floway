#!/usr/bin/env bash
# =============================================================================
# rollback-prod.sh — copilot-gateway PROD 回滚脚本（模板/手动版）
# =============================================================================
# 何时用：
#   - deploy-prod.sh 已经在部署前生成了「硬编码 bookmark」的 ROLLBACK-NOW-*.sh，
#     **优先用那个**（bookmark 是确定值，最安全）。
#   - 本脚本是手动兜底：当你手头有迁移前 bookmark 时，传进来即可回滚。
# -----------------------------------------------------------------------------
# 设计原则（吸取 2026-06-11 事故）：
#   1. 用 bookmark（确定值），不用时间戳——避免 4.81 时间戳格式坑。
#   2. 破坏性 migration 0028 重建了 api_keys，**代码 + 数据必须原子回滚**，
#      绝不提供「只回代码」的 --code-only 危险选项（只回代码必崩 502）。
#   3. 数据先回（time-travel restore）→ 代码后回（重部署迁移前基线）。
# -----------------------------------------------------------------------------
# 用法：
#   BOOKMARK=<迁移前bookmark> ./rollback-prod.sh
#   # bookmark 来源：部署前 `wrangler d1 time-travel info copilot-db --json`
#   #               或 ~/d1-backups/ROLLBACK-NOW-*.sh 里硬编码的值
# =============================================================================
set -euo pipefail

PROD_DB_NAME="copilot-db"
DEPLOY_BASELINE="5aed8a9d"   # 迁移前 deploy 基线 commit
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

die() { printf '\n\033[1;31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

: "${BOOKMARK:?必须提供 BOOKMARK 环境变量（迁移前 D1 time-travel bookmark）}"

echo "⚠️  PROD 回滚：DB=${PROD_DB_NAME}  bookmark=${BOOKMARK}"
echo "⚠️  这会丢弃 bookmark 之后的所有 prod 数据写入。"
read -r -p "确认请输入 ROLLBACK： " CONFIRM
[ "${CONFIRM}" = "ROLLBACK" ] || die "已取消"

# --- STEP A: 数据回滚（确定 bookmark，原子）---
echo "==> STEP A: 数据回滚 time-travel restore"
npx wrangler d1 time-travel restore "${PROD_DB_NAME}" --bookmark="${BOOKMARK}" \
  || die "time-travel restore 失败"
echo "  ✓ 数据已回滚到 ${BOOKMARK}"

# --- STEP B: 代码回滚（重部署迁移前基线，与数据保持一致）---
echo "==> STEP B: 代码回滚（重部署 ${DEPLOY_BASELINE} 基线）"
echo "  以下命令需人工执行（避免脚本自动改工作区造成二次事故）："
cat <<MANUAL

    cd ${REPO_ROOT}
    git stash || true
    git checkout ${DEPLOY_BASELINE} -- .
    pnpm install --frozen-lockfile
    pnpm run build:web
    npx wrangler deploy        # 不带 --env，prod 默认 env

MANUAL
echo "  执行完后，跑真实 completion 验证（不要只看 200）："
echo "    curl -X POST https://copilot.codetrek.work/v1/chat/completions \\"
echo "      -H 'Authorization: Bearer <PROD_KEY>' -H 'Content-Type: application/json' \\"
echo "      -d '{\"model\":\"gpt-4o-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"What is 17*23? Reply only the number\"}],\"max_tokens\":15}'"
echo "    # 必须返回 content=391"

echo ""
echo "✅ 数据回滚完成。代码回滚请按上面步骤手动执行并验证。"
