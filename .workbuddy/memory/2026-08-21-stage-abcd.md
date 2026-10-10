# Local-first 阶段 A~D 完成记录（2026-08-21）

分支 `release/v1.5.0`。起点 `134ad5c08`，当前 HEAD `18dec48d8`。

## 本轮提交（3 个）

```
18dec48d8  阶段 D：Bootstrap/Reconcile（v89）      9 files, +1599
747f5a778  阶段 A+B+C：身份与队列语义（v88）      12 files, +1088 -89
c84382b4b  上行链路修复（v87）— 上一轮            3 files, +764
```

## 阶段 A：Active Profile 唯一性 ✅

- DB：`idx_sync_profiles_single_active`（partial unique index，
  已验证 SQLite 3.49.2 支持，enabled=0 可多行）
- 业务：新增 `switchActiveProfile()` 作为**启用 Profile 的唯一入口**，
  事务内先全部停用再启用。顺序不可颠倒 —— 先启用会瞬间存在两个
  enabled=1 直接触发索引冲突
- 新增 `disableAllProfiles()` / `getActiveProfile()`
- `setProfileEnabled` 标 `@internal`
- 脏数据：多个 enabled 时**全部停用**（不猜用户想要哪个服务器）
- 路由 `sync-local.ts` 已改用新 API

## 阶段 B：Installation-scoped Device ID ✅

- `sync_device_identity`（singletonKey CHECK=1 单例）+ `sync_profile_devices`（membership）
- 迁移**复用最早的 deviceId**：服务端已记录的设备关系继续有效；
  规则与 v87 `sync_v2_local_device` 视图一致，触发器取值不变
- `sync_devices` 保留不动（服务端 applied mutation 的 origin deviceId 不该被重写）
- `ensureInstallationDevice()` / `getInstallationDeviceId()` / `listProfileDevices()`
- `touchDevice` 更新全部 membership
- 诊断路由 3 处 `sync_devices` 查询已迁移

## 阶段 C：Outbox profileId NOT NULL ✅

- 重建 `sync_outbox` 施加 NOT NULL
- `enqueueMutation` 的 profileId 必填 + 运行时守卫
- 删除 `listPendingMutations` 的 `OR profileId IS NULL` 分支
- 外键 SET NULL → CASCADE
- 旧 NULL 条目归档到 `sync_outbox_legacy_unbound`

**踩过的坑**：v87 的 18 个触发器定义在业务表上但写入 `sync_outbox`，
直接 `DROP TABLE` 会让它们变悬空引用，之后任何业务写入都报
`no such table: main.sync_outbox`。解法是把 v87 安装逻辑抽成
`installSyncOutboxCaptureTriggers()`，v88 按
**卸触发器 → 重建表 → 装回触发器** 执行，末尾再覆盖设备视图。

## 阶段 D：Bootstrap / Reconcile ✅（v89）

- 状态机 `pending→preparing→pulling→reconciling→pushing→verifying→ready`（+failed）
- 进度落库（`bootstrapStatus`/`bootstrapCursor`/`bootstrapSequence`），resumable
- 合并规则：ID 只在一边→同步；同 ID 同内容→跳过；**同 ID 异内容→冲突台账**
- 禁止标题匹配（不同 ID 即不同实体）；禁止 LWW
- `note_tag`/`favorite` 例外：复合 ID 编码全部信息，不构成冲突
- `version`/`updatedAt` 差异不算冲突
- sequence high-water：`plan(N) → snapshot(at N) → changes(after N)` 收敛
- Change Feed 无 payload，verifying 阶段先收清单再从 snapshot 补内容
- **引擎前置闸门**：`bootstrapStatus !== 'ready'` 时 `reconcileSyncEngine` 不启动
- 新增 API：`POST/GET /api/sync/local/bootstrap`、`POST .../bootstrap/reset`
- 迁移兼容：已启用的旧 Profile 视为 ready（否则触发器停写 = 静默中断同步）

## 测试

| 文件 | 项数 |
|---|---|
| sync-v2-bootstrap（新） | 23 |
| sync-v2-identity-outbox（新） | 20 |
| sync-v2-outbox-capture | 12 |
| Sync V2 全套合计 | **163 全绿** |
| 迁移 + 业务回归 | 14 全绿 |

backend tsc 干净。

**修正的旧测试语义**（都是断言了被废除的错误行为，改为验证新契约而非放宽断言）：
- "profileId 为空在开启后一并补传" → 验证被拒绝
- "不同 Profile 拥有各自独立的设备关系"（`assert.notEqual`）→ 反转为共享 deviceId
- 11 项因 v89 闸门失败 → 补 `markReady()` 显式置位

## 迁移版本

当前最高 **89**。下一个可用：**90**。

**务必用运行时读取**（`knowledgeTreeScopeTriggerRepairMigration` 用常量声明
版本号，按字面量 grep 会漏）：
```bash
cd backend && cat > vc.mjs <<'EOF'
const m = await import("./src/db/migrations.ts");
const vs = m.MIGRATIONS.map(x => x.version).sort((a,b)=>a-b);
console.log("最高:", vs[vs.length-1], "重复:", vs.filter((v,i)=>vs.indexOf(v)!==i));
EOF
node --import tsx ./vc.mjs; rm vc.mjs
```

## 未完成：阶段 E~P（11 项）

E Lite 真迁移 / F 桌面收口 / G 剪藏闭环验证 / H 附件二进制 /
I Mobile Native / J 个人模块 / K Workspace / L Realtime /
M Conflict 完善 / N Backup 对账 / O 凭据隔离 / P Legacy 收口

阶段 E 是下一步，它依赖 D 已完成的 Bootstrap（Lite 迁移的最后一步就是
下载完数据后走 Bootstrap 建立基线）。

## 环境注意事项

- `git commit` 后 ref 时而不推进 → 手改 `.git/packed-refs`，SHA 取
  `.git/logs/refs/heads/release/v1.5.0` 尾行
- `git push` 需交互式凭据，此环境不可用；`origin/release/v1.5.0` 仍在 `d5d0294c`
- `better_sqlite3.node` ABI 127 副本需放在 `node_modules/better-sqlite3/build/`
  （用户已确认可保留，不入库，不影响 `build/Release/` 的 Electron 版本）
- 测试输出极长，用 `tail` 比 `grep` 可靠
- 备份：`nowen-stage-abc-v88.tar.gz`、`nowen-stage-d-v89.tar.gz`
