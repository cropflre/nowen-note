/**
 * 数据库文件（.data）级别的导出 / 导入 / 空间统计
 *
 * 与 /api/backups 的区别：
 *   - /api/backups 面向系统定时备份（有 .meta.json、批量管理）
 *   - /api/data-file 面向用户主动操作：一次性下载当前 `.data` 文件 /
 *     上传另一个 `.data` 文件覆盖当前库；以及单纯查看占用大小
 *
 * 安全模型：
 *   - info   ：登录用户即可查看（返回字节数，非敏感）
 *   - export ：仅管理员（下载整库文件 = 所有用户数据）
 *   - import ：仅管理员 + sudo（会覆盖全部数据）
 *
 * 导入流程（Windows 文件锁安全）：
 *   1) 校验上传文件头前 16 字节为 "SQLite format 3\0"
 *   2) 将上传文件写入 `<dbPath>.import.tmp`
 *   3) 对当前库执行 `db.backup()` 快照到 `<dbPath>.pre-import-<ts>.bak`
 *   4) closeDb() 释放句柄
 *   5) fs.rename(tmp, dbPath)（原子替换）
 *   6) 清理 -wal / -shm 旁路文件（否则打开会复原旧内容）
 *   7) 返回 requireRestart=true，前端提示用户重启后端进程
 */

import { Hono } from "hono";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import Database from "better-sqlite3";
import { getDb, getDbPath, closeDb } from "../db/schema.js";
import { verifySudoFromRequest } from "../lib/auth-security.js";
import { getAttachmentsDir } from "./attachments.js";

const app = new Hono();

// SQLite 文件头（前 16 字节固定）
const SQLITE_MAGIC = Buffer.from("SQLite format 3\u0000", "utf-8");

/** 读取当前 db 主文件 + wal + shm 的总字节数（如果存在） */
function computeDbFileSize(dbPath: string): { main: number; wal: number; shm: number; total: number } {
  const main = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  const wal = fs.existsSync(dbPath + "-wal") ? fs.statSync(dbPath + "-wal").size : 0;
  const shm = fs.existsSync(dbPath + "-shm") ? fs.statSync(dbPath + "-shm").size : 0;
  return { main, wal, shm, total: main + wal + shm };
}

/** 递归求目录占用（用于整个 data 目录的空间统计，包含 attachments、backups 等） */
function computeDirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      try {
        if (ent.isDirectory()) {
          stack.push(full);
        } else if (ent.isFile()) {
          total += fs.statSync(full).size;
        }
      } catch { /* ignore */ }
    }
  }
  return total;
}

/** 校验请求者是否管理员；非管理员返回统一错误 Response，否则返回 null */
function requireAdminOrDeny(c: any): Response | null {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权" }, 401);
  const db = getDb();
  const me = db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | undefined;
  if (!me || me.role !== "admin") return c.json({ error: "仅管理员可操作" }, 403);
  return null;
}

