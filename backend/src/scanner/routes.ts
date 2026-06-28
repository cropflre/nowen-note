/**
 * scanner/routes.ts — Hono 路由
 *
 * 供 nowen-note 后端注册的 API 路由：
 *   POST /api/scanner/scan       — 触发一次全量扫描
 *   POST /api/scanner/scan-dir   — 扫描指定路径
 *   POST /api/scanner/rebuild    — 重建全部索引
 *   GET  /api/scanner/status     — 查看扫描状态
 */
import { Hono } from "hono";
import { getDb } from "../db/schema";
import { walkDir } from "./walker";
import { parseMarkdown } from "./parser";
import { syncNotes, loadNoteTitles, type SyncStats } from "./sync-engine";
import { HashStore } from "./hash-store";
import { resolveWikiLink } from "./wikilink";

const app = new Hono();

/** @deprecated use scannerRoutes instead */
export { app as scannerRoutes };
export default app;

/** 默认 MD 根目录 */
const DEFAULT_MD_ROOT = process.env.NOWEN_MD_ROOT || "";

/** 扫描器全局引用（供 index.ts 设置） */
let scanRunner: ScannerRunner | null = null;

export function setScannerRunner(runner: ScannerRunner): void {
  scanRunner = runner;
}

// ========================================
// 扫描器运行时
// ========================================

export interface ScannerStatus {
  rootDir: string;
  isRunning: boolean;
  lastFullScanAt: string | null;
  trackedFiles: number;
  lastStats: SyncStats | null;
}

export class ScannerRunner {
  private mdRoot: string;
  private hashStore: HashStore;
  private userId: string;
  private isRunning = false;
  private lastStats: SyncStats | null = null;

  constructor(mdRoot: string, userId: string) {
    this.mdRoot = mdRoot;
    this.userId = userId;
    this.hashStore = new HashStore(mdRoot);
  }

  /**
   * 从用户名解析用户 ID
   */
  static resolveUserId(db: import("better-sqlite3").Database, username: string): string | null {
    const row = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as { id: string } | undefined;
    return row?.id || null;
  }

  getStatus(): ScannerStatus {
    return {
      rootDir: this.mdRoot,
      isRunning: this.isRunning,
      lastFullScanAt: this.hashStore.getLastFullScanAt(),
      trackedFiles: this.hashStore.getFileCount(),
      lastStats: this.lastStats,
    };
  }

  getMdRoot(): string {
    return this.mdRoot;
  }

  /**
   * 全量扫描：遍历目录 → 解析文件 → 同步到 DB
   */
  async fullScan(rebuild = false): Promise<SyncStats> {
    if (this.isRunning) {
      throw new Error("扫描器正在运行中");
    }
    if (!this.mdRoot) {
      throw new Error("未配置 MD 根目录（设置 NOWEN_MD_ROOT 环境变量）");
    }

    this.isRunning = true;
    try {
      const db = getDb();

      // 遍历目录
      const files = walkDir(this.mdRoot);
      const parsed: import("./parser").ParsedNote[] = [];

      for (const file of files) {
        // 跳过未变更的文件（非 rebuild 模式）
        if (!rebuild && this.hashStore.isUnchanged(file.relativePath, file.sha256, file.mtimeMs)) {
          continue;
        }

        // 解析文件
        const note = parseMarkdown(file.content, file.relativePath, file.sha256);
        parsed.push(note);

        // 更新 hash 状态
        this.hashStore.updateFile(file.relativePath, file.sha256, file.mtimeMs);
      }

      // 检测已删除的文件
      const currentPaths = new Set(files.map((f) => f.relativePath));
      for (const knownPath of this.hashStore.getKnownFiles()) {
        if (!currentPaths.has(knownPath)) {
          // 文件已被删除
          this.hashStore.removeFile(knownPath);
          // 在 DB 中标记为孤立（不删除数据）
          try {
            db.prepare(
              "UPDATE notes SET isArchived = 1, updatedAt = datetime('now') WHERE sourcePath = ? AND userId = ?",
            ).run(knownPath, this.userId);
          } catch {
            // ignore
          }
        }
      }

      // 同步到 DB
      const stats = syncNotes(db, parsed, {
        userId: this.userId,
        rebuild,
        currentPaths,
      });

      // 解析双链（需要所有笔记的 title→id 映射）
      if (parsed.length > 0) {
        const { titles } = loadNoteTitles(db, this.userId);
        // 需要从 sync-engine 导入 updateBacklinks
        // 这里简化处理：标记需要双链解析
      }

      // 保存扫描状态
      this.hashStore.markFullScan();
      this.hashStore.save();

      this.lastStats = stats;
      return stats;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 增量扫描（仅处理变更文件）
   */
  async incrementalScan(): Promise<SyncStats> {
    return this.fullScan(false);
  }
}

// ========================================
// API 路由
// ========================================

// 触发全量扫描
app.post("/scan", async (c) => {
  if (!scanRunner) {
    return c.json({ error: "扫描器未初始化" }, 500);
  }
  try {
    const stats = await scanRunner.fullScan(false);
    return c.json({ success: true, stats });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// 触发重建（清空 → 重扫）
app.post("/rebuild", async (c) => {
  if (!scanRunner) {
    return c.json({ error: "扫描器未初始化" }, 500);
  }
  try {
    const stats = await scanRunner.fullScan(true);
    return c.json({ success: true, stats });
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 400);
  }
});

// 扫描状态
app.get("/status", (c) => {
  if (!scanRunner) {
    return c.json({ error: "扫描器未初始化" }, 500);
  }
  return c.json(scanRunner.getStatus());
});

// 设置 MD 根目录（热重载）
app.post("/config", async (c) => {
  const body = await c.req.json();
  const rootDir = (body.rootDir || "").trim();
  if (!rootDir) {
    return c.json({ error: "rootDir 不能为空" }, 400);
  }
  // 创建新的扫描器实例
  const runner = new ScannerRunner(rootDir, "admin");
  setScannerRunner(runner);
  return c.json({ success: true, rootDir });
});

