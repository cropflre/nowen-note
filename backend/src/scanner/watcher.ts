/**
 * scanner/watcher.ts — 实时文件监听器
 *
 * 使用 chokidar 监控 MD 文件目录的变更事件，
 * 实现增量同步：文件修改 → 解析 → DB upsert。
 *
 * 启动方式（在 index.ts 中）:
 *   const watcher = createFileWatcher(mdRoot, userId, {
 *     onSync: (path, stats) => console.log("同步完成", stats),
 *   });
 */
import chokidar, { type FSWatcher } from "chokidar";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import type _BetterSqlite3 from "better-sqlite3";
type Database = _BetterSqlite3.Database;
import { parseMarkdown } from "./parser";
import { syncNotes, loadNoteTitles } from "./sync-engine";
import { HashStore } from "./hash-store";

/** 同步回调 */
export type SyncCallback = (relativePath: string, stats: { created: boolean }) => void;

/** 监听器配置 */
export interface WatcherOptions {
  /** 同步延迟（毫秒，默认 300），用于防抖 */
  debounceMs?: number;
  /** 每次同步完成后的回调 */
  onSync?: SyncCallback;
  /** 错误回调 */
  onError?: (relativePath: string, error: Error) => void;
  /** 排除的目录 */
  ignoreDirs?: string[];
}

/** 默认排除目录 */
const DEFAULT_IGNORE = [
  ".git",
  "node_modules",
  ".nowen",
  "templates",
  ".obsidian",
  ".trash",
  ".hg",
  ".svn",
];

/**
 * 创建文件监听器
 *
 * @param mdRoot MD 文件根目录
 * @param userId 用户 UUID
 * @param options 配置项
 * @returns 监听器实例（可调用 .close() 停止）
 */
export function createFileWatcher(
  mdRoot: string,
  userId: string,
  options: WatcherOptions = {},
): FSWatcher {
  const debounceMs = options.debounceMs ?? 300;
  const ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORE;

  // 防抖映射表：relativePath → timer
  const debounceMap = new Map<string, NodeJS.Timeout>();

  // 创建 hash store（只在 .nowen/ 下记录状态）
  const hashStore = new HashStore(mdRoot);

  const watcher = chokidar.watch(mdRoot, {
    ignored: (testPath, stats) => {
      // 忽略排除目录
      const rel = path.relative(mdRoot, testPath);
      const parts = rel.split(path.sep);
      for (const dir of ignoreDirs) {
        if (parts.includes(dir)) return true;
      }
      // 只监听 .md 文件
      if (stats?.isFile?.()) {
        return !testPath.endsWith(".md");
      }
      return false;
    },
    persistent: true,
    ignoreInitial: true, // 只监听变更，不处理已有文件
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 100,
    },
  });

  /**
   * 处理单个 MD 文件变更（防抖）
   */
  const handleChange = (filePath: string, event: "add" | "change" | "unlink") => {
    const relativePath = path.relative(mdRoot, filePath);

    // 清除已有防抖
    const existing = debounceMap.get(relativePath);
    if (existing) clearTimeout(existing);

    if (event === "unlink") {
      // 文件删除 → 立即处理
      processDelete(relativePath);
      return;
    }

    // 防抖：等一段时间内不再有事件再处理
    const timer = setTimeout(() => {
      debounceMap.delete(relativePath);
      processFile(relativePath, filePath);
    }, debounceMs);

    debounceMap.set(relativePath, timer);
  };

  /**
   * 处理文件创建/修改
   */
  const processFile = (relativePath: string, fullPath: string) => {
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      if (!content.trim()) return;

      const sha256 = crypto.createHash("sha256").update(content).digest("hex");
      const stat = fs.statSync(fullPath);

      // 检查是否真的变更了（通过 hash-store）
      if (hashStore.isUnchanged(relativePath, sha256, stat.mtimeMs)) {
        return; // 内容没变，跳过
      }

      const note = parseMarkdown(content, relativePath, sha256);
      const db = getDb();

      const stats = syncNotes(db, [note], {
        userId,
        rebuild: false,
      });

      // 更新 hash 状态
      hashStore.updateFile(relativePath, sha256, stat.mtimeMs);
      hashStore.save();

      options.onSync?.(relativePath, { created: stats.created > 0 });
    } catch (e: any) {
      options.onError?.(relativePath, e);
    }
  };

  /**
   * 处理文件删除
   */
  const processDelete = (relativePath: string) => {
    try {
      const db = getDb();
      // 将笔记标记为归档（不删除数据）
      db.prepare(
        "UPDATE notes SET isArchived = 1, updatedAt = datetime('now') WHERE sourcePath = ? AND userId = ?",
      ).run(relativePath, userId);

      hashStore.removeFile(relativePath);
      hashStore.save();

      options.onSync?.(relativePath, { created: false });
    } catch (e: any) {
      options.onError?.(relativePath, e);
    }
  };

  // 注册事件
  watcher.on("add", (p) => handleChange(p, "add"));
  watcher.on("change", (p) => handleChange(p, "change"));
  watcher.on("unlink", (p) => handleChange(p, "unlink"));

  return watcher;
}

/**
 * 获取 DB 连接（懒加载，避免循环依赖）
 */
let _db: _BetterSqlite3.Database | null = null;
function getDb(): _BetterSqlite3.Database {
  if (!_db) {
    _db = require("../db/schema").getDb();
  }
  return _db!;
}