// ============================================================================
// GET /api/data-file/info — 数据库文件大小 & 系统占用概览
// ----------------------------------------------------------------------------
// 所有登录用户可见。字段：
//   dbFile:       当前 SQLite 文件（含 -wal / -shm）字节数
//   dataDir:      data 目录总占用（含 attachments 等），仅管理员返回（避免普通用户看到 server 路径结构）
//   counts:       系统范围 notes/users/notebooks 数量；普通用户只拿到自己维度
//   userUsage:    当前用户数据估算占用（基于文本字段 LENGTH() + attachments.size）
// ============================================================================
app.get("/info", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权" }, 401);
  const db = getDb();
  const me = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId) as { id: string; role: string } | undefined;
  if (!me) return c.json({ error: "未授权" }, 401);
  const isAdmin = me.role === "admin";

  // 1) 数据库文件大小
  const dbPath = getDbPath();
  const dbFile = computeDbFileSize(dbPath);

  // 2) 当前用户的数据量估算
  function safeGet<T = any>(sql: string, ...params: any[]): T | null {
    try { return db.prepare(sql).get(...params) as T; } catch { return null; }
  }
  const userNoteStats = safeGet<{ count: number; bytes: number }>(
    `SELECT COUNT(*) as count,
            COALESCE(SUM(
              COALESCE(LENGTH(content), 0) +
              COALESCE(LENGTH(contentText), 0) +
              COALESCE(LENGTH(title), 0)
            ), 0) as bytes
       FROM notes WHERE userId = ?`, userId
  ) || { count: 0, bytes: 0 };
  const userAttachmentStats = safeGet<{ count: number; bytes: number }>(
    `SELECT COUNT(*) as count, COALESCE(SUM(COALESCE(size, 0)), 0) as bytes
       FROM attachments WHERE userId = ?`, userId
  ) || { count: 0, bytes: 0 };
  const userNotebookCount = safeGet<{ c: number }>(
    `SELECT COUNT(*) as c FROM notebooks WHERE userId = ?`, userId
  )?.c || 0;

  // 3) 系统聚合（所有用户可见笔记数/用户数，非敏感聚合）
  const sysNoteCount = safeGet<{ c: number }>("SELECT COUNT(*) as c FROM notes")?.c || 0;
  const sysUserCount = safeGet<{ c: number }>("SELECT COUNT(*) as c FROM users")?.c || 0;
  const sysNotebookCount = safeGet<{ c: number }>("SELECT COUNT(*) as c FROM notebooks")?.c || 0;

  // 4) data 目录（管理员才看到，避免泄漏服务器路径）
  let dataDirTotal = 0;
  let dataDir: string | null = null;
  if (isAdmin) {
    dataDir = path.dirname(dbPath);
    dataDirTotal = computeDirSize(dataDir);
  }

  return c.json({
    dbFile: {
      path: isAdmin ? dbPath : undefined,
      main: dbFile.main,
      wal: dbFile.wal,
      shm: dbFile.shm,
      total: dbFile.total,
    },
    user: {
      notes: userNoteStats,
      attachments: userAttachmentStats,
      notebookCount: userNotebookCount,
      totalBytes: userNoteStats.bytes + userAttachmentStats.bytes,
    },
    system: {
      noteCount: sysNoteCount,
      userCount: sysUserCount,
      notebookCount: sysNotebookCount,
      dataDirBytes: isAdmin ? dataDirTotal : undefined,
      dataDirPath: isAdmin ? dataDir : undefined,
    },
  });
});

// ============================================================================
// GET /api/data-file/export — 下载当前 SQLite 文件
// ----------------------------------------------------------------------------
// 仅管理员。使用 `db.backup()` 在线 copy 到临时文件再流式返回，避免读取活动 WAL
// 造成的不一致（热备份）。
// ============================================================================
app.get("/export", async (c) => {
  const denied = requireAdminOrDeny(c);
  if (denied) return denied;

  const db = getDb();
  const dbPath = getDbPath();
  const tmpDir = path.dirname(dbPath);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const tmpPath = path.join(tmpDir, `.export-${ts}-${crypto.randomBytes(4).toString("hex")}.tmp`);

  try {
    await db.backup(tmpPath);
    const content = fs.readFileSync(tmpPath);
    const checksum = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    const filename = `nowen-note-${ts}.data`;

    return new Response(content, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": content.length.toString(),
        "X-Data-Checksum": checksum,
      },
    });
  } catch (err: any) {
    return c.json({ error: `导出失败: ${err.message}` }, 500);
  } finally {
    // 清理临时文件（Response 已 readFileSync 进内存）
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
});

