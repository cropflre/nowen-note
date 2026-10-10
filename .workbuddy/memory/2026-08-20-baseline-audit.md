# Local-first 真实基线核查（2026-08-20 17:50）

分支 `release/v1.5.0`，HEAD `134ad5c0`（你在中间做了测试基线收口）。

## Git 环境已修复 ✅

单个损坏 Codex checkpoint ref：
```
refs/codex/turn-diffs/checkpoints/e86959ca…/940467e8…/1786701874210/0d3fc2a7-cdb0-4dbb-a403-6d64219db0e2
→ 994fd81a18e7543ed7b83500e3759cad460ff8f2（对象不存在）
```
核实：无分支可达、非 branch/tag/源码、同命名空间另 3 个 ref 完好。
`git update-ref -d` 删除 → `git fetch origin` 恢复正常，`git fsck --full` 无损坏。
备份记录：`.workbuddy/memory/git-corrupted-ref-backup-2026-08-20.md`

`origin/main` 已推进到 `fd17d980f`（按要求暂不 merge）。

## 你的三项诊断全部确认

1. **Active Profile 无 DB 约束** — `profile.ts:83 setProfileEnabled` 是公开旁路，
   `sync_profiles` 无 partial unique index。已验证 SQLite 3.49.2 支持
   `CREATE UNIQUE INDEX … WHERE enabled = 1` 且行为正确。
2. **Device ID 是 Profile-scoped** — `device.ts:30` 按 profileId 查，缺失就 `randomUUID()`。
3. **Outbox 允许 profileId=NULL** — `outbox.ts:32` optional，
   `listPendingMutations:129` 有 `OR profileId IS NULL`。

下一个可用 migration 版本：**85**（当前最高 84）。

## 更严重的第 4 项（我核查中发现，你未列出）

**上行链路完全断开：`enqueueMutation` / `withMutation` 在业务代码中调用次数为 0。**

```
grep -rn "enqueueMutation\|withMutation" backend/src/ --exclude-dir=sync  →  空
grep -rln "INSERT INTO sync_outbox" backend/src/db/                        →  空（无触发器）
```

含义：
- `sync_changes_v2` 有 12 个触发器 → **服务端**变更能被其他设备拉取（下行完整）
- `sync_outbox` 没有任何写入路径 → **本地**变更永远推不出去（上行断开）

所以当前状态是「Server → Local 单向」，而非 Local-first 双向同步。
这是 Phase 11「只做上传不算完成」的镜像问题：只做了下载。
Phase 4 的 26 项引擎测试全部用 `enqueueMutation` 手工造数据，因此测试全绿掩盖了这个断点。

**修法**：需要新增一组 outbox 触发器（复用 v66/v82 已验证的 DB Trigger 思路），
条件为「flag on + 存在 active profile + 未被抑制」。这也正好满足你阶段 C
「仅此设备绝不写 Outbox」的要求。

## 其余现状

- **Mobile**：`frontend/android` + `frontend/ios` 原生工程存在，Capacitor **8.3.1**。
  未引入任何 Native SQLite（`@capacitor-community/sqlite` 8.1.1 的 peer 为 `>=8.0.0`，兼容）。
  `localRepository.ts` 目前只有抽象层。
- **个人模块**：`tasks`/`diaries`/`habits`/`note_versions`/`ai_chat_*` 等均未接 Sync V2。
- **Workspace**：`workspace_members`/`note_acl`/`notebook_members` 未接 Sync V2。
- **Lite 迁移**：只有 `liteMigrationStatus` 状态字段，无真实搬数据实现。
- **Legacy**：`legacyCleanup.ts` 只有清单与守卫。

## 环境注意事项

- `better_sqlite3.node` 的 ABI 127 副本被 `f6fbcb83a`（清理遮蔽 Electron ABI 的 SQLite 模块）
  移除，导致所有后端 DB 测试无法运行。已重新放置到
  `node_modules/better-sqlite3/build/`（bindings 优先级高于 `build/Release/`），
  不影响 Electron 打包用的那份。**这是本地 node_modules 改动，不入库。**
  若该提交是有意为之，需另找方案（例如测试时用 electron-rebuild 或独立 venv）。
- `git commit` 后 ref 不自动推进，需手改 `.git/packed-refs`。
- `git push` 需交互式凭据，此环境不可用。
