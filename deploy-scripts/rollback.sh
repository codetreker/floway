#!/usr/bin/env bash
# =============================================================================
# rollback.sh — copilot-gateway PROD 回滚. 用法: ./rollback.sh <RFC3339时间戳>
#   <时间戳> = 部署时用的同一个"迁移前锚点"时间戳.
#   例: ./rollback.sh 2026-06-12T14:20:00Z
# 吸取 2026-06-11/06-12 事故:
#   - 破坏性 migration 0028 重建 api_keys, 代码+数据必须一起回, 绝不只回代码
#   - 数据先回(time-travel restore --timestamp)→ 代码后回(重部署迁移前基线)
#   - 回滚目标 = 上一个 good prod-* tag, 不硬编码、不肉眼取 current version
#     (06-12: 硬编码/取错版本 → 回到 4 月老版 → 二次翻车 1101)
# 代码基线不再写死: 脚本自动列最近 prod-* tag + 日期, 由操作员在回路确认.
#   注意"上一个 good"语义坑:
#     - 部署失败在打 tag 之前   → 最新 prod-* tag 就是上一个 good (选它)
#     - 部署成功打了 tag、上线后才发现炸 → 最新那个是坏的, 要选再上一个
#   destructive 操作不替你赌, 由你看日期确认.
# =============================================================================
set -euo pipefail

TS="${1:?用法: ./rollback.sh <RFC3339时间戳, 部署时用的同一个值>}"
DB_NAME="copilot-db"
PROD_BASE="https://copilot.codetrek.work"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
die() { printf '\n\033[1;31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

cd "${REPO_ROOT}"
git fetch --tags --quiet origin 2>/dev/null || true

# --- 选回滚代码基线 (上一个 good prod-* tag) -------------------------------
echo "=================================================================="
echo " 选择回滚代码基线 — 最近的 prod-* tag"
echo "=================================================================="
mapfile -t TAGS < <(git tag --list 'prod-*' --sort=-creatordate | head -3)

DEPLOY_BASELINE=""
if [ "${#TAGS[@]}" -eq 0 ]; then
  echo "⚠️  没有任何 prod-* tag。"
  echo "    (首次发布前、或 tag 未 push 时会这样。)"
  read -r -p "请手动输入回滚目标 commit/ref: " DEPLOY_BASELINE
  [ -n "${DEPLOY_BASELINE}" ] || die "未提供回滚目标"
else
  echo "找到 ${#TAGS[@]} 个最近 tag (新→旧)，默认 [1] = 最新:"
  echo ""
  i=1
  for t in "${TAGS[@]}"; do
    d=$(git log -1 --format='%ci' "$t" 2>/dev/null | cut -d' ' -f1,2)
    c=$(git rev-parse --short "$t" 2>/dev/null)
    flag=""
    [ "$i" -eq 1 ] && flag="  ← 上一个 (默认)"
    printf "  [%d] %-18s %s  %s%s\n" "$i" "$t" "$c" "$d" "$flag"
    i=$((i+1))
  done
  echo ""
  echo "⚠️  选哪个看失败模式:"
  echo "    · 部署失败在打 tag 前 → [1] 最新就是上一个 good"
  echo "    · 部署成功上线后才炸  → [1] 是坏的, 选 [2] 再上一个"
  echo ""
  read -r -p "选择回滚目标编号 [默认 1]: " SEL
  SEL="${SEL:-1}"
  case "${SEL}" in
    1|2|3) ;;
    *) die "无效选择: ${SEL}" ;;
  esac
  idx=$((SEL-1))
  [ "${idx}" -lt "${#TAGS[@]}" ] || die "编号超出范围: ${SEL}"
  CHOSEN_TAG="${TAGS[$idx]}"
  DEPLOY_BASELINE=$(git rev-parse --short "${CHOSEN_TAG}")
  echo "  → 已选 ${CHOSEN_TAG} (${DEPLOY_BASELINE})"
fi

echo ""
echo "=================================================================="
echo " PROD 回滚 — copilot-gateway"
echo "   DB        : ${DB_NAME}"
echo "   时间戳锚点 : ${TS}  (回滚到此刻之前的 DB 状态)"
echo "   代码基线  : ${DEPLOY_BASELINE}"
echo "=================================================================="
echo "⚠️  ①数据回滚到时间戳之前 ②代码回滚到基线 ${DEPLOY_BASELINE}"
echo "⚠️  会丢弃该时间戳之后的所有 prod 数据写入。"
read -r -p "确认请输入 ROLLBACK: " CONFIRM
[ "${CONFIRM}" = "ROLLBACK" ] || die "已取消"

echo "==> STEP A: 数据回滚 time-travel restore --timestamp ${TS}"
npx wrangler d1 time-travel restore "${DB_NAME}" --timestamp "${TS}" || die "restore 失败"
echo "  ✓ 数据已回滚到 ${TS} 之前"

echo "==> STEP B: 代码回滚 (重部署基线 ${DEPLOY_BASELINE})"
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
