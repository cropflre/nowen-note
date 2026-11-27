import type { Migration } from "./migrations.impl.js";
import { installSyncChangesV2Triggers } from "./syncChangesV2Migration.js";
import { installSyncOutboxCaptureTriggers } from "./syncOutboxCaptureMigration.js";

/**
 * v152: 重装附件 UPDATE 同步触发器。
 *
 * 历史上的 sync_outbox_attachments_update 与 sync_v2_attachments_update
 * 对任意 UPDATE attachments 无条件入队/写 Change Feed，导致仅回填本地 path
 * 或无字段变化时也产生冗余同步。本迁移重装两端触发器使字段变更过滤在已有库生效。
 */
export const syncAttachmentUpdateTriggerMigration: Migration = {
  version: 152,
  name: "sync-v2-attachment-update-trigger-diff",
  up: (db) => {
    installSyncChangesV2Triggers(db);
    installSyncOutboxCaptureTriggers(db);
  },
};
