# 2026-08-21 Local-first 阶段 E~P 实施记录

## 提交

```
615221d35  阶段 N/O/P：备份对账 + Flag 默认开启 + QA 清单       6 files, +387 -33
97c24b8df  阶段 F/G/J/L/M：个人数据全量同步 + 实时通知（v90）  15 files, +1808 -11
785e373b3  阶段 E+H：附件二进制 + Lite 真迁移                  14 files
18dec48d8  阶段 D：Bootstrap/Reconcile（v89）
747f5a778  阶段 A+B+C：身份与队列语义（v88）
c84382b4b  上行链路修复（v87）
```

分支 `release/v1.5.0`。**未 push**（环境需交互式凭据）。
`origin/release/v1.5.0` 仍在 `d5d0294c`。

## 迁移版本

当前最高 **90**。下一个用 91，但**务必用运行时读 MIGRATIONS 确认**：

```bash
cd backend && cat > vc.mjs <<'EOF'
const m = await import("./src/db/migrations.ts");
const vs = m.MIGRATIONS.map(x => x.version).sort((a,b)=>a-b);
console.log("最高:", vs[vs.length-1], "| 重复:", vs.filter((v,i)=>vs.indexOf(v)!==i).join(",") || "无");
EOF
node --import tsx ./vc.mjs; rm -f vc.mjs
```

有迁移用常量声明版本号（knowledgeTreeScopeTriggerRepairMigration），
按 `version: [0-9]+` 字面量 grep 会漏。

## 本轮修复的三个真实缺陷

1. **所有上行同步静默失效（严重）** ——
   v87 建 `sync_v2_local_device` 视图读 `sync_devices`，v88 后设备写入
   `sync_device_identity`，视图返回 NULL → `sync_v2_should_enqueue` 恒为 0
   → 本地变更永不进 Outbox，无任何错误提示。v90 修正为以安装级身份为准。
   **是阶段 J 的 Outbox 断言暴露的 —— 只测"能 apply"永远发现不了。**

2. **已开启同步时新增附件永不上传** ——
   `registerLocalAttachment` 的 ON CONFLICT 只更新 profileId 不动 status，
   v84 触发器先建的 `local` 状态行永不提升为 `pending`。
   修为只把 local → pending，其余状态一律不动。

3. **恢复备份后会丢失远端新数据** ——
   旧游标让引擎误认为"备份后的远端变更都已应用"。
   新增 `markSyncNeedsReconcile()` 接在 `restoreFromBackup` 统一出口。

## SQLite 表重建的两个坑（已踩两次）

1. **必须先卸掉相关触发器**。DROP TABLE 让触发器悬空，
   且重建过程本身（含 `SELECT ... FROM 旧表`）就会触发它们，
   报 `no such table: main.sync_outbox`。
   为此抽出 `installSyncChangesV2Triggers()` / `installSyncOutboxCaptureTriggers()`。

2. **sequence 必须原值保留**。客户端游标指向这些序号，
   重新编号会让所有设备游标失效并触发全量重拉。

3. **entityType CHECK 分布在三张表**：`sync_changes_v2` / `sync_outbox` /
   `sync_conflicts`。漏一张的后果各不相同（收不到 / 存不了 / 冲突丢失）。

## 测试环境注意

`better_sqlite3.node` 是为 Electron（ABI 130）编译的，与 Node 22（ABI 127）
不匹配。需把 ABI127 副本放到 `node_modules/better-sqlite3/build/`
（bindings 优先级高于 `build/Release/`），不触碰 Electron 那份。
源文件在 `/tmp/bs3probe/out/build/Release/better_sqlite3.node`。

提交后 ref 常不自动推进，需手改 `.git/packed-refs`（reflog 里能取到 SHA）。

## 测试基线

- Sync V2 全套 **205 项**
- Electron **63 项**
- 业务与迁移回归 63 项
- backend / frontend tsc 干净

## 明确未完成

- **阶段 I（Mobile Native Local-first）** —— Android / iOS 仍 Server-first，
  `localRepository.ts` 只是抽象层。Capacitor 8 兼容
  `@capacitor-community/sqlite@8.1.1`（已验证），但未引入。
- **阶段 K（Workspace Local-first）** —— 协议层已显式拒绝 workspaceId，
  触发器已过滤工作区数据。ACL / 成员变更 / 离线权限撤销未实现。
- **阶段 P 的删除部分** —— Legacy 代码全部保留（按用户决定）。
- 前端 Lite 迁移向导 UI、三方合并编辑器。

QA 清单：`docs/LOCAL_FIRST_QA_CHECKLIST.md`（14 模块约 120 项，尚未执行）。
