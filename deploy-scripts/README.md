# Upstream Sync 0611 — 部署 & 回滚脚本

本次同步把上游 `Menci/Floway` 的 7 个提交并入 deploy 分支:
multi-user accounts (#49) + per-upstream proxies (#48) + auth/data-plane/perf fixes。

## ⚠️ 部署关键点（演练 2026-06-11 验证）

1. **必须 `nodejs_compat`**：proxy 的 reality 协议依赖 `@reclaimprotocol/tls`，
   构建期 `import {webcrypto} from 'crypto'`，缺 flag 会 **构建失败**（与是否启用 proxy 无关）。
   已加到 `wrangler.jsonc` 顶层 + `env.staging`。
2. **破坏性 migration**：0028 DROP+重建 `api_keys`（数据迁到 user_id=1）、
   0029 重建 2 张遥测表。**部署前必须备份 + 记录 Time Travel 锚点**。
3. **回滚用 Time Travel**：`wrangler d1 export` 备份不含 `DROP TABLE`，
   不能直接 `--file` 重放还原破坏性 migration。数据回滚主路径是
   `wrangler d1 time-travel restore`（D1 原生时间点恢复）。

## 脚本

| 脚本 | 用途 |
|------|------|
| `DEPLOY-upstream-sync-0611.sh` | prod 部署原子脚本（备份→migration→deploy→验证，`set -euo pipefail` 失败即停） |
| `ROLLBACK-upstream-sync-0611.sh` | 回滚（`prod`/`staging` + 迁移前时间戳；Time Travel 主路径） |
| `STAGING-DRILL-upstream-sync-0611.sh` | staging 部署演练 |
| `STAGING-ROLLBACK-upstream-sync-0611.sh` | staging 回滚演练 |

## prod 部署流程（需建军确认后执行）

```bash
cd <worktree 根目录>   # 含 wrangler.jsonc
bash deploy-scripts/DEPLOY-upstream-sync-0611.sh
# 出问题回滚（时间戳取部署脚本 STEP1 备份前）:
bash deploy-scripts/ROLLBACK-upstream-sync-0611.sh prod <迁移前RFC3339时间戳>
```

## 演练结论（2026-06-11 staging）

- ✅ migration 0018→0030 全绿（含破坏性 0028/0029/0030）
- ✅ 数据零丢失（api_keys 6 行保留、admin id=1 在）
- ✅ deploy 成功，HTTP 健康（`/`=200，API=401 需认证）
- ✅ Time Travel 回滚验证：干净还原到迁移前（0017，users 表消失，旧 api_keys 结构）
- 🎯 抓到 2 个 prod blocker：缺 nodejs_compat（已修）+ staging binding 未继承（已修）
