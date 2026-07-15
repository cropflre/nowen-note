/**
 * Query Services 入口
 *
 * QueryService 层承接跨表复杂查询（UNION ALL / EXISTS / 多表 JOIN / CTE）。
 * 单表 CRUD 仍由各 Repository 负责。
 *
 * 设计原则：
 * - QueryService 不处理 HTTP / 鉴权 / 文件删除
 * - QueryService 不直接访问数据库驱动，统一委托 Repository 边界
 * - PostgreSQL 同步/异步双库实现由 #249 统一推进
 */

export { attachmentQueryService } from "./attachmentQueryService";
export type { AttachmentPathEntry, NoteReference, MyUploadsSummary } from "./attachmentQueryService";

export { memberQueryService } from "./memberQueryService";
