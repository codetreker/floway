# FORK_SOP.md — Fork 维护 & 上游同步标准流程

> **每次 sync upstream 前必须读这个文件。** 这是 fork 维护的 single source of truth。
> 发布 prod / 回滚 → 看 `DEPLOY_SOP.md`。本文件只管"怎么维护 fork、怎么吸上游"。
> 纪律来自 2026-06-12 prod 事故，每条背后都有血。

---

## 0. 仓库模型（迁移后）

```
upstream/main   = Menci/copilot-gateway 上游（只读参照）
origin/main     = 我们的真 main = 上游 + 我们的定制 commit。发布唯一来源。
sync/<date>     = 临时分支，吸 upstream 用。验证通过后 merge 回 main。
```

**核心约定：**

- **发布只走 `origin/main`**。不再有独立的 `deploy` 分支当发布源。
- **吸上游永远用 `merge`，不用 `squash`**。原因见 §4。
- **upstream 的改动当天 merge 当天发 = 禁止**。必须过 staging 真实验证 + review（见 DEPLOY_SOP §2）。

---

## 1. 红线（违反 = 事故）

1. **不许 upstream merge 进 main 当天直接发 prod。** 必走 `sync/<date>` 分支 → staging 实测 → review → merge main → 发 prod。
   （06-12：早上 merge 当天发、拿静态 200 糊弄 → 全站 502。）

2. **每次吸 upstream 必须 diff `wrangler.jsonc`。** 配置漏项照样炸。
   （06-12：漏 `run_worker_first` 白名单 `/azure-api.codex/*` + `nodejs_compat` → codex WS 全挂。）

3. **吸上游永远 `merge --no-ff`，绝不 squash。** 详见 §4。

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
#    有破坏性 → DEPLOY_SOP §4 回滚预案必须先准备好
```

## 3. 验证 + 合回 main

1. 把 sync 分支部署到 staging，跑 **DEPLOY_SOP §2 的 staging 验证三件套**（真实 completion + codex WS + per-key 路由）。
2. 三件套全绿 → 提 PR：`sync/<date>` → `main`，飞马 + Copilot review。
3. review 过 → **merge（不 squash）** 进 main。
4. 发布是单独动作，按 **DEPLOY_SOP §3** 走。sync 完不等于发布，可以攒。

---

## 4. 为什么 merge 不 squash（同步上游）

- fork 定期吸 upstream 靠 **merge-base**（共同祖先）算增量。
- **merge**：保留 upstream 真实 commit + merge node → merge-base 准确 → 每次只处理真正的新增量，冲突最小。
- **squash**：把 upstream 一坨压成一个新 commit → git 认不出我们"有"过 upstream 历史 → 下次 sync 把已合过的再当差异重算 → 冲突地狱，越攒越烂。
- squash 只适合"自己的 feature 分支并 main 求干净历史"。**同步上游恰恰相反，要保真。**

---

## 5. 一次性迁移（deploy → main，仅执行一次）

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

## 检查清单（每次 sync 逐条打勾）

- [ ] 走了 `sync/<date>` 分支，没在 main 上直接 merge upstream
- [ ] `git merge --no-ff`，没 squash
- [ ] diff 过 `wrangler.jsonc`：codex 白名单 + nodejs_compat + prod db_id 都在
- [ ] 看过 migrations 有无破坏性变更；有 → 回滚预案就绪（DEPLOY_SOP §4）
- [ ] staging 三件套全绿（DEPLOY_SOP §2）才提 PR
- [ ] PR 过了 review 才 merge main
- [ ] merge 进 main（不 squash）
- [ ] 发布是单独动作 → 走 DEPLOY_SOP
