import type { Migration } from "./migrations.impl.js";

// Development servers may have applied the initial v121 before queue fields were added.
export const wechatAssistantQueueColumnsMigration: Migration = {
  version: 122,
  name: "wechat-assistant-queue-authorization-columns",
  up(db) {
    const columns = new Set((db.prepare("PRAGMA table_info(wechat_assistant_items)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("openId")) db.exec("ALTER TABLE wechat_assistant_items ADD COLUMN openId TEXT");
    // Existing jobs without an authorization snapshot must fail closed until explicitly retried.
    if (!columns.has("tokenVersion")) db.exec("ALTER TABLE wechat_assistant_items ADD COLUMN tokenVersion INTEGER NOT NULL DEFAULT -1");
  },
};
