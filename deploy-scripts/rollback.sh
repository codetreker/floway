#!/usr/bin/env bash
# =============================================================================
# rollback.sh — copilot-gateway PROD 回滚. 用法: ./rollback.sh <RFC3339时间戳>
#   <时间戳> = 部署时用的同一个"迁移前锚点"时间戳.
#   例: ./rollback.sh 2026-06-12T14:20:00Z
# 吸取 2026-06-11 事故:
#   - 破坏性 migration 0028 重建 api_keys, 代码+数据必须一起回, 绝不只回代码
#   - 数据先回(time-travel restore --timestamp)→ 代码后回(重部署迁移前基线)
# =============================================================================
set -euo pipefail

TS="${1:?用法: ./rollback.sh <RFC3339时间戳, 部署时用的同一个值>}"
DB_NAME="copilot-db"
DEPLOY_BASELINE="5aed8a9d"   # 迁移前 deploy 基线 commit
PROD_BASE="https://copilot.codetrek.work"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
die() { printf '\n\033[1;31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

echo "=================================================================="
echo " PROD 回滚 — copilot-gateway"
echo "   DB        : ${DB_NAME}"
echo "   时间戳锚点 : ${TS}  (回滚到此刻之前的 DB 状态)"
echo "=================================================================="
echo "⚠️  ①数据回滚到时间戳之前 ②代码回滚到迁移前基线 ${DEPLOY_BASELINE}"
echo "⚠️  会丢弃该时间戳之后的所有 prod 数据写入。"
read -r -p "确认请输入 ROLLBACK: " CONFIRM
[ "${CONFIRM}" = "ROLLBACK" ] || die "已取消"

echo "==> STEP A: 数据回滚 time-travel restore --timestamp ${TS}"
npx wrangler d1 time-travel restore "${DB_NAME}" --timestamp "${TS}" || die "restore 失败"
echo "  ✓ 数据已回滚到 ${TS} 之前"

echo "==> STEP B: 代码回滚 (重部署迁移前基线 ${DEPLOY_BASELINE})"
echo "  以下命令需人工执行 (避免脚本自动改工作区造成二次事故):"
cat <<MANUAL

    cd ${REPO_ROOT}
    git stash || true
    git checkout ${DEPLOY_BASELINE} -- .
    pnpm install --frozen-lockfile
    pnpm run build:web
    npx wrangler deploy        # 不带 --env, prod 默认 env

MANUAL
echo "==> STEP C: 代码回滚后跑真实验证 (必须返回 391, 不要只看 200):"
echo "    curl -X POST ${PROD_BASE}/v1/chat/completions -H 'Authorization: Bearer <PROD_KEY>' \\"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"model\":\"gpt-4o-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"What is 17*23? Reply only the number\"}],\"max_tokens\":15}'"
echo ""
echo "✅ 数据回滚完成。代码回滚请按上面手动执行并验证。"
