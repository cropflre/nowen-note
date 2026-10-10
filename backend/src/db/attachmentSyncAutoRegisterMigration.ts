import type { Migration } from "./migrations.impl.js";

/**
 * v84: 附件同步状态自动登记（Phase 9 接线）。
 *
 * 问题：`INSERT INTO attachments` 在代码里有 8 处以上——
 * attachments-core（4 处）、files、folder-sync、url-import、
 * noteDuplicates、noteTemplates，还有 Clipper 与导入链路。
 * 逐个调用 registerLocalAttachment() 埋点，未来新增一条路径就会漏，
 * 表现为"某个入口上传的图片永远不同步"，而且极难发现。
 *
 * 因此沿用 v66 / v82 已验证的 DB Trigger 思路：由数据库保证
 * 只要附件行存在，同步状态行就一定存在。
 *
 * 与 v82 的差别：
 * - v82 记录的是"变更事件"（追加型 feed）；
 * - v84 维护的是"当前状态"（每个附件一行），因此用 ON CONFLICT 幂等。
 *
 * 关键设计：
 *
 * 1) **初始状态由是否存在启用的 Profile 决定**
 *    没有启用同步 → 'local'（仅本机，不排队上传）
 *    已启用同步   → 'pending'（等待上传）
 *    这样"关闭同步期间插入的图片"会留在 local，开启同步后由
 *    promoteLocalAttachments() 统一提升为 pending 补传，
 *    否则其他设备上会全是破图。
 *
 * 2) **只登记个人空间附件**（workspaceId IS NULL）
 *    与 Sync V2 第一版范围一致。工作区附件涉及 ACL 与权限撤销，
 *    不在第一版协议内，误登记会让引擎尝试推送无权限的数据。
 *
 * 3) **不覆盖已有状态行**
 *    Pull 远端附件时会先写入 remoteOnly=1 的状态行，随后再插入
 *    attachments 行。若触发器无条件重置为 pending，就会把"远端已有、
 *    待下载"误判成"本地新增、待上传"，导致把空文件推回服务器。
 *    因此 ON CONFLICT 时只补 profileId，绝不改 status。
 *
 * 4) **受抑制开关约束**
 *    复用 v82 的 sync_v2_should_log。Apply 远端变更时开关为关，
 *    此时不该产生"本地新增待上传"的登记。
 *
 * 无需 delete 触发器：attachment_sync_state 对 attachments(id)
 * 建了 ON DELETE CASCADE 外键，附件删除时状态行自动消失。
 */
export const attachmentSyncAutoRegisterMigration: Migration = {
  version: 84,
  name: "attachment-sync-auto-register",
  up: (db) => {
    // 判定"当前是否已启用同步"，并顺带给出该用哪个 profileId。
    // 用视图承载，避免把这段子查询重复写进触发器。
    db.exec(`
      DROP VIEW IF EXISTS sync_v2_active_profile;
      CREATE VIEW sync_v2_active_profile AS
        SELECT id AS profileId FROM sync_profiles
        WHERE enabled = 1
        ORDER BY updatedAt DESC
        LIMIT 1;
    `);

    db.exec(`
      DROP TRIGGER IF EXISTS sync_v2_attachment_state_insert;
      CREATE TRIGGER sync_v2_attachment_state_insert
      AFTER INSERT ON attachments
      WHEN NEW.workspaceId IS NULL
        AND (SELECT enabled FROM sync_v2_should_log) = 1
      BEGIN
        INSERT INTO attachment_sync_state
          (attachmentId, profileId, status, remoteOnly, updatedAt)
        VALUES (
          NEW.id,
          (SELECT profileId FROM sync_v2_active_profile),
          CASE
            WHEN (SELECT profileId FROM sync_v2_active_profile) IS NOT NULL
              THEN 'pending'
            ELSE 'local'
          END,
          0,
          datetime('now')
        )
        ON CONFLICT(attachmentId) DO UPDATE SET
          profileId = COALESCE(excluded.profileId, attachment_sync_state.profileId),
          updatedAt = datetime('now');
      END;
    `);

    // 回填：升级前已存在的个人附件也要纳入管理，
    // 否则老用户开启同步后历史图片永远不会上传。
    //
    // 状态同样按"是否已启用同步"决定，并且不动任何已有状态行。
    db.exec(`
      INSERT INTO attachment_sync_state
        (attachmentId, profileId, status, remoteOnly, updatedAt)
      SELECT
        a.id,
        (SELECT id FROM sync_profiles WHERE enabled = 1 ORDER BY updatedAt DESC LIMIT 1),
        CASE
          WHEN (SELECT id FROM sync_profiles WHERE enabled = 1 LIMIT 1) IS NOT NULL
            THEN 'pending'
          ELSE 'local'
        END,
        0,
        datetime('now')
      FROM attachments a
      WHERE a.workspaceId IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM attachment_sync_state s WHERE s.attachmentId = a.id
        );
    `);
  },
};
