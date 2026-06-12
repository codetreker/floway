# deploy-scripts — copilot-gateway 部署/回滚（sync-0612）

吸取 2026-06-11 prod 事故教训重写。**只用于 prod**；staging 演练直接用 `npx wrangler deploy --env staging`。

## 事故根因 → 本次对策

| # | 上次事故 | 本次对策 |
|---|---------|---------|
| 1 | 破坏性 migration 0028 重建 api_keys（user_id NOT NULL），回滚只回代码不回 DB → 全 502 | 部署前先取 D1 time-travel **bookmark**，落盘「硬编码该 bookmark」的回滚脚本；回滚时**代码+数据原子回滚**，删掉危险的 `--code-only` |
| 2 | wrangler.jsonc 漏 `/azure-api.codex/*` 白名单 → codex WS 用不了 | wrangler.jsonc 已固化白名单；deploy 脚本 STEP 0 静态断言再确认 |
| 3 | 部署后只验静态 schema 当通过 → 假绿 | STEP 5 跑**真实 completion（17*23=391）+ 连发 2 次验 token 写入 + codex HTTP**，schema 查询不算 |
| 4 | 回滚脚本时间戳格式 bug + 命令事后才生成 | 用 **bookmark（确定值）** 不用时间戳；回滚命令在部署**之前**就落盘到 `~/d1-backups/ROLLBACK-NOW-<ts>.sh` |

## 文件

- `deploy-prod.sh` — prod 部署主脚本。STEP 0 断言 → STEP 1 SQL dump → STEP 2 取 bookmark + 生成回滚脚本 → STEP 3 migration → STEP 4 build+deploy → STEP 5 真实验证。
- `rollback-prod.sh` — 手动回滚兜底（传 `BOOKMARK=`）。优先用部署时自动生成的 `ROLLBACK-NOW-*.sh`。
- `ws_test_staging.js` / `ws_test_prod.js` — codex WS 真实流式验证（连到 `response.done`）。

## 用法

```bash
# prod 部署（需 prod api key 做部署后真实验证）
PROD_KEY=<prod-api-key> ./deploy-scripts/deploy-prod.sh

# 出事回滚（优先用部署时落盘的脚本）
bash ~/d1-backups/ROLLBACK-NOW-<ts>.sh
# 或手动：
BOOKMARK=<迁移前bookmark> ./deploy-scripts/rollback-prod.sh
```

## 铁律

- prod 部署**不带 `--env`**（prod 是默认 env），migration 必须 `--remote`。
- `wrangler d1 time-travel info` **不能带 `--remote`**（4.81 不支持）。
- 所有脚本 `set -euo pipefail`。
- 部署后验证必须真实跑 completion + codex，不许 curl 200 糊弄。
