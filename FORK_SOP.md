# FORK_SOP.md — Fork 维护 & 发布标准流程

> **每次 sync upstream / 发布 prod 前必须读这个文件。** 这是 single source of truth。
> 这套流程是 2026-06-12 prod 事故（连环翻车）换来的，每条纪律背后都有血。

---

## 0. 仓库模型（迁移后）

```
upstream/main   = Menci/copilot-gateway 上游（只读参照）
origin/main     = 我们的真 main = 上游 + 我们的定制 commit。发布唯一来源。
sync/<date>     = 临时分支，吸 upstream 用。验证通过后 merge 回 main。
```

**核心约定：**

- **发布只走 `origin/main`**。不再有独立的 `deploy` 分支当发布源。
- **吸上游永远用 `merge`，不用 `squash`**。原因见 §5。
- **每次 prod 发布打 tag** `prod-YYYYMMDD`（可加序号 `-2`）。回滚靠 tag，不靠 current version。
- **upstream 的改动当天 merge 当天发 = 禁止**。必须过 staging 真实验证 + review。

---

## 1. 红线（违反 = 事故）

1. **不许 upstream merge 进 main 当天直接发 prod。** 必走 `sync/<date>` 分支 → staging 实测 → review → merge main → 发 prod。
   （06-12：早上 merge 当天发、拿静态 200 糊弄 → 全站 502。）

2. **每次吸 upstream 必须 diff `wrangler.jsonc`。** 配置漏项照样炸。
   （06-12：漏 `run_worker_first` 白名单 `/azure-api.codex/*` + `nodejs_compat` → codex WS 全挂。）

3. **验证必须跑真实 completion + WS，不许拿 schema 查询/200 状态码当通过。**
   （06-12：STEP5 只查行数 schema，错报"正常" → 实际 502。MEMORY 铁律：curl 200 不算 e2e。）

4. **破坏性 migration 的回滚，代码和数据必须绑死一起回。** 绝不只回代码。
   （06-12：回滚只回代码不回 DB → 旧代码写新 schema 表崩 → 持续 502。）

5. **回滚命令是发布的前置交付物，不是事后产物。** 发布脚本第一件事就打印完整回滚命令并贴频道。
   （06-12：回滚 bookmark 执行时才临时取，部署一挂就没了，建军登机器翻半天。）

---

## 2. Sync 上游流程

```bash
cd /workspace/copilot-gateway
git fetch upstream && git fetch origin

# 1) 从 main 开 sync 分支
git worktree add .worktrees/sync-$(date +%m%d) -b sync/$(date +%Y%m%d) origin/main
cd .worktrees/sync-$(date +%m%d)

# 2) merge 上游（永远 --no-ff，保留 merge commit；不要 squash）
git merge --no-ff upstream/main
#    → 解冲突。重点盯 wrangler.jsonc / migrations / package.json

# 3) ⚠️ 红线2：diff wrangler.jsonc，确认我们的定制项一个不少
git diff origin/main..HEAD -- wrangler.jsonc
#    必须保留的（最少）：
#      - assets.run_worker_first 白名单含 "/azure-api.codex/*"
#      - compatibility_flags 含 "nodejs_compat"
#      - prod database_id
#    上游若新增 binding/flag，评估后合入

# 4) 看 migrations 有没有破坏性变更（DROP/重建表/NOT NULL 加列）
git diff origin/main..HEAD -- migrations/
#    有破坏性 → §4 回滚预案必须先准备好
```

---

## 3. Staging 验证（合 main 前必做）

部署 sync 分支到 staging（`copilot-staging.oc-pegasus.workers.dev`），跑**真实**验证：

```bash
# A) 真实 completion（红线3，不许只看 200）
curl -X POST https://copilot-staging.oc-pegasus.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <STAGING_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"What is 17*23? Reply only the number"}],"max_tokens":15}'
#    → 必须返回正确答案 391，不是 502/空

# B) codex WS 真实握手 + 流式（06-12 就是这条没覆盖）
node deploy-scripts/ws_test_staging.js
#    → 101 upgrade + response.create 流式事件全通

# C) 多 upstream / per-key backend 路由（prod 有、staging 易漏的数据路径）
#    06-12 教训：staging 不炸 prod 炸，就因为 prod 有 per-key 绑 codex backend 的数据
```

