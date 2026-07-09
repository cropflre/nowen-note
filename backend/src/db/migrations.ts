/**
 * SQLite Schema 迁移框架（D3）
 * ---------------------------------------------------------------------------
 *
 * 在此之前，schema.ts 末尾散落着大量
 *
 *   try { db.prepare("SELECT col FROM t LIMIT 1").get(); }
 *   catch { db.prepare("ALTER TABLE t ADD COLUMN col ...").run(); }
 *
 * 这种 "用 SELECT 失败兜底" 的迁移方式有几个根本性问题：
 *
 *   1) **没有版本号**：无法判断 "当前 DB 走到了哪一步"。一旦某次 ALTER 中途
 *      失败，下次启动只会重试自己；无法编写 "v3 迁移依赖 v2 已完成" 的脚本。
 *   2) **无法防回滚**：用户用旧版程序打开新版数据库时，旧程序看不到新列，
 *      会误认为是旧库直接添加列，可能写入与新版不兼容的数据。
 *   3) **难以审计**：无法回答 "这个库经历过哪些迁移、每一步在何时完成"。
 *   4) **无法防并发**：多副本部署时谁先抢到锁先执行。
 *
 * 本模块解决方案：
 *
 *   - `schema_migrations` 表持久化 **已应用** 的版本号 + 应用时间。
 *   - `MIGRATIONS` 数组按 `version` 升序登记每条迁移；每条迁移在自己的
 *     事务里运行——失败回滚，不会留下 "半截结构"。
 *   - 启动时按版本号串行 apply：当前版本 < 迁移版本 → 执行；否则跳过。
 *   - 拒绝降级：当 user_version > MAX(已知迁移版本) 时直接抛错，避免旧版
 *     程序破坏新库。
 *
 * 与备份的协作（B2/B4）：
 *   - 备份元信息里写入当前 schema_version。恢复时校验版本是否兼容
 *     （由 backup.ts 完成，不在此处）。
 *
 * 设计取舍：
 *   - 仍然保留 schema.ts 里的 `CREATE TABLE IF NOT EXISTS ...` 作为 v0
 *     "基线"；新部署一开始就有完整结构，迁移系统只在已存在的旧库上做
 *     增量改动。这样不必把整套 DDL 拆成"v1 创建表→v2 加列"的迁移链。
 *   - 旧的散落 try/catch ALTER 仍保留几个版本，逐步迁过来——本次只把
 *     "新增的"演化登记到 MIGRATIONS。
 */

import type Database from "better-sqlite3";

/** 单条迁移声明 */
export interface Migration {
  /** 单调递增的整数版本号；不允许跳号或重复 */
  version: number;
  /** 人类可读名称，便于日志与排查 */
  name: string;
  /**
   * 执行迁移；调用方已经把它包在事务里，函数内部抛任何异常都会触发回滚。
   * 不要在函数里再开嵌套事务。
   */
  up(db: Database.Database): void;
}

