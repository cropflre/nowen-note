import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";
import { ensureKnowledgeTreeScopeAwareTriggers } from "./knowledgeTreeScopeTriggerRepairMigration.js";

export const KNOWLEDGE_TREE_RUNTIME_TRIGGER_REPAIR_SCHEMA_VERSION = 92;

/**
 * v85 修复曾被运行期知识树初始化覆盖。使用新版本重新安装最终触发器，
 * 让已经记录 v85 的现有数据库也能在升级时自动恢复正确状态。
 */
export const knowledgeTreeRuntimeTriggerRepairMigration: Migration = {
  version: KNOWLEDGE_TREE_RUNTIME_TRIGGER_REPAIR_SCHEMA_VERSION,
  name: "knowledge-tree-runtime-trigger-repair",
  up: (db: Database.Database) => ensureKnowledgeTreeScopeAwareTriggers(db),
};
