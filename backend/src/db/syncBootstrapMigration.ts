import type { Migration } from "./migrations.impl.js";

/**
 * v89: 首次同步对账（Bootstrap / Reconcile）状态机。
 *
 * ## 为什么必须有 Bootstrap
 *
 * 首次开启同步**不能**把用户过去的历史 mutation replay 到服务器上：
 * - "仅此设备"期间根本不产生 Outbox（v87 的闸门 + v88 的 NOT NULL），
 *   所以没有历史可以 replay；
 * - 即使有，重放一段操作流也无法处理"两边都有数据"的合并。
 *
 * 正确做法是按**当前最终状态**对账：
 *
 *   Local 有数据 / Remote 空  → 本地状态上传
 *   Local 空 / Remote 有数据  → Remote Snapshot 下载
 *   两边都有                  → 按 Stable Entity ID 合并，冲突入台账
 *
 * 禁止按标题匹配：不同 ID 即不同实体，哪怕标题一模一样。
 * 禁止 LWW：同 ID 不同版本且没有可靠共同 base 时进 sync_conflicts。
 *
 * ## 状态机
 *
 *   pending → preparing → pulling → reconciling → pushing → verifying → ready
 *                                                                     ↘ failed
 *
 * 只有进入 ready 之后，v87 的 outbox 触发器才会开始写入
 * （闸门条件之一就是 bootstrapStatus='ready'），增量同步引擎才启动。
 * 这保证了"基线建立完成前不会有半成品 mutation 被推送"。
 *
 * ## Resumable / Idempotent
 *
 * 应用可能在任意阶段被强杀。因此进度必须落库而不是留在内存：
 * - bootstrapCursor      snapshot 分页游标，续传用
 * - bootstrapSequence    snapshot 时刻的服务端 high-water sequence
 * - bootstrapPushedAt    上传阶段的完成标记
 *
 * 重启后从 bootstrapStatus 对应的阶段继续，已应用过的实体由
 * applyRemoteChanges 的 upsert 语义天然幂等。
 *
 * ## Snapshot 一致性
 *
 * 关键问题：下载 snapshot 期间服务端可能产生新变更。
 * 解法（sequence high-water）：
 *
 *   plan → 得到 serverSequence = N
 *   snapshot(at N) 分页下载并应用
 *   changes(after N) 补齐这期间的增量
 *   → 收敛，游标落在最新
 *
 * 不这样做就会丢掉 snapshot 窗口内的服务端变更。
 *
 * ## Bootstrap 期间的本地编辑
 *
 * 不禁止用户编辑（"禁止编辑几分钟"不是可接受的产品行为）。
 * 机制：bootstrapStatus 未到 ready 时触发器不写 Outbox，
 * 因此这段时间的本地修改只落本地库；Bootstrap 的 pushing 阶段
 * 扫描的是**当前最终状态**，天然把这些修改一并上传。
 */
export const syncBootstrapMigration: Migration = {
  version: 89,
  name: "sync-v2-bootstrap-reconcile",
  up: (db) => {
    const cols = db.prepare("PRAGMA table_info(sync_profiles)").all() as Array<{ name: string }>;
    const has = (name: string) => cols.some((c) => c.name === name);

    // 逐列添加：ALTER TABLE ADD COLUMN 在 SQLite 上是廉价操作，
    // 且比重建表安全（不会丢触发器与索引）。
    if (!has("bootstrapStatus")) {
      db.exec(`
        ALTER TABLE sync_profiles ADD COLUMN bootstrapStatus TEXT
          NOT NULL DEFAULT 'pending';
      `);
    }
    if (!has("bootstrapCursor")) {
      db.exec("ALTER TABLE sync_profiles ADD COLUMN bootstrapCursor TEXT;");
    }
    if (!has("bootstrapSequence")) {
      db.exec("ALTER TABLE sync_profiles ADD COLUMN bootstrapSequence INTEGER;");
    }
    if (!has("bootstrapError")) {
      db.exec("ALTER TABLE sync_profiles ADD COLUMN bootstrapError TEXT;");
    }
    if (!has("bootstrapStartedAt")) {
      db.exec("ALTER TABLE sync_profiles ADD COLUMN bootstrapStartedAt TEXT;");
    }
    if (!has("bootstrapReadyAt")) {
      db.exec("ALTER TABLE sync_profiles ADD COLUMN bootstrapReadyAt TEXT;");
    }

    // 已存在且已启用的 Profile 视为 ready。
    //
    // 理由：它们是在 Bootstrap 机制存在之前建立的同步关系，用户已经在用。
    // 强行置为 pending 会让 v87 的触发器停止写 Outbox（闸门要求 ready），
    // 等于静默中断这些用户的同步。把它们当作"基线已建立"是唯一安全的选择：
    // 后续增量同步仍会通过 changes/ACK 收敛，真有分歧会走冲突流程。
    db.exec(`
      UPDATE sync_profiles
      SET bootstrapStatus = 'ready',
          bootstrapReadyAt = COALESCE(bootstrapReadyAt, datetime('now'))
      WHERE enabled = 1 AND bootstrapStatus = 'pending';
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sync_profiles_bootstrap
        ON sync_profiles(bootstrapStatus);
    `);

    // 重建写入闸门视图，纳入 bootstrapStatus 条件。
    // v87 建这个视图时该列还不存在，用的是无条件版本。
    db.exec(`
      DROP VIEW IF EXISTS sync_v2_outbox_target;
      CREATE VIEW sync_v2_outbox_target AS
        SELECT id AS profileId FROM sync_profiles
        WHERE enabled = 1
          AND bootstrapStatus = 'ready'
        ORDER BY updatedAt DESC
        LIMIT 1;
    `);
  },
};
