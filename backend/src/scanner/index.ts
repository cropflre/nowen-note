/**
 * scanner/index.ts — 扫描器模块入口
 *
 * 导出所有公共 API，供 nowen-note 后端集成。
 *
 * 初始化方式（在 backend/src/index.ts 中）:
 *   import { initScanner } from "./scanner";
 *   initScanner(getDb());
 *
 * 使用方式:
 *   POST /api/scanner/scan     触发全量扫描
 *   POST /api/scanner/status   查看状态
 */
export { walkDir, type FileEntry } from "./walker";
export { parseMarkdown, type ParsedNote } from "./parser";
export { extractWikiLinks } from "./wikilink";
export { extractInlineTags } from "./tag-extractor";
export { extractTasks } from "./task-extractor";
export { syncNotes, loadNoteTitles, type SyncStats, type NotebookInfo } from "./sync-engine";
export { HashStore } from "./hash-store";
export { ScannerRunner, setScannerRunner, scannerRoutes, type ScannerStatus } from "./routes";
export { createFileWatcher, type SyncCallback, type WatcherOptions } from "./watcher";