// ============================================================================
// POST /api/data-file/import — 上传 .data 文件覆盖当前库
// ----------------------------------------------------------------------------
// 仅管理员 + sudo。multipart/form-data，字段名 "file"。
// 流程见文件头注释。成功后后端关闭了 db 连接，**必须重启进程**才能让后续
// getDb() 重新打开新文件；否则 better-sqlite3 会再打开一个空库。
// ============================================================================
app.post("/import", async (c) => {
  // 1) 权限：管理员 + sudo
  const denied = requireAdminOrDeny(c);
  if (denied) return denied;

  const userId = c.req.header("X-User-Id") || "";
  const db = getDb();
  const me = db.prepare("SELECT tokenVersion FROM users WHERE id = ?").get(userId) as { tokenVersion: number } | undefined;
  const sudo = verifySudoFromRequest(c, userId, me?.tokenVersion ?? 0);
  if (!sudo.ok) {
    return c.json({ error: sudo.message, code: sudo.code }, sudo.status as any);
  }

  // 2) 读取上传文件
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "请求必须是 multipart/form-data" }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "缺少 file 字段" }, 400);
  }
  if (file.size === 0) {
    return c.json({ error: "上传文件为空" }, 400);
  }
  // 上限 500MB，避免恶意大文件
  if (file.size > 500 * 1024 * 1024) {
    return c.json({ error: "文件过大（>500MB）" }, 413);
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  // 3) 校验 SQLite 文件头
  if (bytes.length < 16 || !bytes.slice(0, 16).equals(SQLITE_MAGIC)) {
    return c.json({ error: "文件不是合法的 SQLite 数据库（文件头校验失败）" }, 400);
  }

  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const tmpPath = path.join(dir, `.import-${ts}.tmp`);
  const preBackupPath = path.join(dir, `nowen-note.pre-import-${ts}.bak`);

  try {
    // 4) 先把新数据写到临时文件，并用 better-sqlite3 打开校验（能 PRAGMA 读到 schema 才算合法）
    fs.writeFileSync(tmpPath, bytes);
    try {
      const probe = new Database(tmpPath, { readonly: true });
      try {
        probe.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").get();
      } finally {
        probe.close();
      }
    } catch (err: any) {
      fs.unlinkSync(tmpPath);
      return c.json({ error: `数据库文件无法打开：${err.message}` }, 400);
    }

    // 5) 备份当前库（使用在线 backup，保证一致性）
    try {
      await db.backup(preBackupPath);
    } catch (err: any) {
      // 备份失败，拒绝继续，防止数据丢失
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      return c.json({ error: `导入前的安全备份失败，已中止: ${err.message}` }, 500);
    }

    // 6) 关闭当前连接（释放 Windows 文件锁）
    closeDb();

    // 7) 替换主库文件 + 清理 wal / shm
    try {
      fs.renameSync(tmpPath, dbPath); // 原子替换
    } catch (err: any) {
      // 替换失败，尝试从备份还原
      try {
        const backupData = fs.readFileSync(preBackupPath);
        fs.writeFileSync(dbPath, backupData);
      } catch { /* ignore */ }
      return c.json({ error: `替换数据库文件失败: ${err.message}` }, 500);
    }
    for (const side of [dbPath + "-wal", dbPath + "-shm"]) {
      try { if (fs.existsSync(side)) fs.unlinkSync(side); } catch { /* ignore */ }
    }

    const newSize = fs.statSync(dbPath).size;
    return c.json({
      success: true,
      requireRestart: true,
      message: "导入成功，请重启后端进程以加载新数据库",
      size: newSize,
      preImportBackup: path.basename(preBackupPath),
    });
  } catch (err: any) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return c.json({ error: `导入失败: ${err.message}` }, 500);
  }
});

