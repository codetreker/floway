# DEPLOY_SOP.md — Prod 发布 & 回滚标准流程

> **每次发布 prod / 回滚前必须读这个文件。** 这是发布流程的 single source of truth。
> 每条纪律背后都有 2026-06-12 prod 连环事故的血。
> Fork 维护 / 吸上游 → 看 `FORK_SOP.md`。本文件只管"把 main 发到 prod"。

---

## 0. 前提

- 发布唯一来源 = `origin/main`。要发的代码必须已经在 main 上（sync 流程见 FORK_SOP §2-3）。
- prod target：Cloudflare Workers，`https://copilot.codetrek.work`，DB `copilot-db`。
- staging：`https://copilot-staging.oc-pegasus.workers.dev`。

---

## 1. 红线（违反 = 事故）

1. **验证必须跑真实 completion + WS，不许拿 schema 查询 / 200 状态码当通过。**
   （06-12：STEP5 只查行数 schema，错报"正常" → 实际全站 502。铁律：curl 200 不算 e2e。）

2. **破坏性 migration 的回滚，代码和数据必须绑死一起回。** 绝不只回代码。
   （06-12：回滚只回代码不回 DB → 旧代码写新 schema 表崩 → 持续 502。）

3. **回滚命令是发布的前置交付物，不是事后产物。** 发布前先打印完整回滚命令并贴频道。
   （06-12：回滚 bookmark 执行时才临时取，部署一挂就没了，建军登机器翻半天才找到。）

4. **回滚目标版本 = 上一个 good `prod-*` tag，不许肉眼取 current version。**
   （06-12：回滚取了 current = 4 月老版 0495548e，正确是 8b6d3e5d → 二次翻车 1101 错误。）
   `rollback.sh` 自动列最近 3 个 `prod-*` tag + 日期供你确认选择（不再硬编码、也不盲选 head-1，
   因为"上一个 good"在部署成功后才发现炸的场景里是 head-2，destructive 操作由人在回路定）。

5. **每次吸上游后的首发，必须确认 `wrangler.jsonc` 定制项没丢**（deploy.sh STEP1 已断言，但人也要看）。
   （06-12：漏 `run_worker_first` 白名单 `/azure-api.codex/*` + `nodejs_compat` → codex WS 全挂。）

---

## 2. Staging 验证三件套（合 main 前 & 发 prod 前都用这套）

> FORK_SOP §3 引用本节。任何代码进 prod 路径前，先在 staging 跑全这三项。

```bash
# A) 真实 completion（红线1，不许只看 200）
curl -X POST https://copilot-staging.oc-pegasus.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <STAGING_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"What is 17*23? Reply only the number"}],"max_tokens":15}'
#    → 必须返回正确答案 391，不是 502 / 空 / schema-only

# B) codex WS 真实握手 + 流式（06-12 就是这条没覆盖）
node deploy-scripts/ws_test_staging.js
#    → 101 upgrade + response.create 流式事件全通

# C) 多 upstream / per-key backend 路由
#    06-12 教训：staging 不炸 prod 炸，就因为 prod 有 per-key 绑 codex backend 的数据，
#    staging 无此数据 → 演练根本没覆盖这条代码路径。
#    → 用一个绑了 codex backend 的 key 实测路由，别只测默认 key
```

三件套全绿才算 staging 通过。

---

## 3. Prod 发布流程

```bash
cd /workspace/copilot-gateway && git checkout main && git pull origin main

# 1) ⚠️ 红线3：发布前先生成完整回滚命令并贴频道
#    a. 查上一个 good tag（= 回滚代码目标，仅供贴频道告知，脚本会自动列）
git tag --list 'prod-*' --sort=-creatordate | head -3
#    b. 生成迁移前时间戳锚点（RFC3339），deploy/rollback 用同一个值
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "回滚: ./deploy-scripts/rollback.sh ${TS}  (脚本会列 prod-* tag 让你选代码基线)"
#    → 把这行 + 上一个 prod-* tag 贴到 #project-copilot-gateway

# 2) 执行部署
#    deploy.sh 内含：时间戳校验 → wrangler.jsonc 断言（红线5）→ DB 备份 →
#                    migration → wrangler deploy → 真实 completion 验证（红线1）
./deploy-scripts/deploy.sh ${TS}

# 3) 部署成功 → 打 tag（红线4 的下次回滚目标）
git tag prod-$(date +%Y%m%d)        # 同日二次发布加 -2
git push origin prod-$(date +%Y%m%d)
```

---

## 4. 回滚流程

破坏性 migration 已部署、prod 炸了时：

```bash
# 数据先回 → 代码后回，两者绑死（红线2）。用发布时同一个时间戳。
./deploy-scripts/rollback.sh <发布时的同一个 RFC3339 时间戳>
#   STEP A: time-travel restore --timestamp（数据回到迁移前）
#   STEP B: 脚本先列最近 prod-* tag 让你选代码基线 → 打印手动 checkout 命令
#   STEP C: 跑真实 completion 验证（红线1，返回 391 才算好）
```

**回滚后复盘**：把根因 + 时间线写进项目 memory，更新本 SOP 如有新坑。

---

## 5. 检查清单（每次发布逐条打勾）

- [ ] 要发的代码已在 `origin/main`（不在 sync 分支/worktree 里）
- [ ] staging 跑了**真实 completion**（返回 391）
- [ ] staging 跑了 **codex WS** 真实握手流式
- [ ] staging 测了 **per-key backend 路由**（不只默认 key）
- [ ] `wrangler.jsonc`：codex 白名单 + nodejs_compat + prod db_id 都在
- [ ] 看过 migrations 有无破坏性变更；有 → 回滚预案就绪
- [ ] 发布前完整回滚命令 + 上一个 prod-* tag 已贴频道
- [ ] 发布成功后打了 `prod-YYYYMMDD` tag 并 push
      （回滚时 `rollback.sh` 会自动列 tag 让你选基线，无需手动改脚本）