**全绿** → 提 PR：`sync/<date>` → `main`，飞马 + Copilot review。
review 过 → **merge（不 squash）** 进 main。

---

## 4. Prod 发布流程

```bash
cd /workspace/copilot-gateway && git checkout main && git pull origin main

# 1) ⚠️ 红线5：发布前先生成完整回滚命令并贴频道
#    a. 记录"发布前最后一个 good tag"（上一次的 prod-* tag）
git tag --list 'prod-*' --sort=-creatordate | head -3
#    b. 生成迁移前时间戳锚点（RFC3339），deploy/rollback 用同一个值
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "回滚命令: ./deploy-scripts/rollback.sh ${TS}  (代码基线 = 上一个 prod-* tag)"
#    → 把这行贴到 #project-copilot-gateway

# 2) 执行部署（脚本内含：时间戳校验→wrangler.jsonc 断言→DB 备份→migration→deploy→真实验证）
./deploy-scripts/deploy.sh ${TS}

# 3) 部署成功 → 打 tag
git tag prod-$(date +%Y%m%d)        # 同日二次发布加 -2
git push origin prod-$(date +%Y%m%d)
```

**注意：** `deploy-scripts/rollback.sh` 里的 `DEPLOY_BASELINE` 必须更新为
**上一个 prod-* tag 对应的 commit**（发布前最后一个 good 版本）。
06-12 就是回滚选错版本（取了 current = 4 月老版 0495548e，正确是 8b6d3e5d）。
**有了 prod-* tag，回滚目标 = 上一个 tag，不再靠肉眼取 current version。**

---

## 5. 为什么 merge 不 squash（同步上游）

- fork 定期吸 upstream 靠 **merge-base**（共同祖先）算增量。
- **merge**：保留 upstream 真实 commit + merge node → merge-base 准确 → 每次只处理真正的新增量，冲突最小。
- **squash**：把 upstream 一坨压成一个新 commit → git 认不出我们"有"过 upstream 历史 → 下次 sync 把已合过的再当差异重算 → 冲突地狱，越攒越烂。
- squash 只适合"自己的 feature 分支并 main 求干净历史"。**同步上游恰恰相反，要保真。**

---

## 6. 一次性迁移（deploy → main，仅执行一次）

当前 `deploy` = `origin/main`(上游镜像) + 19 个定制 commit。迁移把定制落进 main：

```bash
# 1) 确认 deploy 已包含 main 全部（应为 0 missing）
git log --oneline deploy..origin/main | wc -l        # 期望 0

# 2) 把 main 快进到 deploy（保留全部 merge 历史，不 rebase 不 squash）
git checkout main && git merge --ff-only deploy
git push origin main

# 3) 给迁移点打基线 tag（= 当前 prod 运行版本）
git tag prod-<当前prod发布日> <当前prod commit>
git push origin prod-<...>

# 4) deploy 分支退役：保留只读做历史指针，新工作一律基于 main
#    （不要删，留作 06-08 稳定版 8b6d3e5d 等历史锚点的参照）
```

迁移后：`origin/main` 成为唯一发布源，`deploy` 冻结。

---

## 检查清单（每次发布逐条打勾）

- [ ] sync 走了 `sync/<date>` 分支，没在 main 上直接 merge upstream
- [ ] `git merge --no-ff`，没 squash
- [ ] diff 过 `wrangler.jsonc`：codex 白名单 + nodejs_compat + prod db_id 都在
- [ ] 看过 migrations 有无破坏性变更；有 → 回滚预案就绪
- [ ] staging 跑了**真实 completion**（返回 391）
- [ ] staging 跑了 **codex WS** 真实握手流式
- [ ] PR 过了 review 才 merge main
- [ ] 发布前完整回滚命令已贴频道
- [ ] `rollback.sh` 的 `DEPLOY_BASELINE` = 上一个 prod-* tag commit
- [ ] 发布成功后打了 `prod-YYYYMMDD` tag 并 push
