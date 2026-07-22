# Share Comments 旧库升级崩溃修复设计

## 背景

用户从 1.3.1 升级到 1.3.8 后，后端在数据库初始化阶段持续报错：

```text
SqliteError: no such column: sourceType
```

旧数据库已经存在 `share_comments` 表，但没有 `sourceType`、`sourceId` 和 `isHidden` 字段。`initSchema` 使用 `CREATE TABLE IF NOT EXISTS`，不会为已有表补列，却立即创建依赖 `sourceType` 和 `sourceId` 的 `idx_share_comments_source` 索引。异常发生后，负责补列的 v50 迁移无法执行。

## 目标

- 允许缺少上述新字段的旧数据库正常启动并完成 v50 迁移。
- 保留旧评论数据。
- 新数据库仍能获得 `idx_share_comments_source` 索引。
- 修改范围仅限本次迁移顺序问题及其回归测试。

## 方案

从 `initSchema` 的基线 SQL 中移除 `idx_share_comments_source` 的创建，并添加中文注释说明该索引由 v50 迁移负责。

v50 迁移继续按现有顺序执行：

1. 使用 `addColumnIfMissing` 补齐 `sourceType`、`sourceId` 和 `isHidden`。
2. 创建 `idx_share_comments_source`。

不提前手工补列，也不调整 `initSchema` 与全部迁移的整体执行顺序。

## 回归测试

新增一个完整初始化路径测试：

1. 在临时 SQLite 文件中创建旧版 `share_comments` 表，不包含三个新字段，并写入一条旧评论。
2. 设置 `DB_PATH` 后调用真实的 `getDb()`。
3. 修复前应稳定失败并出现 `no such column: sourceType`。
4. 修复后断言：
   - `getDb()` 成功返回；
   - 三个字段已存在；
   - `idx_share_comments_source` 已存在；
   - 旧评论数据仍然存在。

## 验证

- 先运行新增测试并确认红灯来自当前索引顺序缺陷。
- 实施最小生产代码修改后确认新增测试通过。
- 运行数据库迁移相关测试和后端完整测试，确保没有回归。