// ============================================================================
// POST /api/data-file/cleanup-orphans — 清理孤儿附件
// ----------------------------------------------------------------------------
// 所有登录用户可用，但只清理"当前用户名下"的孤儿附件。
//
// 孤儿两类：
//   1) DB 孤儿：attachments 行的 noteId 已经不存在（笔记早被永久删除，但历史
//      版本遗留了行），CASCADE 场景下正常不会出现；为兼容老数据仍然扫一次。
//   2) 磁盘孤儿：文件系统里存在、但 attachments 表里已经没有对应行的物理文件
//      （来自之前"清空回收站"未清理物理文件的历史残留）。
//
// 为了安全，磁盘扫描只删除**存在于 attachments.path 命名约定**（uuid.扩展名）
// 的文件，并用"不在 DB 已登记 path 集合内"作为判定标准，不会误删其它用户数据。
// ============================================================================
app.post("/cleanup-orphans", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权" }, 401);
  const db = getDb();
  const me = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId) as { id: string; role: string } | undefined;
  if (!me) return c.json({ error: "未授权" }, 401);
  const isAdmin = me.role === "admin";

  // 1) DB 孤儿：attachments 行 noteId 对应的 notes 已不存在
  //    普通用户仅清自己；管理员清全表
  const dbOrphanRows = (isAdmin
    ? db.prepare(
        `SELECT a.id, a.path FROM attachments a
         LEFT JOIN notes n ON n.id = a.noteId
         WHERE n.id IS NULL`,
      ).all()
    : db.prepare(
        `SELECT a.id, a.path FROM attachments a
         LEFT JOIN notes n ON n.id = a.noteId
         WHERE n.id IS NULL AND a.userId = ?`,
      ).all(userId)) as { id: string; path: string }[];

  const attachmentsDir = getAttachmentsDir();
  let dbOrphansRemoved = 0;
  let dbOrphanFilesRemoved = 0;
  if (dbOrphanRows.length > 0) {
    const delStmt = db.prepare("DELETE FROM attachments WHERE id = ?");
    const tx = db.transaction((list: { id: string; path: string }[]) => {
      for (const r of list) {
        // 删文件
        try {
          const abs = path.join(attachmentsDir, r.path);
          if (fs.existsSync(abs)) {
            fs.unlinkSync(abs);
            dbOrphanFilesRemoved++;
          }
        } catch { /* ignore */ }
        // 删 DB 行
        try {
          delStmt.run(r.id);
          dbOrphansRemoved++;
        } catch { /* ignore */ }
      }
    });
    tx(dbOrphanRows);
  }

  // 2) 磁盘孤儿：仅管理员才能做全量扫描（普通用户拿不到其它人上传的文件列表）
  let diskOrphansRemoved = 0;
  let diskOrphanBytes = 0;
  let diskScanSkipped = false;
  if (isAdmin) {
    try {
      // 收集 DB 中已登记的全部 path
      const rows = db.prepare("SELECT path FROM attachments").all() as { path: string }[];
      const knownPaths = new Set<string>();
      for (const r of rows) {
        if (r?.path) knownPaths.add(r.path);
      }
      // 扫描目录
      if (fs.existsSync(attachmentsDir)) {
        const entries = fs.readdirSync(attachmentsDir, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isFile()) continue;
          // 仅清理符合 "uuid.ext" 命名约定的文件，避免误删用户自己放进来的东西
          // uuid v4: 8-4-4-4-12 hex
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i.test(ent.name)) {
            continue;
          }
          if (knownPaths.has(ent.name)) continue;
          const abs = path.join(attachmentsDir, ent.name);
          try {
            const size = fs.statSync(abs).size;
            fs.unlinkSync(abs);
            diskOrphansRemoved++;
            diskOrphanBytes += size;
          } catch { /* ignore */ }
        }
      }
    } catch {
      diskScanSkipped = true;
    }
  } else {
    diskScanSkipped = true;
  }

  return c.json({
    success: true,
    dbOrphansRemoved,        // 已清理的孤儿 attachments 行数
    dbOrphanFilesRemoved,    // 与上面孤儿行关联的、成功 unlink 的磁盘文件数
    diskOrphansRemoved,      // 磁盘上无 DB 对应的孤儿文件被清理数（管理员才执行）
    diskOrphanBytes,         // 磁盘孤儿释放的字节数
    diskScanSkipped,         // 非管理员时跳过磁盘全量扫描
  });
});

// ============================================================================
// POST /api/data-file/vacuum — 压缩 SQLite 数据库，真正回收磁盘空间
// ----------------------------------------------------------------------------
// 仅管理员。SQLite 的 VACUUM 会重写整个主文件，把 DELETE 留下的空闲 page
// 真正释放；同时建议先 wal_checkpoint(TRUNCATE) 把 WAL 并回主文件并截断。
//
// 注意：
//   - VACUUM 会获取 DB 排他锁，执行期间其它写操作会等待
//   - 大库执行时间较长（几百 MB 可能数秒～数十秒）
//   - VACUUM 需要临时"约等于原库大小"的磁盘空间
// ============================================================================
app.post("/vacuum", (c) => {
  const denied = requireAdminOrDeny(c);
  if (denied) return denied;

  const dbPath = getDbPath();
  const before = computeDbFileSize(dbPath);

  const db = getDb();
  try {
    // 1) 将 WAL 并回主文件并截断（否则 VACUUM 后 WAL 仍可能很大）
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* ignore */ }

    // 2) 真正执行 VACUUM
    db.exec("VACUUM");

    // 3) 再做一次 checkpoint，确保新产生的变更也落盘
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* ignore */ }
  } catch (err: any) {
    return c.json({ error: `VACUUM 失败: ${err.message}` }, 500);
  }

  const after = computeDbFileSize(dbPath);
  return c.json({
    success: true,
    before: { main: before.main, wal: before.wal, shm: before.shm, total: before.total },
    after: { main: after.main, wal: after.wal, shm: after.shm, total: after.total },
    freed: Math.max(0, before.total - after.total),
  });
});

export default app;
