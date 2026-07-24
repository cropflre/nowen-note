/**
 * mindmaps / mindmap_folders 统一 schema 兜底
 * ---------------------------------------------------------------------------
 * 背景：
 *   mindmaps.ts 的 ensureTable() 只建 mindmaps 表 + 兜底 starred，
 *   没有兜底 folderId；mindmap-folders.ts 没有任何表初始化逻辑。
 *   当旧库迁移状态异常（v17 未执行或部分执行），列表接口会触发
 *   "no such column: m.folderId" 或 "no such table: mindmap_folders" 500。
 *
 * 设计：
 *   导出单个 ensureMindmapSchema(db?) 函数，两个路由文件共用同一份逻辑。
 *   SQLite DDL、列信息探测和补列逻辑集中到 Repository 边界；
 *   PostgreSQL Schema parity 与迁移机制由 #250 负责。
 */

import {
  mindmapSchemaRepository,
  type MindmapSchemaDatabase,
} from "../repositories/mindmapSchemaRepository";

export function ensureMindmapSchema(db?: MindmapSchemaDatabase): void {
  mindmapSchemaRepository.ensure(db);
}
