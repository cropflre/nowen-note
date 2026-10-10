# Local-first 完整重构：进度记录（2026-08-20 晚）

分支 `release/v1.5.0`。起始 HEAD `134ad5c0`，当前 HEAD `c84382b4b`。

## 已完成

### 1. Git 环境修复 ✅

单个损坏 Codex checkpoint ref：
```
refs/codex/turn-diffs/checkpoints/e86959ca…/940467e8…/1786701874210/0d3fc2a7-cdb0-4dbb-a403-6d64219db0e2
→ 994fd81a18e7543ed7b83500e3759cad460ff8f2（对象不存在）
```
核实无分支可达、非 branch/tag/源码，同命名空间另 3 个 ref 完好 → `git update-ref -d`。
`git fetch origin` 恢复正常，`git fsck --full` 无损坏。
备份：`.workbuddy/memory/git-corrupted-ref-backup-2026-08-20.md`
`origin/main` 现为 `fd17d980f`（按要求暂不 merge）。

### 2. 上行链路修复（commit c84382b4b，migration v87）✅

**这是核查中发现的、用户未列出的第 4 项遗留问题，比原三项更严重。**

问题：`enqueueMutation`/`withMutation` 在业务代码中调用次数为 0，
也没有 outbox 触发器 → 本地变更从来没有任何路径进入 `sync_outbox`。
当前状态实际是「Server → Local 单向」。Phase 4 的 26 项引擎测试全部用
`enqueueMutation()` 手工造数据，因此测试全绿掩盖了这个断点。

修法：新增 18 个 `sync_outbox_*` 触发器（复用 v66/v82/v84 的 DB Trigger 思路），
覆盖 notebook/note/tag/note_tag/favorite/attachment 的 insert/update/delete。

四条件闸门（`sync_v2_should_enqueue` 视图）：
1. 抑制开关关闭（防 Pull→Apply→Push 回环）
2. 存在启用的 SyncProfile ← **这就是「仅此设备绝不写 Outbox」的落地点**
3. `bootstrapStatus='ready'`（列不存在时视为 ready，为阶段 D 预留）
4. `workspaceId IS NULL`

测试：`sync-v2-outbox-capture.test.ts` **12 项**，全部通过真实业务表 CRUD 驱动，
不调用任何 sync API 造数据。Sync V2 回归 108 项 + 迁移业务 14 项通过。

## 关键事实：迁移版本号

**真实最高版本是 87（我的 v87 之前是 86）。**
`knowledgeTreeScopeTriggerRepairMigration` 用常量
`KNOWLEDGE_TREE_SCOPE_TRIGGER_REPAIR_SCHEMA_VERSION` 声明版本号，
**按 `version: [0-9]+` 字面量 grep 会漏掉它**（我第一次就踩了，写成 85 导致重复）。

正确做法（务必用这个）：
```bash
cd backend && cat > vc.mjs <<'EOF'
const m = await import("./src/db/migrations.ts");
const vs = m.MIGRATIONS.map(x => x.version).sort((a,b)=>a-b);
console.log("最高:", vs[vs.length-1], "重复:", vs.filter((v,i)=>vs.indexOf(v)!==i));
EOF
node --import tsx ./vc.mjs; rm vc.mjs
```

## 未完成（按用户原始阶段划分）

- 阶段 A：Active Profile 唯一性 —— 已确认 `profile.ts:83 setProfileEnabled` 是公开旁路，
  `sync_profiles` 无 partial unique index。已验证 SQLite 3.49.2 支持
  `CREATE UNIQUE INDEX … WHERE enabled=1` 且行为正确（多个 enabled=0 允许）。
- 阶段 B：Installation-scoped Device ID —— `device.ts:30` 按 profileId 查、缺失即 randomUUID()。
  注意 v87 的 `sync_v2_local_device` 视图已按「最早创建」取值，阶段 B 替换实现时取值不变。
- 阶段 C：Outbox profileId NOT NULL —— `outbox.ts:32` optional、`listPendingMutations:129`
  有 `OR profileId IS NULL`。v87 已保证新数据必带 profileId，剩下是 rebuild 表 + 归档旧 NULL 数据。
- 阶段 D~P：Bootstrap/Reconcile、Lite 真迁移、Clipper 闭环验证、Attachment binary、
  Mobile Native、个人模块、Workspace、Realtime、Conflict、Backup、Credentials、Legacy 收口
  —— 全部未开始。

## 用户已确认的三项决策

1. 优先补上行链路（已完成），再 A→B→C→D
2. Phase 10：共享 TS 层 + Android 验证；iOS 原生构建列入人工清单，报告写明「未经构建验证」
3. `better_sqlite3.node` ABI 127 副本可保留在本地 `node_modules/better-sqlite3/build/`
   （不入库，不影响 `build/Release/` 里 Electron 用的那份）

## 环境注意事项

- `git commit` 后 ref 时而不推进 → 手改 `.git/packed-refs`，SHA 取
  `.git/logs/refs/heads/release/v1.5.0` 尾行。
- `git push` 需交互式凭据，此环境不可用。
- 工作区有用户自己的其他改动（`backend/scripts/run-tests-serial.mjs`、
  `apiTokenUsageMigration.ts` 等），提交时须精确 `git add` 指定文件，不要 `git add -A`。
- 测试输出极长，用 `tail` 比 `grep` 可靠；`note-delete-attachments.test.ts` 单文件约 103 秒。
