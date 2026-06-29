/**
 * Query Services 入口
 *
 * QueryService 层承接跨表复杂查询（UNION ALL / EXISTS / 多表 JOIN / CTE）。
 * 单表 CRUD 仍由各 Repository 负责。
 *
 * 设计原则：
 * - QueryService 不处理 HTTP / 鉴权 / 文件删除
 * - QueryService 使用 getDb() 获取数据库实例
 * - 未来 PostgreSQL 接入时，只需为 QueryService 提供 pg 实现
 */

export { attachmentQueryService } from "./attachmentQueryService";
export type { AttachmentPathEntry, NoteReference, MyUploadsSummary } from "./attachmentQueryService";

export { memberQueryService } from "./memberQueryService";