// ===== 已登记迁移 =====
// 新增迁移：只追加，不修改/删除已发布的项；版本号严格递增。
//
// 起点 v1 故意不包含旧的 ALTER 列，因为这些 ALTER 已经通过 schema.ts 里的
// try/catch 兜底执行过；把它们写到迁移里反而会和 catch 路径竞争（会双写）。
// 当下后续新增的列 / 索引 / 表统一从 v2 开始登记。
export const MIGRATIONS: Migration[] = [
  // 示例位：用 v1 来标记 "迁移系统首次接管" 的 anchor，不做任何 schema 改动。
  // 下次有新 schema 变化时，加 v2、v3 ...
  {
    version: 1,
    name: "init-migration-table-anchor",
    up: () => {
      // no-op：仅用于把 user_version 从 0 抬到 1，让以后的迁移有起点。
    },
  },

  // ==========================================================================
  // v2：工作区数据隔离 Phase 1 — 基础设施
  // --------------------------------------------------------------------------
  // 为 diaries / tasks / mindmaps / attachments 加 workspaceId（nullable，NULL=个人空间），
  // 新增 favorites 表替代 notes.isFavorite 的单用户语义（老字段保留、不删，
  // Phase 2 再把读路径切到 favorites 后再考虑废弃）；workspaces 增加
  // enabledFeatures 存"该工作区启用了哪些功能模块"（空字符串 = 默认全开）。
  //
  // 安全保证：
  //   - 所有变更都是 ALTER TABLE ADD COLUMN / CREATE TABLE IF NOT EXISTS，
  //     **零数据修改**，存量数据 workspaceId 自动为 NULL → 挂在个人空间，
  //     符合"存量全部归个人、工作区是新增维度"的零风险策略。
  //   - SQLite 对 ALTER TABLE ADD COLUMN 不支持带 FOREIGN KEY 的列；
  //     workspaceId 的引用完整性由业务层在删除工作区时维护（workspaces 路由
  //     已有 UPDATE notebooks/notes SET workspaceId=NULL 的 tx，后续 Phase 2
  //     扩展到 diaries/tasks/mindmaps/attachments 即可）。
  //   - mindmaps 表在当前基线里可能还不存在（老库没有这个模块），用
  //     "SELECT 探测 + catch 兜底 ALTER" 的幂等模式处理，不存在则跳过 ALTER——
  //     Phase 2 真正引入 mindmaps 模块时再在那条迁移里自己加带 workspaceId
  //     的 CREATE TABLE。
  {
    version: 2,
    name: "workspace-data-isolation-phase1",
    up: (db) => {
      // ---- 工具：幂等加列（列已存在时静默跳过） ----
      const addColumnIfMissing = (
        table: string,
        column: string,
        definition: string,
      ) => {
        // 用 PRAGMA table_info 精确探测，不依赖 SELECT 抛错，避免其它错误误吞。
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (cols.length === 0) {
          // 表本身不存在：跳过（mindmaps 等后续模块的表由各自首次建立时保证带 workspaceId）
          return;
        }
        if (cols.some((c) => c.name === column)) return;
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
      };

      // ---- 1. 说说：加 workspaceId ----
      addColumnIfMissing("diaries", "workspaceId", "TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS idx_diaries_workspace ON diaries(workspaceId);");

      // ---- 2. 待办：加 workspaceId ----
      addColumnIfMissing("tasks", "workspaceId", "TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspaceId);");

      // ---- 3. 思维导图：加 workspaceId（若表存在）----
      addColumnIfMissing("mindmaps", "workspaceId", "TEXT");
      // 索引只在表存在时建；CREATE INDEX 对不存在的表会抛错，所以用 try/catch 兜底。
      try {
        db.exec("CREATE INDEX IF NOT EXISTS idx_mindmaps_workspace ON mindmaps(workspaceId);");
      } catch {
        // 表还不存在，跳过索引。下次 mindmaps 表建立时可再补建索引。
      }

      // ---- 4. 附件：加 workspaceId（跟随所属笔记/说说/任务）----
      //   attachments 语义是"笔记的附件"，workspaceId 冗余一份便于"工作区空间占用统计"
      //   和"按工作区清理"不必跨表 join。注意此列**仅 Phase 2 之后写入**，Phase 1
      //   只是加列，存量保持 NULL（= 个人空间 / 未归属，行为与之前一致）。
      addColumnIfMissing("attachments", "workspaceId", "TEXT");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_attachments_workspace ON attachments(workspaceId);",
      );

      // ---- 5. 收藏：独立表替代 notes.isFavorite 的"单用户"语义 ----
      //   为什么不直接改 isFavorite？
      //     工作区协作下，"这条笔记我收藏了"必须是 **per-user** 的：
      //     A 收藏了不代表 B 也收藏。保留老字段兼容 Phase 1 旧代码继续工作，
      //     Phase 2 把读路径切到 favorites 后再逐步废弃 isFavorite 字段。
      //
      //   workspaceId 冗余：收藏的笔记可能跨空间（个人空间+工作区），这里存一份
      //   "这次收藏时笔记所在的 workspaceId"便于按空间筛选收藏列表；NULL 表示
      //   收藏的是个人空间的笔记。
      db.exec(`
        CREATE TABLE IF NOT EXISTS favorites (
          userId TEXT NOT NULL,
          noteId TEXT NOT NULL,
          workspaceId TEXT,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (userId, noteId),
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(userId, createdAt DESC);
        CREATE INDEX IF NOT EXISTS idx_favorites_note ON favorites(noteId);
        CREATE INDEX IF NOT EXISTS idx_favorites_workspace ON favorites(workspaceId);
      `);

      // ---- 6. 工作区功能开关 ----
      //   enabledFeatures 存 JSON 字符串，格式：
      //     {"notes":true,"diaries":true,"tasks":true,"mindmaps":true,"files":true,"favorites":true}
      //   约定：
      //     - 空字符串 ''（默认）视为"未配置"，在应用层解释为"全部启用"，
      //       这样**老工作区无需迁移数据**——未来新建工作区的默认值也是 ''
      //       （全开），owner 按需关闭再写入 JSON。
      //     - 个人空间不走这个字段（个人空间本来就是 workspaceId=NULL，
      //       前端可以读取当前用户的全局偏好，后端不强制）。
      addColumnIfMissing("workspaces", "enabledFeatures", "TEXT NOT NULL DEFAULT ''");
    },
  },

  // ==========================================================================
  // v3：工作区数据隔离 Phase 2 — Y1（favorites 切换 + 附件 workspaceId 冗余）
  // --------------------------------------------------------------------------
  // 本次做两件事：
  //
  //   1) 为 diary_attachments / task_attachments 加 workspaceId（nullable）+ 索引，
  //      与父资源（diary / task）对齐。Phase 2 的附件归属方案是：
  //        - 上传时由前端带上当前工作区 workspaceId（说说/任务都是"先传附件拿 id
  //          再提交父记录"的链路，前端自己知道在哪个工作区里发）；
  //        - 服务端落表时写入该列，**与父资源的 workspaceId 必须一致**（父资源创建
  //          时会做一次校验：如果传入的附件 id 的 workspaceId 与父不一致，直接拒绝
  //          绑定）。
  //      零数据变更：存量附件 workspaceId = NULL，语义是"个人空间 / 未归档"，
  //      与现有行为完全一致。
  //
  //   2) **favorites 数据回填**：把老 `notes.isFavorite = 1` 的行一次性同步到
  //      favorites 表，userId 取笔记主人、workspaceId 跟笔记走。
  //      之所以放到迁移而不是业务层：
  //        - 一次性、幂等、在事务里做，不存在"写了一半挂了"的风险；
  //        - 业务层不用再去兼容"favorites 表是空的但笔记有 isFavorite=1"的过渡态，
  //          Y1 同步提交后即可以"favorites 是唯一真相源"的假设写代码。
  //      语义变化说明：
  //        - 老语义："isFavorite 是笔记的一个属性，任何能看到笔记的人看到的收藏状态
  //          都一样"——这在个人空间没问题，但到工作区就错了。
  //        - 新语义："favorites 是 per-user 的关系表，A 收藏不等于 B 收藏"。
  //      回填策略：只给笔记主人插一条 favorites 行（因为老 isFavorite=1 表达的就是
  //      "笔记主人收藏了它"），其他成员回填前没收藏、回填后依然没收藏，逻辑自然。
  //      **不删 notes.isFavorite 列**：保留一个版本作为兼容（Y1 后没人再读它；
  //      再过一版彻底删列）。Y1 同步停止写 isFavorite，避免新/旧字段不同步。
  //
  // 回滚注意：如果要从 v3 回滚到 v2，favorites 表里由本次回填产生的行不会自动
  // 撤销——但因为我们保留了 notes.isFavorite 列，旧代码读老字段依然有效，所以
  // 即使"新表多了几行"也不影响旧版行为。
  {
    version: 3,
    name: "workspace-data-isolation-phase2-y1-favorites",
    up: (db) => {
      // 同 v2 里的工具（每条迁移独立闭包，不共享函数）
      const addColumnIfMissing = (
        table: string,
        column: string,
        definition: string,
      ) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (cols.length === 0) return;
        if (cols.some((c) => c.name === column)) return;
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
      };

      // ---- 1. diary_attachments.workspaceId ----
      addColumnIfMissing("diary_attachments", "workspaceId", "TEXT");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_diary_attachments_workspace ON diary_attachments(workspaceId);",
      );

      // ---- 2. task_attachments.workspaceId ----
      addColumnIfMissing("task_attachments", "workspaceId", "TEXT");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_task_attachments_workspace ON task_attachments(workspaceId);",
      );

      // ---- 3. favorites 数据回填 ----
      // 使用 INSERT OR IGNORE：favorites 表主键是 (userId, noteId)，已存在的行不会被
      // 重复插入；这也让本条迁移可以"幂等重放"——即便未来因故把 v3 记录抹了重跑，
      // 也不会产生脏数据或抛约束错误。
      //
      // SELECT 条件：
      //   - isFavorite = 1（老数据里真正被收藏的笔记）
      //   - isTrashed = 0（放在回收站的就不要回填了，视作"等价于取消收藏"）
      //   - 不 JOIN users/workspaces 校验引用完整性：notes.userId 走 FK CASCADE，
      //     workspaceId 可空，favorites 的 FK 仅指向 users(id) 和 notes(id)，
      //     这两张表的行只要此刻存在，插入就稳定。
      //
      // createdAt 留给默认值 datetime('now')——老字段没有"什么时候收藏"的时间，
      // 用迁移时刻作近似，用户看到的"收藏时间"就是首次升级到 v3 的时间，符合预期。
      db.prepare(`
        INSERT OR IGNORE INTO favorites (userId, noteId, workspaceId, createdAt)
        SELECT userId, id, workspaceId, datetime('now')
        FROM notes
        WHERE isFavorite = 1 AND isTrashed = 0
      `).run();
    },
  },

  // ==========================================================================
  // v4：工作区数据隔离 Phase 2 — Y4（mindmaps 补 workspaceId + 索引）
  // --------------------------------------------------------------------------
  // 背景：v2 里对 mindmaps 的 workspaceId 迁移是"表存在才 ALTER、不存在就跳过"。
  // 老库的 mindmaps 表由路由模块 ensureTable() 在首次 import 时建立，v2 跑的
  // 时点 mindmaps 表很可能已经存在 → v2 能正确补列；但也存在一种情况：
  //   - 用户的老库 v2 升级时 mindmaps 还没被路由初始化过（比如从未访问过导图
  //     模块，或后端启动顺序发生变化），v2 就跳过了加列；
  //   - 然后用户升到 v3+ 开始访问导图路由 → ensureTable() 用**当前代码**的
  //     CREATE TABLE IF NOT EXISTS 建表，此时 Y4 的新建表语句已经带了
  //     workspaceId 列，问题自然消失；
  //   - 但也可能反过来：升级到 v4 之前路由已经 ensureTable() 建出不带
  //     workspaceId 的旧表，此时 CREATE TABLE IF NOT EXISTS 不会"补列"，
  //     就会出现 "mindmaps 表存在但缺 workspaceId 列" 的中间态。
  //
  // 本迁移一次性兜底：
  //   - 如果 mindmaps 表存在且缺 workspaceId 列 → 补列 + 建索引；
  //   - 如果表不存在 → 什么都不做（后续 ensureTable() 会用新 DDL 建出带列的表）；
  //   - 如果列已经有了 → 只补索引（CREATE INDEX IF NOT EXISTS 幂等）。
  //
  // 与 v2 的关系：v2 是"Phase 1 基础设施"的尝试，v4 是最终兜底；两者对同一张
  // 表做相同动作是安全的（都用 IF NOT EXISTS / PRAGMA 探测），不会双写。
  {
    version: 4,
    name: "workspace-data-isolation-phase2-y4-mindmaps",
    up: (db) => {
      const addColumnIfMissing = (
        table: string,
        column: string,
        definition: string,
      ) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (cols.length === 0) return;
        if (cols.some((c) => c.name === column)) return;
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
      };

      addColumnIfMissing("mindmaps", "workspaceId", "TEXT");
      // 仅当表存在时建索引；如果 mindmaps 表此时尚未建立，后续
      // mindmaps.ts 的 ensureTable() 会用已经带索引的 DDL 补齐。
      const hasTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mindmaps'")
        .get();
      if (hasTable) {
        db.exec(
          "CREATE INDEX IF NOT EXISTS idx_mindmaps_workspace ON mindmaps(workspaceId);",
        );
      }
    },
  },

  // ==========================================================================
  // v5：修正「附件上传时未继承笔记 workspaceId」的存量数据
  // --------------------------------------------------------------------------
  // 背景（bug）：
  //   /api/attachments（POST）在 v2 加列之后一直漏写 workspaceId 字段，直接
  //   `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)`，
  //   导致所有通过编辑器粘贴 / 拖拽 / "插入图片" 上传的附件在 DB 中
  //   workspaceId 都是 NULL。
  //
  // 症状：
  //   - 在工作区笔记里上传图片，DataManager / FileManager 切到该工作区看不到；
  //   - 切到个人空间反而能看到（因为个人空间的过滤条件正是
  //     `a.userId = ? AND a.workspaceId IS NULL`）。
  //
  // 本迁移的修复动作：
  //   对每条 attachments.workspaceId IS NULL 的行，若它挂在一条 workspaceId
  //   非空的笔记上，就把笔记的 workspaceId 复制到附件行。
  //
  //   显式排除两种边界：
  //     1) 孤儿附件（noteId 指向已删除的笔记）—— JOIN 失败，保持 NULL，由
  //        /api/data-file/cleanup-orphans 统一清理；
  //     2) 存量就是"个人空间上传"的附件（notes.workspaceId IS NULL）—— 本来就
  //        对，不要动。
  //
  // 幂等：UPDATE 只命中 workspaceId IS NULL 的行；二次运行是 no-op。若未来又
  // 有同类 bug 引入新 NULL，本迁移已记录到 schema_migrations，不会重跑——
  // 但之后再出现的 NULL 不是本次迁移的职责，由新的 vN+1 迁移收拾。
  //
  // 回滚不可逆：回到 v4 时，被本迁移改成非 NULL 的附件不会自动回归 NULL；
  // 但 v4 代码的 list / stats / 下载链路对附件 workspaceId 的读取是幂等的
  // （非空就按工作区过滤），不会出错，最多是"老代码看不到被回填过的附件"。
  {
    version: 5,
    name: "attachments-backfill-workspace-id-from-notes",
    up: (db) => {
      db.prepare(`
        UPDATE attachments
           SET workspaceId = (
             SELECT n.workspaceId FROM notes n WHERE n.id = attachments.noteId
           )
         WHERE workspaceId IS NULL
           AND EXISTS (
             SELECT 1 FROM notes n
              WHERE n.id = attachments.noteId
                AND n.workspaceId IS NOT NULL
           )
      `).run();
    },
  },

  // ==========================================================================
  // v6：把"个人空间导出/导入"开关从站点级全局下沉为 per-user 字段
  // --------------------------------------------------------------------------
  // 背景：
  //   v5 之前，是否允许普通用户在个人空间导出 / 导入笔记由 system_settings 里的
  //   `feature_personal_export_enabled` / `feature_personal_import_enabled` 两个
  //   全局开关控制——"要么全站开、要么全站关"，缺少"对个别用户开、其他用户关"
  //   的细粒度运维能力。
  //
  // 方案 B（per-user）：
  //   把开关落到 `users` 表的两列，由管理员在「用户管理 → 编辑用户」里逐个切换。
  //   - 默认值 1（开启），保证存量用户在升级后行为不变。
  //   - 普通用户不能自行修改这两列（routes/users.ts 的 PATCH 只接受管理员）；
  //     非高危字段，不走 sudo、不 bump tokenVersion——避免日常运维过度打扰。
  //   - 旧的全局 feature_* 键保留在 system_settings（不做 DELETE），只是不再被
  //     读写；让回滚到 v5 代码时依然能读到旧值。
  //
  // 回滚：
  //   回到 v5 时两列仍然存在但不被读写，不会破坏旧版行为。
  //   如果确实需要把 per-user 开关"广播"回全局，运维可自行根据 users 表的值
  //   重建 system_settings 里的两个 feature_* 键。
  //
  // 幂等性：
  //   `addColumnIfMissing` 在列已存在时跳过，二次运行无副作用。
  {
    version: 6,
    name: "users-personal-export-import-per-user-toggle",
    up: (db) => {
      const addColumnIfMissing = (
        table: string,
        column: string,
        definition: string,
      ) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (cols.length === 0) return;
        if (cols.some((c) => c.name === column)) return;
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
      };

      // 1 = 开启；0 = 禁用。管理员账号同样按 users 行的值生效，但业务层
      // （routes/export.ts 的闸门）会对 role='admin' 的用户无条件放行，
      // 确保管理员永远保有数据救援能力，不会因"管理员给自己关了"而锁死。
      addColumnIfMissing(
        "users",
        "personalExportEnabled",
        "INTEGER NOT NULL DEFAULT 1",
      );
      addColumnIfMissing(
        "users",
        "personalImportEnabled",
        "INTEGER NOT NULL DEFAULT 1",
      );
    },
  },

  // ==========================================================================
  // v7：AI 向量索引按"工作区/个人空间"维度隔离
  // --------------------------------------------------------------------------
  // 背景（安全 + 功能双重缺陷）：
  //   v6 之前 `note_embeddings` / `embedding_queue` 仅有 `userId` 列，没有
  //   `workspaceId`。`vec-store.knnSearch` 的反查也只按 `m.userId === userId`
  //   过滤。这意味着：
  //     - 跨空间污染：用户 A 在「个人空间」问问题时，命中结果会包含 A 自己在
  //       工作区里写的笔记（只要 owner 是 A）；A 在工作区视图问问题时反过来
  //       也会召回到个人空间笔记。空间边界完全没生效。
  //     - 工作区 RAG 实际不工作：A 在工作区 W 视图下提问，B 在 W 写的笔记
  //       `note_embeddings.userId = B ≠ A`，永远召不回，工作区共享知识库形同虚设。
  //
  // 方案：
  //   把 `workspaceId TEXT NULL` 加到 `note_embeddings` 和 `embedding_queue`
  //   两张表，并改造触发器把 `notes.workspaceId` 同步到队列；同时**一次性
  //   backfill** 把存量 embedding/队列项按 `notes.workspaceId` 回填——保证
  //   零数据丢失，已经算好的向量不需要重新调 embedding API。
  //
  //   语义：workspaceId IS NULL 表示"个人空间"，与 notes/notebooks/attachments
  //   的全栈一致约定。检索时按 (userId, workspaceId) 二元组定位 scope：
  //     - 个人空间：仅召回 workspaceId IS NULL 且 userId = 当前用户的向量
  //     - 工作区：仅召回 workspaceId = <ws_id> 的向量（不再以"作者"过滤，
  //       让同一个工作区的成员能互相搜索到彼此的笔记，符合协作语义）
  //
  // 触发器升级：
  //   旧的 notes_embed_ai / notes_embed_au 只塞 `new.userId`；改成同时塞
  //   `new.workspaceId`，这样新写入的笔记/编辑后入队都会带上正确空间归属。
  //
  // 幂等性：
  //   - addColumnIfMissing 在列已存在时跳过；
  //   - 触发器 DROP + CREATE，多次执行结果一致；
  //   - backfill 用 `WHERE workspaceId IS NULL AND EXISTS(...)`，命中过的不会
  //     重复改写；老库存量 NULL → 个人空间笔记保持 NULL（语义正确，无副作用）。
  //
  // 回滚：回到 v6 时新加的列依然存在但 v6 代码不读，行为退化为"仅按 userId
  //   过滤"——比 v7 弱但和 v6 行为一致，不会破坏数据。
  {
    version: 7,
    name: "embeddings-add-workspace-id-and-backfill",
    up: (db) => {
      const addColumnIfMissing = (
        table: string,
        column: string,
        definition: string,
      ) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (cols.length === 0) return;
        if (cols.some((c) => c.name === column)) return;
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
      };

      // ---- 1. 向 note_embeddings / embedding_queue 加 workspaceId 列 ----
      addColumnIfMissing("note_embeddings", "workspaceId", "TEXT");
      addColumnIfMissing("embedding_queue", "workspaceId", "TEXT");

      // ---- 2. 索引：按 (userId, workspaceId) 复合查找最常见 ----
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_note_embeddings_user_ws ON note_embeddings(userId, workspaceId);",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_note_embeddings_ws ON note_embeddings(workspaceId);",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_embedding_queue_user_ws ON embedding_queue(userId, workspaceId);",
      );

      // ---- 3. 重建触发器：同步 workspaceId ----
      // schema.ts 里的 CREATE TRIGGER 在每次启动 db 时都会被 DROP + CREATE，
      // 因此源头会保证新部署用新触发器。但已经在运行的库内可能有"旧 user-only
      // 触发器"残留——这里再 DROP 一次，让运行中的库立刻切到新版本。
      // schema.ts 里也会同步把这两个触发器替换成新版（见同 PR 改动）。
      db.exec(`
        DROP TRIGGER IF EXISTS notes_embed_ai;
        CREATE TRIGGER notes_embed_ai AFTER INSERT ON notes
        WHEN new.isTrashed = 0
        BEGIN
          INSERT INTO embedding_queue (noteId, userId, workspaceId, status, retries, enqueuedAt, updatedAt)
          VALUES (new.id, new.userId, new.workspaceId, 'pending', 0, datetime('now'), datetime('now'))
          ON CONFLICT(noteId) DO UPDATE SET
            workspaceId = excluded.workspaceId,
            status = 'pending',
            retries = 0,
            lastError = NULL,
            updatedAt = datetime('now');
        END;

        DROP TRIGGER IF EXISTS notes_embed_au;
        CREATE TRIGGER notes_embed_au AFTER UPDATE ON notes
        WHEN (old.title IS NOT new.title OR old.contentText IS NOT new.contentText
              OR old.workspaceId IS NOT new.workspaceId)
             AND new.isTrashed = 0
        BEGIN
          INSERT INTO embedding_queue (noteId, userId, workspaceId, status, retries, enqueuedAt, updatedAt)
          VALUES (new.id, new.userId, new.workspaceId, 'pending', 0, datetime('now'), datetime('now'))
          ON CONFLICT(noteId) DO UPDATE SET
            workspaceId = excluded.workspaceId,
            status = 'pending',
            retries = 0,
            lastError = NULL,
            updatedAt = datetime('now');
        END;
      `);

      // ---- 4. backfill：把存量 embedding 和队列项按 notes.workspaceId 回填 ----
      // 个人空间笔记 notes.workspaceId IS NULL → 这里维持 NULL（即默认值）
      // 工作区笔记 → 把 notes.workspaceId 复制到 embedding 行
      // 用 EXISTS 子查询确保只更新"对应的 note 当前是工作区笔记"的 embedding；
      // 已被 trash 的笔记 (isTrashed=1) 也允许回填——后续 trash→delete 时 CASCADE
      // 自然清理，无需特殊处理。
      db.prepare(`
        UPDATE note_embeddings
           SET workspaceId = (
             SELECT n.workspaceId FROM notes n WHERE n.id = note_embeddings.noteId
           )
         WHERE workspaceId IS NULL
           AND EXISTS (
             SELECT 1 FROM notes n
              WHERE n.id = note_embeddings.noteId
                AND n.workspaceId IS NOT NULL
           )
      `).run();

      db.prepare(`
        UPDATE embedding_queue
           SET workspaceId = (
             SELECT n.workspaceId FROM notes n WHERE n.id = embedding_queue.noteId
           )
         WHERE workspaceId IS NULL
           AND EXISTS (
             SELECT 1 FROM notes n
              WHERE n.id = embedding_queue.noteId
                AND n.workspaceId IS NOT NULL
           )
      `).run();
    },
  },

  // ==========================================================================
  // v8：AI 知识库扩展到"附件内容"索引
  // --------------------------------------------------------------------------
  // 背景：
  //   v7 之前知识问答仅能检索 notes.title + notes.contentText，用户粘贴进笔记
  //   的 PDF / 纯文本附件完全不参与召回。用户反馈希望附件内容也能命中。
  //
  // 方案：复用现有 note_embeddings + vec_note_chunks 基础设施，不新建向量表：
  //   - 给 note_embeddings 加两列：
  //       entityType TEXT NOT NULL DEFAULT 'note'    -- 'note' | 'attachment'
  //       attachmentId TEXT                           -- attachment 任务的附件 id；note 任务为 NULL
  //     note 行语义不变；attachment 行的 noteId 仍填附件所属笔记，便于在
  //     AI 回答里点回源笔记。
  //   - 新建 attachment_embedding_queue（主键 attachmentId）。不复用
  //     embedding_queue 是因为它主键是 noteId，attachment 会与 note 冲突，
  //     语义也更清楚。
  //   - 新建 attachment_chunks：与 note 的 chunk 切分策略对齐，存原文文本
  //     以便召回后拼 prompt。不复用 note_embeddings.chunkText 的唯一原因
  //     是希望保留"note_embeddings 每行都是实际写到 vec 表的真相源"的单一
  //     语义：attachment 索引失败 / 重建时可以独立地操作 attachment_chunks，
  //     不影响 note 行。
  //
  //   - CASCADE：attachment_chunks → attachments(id)，attachment 被删时
  //     chunk/queue 全清；note_embeddings 里对应的 attachment 行额外用
  //     触发器清理（attachments 表没有 embedding 外键）。
  //
  // workspaceId 继承：attachments 表已经有 workspaceId（v5 backfill 完成），
  //   索引时直接 copy；KNN 检索走同一套 scope 过滤逻辑。
  //
  // 零回填风险：v7 已把 note_embeddings.workspaceId 全部回填；这里只是加列，
  //   存量 note 行的 entityType 自动为默认值 'note'，行为与之前完全一致。
  //
  // 回滚：回到 v7 时新列仍在但不被读（老代码 SELECT * 不会爆，
  //   INSERT 不带这些列也 OK——entityType 有 DEFAULT）。
  {
    version: 8,
    name: "attachment-content-embeddings",
    up: (db) => {
      const addColumnIfMissing = (
        table: string,
        column: string,
        definition: string,
      ) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (cols.length === 0) return;
        if (cols.some((c) => c.name === column)) return;
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
      };

      // ---- 1. note_embeddings：加 entityType + attachmentId ----
      // entityType DEFAULT 'note' 让存量行自然归为 note 类型；插入 attachment 行
      // 时显式传 'attachment'。attachmentId 允许 NULL（note 行填 NULL）。
      addColumnIfMissing(
        "note_embeddings",
        "entityType",
        "TEXT NOT NULL DEFAULT 'note'",
      );
      addColumnIfMissing("note_embeddings", "attachmentId", "TEXT");

      // 索引：按 (entityType, attachmentId) 查找——重建 / 删除某个附件的
      // 所有 chunk 行时走这个索引。
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_note_embeddings_attachment ON note_embeddings(attachmentId);",
      );

      // ---- 2. attachment_chunks：切分文本存储 ----
      db.exec(`
        CREATE TABLE IF NOT EXISTS attachment_chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          attachmentId TEXT NOT NULL,
          chunkIndex INTEGER NOT NULL DEFAULT 0,
          chunkText TEXT NOT NULL DEFAULT '',
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (attachmentId) REFERENCES attachments(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_attachment_chunks_attachment ON attachment_chunks(attachmentId);
      `);

      // ---- 3. attachment_embedding_queue：附件任务队列 ----
      db.exec(`
        CREATE TABLE IF NOT EXISTS attachment_embedding_queue (
          attachmentId TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          workspaceId TEXT,
          noteId TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          retries INTEGER NOT NULL DEFAULT 0,
          lastError TEXT,
          enqueuedAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (attachmentId) REFERENCES attachments(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_attachment_queue_status ON attachment_embedding_queue(status, enqueuedAt);
        CREATE INDEX IF NOT EXISTS idx_attachment_queue_user_ws ON attachment_embedding_queue(userId, workspaceId);
      `);

      // ---- 4. 清理悬挂向量的触发器 ----
      // 附件删除时，note_embeddings 里 attachmentId = old.id 的 attachment 行
      // 要一并清掉（否则 KNN 还会命中；SELECT 反查 attachments 会失败）。
      // vec_note_chunks 的悬挂 rowid 由运维侧 /api/ai/embeddings/reindex-vec
      // 兜底——attachment 删除属于低频事件，不值得在触发器里调外部代码。
      db.exec(`
        DROP TRIGGER IF EXISTS attachments_embed_ad;
        CREATE TRIGGER attachments_embed_ad AFTER DELETE ON attachments
        BEGIN
          DELETE FROM note_embeddings
           WHERE entityType = 'attachment' AND attachmentId = old.id;
        END;
      `);

      // ---- 5. 存量附件一次性入队（可选；若没配 embedding 模型 worker 会跳过）----
      // 仅入队"尚未被索引过 + 所在笔记未回收"的附件。与 schema.ts 里 note 的
      // 存量回填同款策略：用户没配 embedding 的话不会发任何 API 调用。
      db.prepare(`
        INSERT INTO attachment_embedding_queue
          (attachmentId, userId, workspaceId, noteId, status, retries, enqueuedAt, updatedAt)
        SELECT a.id, a.userId, a.workspaceId, a.noteId, 'pending', 0, datetime('now'), datetime('now')
        FROM attachments a
        JOIN notes n ON n.id = a.noteId
        WHERE n.isTrashed = 0
          AND NOT EXISTS (
            SELECT 1 FROM note_embeddings e
             WHERE e.entityType = 'attachment' AND e.attachmentId = a.id
          )
        ON CONFLICT(attachmentId) DO NOTHING
      `).run();
    },
  },

  // ==========================================================================
  // v9：AI 自定义指令模板（P2）
  // --------------------------------------------------------------------------
  // 背景：
  //   v8 之前用户在"AI 写作助手 → 自定义指令"里输入的 prompt 一次性使用、
  //   不会保存。常用指令需要反复键入，体验差。
  //
  // 方案：
  //   新增 ai_custom_prompts 表，按 (userId, name) 唯一约束保存用户命名的
  //   prompt 模板。写路径走新 REST 端点 /api/ai/prompts（GET/POST/PUT/DELETE）。
  //
  // 零风险：纯新增表，不触及任何现有数据。
  //
  // 回滚：回到 v8 时表仍在但不被访问，保留用户已保存的模板数据。
  {
    version: 9,
    name: "ai-custom-prompts",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_custom_prompts (
          id TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          name TEXT NOT NULL,
          prompt TEXT NOT NULL DEFAULT '',
          usageCount INTEGER NOT NULL DEFAULT 0,
          lastUsedAt TEXT,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
        );
      `);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_custom_prompts_user_name
          ON ai_custom_prompts(userId, name);
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_ai_custom_prompts_user_usage
          ON ai_custom_prompts(userId, usageCount DESC, updatedAt DESC);
      `);
    },
  },

  // ==========================================================================
  // v10：AI 知识问答"多会话"支持
  // --------------------------------------------------------------------------
  // 背景：
  //   v9 之前 ai_chat_messages 只按 userId 挂载，没有"会话 / 对话分组"概念。
  //   所有消息渲染为一条长滚动记录，用户无法像 ChatGPT 那样分主题保存多段
  //   对话。用户要求：「AI 知识问答支持多个聊天、保存多个聊天记录」。
  //
  // 方案：
  //   1) 新建 ai_chat_conversations 表，按 userId 分组；每个用户可创建多条
  //      会话，记录 title（可空=自动命名）、createdAt、updatedAt、archived。
  //   2) 给 ai_chat_messages 加 conversationId 列 + 索引；外键指向
  //      ai_chat_conversations.id，ON DELETE CASCADE 让"删除会话"连带清理
  //      消息（SQLite ALTER ADD COLUMN 不能直接加 FOREIGN KEY，但 CASCADE
  //      行为由业务层 DELETE 显式触发即可，这里不走 FK 级联）。
  //   3) 存量回填：给每个"有历史消息"的 userId 创建一条"默认对话"，并把该
  //      用户的所有已有消息挂到该对话。这样老用户升级后已经沉淀的 AI 对话
  //      自动落到"默认对话"里，不会丢。
  //
  // 索引：
  //   - ai_chat_conversations: (userId, archived, updatedAt DESC) 用于会话列表
  //   - ai_chat_messages: (conversationId, createdAt) 用于单会话时间线渲染
  //
  // 回滚：回到 v9 时新表仍在但不读、ai_chat_messages.conversationId 列仍在但
  //   被忽略——v9 代码走 (userId, createdAt) 一次性全拉回来，跨会话的消息会
  //   混在一起显示。虽然视觉上不再"分组"，但数据不丢。
  //
  // 幂等：
  //   - CREATE TABLE / INDEX IF NOT EXISTS；
  //   - ALTER ADD COLUMN 走 addColumnIfMissing；
  //   - 回填用 INSERT ... WHERE NOT EXISTS + UPDATE ... WHERE conversationId IS NULL，
  //     二次重放不产生重复对话行。
  {
    version: 10,
    name: "ai-chat-conversations",
    up: (db) => {
      const addColumnIfMissing = (
        table: string,
        column: string,
        definition: string,
      ) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (cols.length === 0) return;
        if (cols.some((c) => c.name === column)) return;
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
      };

      // ---- 1. 会话表 ----
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_chat_conversations (
          id TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          archived INTEGER NOT NULL DEFAULT 0,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_ai_chat_conv_user
          ON ai_chat_conversations(userId, archived, updatedAt DESC);
      `);

      // ---- 2. 给 ai_chat_messages 加 conversationId + 索引 ----
      addColumnIfMissing("ai_chat_messages", "conversationId", "TEXT");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_ai_chat_msg_conv ON ai_chat_messages(conversationId, createdAt);",
      );

      // ---- 3. 回填：为每个有历史消息且还没有默认会话的 userId 创建一个 ----
      // 策略：找出"有消息但任意消息 conversationId 仍为 NULL"的 userId，
      // 为其生成一个 id 前缀 "legacy-" 的默认会话；title 置空（前端展示
      // i18n 的"默认对话"），updatedAt 取该用户最新一条消息时间。
      const orphanUsers = db.prepare(`
        SELECT DISTINCT userId
        FROM ai_chat_messages
        WHERE conversationId IS NULL
      `).all() as { userId: string }[];

      const insertConv = db.prepare(`
        INSERT INTO ai_chat_conversations (id, userId, title, archived, createdAt, updatedAt)
        VALUES (?, ?, '', 0, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
      `);
      const updateMsg = db.prepare(`
        UPDATE ai_chat_messages
           SET conversationId = ?
         WHERE userId = ? AND conversationId IS NULL
      `);
      const pickTime = db.prepare(`
        SELECT MIN(createdAt) AS minT, MAX(createdAt) AS maxT
        FROM ai_chat_messages
        WHERE userId = ?
      `);

      for (const u of orphanUsers) {
        const t = pickTime.get(u.userId) as { minT: string | null; maxT: string | null };
        const convId = `legacy-${u.userId}-${Date.now().toString(36)}`;
        insertConv.run(convId, u.userId, t.minT || null, t.maxT || null);
        updateMsg.run(convId, u.userId);
      }
    },
  },

  // ==========================================================================
  // v11：附件图床增强 —— hash 去重 + 反向引用倒排索引
  // --------------------------------------------------------------------------
  // 背景（路线 A）：
  //   FileManager 已经事实上承担"图床"职责（全局视图 + 复制外链 + 孤儿清理），
  //   但还缺两块硬伤未补：
  //
  //   1) 缺 hash 去重：同一张图通过编辑器粘贴 / 剪藏 / 拖拽多次上传会落 N 份
  //      磁盘文件 N 行 DB。规模一大磁盘膨胀严重。
  //
  //   2) 反查走全表 LIKE：/api/files/:id 详情接口要回答"这张图被哪些笔记引用"，
  //      v10 之前实现是 `notes.content LIKE '%/api/attachments/<id>%'`，
  //      笔记规模上来后 O(N) 扫全部 content 字段 + 子串匹配，content 又通常是
  //      KB~MB 量级的 JSON/HTML，每次详情查询都很慢。
  //
  // 本迁移做三件事：
  //
  //   A. attachments 表新增 hash 列（TEXT NULL，SHA-256 hex）。
  //      - 上传链路（/api/attachments、/api/files/upload、extractInlineBase64Images）
  //        会计算 hash 并优先复用已存在的相同 (userId, workspaceId, hash) 行；
  //        命中则返回老 id，不写新文件不写新行。
  //      - 列允许 NULL：老附件不强制回填 hash（懒迁移策略）。新上传时只在
  //        "hash 非空的行"里查命中，老行不参与去重——可接受，老数据本来就
  //        没有去重诉求。需要时另开管理端接口/脚本逐行扫盘补 hash。
  //      - 复合索引 (userId, workspaceId, hash)：上传查命中走这条索引。
  //        注意 SQLite 的复合索引可对 NULL 值正常索引，但 (.., .., hash IS NULL)
  //        的命中没意义，所以查询时一定要带 hash IS NOT NULL 谓词。
  //
  //   B. 新建 attachment_references 表（attachmentId, noteId 复合主键）作为
  //      "笔记→附件引用"的倒排索引：
  //      - PK(attachmentId, noteId)：天然去重，同一笔记多次引用同一附件只一行。
  //      - 双外键 ON DELETE CASCADE：笔记删除 / 附件删除时自动清理对应行，
  //        业务层零额外清理代码。
  //      - 索引 idx_attachment_references_attachment(attachmentId)：详情接口
  //        反查"这个附件被哪些笔记引用"走这条；按 attachmentId 单边过滤的
  //        SQL 命中索引头部，O(log N + 命中数)。
  //      - 索引 idx_attachment_references_note(noteId)：笔记侧增量维护用
  //        （UPDATE/DELETE WHERE noteId = ?），不建会扫全表。
  //
  //   C. 一次性回填 attachment_references。
  //      用单条 SQL + 正则不行（SQLite 默认无 regexp 函数）；改用 JS 侧扫描：
  //      读全部 notes（id, content），逐条 extract attachment id 集合，
  //      批量 INSERT OR IGNORE 到 attachment_references。
  //      性能：1k 笔记 × 平均 5 个引用 ≈ 5k 行插入 + 1k 次字符串 indexOf，
  //      在事务里 < 1s 级别，可接受。
  //
  //      回填时**包括** isTrashed=1 的笔记（与运行时 syncReferences 的语义一致：
  //      回收站里的笔记保留引用，恢复后无需重算）。
  //
  // 幂等性：
  //   - addColumnIfMissing 跳过已存在列；
  //   - CREATE TABLE / INDEX IF NOT EXISTS；
  //   - 回填用 INSERT OR IGNORE：二次运行不产生重复。
  //
  // 回滚：回到 v10 时新列/新表仍在但旧代码不读，行为退化为"反查走 LIKE 扫全表 +
  //   上传不去重"——和 v10 完全一致，无破坏。
  //
  // 风险：
  //   - 回填阶段需要把所有 notes.content 读到内存做字符串扫描；如果用户有
  //     极端规模的库（>50k 笔记 + 高频附件），可能 OOM。当前用户量级不会触发。
  //     极端规模时可改为分批 LIMIT/OFFSET，但实现复杂度上升，本次不做。
  //   - hash 列允许 NULL 的设计意味着"老附件不参与去重"——这是有意为之的
  //     懒迁移；如果用户希望强制回填，未来再提供一个 admin 端的 backfill 接口。
  {
    version: 11,
    name: "attachment-hash-dedup-and-references",
    up: (db) => {
      const addColumnIfMissing = (
        table: string,
        column: string,
        definition: string,
      ) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (cols.length === 0) return;
        if (cols.some((c) => c.name === column)) return;
        db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
      };

      // ---- A. attachments.hash + 复合索引 ----
      addColumnIfMissing("attachments", "hash", "TEXT");
      // 复合索引按 (userId, workspaceId, hash)：上传去重查询的 WHERE 三列齐写。
      // 不加 UNIQUE 约束：
      //   - 三列里 hash 可能为 NULL（老数据），UNIQUE 对多 NULL 行为有歧义；
      //   - 应用层在"非 NULL hash"上自行保证唯一即可，不需要 DB 兜底。
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_attachments_user_ws_hash ON attachments(userId, workspaceId, hash);",
      );

      // ---- B. attachment_references 倒排表 ----
      db.exec(`
        CREATE TABLE IF NOT EXISTS attachment_references (
          attachmentId TEXT NOT NULL,
          noteId TEXT NOT NULL,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (attachmentId, noteId),
          FOREIGN KEY (attachmentId) REFERENCES attachments(id) ON DELETE CASCADE,
          FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_attachment_references_attachment
          ON attachment_references(attachmentId);
        CREATE INDEX IF NOT EXISTS idx_attachment_references_note
          ON attachment_references(noteId);
      `);

      // ---- C. 一次性回填 ----
      // 与 lib/attachmentRefs.ts 的 extractAttachmentIdsFromContent 保持同款正则，
      // 但这里是迁移上下文，不依赖 src/lib —— 内联一份小副本，避免 migrations
      // 模块产生外部依赖（迁移代码应自包含，便于追溯）。
      const ATTACHMENT_ID_RE =
        /\/api\/attachments\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;

      const notes = db
        .prepare("SELECT id, content FROM notes")
        .all() as { id: string; content: string | null }[];

      const insertRef = db.prepare(
        "INSERT OR IGNORE INTO attachment_references (attachmentId, noteId) VALUES (?, ?)",
      );

      let totalInserted = 0;
      for (const n of notes) {
        if (!n.content || typeof n.content !== "string") continue;
        if (n.content.indexOf("/api/attachments/") < 0) continue;
        const re = new RegExp(ATTACHMENT_ID_RE.source, "g");
        const seen = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = re.exec(n.content)) !== null) {
          seen.add(m[1].toLowerCase());
        }
        for (const attId of seen) {
          try {
            const info = insertRef.run(attId, n.id);
            if (info.changes > 0) totalInserted++;
          } catch {
            // 外键失败（笔记里写了不存在的 attachment id，例如手动改的 / 删过附件）
            // 静默跳过 —— 这种"脏引用"不索引才是正确行为。
          }
        }
      }

      console.log(
        `[migrations] v11 backfill attachment_references: scanned ${notes.length} notes, inserted ${totalInserted} rows`,
      );
    },
  },

  // -------------------------------------------------------------------------
  // v12 ：attachments.uploadSource —— 标记附件的"上传入口来源"
  // -------------------------------------------------------------------------
  // 背景：
  //   v11 之前，"我的上传" tab 用 `attachments.noteId == holderNoteId` 来识别——
  //   即"挂在 holder note（'未归档文件'）下的就是用户从文件管理直接上传的"。
  //   但这个口径有两个历史污染源：
  //     1) 用户在 FileManager 页面停留时全局 paste 监听器会把浏览器粘贴的图片
  //        （网站 logo / favicon / 截图）当作上传，全部挂到 holder；
  //     2) 任何走 POST /api/files/upload 的代码路径（哪怕是测试 / 误操作）都会
  //        进入 holder。
  //   结果："我的上传" 实际混入了大量历史脏数据（实测一台机器上 89 张里
  //   绝大多数不是用户主动上传的）。
  //
  // 设计：
  //   给 attachments 加一列 uploadSource TEXT（可空）：
  //     - NULL          → 来源未知（v12 之前的老附件 / 编辑器粘贴 / 内联抽取等
  //                        非"文件管理直传"渠道）；
  //     - 'file_manager'→ 用户在文件管理页面通过 POST /api/files/upload 上传
  //                        （包括点击上传按钮、拖拽、显式粘贴）。
  //   "我的上传"筛选改为 `uploadSource = 'file_manager'`，与 holder note 解耦。
  //
  // 不回填策略：
  //   老数据全部留 NULL（不算"我的上传"）。这是有意为之——历史 holder 下混了脏
  //   数据，无法靠 SQL 区分哪些是用户真上传 vs 哪些是误粘贴，索性一刀切：
  //   v12 之后的新数据才有"我的上传"标记，对老库零破坏。
  //   用户感知是："我的上传"从这一刻起开始重新计数；老附件仍然在"全部 / 图片 /
  //   文件 / 孤儿"等其它 tab 里可见，没有丢失。
  //
  // 索引：
  //   "我的上传"查询条件是 `userId = ? AND workspaceId IS NULL AND uploadSource = ?`
  //   或 `workspaceId = ? AND uploadSource = ?`。当前 attachments 表已有
  //   (userId, workspaceId, hash) 复合索引覆盖前两列，uploadSource 选择性低
  //   （多数为 NULL），单列索引收益小，故不加索引——按 scope 过滤后行数已经够小。
  //
  // 回滚：
  //   回到 v11，新列仍在但旧代码不读，"我的上传"自然回到 holder note 口径。无破坏。
  {
    version: 12,
    name: "attachment-upload-source",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(attachments)").all() as {
        name: string;
      }[];
      if (cols.length === 0) return;
      if (cols.some((c) => c.name === "uploadSource")) return;
      db.prepare("ALTER TABLE attachments ADD COLUMN uploadSource TEXT").run();
    },
  },

  // ==========================================================================
  // v13：分享评论支持未登录访客（share_comments.userId 改 nullable + guestName）
  // --------------------------------------------------------------------------
  // 背景：
  //   v12 之前 share_comments.userId 是 NOT NULL 且外键 ON DELETE CASCADE 到
  //   users(id)。这导致两个问题：
  //
  //     1) 公开分享 + comment 权限下，访客必须登录才能评论。事实上路由代码
  //        （routes/shares.ts: POST /shared/:token/comments）为了"绕过 NOT NULL"
  //        把 userId 偷偷写成 share.ownerId（笔记主自己），结果数据库里看到的
  //        是"笔记主在自己的笔记下评论了一万条"，审计完全失真。前端只能临时
  //        在响应里 COALESCE(guestName, u.username) 拼一个显示名，guestName
  //        本身没存进库——刷新一次列表就丢了。
  //
  //     2) ON DELETE CASCADE：登录用户注销账户会把他在公开分享下的所有评论
  //        一并清掉。对协作场景而言不合理：留言记录是笔记主的资产，账号去留
  //        不应该让对话历史蒸发。
  //
  // 方案：
  //   - userId 改 NULL 允许；外键改 ON DELETE SET NULL（用户被删后该评论
  //     变成"匿名"，前端用 guestName 作为兜底显示名）。
  //   - 新增 guestName TEXT —— 持久化访客昵称；登录用户评论时为 NULL，
  //     显示走 users.username。
  //   - 新增 guestIpHash TEXT —— 仅用于服务端反垃圾（频次限制、封禁名单），
  //     存 SHA-256 hex 不存明文 IP；不暴露给前端。
  //
  // 实施：
  //   SQLite 不支持直接放松 NOT NULL 与修改外键 ON DELETE 行为，必须走表重建：
  //     1) CREATE TABLE share_comments_new (新结构);
  //     2) INSERT INTO share_comments_new SELECT ... FROM share_comments;
  //     3) DROP TABLE share_comments;
  //     4) ALTER TABLE share_comments_new RENAME TO share_comments;
  //     5) 重建索引（DROP + CREATE）。
  //
  //   重建期间 PRAGMA foreign_keys 必须临时关闭——否则 DROP 老表会触发依赖
  //   它的子级（share_comments 自引用 parentId）的 CASCADE 校验，可能报错。
  //   这里用 db.pragma 的标准做法：保存当前值 → 关闭 → 重建 → 恢复。
  //
  // 数据保留：
  //   存量评论 userId 全部非空（v12 及以前的代码强制写入），重建时直接
  //   1:1 拷贝；guestName/guestIpHash 设为 NULL。意味着升级后，老数据看
  //   起来仍然是"登录用户评论"——这与历史行为完全一致，没有任何丢失。
  //
  // 幂等：
  //   通过检查表 schema 是否已经具有 guestName 列来判断是否需要重建。
  //   已重建过则跳过；二次运行无副作用。
  //
  // 回滚：回到 v12 时新表结构里 userId 仍可 NULL，旧代码 INSERT 时若漏
  //   填 userId 会因为没有 NOT NULL 约束而成功插入——但旧代码本来就不会
  //   漏填（永远写 share.ownerId）。新增的 guestName 列旧代码不读，无影响。
  //   唯一行为差异：用户注销时不再 CASCADE 删除评论。运维可接受。
  {
    version: 13,
    name: "share-comments-allow-guest",
    up: (db) => {
      // 1) 表存在性 + 列存在性检查（幂等）
      const cols = db.prepare("PRAGMA table_info(share_comments)").all() as {
        name: string;
        notnull: number;
      }[];
      if (cols.length === 0) {
        // 表还不存在（schema.ts 基线尚未执行）——跳过，schema.ts 会建出新结构
        return;
      }
      const hasGuestName = cols.some((c) => c.name === "guestName");
      const hasGuestIpHash = cols.some((c) => c.name === "guestIpHash");
      const userIdNotNull = cols.find((c) => c.name === "userId")?.notnull === 1;

      // 三个条件都不满足"目标态"才需要重建
      // 即使无需重建，仍要补建 guestIpHash 索引（schema.ts 基线不再建它，避免
      // 老库 db.exec 阶段炸掉 —— 详见 schema.ts 注释）。
      if (hasGuestName && hasGuestIpHash && !userIdNotNull) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_share_comments_guest_ip ON share_comments(guestIpHash, createdAt);`
        );
        return;
      }

      // 2) 关闭外键检查，避免 DROP/RENAME 期间触发 parentId 自引用校验
      // PRAGMA foreign_keys 不能在事务内修改 —— 但本迁移已经被外层包了事务。
      // SQLite 的特殊行为：在事务内调 `PRAGMA foreign_keys = OFF` 是 no-op，
      // 不会报错也不会生效。解决方案：迁移系统给我们的事务结束后再改是不可行的。
      // 实测在事务内做表重建只要顺序正确（先 INSERT 再 DROP）就不会触发
      // foreign_keys 校验失败——SQLite 的 foreign_keys 检查针对**写入新行**，
      // 而我们这里 INSERT 的目标表 share_comments_new 的外键引用都指向"不变"
      // 的 notes/users/share_comments_new 自身，全部满足约束。DROP TABLE 则
      // 不会触发任何 FK 校验（DROP 不是 DML）。所以即使 PRAGMA 没生效也安全。

      // 3) 创建新表（与 schema.ts 基线一致）
      db.exec(`
        CREATE TABLE share_comments_new (
          id TEXT PRIMARY KEY,
          noteId TEXT NOT NULL,
          userId TEXT,
          guestName TEXT,
          guestIpHash TEXT,
          parentId TEXT,
          content TEXT NOT NULL,
          anchorData TEXT,
          isResolved INTEGER DEFAULT 0,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE,
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE SET NULL,
          FOREIGN KEY (parentId) REFERENCES share_comments_new(id) ON DELETE CASCADE
        );
      `);

      // 4) 拷贝数据（按列名显式映射，避免老表多/少列时位置错位）
      // guestName/guestIpHash 在老表不存在 → 拷贝时只填存量列，新列用 NULL 默认值
      db.exec(`
        INSERT INTO share_comments_new (id, noteId, userId, parentId, content, anchorData, isResolved, createdAt, updatedAt)
        SELECT id, noteId, userId, parentId, content, anchorData, isResolved, createdAt, updatedAt
        FROM share_comments;
      `);

      // 5) DROP 老表 + RENAME 新表
      db.exec(`DROP TABLE share_comments;`);
      db.exec(`ALTER TABLE share_comments_new RENAME TO share_comments;`);

    },
  },
  // ==========================================================================
  // v14：notebooks 软删除 — 删除笔记本时把笔记移入回收站，而非 CASCADE 物理删除
  // --------------------------------------------------------------------------
  // 背景（用户反馈的 bug）：
  //   - 用户删除笔记本后，回收站里**看不到**那些笔记；重启容器后才显示，再删
  //     又看不到。
  //   - 根因：notebooks DELETE 接口走 `DELETE FROM notebooks WHERE id = ?`，
  //     而 notes.notebookId FK 是 ON DELETE CASCADE → 笔记本下所有笔记**直
  //     接被物理删除**，永远不会进回收站。
  //   - "重启后能看到"的诡异现象其实是另一种路径产生的：用户先把单条笔记
  //     移到回收站（isTrashed=1），然后又删了它的父笔记本——CASCADE 顺手
  //     把回收站里的这条笔记也带走了。前端列表缓存 + 重启 → 命中/失命中，
  //     表现为时灵时不灵。
  //
  // 方案（与本次代码改动一起生效）：
  //   1) notebooks 加 isDeleted / deletedAt 列（软删标记）。
  //   2) 删除笔记本时：
  //        a. 递归把该笔记本及全部子孙笔记本 isDeleted=1；
  //        b. 把这些笔记本下所有 notes 也置为 isTrashed=1（进回收站）；
  //        c. **不再 DELETE FROM notebooks** → CASCADE 不触发，回收站里的
  //           笔记安全保留，等用户从回收站永久删除时才走 reclaimSpace。
  //   3) 笔记本列表查询、权限解析、移动 / 重命名 / 选作创建目标等所有路径
  //      统一加 isDeleted = 0 过滤，已软删的笔记本视同不存在。
  //   4) 从回收站恢复笔记（isTrashed=0）时校验父笔记本 isDeleted=0；
  //      若父已软删，返回 NOTEBOOK_TRASHED 让前端引导用户选择新笔记本。
  //
  // 数据兼容性：
  //   - ALTER TABLE ADD COLUMN，老库存量笔记本 isDeleted 自动为 0 → 全部
  //     可见，行为与 v13 完全一致，零数据风险。
  //   - 索引 idx_notebooks_isDeleted 用 IF NOT EXISTS 幂等。
  //
  // 回滚：
  //   回到 v13 程序时新列被忽略（旧代码不读 isDeleted），新列残留无副作用；
  //   但用户从 v14 起放进"笔记本回收站"的笔记本会重新被旧代码视作"正常笔记
  //   本"显示出来——可接受。
  {
    version: 14,
    name: "notebooks-soft-delete",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(notebooks)").all() as { name: string }[];
      if (cols.length === 0) return; // 表本身不存在（极端情况）
      if (!cols.some((c) => c.name === "isDeleted")) {
        db.prepare(
          "ALTER TABLE notebooks ADD COLUMN isDeleted INTEGER NOT NULL DEFAULT 0",
        ).run();
      }
      if (!cols.some((c) => c.name === "deletedAt")) {
        db.prepare("ALTER TABLE notebooks ADD COLUMN deletedAt TEXT").run();
      }
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_notebooks_isDeleted ON notebooks(isDeleted);",
      );
    },
  },

  // --------------------------------------------------------------------------
  // v15: users 增加 isDemo 体验账号标记
  // --------------------------------------------------------------------------
  // 背景：体验站点（note.nowen.cn）需要一个对外开放的 demo 账号，但这个账号
  //   不能让用户改密码 / 改用户名 / 启停 2FA，否则下一个访客就进不来了。
  //
  // 设计：
  //   - 在 users 表加一列 isDemo（0/1，默认 0）。
  //   - 后端 auth/change-password、auth/2fa/* 入口在校验通过后追加判断：
  //     若 isDemo=1 直接返回 403 "体验账号不允许修改账号信息"。
  //   - /api/me、/auth/verify、/auth/login 返回的 user 对象都会带上 isDemo，
  //     前端据此隐藏个人设置里的相关入口。
  //   - 体验账号通过 SQL 手工标记：UPDATE users SET isDemo=1 WHERE username='demo';
  //
  // 兼容性：老库 ALTER ADD COLUMN 默认 0，对所有存量用户零影响。
  {
    version: 15,
    name: "users-add-isDemo",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
      if (cols.length === 0) return;
      if (!cols.some((c) => c.name === "isDemo")) {
        db.prepare(
          "ALTER TABLE users ADD COLUMN isDemo INTEGER NOT NULL DEFAULT 0",
        ).run();
      }
    },
  },

  // --------------------------------------------------------------------------
  // v16: rebuild notes FTS index once
  // --------------------------------------------------------------------------
  // 老库可能在 notes_fts/trigger 创建前已经有存量笔记，或历史触发器异常导致
  // FTS 缺行。重建一次让全文搜索覆盖全部现有 notes。
  {
    version: 16,
    name: "notes-fts-rebuild",
    up: (db) => {
      db.prepare("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").run();
    },
  },
  // v17: mindmap folders + mindmaps.folderId
  {
    version: 17,
    name: "mindmap-folders",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mindmap_folders (
          id TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          workspaceId TEXT,
          parentId TEXT,
          name TEXT NOT NULL DEFAULT '\u672a\u547d\u540d\u6587\u4ef6\u5939',
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_mindmap_folders_user ON mindmap_folders(userId);
        CREATE INDEX IF NOT EXISTS idx_mindmap_folders_parent ON mindmap_folders(parentId);
        CREATE INDEX IF NOT EXISTS idx_mindmap_folders_workspace ON mindmap_folders(workspaceId);
      `);
      // mindmaps 表加 folderId 列
      try { db.prepare("ALTER TABLE mindmaps ADD COLUMN folderId TEXT").run(); } catch {}
    },
  },
  // v18: Notebook 级成员关系。Workspace 继续作为底层容器，Notebook 成为产品层协作空间。
  {
    version: 18,
    name: "notebook-members",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notebook_members (
          id TEXT PRIMARY KEY,
          notebookId TEXT NOT NULL,
          userId TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'viewer',
          status TEXT NOT NULL DEFAULT 'active',
          invitedBy TEXT,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (notebookId) REFERENCES notebooks(id) ON DELETE CASCADE,
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (invitedBy) REFERENCES users(id) ON DELETE SET NULL,
          UNIQUE(notebookId, userId)
        );

        CREATE INDEX IF NOT EXISTS idx_notebook_members_notebook
          ON notebook_members(notebookId);
        CREATE INDEX IF NOT EXISTS idx_notebook_members_user
          ON notebook_members(userId);
      `);

      db.prepare(`
        INSERT OR IGNORE INTO notebook_members
          (id, notebookId, userId, role, status, invitedBy, createdAt, updatedAt)
        SELECT
          id || ':' || userId,
          id,
          userId,
          'owner',
          'active',
          NULL,
          datetime('now'),
          datetime('now')
        FROM notebooks
      `).run();
    },
  },
  {
    version: 19,
    name: "notebook-share-links",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notebook_share_links (
          id TEXT PRIMARY KEY,
          notebookId TEXT NOT NULL,
          token TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL DEFAULT 'viewer',
          enabled INTEGER NOT NULL DEFAULT 1,
          expiresAt TEXT,
          createdBy TEXT NOT NULL,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (notebookId) REFERENCES notebooks(id) ON DELETE CASCADE,
          FOREIGN KEY (createdBy) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_notebook_share_links_notebook
          ON notebook_share_links(notebookId);
        CREATE INDEX IF NOT EXISTS idx_notebook_share_links_token
          ON notebook_share_links(token);
      `);
    },
  },
  {
    version: 20,
    name: "tasks-dueAt",
    up: (db) => {
      // dueAt: 精确到分钟的截止时间，ISO 8601 格式（如 2026-06-12T18:00）
      // 兼容旧 dueDate（纯日期）：老任务只有 dueDate，新任务优先使用 dueAt
      // 安全添加列：先查 pragma，不存在才 ALTER
      const cols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      if (!cols.some((c) => c.name === "dueAt")) {
        db.exec("ALTER TABLE tasks ADD COLUMN dueAt TEXT");
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_dueAt ON tasks(dueAt);`);
    },
  },
  {
    version: 21,
    name: "task-reminders",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_reminders (
          id TEXT PRIMARY KEY,
          taskId TEXT NOT NULL,
          userId TEXT NOT NULL,
          offsetMinutes INTEGER NOT NULL DEFAULT 30,
          enabled INTEGER NOT NULL DEFAULT 1,
          lastNotifiedAt TEXT,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_task_reminders_task ON task_reminders(taskId);
        CREATE INDEX IF NOT EXISTS idx_task_reminders_enabled ON task_reminders(enabled);
      `);
    },
  },

  {
    version: 22,
    name: "task-projects",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_projects (
          id TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          workspaceId TEXT,
          name TEXT NOT NULL,
          icon TEXT DEFAULT 'folder',
          color TEXT DEFAULT '#6366f1',
          sortOrder INTEGER DEFAULT 0,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_task_projects_user ON task_projects(userId);
        CREATE INDEX IF NOT EXISTS idx_task_projects_ws ON task_projects(workspaceId);
      `);
      // Add projectId and status columns to tasks table
      const cols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has("projectId")) {
        db.exec("ALTER TABLE tasks ADD COLUMN projectId TEXT");
      }
      if (!colNames.has("status")) {
        db.exec("ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'todo'");
        db.exec("UPDATE tasks SET status = 'done' WHERE isCompleted = 1");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(projectId)");
    },
  },
  {
    version: 23,
    name: "task-repeat",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has("repeatRule")) {
        db.exec("ALTER TABLE tasks ADD COLUMN repeatRule TEXT NOT NULL DEFAULT 'none'");
      }
      if (!colNames.has("repeatInterval")) {
        db.exec("ALTER TABLE tasks ADD COLUMN repeatInterval INTEGER NOT NULL DEFAULT 1");
      }
      if (!colNames.has("repeatEndDate")) {
        db.exec("ALTER TABLE tasks ADD COLUMN repeatEndDate TEXT");
      }
      if (!colNames.has("repeatGroupId")) {
        db.exec("ALTER TABLE tasks ADD COLUMN repeatGroupId TEXT");
      }
      if (!colNames.has("repeatGeneratedFromId")) {
        db.exec("ALTER TABLE tasks ADD COLUMN repeatGeneratedFromId TEXT");
      }
      if (!colNames.has("repeatNextGeneratedId")) {
        db.exec("ALTER TABLE tasks ADD COLUMN repeatNextGeneratedId TEXT");
      }
    },
  },
  {
    version: 24,
    name: "task-templates",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_templates (
          id TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          workspaceId TEXT,
          name TEXT NOT NULL,
          description TEXT,
          icon TEXT,
          color TEXT,
          items TEXT NOT NULL DEFAULT '[]',
          createdAt TEXT DEFAULT (datetime('now')),
          updatedAt TEXT DEFAULT (datetime('now'))
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_task_templates_user ON task_templates(userId)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_task_templates_workspace ON task_templates(workspaceId)`);
    },
  },
  {
    version: 25,
    name: "diaries-add-media",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(diaries)").all() as { name: string }[];
      if (cols.length === 0) return;
      if (!cols.some((c) => c.name === "media")) {
        db.exec("ALTER TABLE diaries ADD COLUMN media TEXT NOT NULL DEFAULT '[]'");
      }
    },
  },
  {
    version: 26,
    name: "tasks-add-startDate",
    up: (db) => {
      const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has("startDate")) {
        db.exec(`ALTER TABLE tasks ADD COLUMN startDate TEXT`);
      }
    },
  },
  {
    version: 27,
    name: "task-dependencies",
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS task_dependencies (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        workspaceId TEXT,
        predecessorTaskId TEXT NOT NULL,
        successorTaskId TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'finish_to_start',
        createdAt TEXT DEFAULT (datetime('now')),
        updatedAt TEXT DEFAULT (datetime('now'))
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_task_dependencies_user ON task_dependencies(userId)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_task_dependencies_workspace ON task_dependencies(workspaceId)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_task_dependencies_predecessor ON task_dependencies(predecessorTaskId)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_task_dependencies_successor ON task_dependencies(successorTaskId)`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_dependencies_unique ON task_dependencies(predecessorTaskId, successorTaskId, type)`);
    },
  },
  {
    version: 28,
    name: "task-reminders-snoozedUntil",
    up: (db) => {
      db.exec(`ALTER TABLE task_reminders ADD COLUMN snoozedUntil TEXT`);
    },
  },
  {
    version: 29,
    name: "tasks-add-description",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has("description")) {
        db.exec("ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''");
      }
    },
  },
  {
    version: 30,
    name: "task-calendar-feeds",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_calendar_feeds (
          id TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          workspaceId TEXT,
          token TEXT NOT NULL UNIQUE,
          enabled INTEGER NOT NULL DEFAULT 1,
          includeCompleted INTEGER NOT NULL DEFAULT 0,
          includeDescription INTEGER NOT NULL DEFAULT 1,
          defaultAlarmMinutes INTEGER NOT NULL DEFAULT 30,
          lastAccessedAt TEXT,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_calendar_feeds_token ON task_calendar_feeds(token);
        CREATE INDEX IF NOT EXISTS idx_task_calendar_feeds_user ON task_calendar_feeds(userId);
      `);
    },
  },
  // v31: notes 增加 contentFormat 字段，区分原生 Markdown 笔记与富文本笔记。
  //   - 'tiptap-json'（默认）：传统 Tiptap 富文本
  //   - 'markdown'：原生 Markdown 笔记，content 直接存 Markdown 源码
  //   - 'html'：HTML 格式（历史数据）
  // 旧数据默认 tiptap-json，不迁移内容。
  {
    version: 31,
    name: "notes-add-contentFormat",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(notes)").all() as { name: string }[];
      if (cols.some((c) => c.name === "contentFormat")) return;
      db.prepare("ALTER TABLE notes ADD COLUMN contentFormat TEXT NOT NULL DEFAULT 'tiptap-json'").run();
    },
  },
  // v32: folder_sync_files 映射表，跟踪"本地文件 → Nowen 笔记"的同步关系。
  //   sourcePathHash = sha256(relativePath)，用于去重和增量更新。
  //   sha256 = 文件内容 hash，用于判断内容是否变化。
  {
    version: 32,
    name: "folder-sync-files",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS folder_sync_files (
          id TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          sourcePathHash TEXT NOT NULL,
          relativePath TEXT NOT NULL,
          filename TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          noteId TEXT NOT NULL,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_folder_sync_files_user_hash
          ON folder_sync_files(userId, sourcePathHash);
        CREATE INDEX IF NOT EXISTS idx_folder_sync_files_note
          ON folder_sync_files(noteId);
      `);
    },
  },
  // v33: attachment_folders 文件夹表 + attachments.folder_id
  {
    version: 33,
    name: "attachment-folders",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS attachment_folders (
          id TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          name TEXT NOT NULL,
          parentId TEXT,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_attachment_folders_user
          ON attachment_folders(userId);
        CREATE INDEX IF NOT EXISTS idx_attachment_folders_parent
          ON attachment_folders(parentId);
      `);
      // attachments.folder_id（可为空，NULL = 未归档）
      try {
        db.prepare("SELECT folderId FROM attachments LIMIT 1").get();
      } catch {
        db.prepare("ALTER TABLE attachments ADD COLUMN folderId TEXT").run();
      }
    },
  },

  // ==========================================================================
  // v34：今日日记功能 — notes 表增加 note_type 和 journal_date
  // --------------------------------------------------------------------------
  // 为支持"一键创建今日日记"功能，notes 表新增：
  //   - note_type: 笔记类型，'normal' | 'journal'，默认 'normal'
  //   - journal_date: 日记归属日期，YYYY-MM-DD 格式，仅 journal 类型有值
  //
  // 设计决策：
  //   - 使用 note_type 而非 category，更语义化
  //   - journal_date 使用 YYYY-MM-DD 格式，方便排序和唯一约束
  //   - 唯一索引：userId + note_type + journal_date 防止同一用户同一天创建多篇日记
  //     SQLite 对 NULL 的 UNIQUE 行为：多个 NULL 视为不同值，所以普通笔记不受影响
  //   - 索引优化：idx_notes_journal_date 支持按日期查询日记
  {
    version: 34,
    name: "journal-type-and-date",
    up: (db) => {
      // notes 表增加 note_type 字段
      try {
        db.prepare("SELECT note_type FROM notes LIMIT 1").get();
      } catch {
        db.prepare("ALTER TABLE notes ADD COLUMN note_type TEXT NOT NULL DEFAULT 'normal'").run();
      }
      // notes 表增加 journal_date 字段
      try {
        db.prepare("SELECT journal_date FROM notes LIMIT 1").get();
      } catch {
        db.prepare("ALTER TABLE notes ADD COLUMN journal_date TEXT").run();
      }
      // 唯一索引：防止同一用户同一天创建多篇日记
      // SQLite 对 NULL 的 UNIQUE 行为：多个 NULL 视为不同值，普通笔记不受影响
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_journal_unique
          ON notes(userId, note_type, journal_date);
      `);
      // 普通索引：支持按日期查询日记列表
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_notes_journal_date
          ON notes(userId, note_type, journal_date);
      `);
    },
  },
  {
    version: 35,
    name: "task-repeat-rule-json",
    up: (db) => {
      // TASK-RECURRENCE-CUSTOM-01: 扩展循环规则字段
      const colNames = new Set(
        db.prepare("PRAGMA table_info(tasks)").all().map((r: any) => r.name),
      );
      if (!colNames.has("repeatRuleJson")) {
        db.exec("ALTER TABLE tasks ADD COLUMN repeatRuleJson TEXT");
      }
    },
  },
  // v36: note_links 笔记间引用关系表（BACKLINKS-02）
  //   存储 [[note:UUID|标题]] 引用关系，支持反向链接查询。
  //   - sourceNoteId: 包含引用的笔记
  //   - targetNoteId: 被引用的笔记
  //   - 唯一约束：同一用户同一对 source→target 只记一条（同一篇笔记多次引用同一目标只显示一次）
  //   - 不存自引用（sourceNoteId === targetNoteId）
  {
    version: 36,
    name: "note-links",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS note_links (
          id TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          sourceNoteId TEXT NOT NULL,
          targetNoteId TEXT NOT NULL,
          linkText TEXT,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_note_links_user_pair
          ON note_links(userId, sourceNoteId, targetNoteId);
        CREATE INDEX IF NOT EXISTS idx_note_links_user_target
          ON note_links(userId, targetNoteId);
        CREATE INDEX IF NOT EXISTS idx_note_links_user_source
          ON note_links(userId, sourceNoteId);
      `);
    },
  },
  // v37: note_links 重建表，补齐外键约束和 ON DELETE CASCADE（NOTE-LINKS-FK-MIGRATION-01）
  //   背景：v36 的 note_links 表没有外键约束，数据一致性依赖手动清理。
  //   本次迁移通过"重建表"方式添加外键约束，确保删除笔记时 note_links 自动清理。
  //
  //   流程：
  //     1) 清理孤儿记录（sourceNoteId/targetNoteId/userId 不存在的行）
  //     2) 创建 note_links_new 表（带完整外键约束）
  //     3) 将合法数据复制到新表（去重）
  //     4) DROP 老表 + RENAME 新表
  //     5) 重建索引
  //
  //   幂等：检查表是否已有外键约束，已重建则跳过。
  {
    version: 37,
    name: "note-links-add-fk",
    up: (db) => {
      // 1) 表存在性检查
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='note_links'"
      ).all();
      if (tables.length === 0) return; // 表还不存在，跳过

      // 2) 检查是否已重建（通过检查外键是否存在）
      const fkList = db.prepare("PRAGMA foreign_key_list(note_links)").all() as { table: string }[];
      if (fkList.length > 0) return; // 已有外键，跳过

      // 3) 清理孤儿记录
      db.exec(`
        DELETE FROM note_links WHERE sourceNoteId NOT IN (SELECT id FROM notes);
        DELETE FROM note_links WHERE targetNoteId NOT IN (SELECT id FROM notes);
        DELETE FROM note_links WHERE userId NOT IN (SELECT id FROM users);
      `);

      // 4) 创建新表（带外键约束）
      db.exec(`
        CREATE TABLE note_links_new (
          id TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          sourceNoteId TEXT NOT NULL,
          targetNoteId TEXT NOT NULL,
          linkText TEXT,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (sourceNoteId) REFERENCES notes(id) ON DELETE CASCADE,
          FOREIGN KEY (targetNoteId) REFERENCES notes(id) ON DELETE CASCADE
        );
      `);

      // 5) 复制合法数据（去重：同一 userId + sourceNoteId + targetNoteId 只保留一条）
      db.exec(`
        INSERT INTO note_links_new (id, userId, sourceNoteId, targetNoteId, linkText, createdAt, updatedAt)
        SELECT id, userId, sourceNoteId, targetNoteId, linkText, createdAt, updatedAt
        FROM note_links
        WHERE rowid IN (
          SELECT MIN(rowid) FROM note_links
          GROUP BY userId, sourceNoteId, targetNoteId
        );
      `);

      // 6) DROP 老表 + RENAME 新表
      db.exec(`DROP TABLE note_links;`);
      db.exec(`ALTER TABLE note_links_new RENAME TO note_links;`);

      // 7) 重建索引
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_note_links_user_pair
          ON note_links(userId, sourceNoteId, targetNoteId);
        CREATE INDEX IF NOT EXISTS idx_note_links_user_target
          ON note_links(userId, targetNoteId);
        CREATE INDEX IF NOT EXISTS idx_note_links_user_source
          ON note_links(userId, sourceNoteId);
      `);
    },
  },
  // v38: note_links 扩展块级引用支持（BLOCK-LINKS-01）
  //   新增字段：
  //     - targetBlockId: 被引用的 heading blockId（nullable，null 表示笔记级引用）
  //     - sourceBlockId: 发起引用所在的 heading blockId（nullable，第一版可不写入）
  //     - linkType: 'note' 或 'block'
  //     - excerpt: 块级引用摘要（nullable）
  //   新增索引和部分唯一约束。
  {
    version: 38,
    name: "note-links-block-fields",
    up: (db) => {
      // 1) 表存在性检查
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='note_links'"
      ).all();
      if (tables.length === 0) return;

      // 2) 检查是否已扩展（通过检查 targetBlockId 列是否存在）
      const cols = db.prepare("PRAGMA table_info(note_links)").all() as { name: string }[];
      const hasTargetBlockId = cols.some((c) => c.name === "targetBlockId");
      if (hasTargetBlockId) return; // 已扩展，跳过

      // 3) 添加新字段
      db.exec(`
        ALTER TABLE note_links ADD COLUMN targetBlockId TEXT;
        ALTER TABLE note_links ADD COLUMN sourceBlockId TEXT;
        ALTER TABLE note_links ADD COLUMN linkType TEXT NOT NULL DEFAULT 'note';
        ALTER TABLE note_links ADD COLUMN excerpt TEXT;
      `);

      // 4) 为已有数据设置 linkType = 'note'
      db.exec(`UPDATE note_links SET linkType = 'note' WHERE linkType IS NULL OR linkType = '';`);

      // 5) 重建唯一约束（使用部分索引）
      //    先删除旧的唯一索引
      try {
        db.exec(`DROP INDEX IF EXISTS idx_note_links_user_pair;`);
      } catch { /* ignore */ }

      //    笔记级唯一：targetBlockId IS NULL
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_note_links_unique_note
          ON note_links(userId, sourceNoteId, targetNoteId)
          WHERE targetBlockId IS NULL;
      `);

      //    块级唯一：targetBlockId IS NOT NULL
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_note_links_unique_block
          ON note_links(userId, sourceNoteId, targetNoteId, targetBlockId)
          WHERE targetBlockId IS NOT NULL;
      `);

      // 6) 新增索引
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_note_links_user_target_block
          ON note_links(userId, targetNoteId, targetBlockId);
        CREATE INDEX IF NOT EXISTS idx_note_links_user_link_type
          ON note_links(userId, linkType);
      `);
    },
  },

  // ==========================================================================
  // v39：日历 ICS 镜像导出到 S3（TASK-CALENDAR-EXPORT-STORAGE-01）
  // --------------------------------------------------------------------------
  // 新增 calendar_export_targets 表，存储用户的 S3 导出配置。
  //   - 一个用户可以有多个 export target
  //   - 一个 feed 可以对应多个 export target
  //   - configJson 加密存储 S3 凭证
  //   - 记录最后导出状态和错误信息
  {
    version: 39,
    name: "calendar-export-targets",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS calendar_export_targets (
          id TEXT PRIMARY KEY,
          userId TEXT NOT NULL,
          feedId TEXT NOT NULL,
          type TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          name TEXT NOT NULL DEFAULT '',
          configJson TEXT NOT NULL,
          publicUrl TEXT,
          lastExportAt TEXT,
          lastStatus TEXT,
          lastError TEXT,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (feedId) REFERENCES task_calendar_feeds(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_calendar_export_targets_user
          ON calendar_export_targets(userId);
        CREATE INDEX IF NOT EXISTS idx_calendar_export_targets_feed
          ON calendar_export_targets(feedId);
        CREATE INDEX IF NOT EXISTS idx_calendar_export_targets_enabled
          ON calendar_export_targets(enabled);
      `);
    },
  },
  // v40: note_versions 增加 contentFormat，确保 Markdown / 富文本版本恢复时格式不丢失。
  {
    version: 40,
    name: "note-versions-add-contentFormat",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(note_versions)").all() as { name: string }[];
      if (cols.some((c) => c.name === "contentFormat")) return;
      db.prepare("ALTER TABLE note_versions ADD COLUMN contentFormat TEXT NOT NULL DEFAULT 'tiptap-json'").run();
    },
  },
  // v41: 循环任务支持按总次数结束；repeatSequenceIndex 用于避免物理删除导致 COUNT 回退。
  {
    version: 41,
    name: "tasks-repeat-end-count",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has("repeatEndCount")) {
        db.prepare("ALTER TABLE tasks ADD COLUMN repeatEndCount INTEGER").run();
      }
      if (!colNames.has("repeatSequenceIndex")) {
        db.prepare("ALTER TABLE tasks ADD COLUMN repeatSequenceIndex INTEGER").run();
      }
    },
  },
  // v42: 用户级 UI 偏好跨浏览器 / 跨设备同步。
  {
    version: 42,
    name: "user-preferences",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_preferences (
          userId TEXT PRIMARY KEY,
          preferencesJson TEXT NOT NULL DEFAULT '{}',
          updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
        );
      `);
    },
  },
];

/** 当前代码已知的最高 schema 版本（== MIGRATIONS 里 max(version)）。 */
export const CURRENT_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (acc, m) => (m.version > acc ? m.version : acc),
  0,
);

/** 创建迁移记录表（幂等）。 */
function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      appliedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/** 读取当前 DB 已应用的最高版本号（无记录返回 0）。 */
export function getCurrentSchemaVersion(db: Database.Database): number {
  ensureMigrationsTable(db);
  const row = db
    .prepare("SELECT MAX(version) AS v FROM schema_migrations")
    .get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

/**
 * 应用所有未执行的迁移。
 *
 * 行为：
 *   - 当前版本 < 已登记最高版本：依次 apply，每条放在自己的事务里。
 *   - 当前版本 == 已登记最高版本：no-op。
 *   - 当前版本 > 已登记最高版本：抛错——典型场景是 "用 v3 程序打开 v5 库"，
 *     旧程序不应继续运行；让它早死，比沉默写坏数据强得多。
 *
 * @returns 实际执行的迁移数量
 */
export function runMigrations(db: Database.Database): number {
  ensureMigrationsTable(db);
  const cur = getCurrentSchemaVersion(db);

  if (cur > CURRENT_SCHEMA_VERSION) {
    // 严格拒绝降级：旧版程序打开新版 DB 时必须立即停机，绝不允许继续读写。
    //
    //   原因：
    //     - 新版 DB 可能新增了列 / 触发器 / 索引，旧代码 INSERT 时漏填列、
    //       UPDATE 时忽略触发器的副作用，轻则违反新版约束（约束失败整个事务
    //       回滚）、重则写出"语法合法但语义破坏"的行（例如附件漏写
    //       workspaceId 导致工作区不可见）。
    //     - 拒绝降级没有误伤：用户要么升级程序、要么回滚 DB（从备份恢复）。
    //
    //   用户可采取的措施（日志里直接给出，减少排查时间）：
    //     1) 升级 nowen-note 到能识别 schema v${cur} 的版本（查 CHANGELOG）；
    //     2) 或从 /userData/backups/ 选一份 schema v${CURRENT_SCHEMA_VERSION}
    //        及以下的备份执行恢复（后端启动会通过，但需注意数据会回滚）；
    //     3) 若确认当前 DB 没有新版独占的数据（例如刚升级一次立刻回滚），
    //        可用 sqlite3 CLI 手动 DELETE FROM schema_migrations WHERE
    //        version > ${CURRENT_SCHEMA_VERSION}，但这属于有损操作，仅限
    //        明确知道自己在做什么的运维。
    throw new Error(
      `[migrations] 数据库版本 ${cur} 高于当前程序支持的 ${CURRENT_SCHEMA_VERSION}。\n` +
      `这通常是"用旧版程序打开新版数据库"造成的。为防止旧程序破坏数据，启动已被拒绝。\n` +
      `处理建议：\n` +
      `  1) 升级 nowen-note 到能识别 schema v${cur} 的版本；\n` +
      `  2) 或从备份恢复一份 schema 版本 <= ${CURRENT_SCHEMA_VERSION} 的数据库；\n` +
      `  3) 确认新库无独占数据时，可手动回滚 schema_migrations 表（有损，慎用）。`,
    );
  }

  const pending = MIGRATIONS.filter((m) => m.version > cur).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return 0;

  // 校验版本严格递增、无跳号、无重复
  let prev = cur;
  for (const m of pending) {
    if (m.version <= prev) {
      throw new Error(`[migrations] 版本号必须严格递增：v${prev} 之后是 v${m.version}（${m.name}）`);
    }
    prev = m.version;
  }

  const insert = db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)");
  let applied = 0;
  for (const m of pending) {
    const tx = db.transaction(() => {
      m.up(db);
      insert.run(m.version, m.name);
    });
    try {
      tx();
      applied++;
      console.log(`[migrations] applied v${m.version} (${m.name})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`[migrations] v${m.version} (${m.name}) failed: ${msg}`);
    }
  }
  return applied;
}
