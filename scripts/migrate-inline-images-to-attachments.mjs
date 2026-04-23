#!/usr/bin/env node
/**
 * migrate-inline-images-to-attachments.mjs
 * ----------------------------------------------------------------------
 * 一次性迁移脚本：把 notes.content 里的内联 base64 图片抽出来落盘 +
 * 写入 attachments 表，并把 content 里的 data URI 替换为
 * `/api/attachments/<id>`。
 *
 * 背景：
 *   历史版本的编辑器把粘贴/插入的图片以 data URI 形式写进 notes.content，
 *   随笔记一起存；一张手机截图就能让单条 note.content 膨胀到几 MB。
 *   本次改造新增了 /api/attachments 路由，图片会落到磁盘文件，content 里
 *   只保留引用 URL；但老数据里已经躺着一堆内联 base64，需要这个脚本清洗。
 *
 * 用法：
 *   node scripts/migrate-inline-images-to-attachments.mjs \
 *        [--db <path>] [--attachments-dir <path>] \
 *        [--dry-run|--apply] [--limit N] [--ids a,b,c] [--verbose]
 *
 *   node scripts/migrate-inline-images-to-attachments.mjs --rollback <backup-file> [--db <path>] [--yes]
 *
 * 选项：
 *   --db                    指定 SQLite 数据库文件路径。
 *                           默认 $DB_PATH → <ELECTRON_USER_DATA or cwd>/data/nowen-note.db
 *   --attachments-dir       附件落盘目录（后端路由里也读这个路径）。
 *                           默认 <ELECTRON_USER_DATA or cwd>/data/attachments/
 *   --dry-run               只预览（默认）。不写磁盘、不写 DB。
 *   --apply                 真正执行。会先对数据库生成 .bak 备份。
 *                           注意：附件文件不会生成备份（首次迁移目录本来就应为空）。
 *   --limit N               最多处理 N 条 note。
 *   --ids a,b,c             仅处理指定笔记 ID。
 *   --verbose               打印每条笔记的替换细节。
 *   --rollback <backup>     用指定 .bak 文件覆盖数据库。
 *                           ⚠️ 回滚数据库不会删除已落盘的附件文件；
 *                              需要自己清理 attachments 目录中
 *                              迁移时生成的 <uuid>.<ext>。
 *   --yes / -y              跳过交互确认。
 *   --help                  显示帮助。
 *
 * 重要：--apply 前一定先停掉后端服务，避免写冲突。
 *
 * 扫描策略：
 *   - 只匹配 <img src="data:image/...;base64,...">（或单引号包裹），
 *     与前端编辑器输出对齐；不碰 CSS / 非 img 场景。
 *   - content 字段可能是 Tiptap JSON 的 stringify 形式（src 在属性对象里）
 *     也可能是 HTML 字符串（src 在属性上）—— 两种都是"被引号包围的 data URI"，
 *     用同一个正则安全替换 src 的值。
 *   - 幂等：脚本再跑一次时会因为 content 里已无 data URI 而直接跳过。
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const args = {
    db: null,
    attachmentsDir: null,
    dryRun: true,
    limit: 0,
    ids: null,
    verbose: false,
    help: false,
    rollback: null,
    yes: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--db":
        args.db = argv[++i];
        break;
      case "--attachments-dir":
        args.attachmentsDir = argv[++i];
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--apply":
        args.dryRun = false;
        break;
      case "--limit":
        args.limit = parseInt(argv[++i] || "0", 10);
        break;
      case "--ids":
        args.ids = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--rollback":
        args.rollback = argv[++i];
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        console.warn(`未识别参数: ${a}`);
    }
  }
  return args;
}

function printHelp() {
  const me = "scripts/migrate-inline-images-to-attachments.mjs";
  console.log(`用法：
  # 1. 迁移（dry-run 预览 / --apply 写入）
  node ${me} [--db <path>] [--attachments-dir <path>]
             [--dry-run|--apply] [--limit N] [--ids a,b] [--verbose]

  # 2. 回滚到指定备份（仅覆盖 DB，需自行清理附件目录）
  node ${me} --rollback <backup-file> [--db <path>] [--yes]

选项：
  --db                 指定 SQLite 文件路径，默认 data/nowen-note.db
  --attachments-dir    附件落盘目录，默认 data/attachments/
  --dry-run            只预览（默认）
  --apply              真正执行（先生成 .bak 备份；按笔记粒度做事务）
  --limit N            最多处理 N 条笔记
  --ids a,b            仅处理指定笔记 ID
  --verbose            打印每条笔记的替换详情
  --rollback           用指定 .bak 文件覆盖数据库
  --yes                跳过回滚前的交互确认`);
}

// ---------- 路径与工具 ----------

function resolveDbPath(cliPath) {
  if (cliPath) return path.resolve(cliPath);
  if (process.env.DB_PATH) return path.resolve(process.env.DB_PATH);
  const base = process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data");
  return path.resolve(base, "nowen-note.db");
}

function resolveAttachmentsDir(cliPath) {
  if (cliPath) return path.resolve(cliPath);
  const base = process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data");
  return path.resolve(base, "attachments");
}

function backupDb(dbPath) {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const bak = `${dbPath}.${stamp}.bak`;
  fs.copyFileSync(dbPath, bak);
  return bak;
}

function confirmInteractive(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// ---------- base64 图片抽取（与 backend/src/routes/attachments.ts 对齐） ----------

// 允许的图片 MIME（svg/ico 放行，按前端默认接受范围）
const ALLOWED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

const MIME_TO_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

const MAX_SIZE = 50 * 1024 * 1024; // 50MB，与后端一致

// 匹配被引号包裹的 data URI："data:image/xxx;base64,...."
const INLINE_IMG_BASE64_RE = /(["'])data:(image\/[a-z0-9.+\-]+);base64,([A-Za-z0-9+/=]+)\1/gi;

/**
 * 对单条 content 扫描抽取 base64 图片。
 * 返回：{ content, writes }。writes 是待写磁盘 + 写 DB 的操作列表。
 * 这里只**准备**操作，真正落盘/入库由调用方在事务外（文件系统）+ 事务内（DB）执行，
 * 便于 dry-run 模式直接看到将要产生多少附件。
 */
function prepareRewrites(content, noteId, userId, attachmentsDir) {
  const writes = [];
  if (!content || typeof content !== "string") return { content: content || "", writes };
  if (content.indexOf("data:image") < 0) return { content, writes };

  const newContent = content.replace(
    INLINE_IMG_BASE64_RE,
    (match, quote, mime, base64) => {
      const mimeLower = mime.toLowerCase();
      if (!ALLOWED_MIMES.has(mimeLower)) return match;

      let buffer;
      try {
        buffer = Buffer.from(base64, "base64");
      } catch {
        return match;
      }
      if (buffer.length === 0 || buffer.length > MAX_SIZE) return match;

      const id = crypto.randomUUID();
      const ext = MIME_TO_EXT[mimeLower] || "bin";
      const filename = `${id}.${ext}`;
      const savePath = path.join(attachmentsDir, filename);

      writes.push({
        id,
        noteId,
        userId,
        filename,
        mime: mimeLower,
        size: buffer.length,
        buffer,
        savePath,
      });

      return `${quote}/api/attachments/${id}${quote}`;
    },
  );

  return { content: newContent, writes };
}

// ---------- 迁移流程 ----------

async function runMigrate(args) {
  const dbPath = resolveDbPath(args.db);
  const attachmentsDir = resolveAttachmentsDir(args.attachmentsDir);

  if (!fs.existsSync(dbPath)) {
    console.error(`[x] 数据库文件不存在: ${dbPath}`);
    process.exit(1);
  }

  console.log(`[i] DB:              ${dbPath}`);
  console.log(`[i] Attachments dir: ${attachmentsDir}`);
  console.log(`[i] Mode:            ${args.dryRun ? "DRY-RUN" : "APPLY"}`);

  if (!args.dryRun) {
    const bak = backupDb(dbPath);
    console.log(`[i] 已生成 DB 备份:   ${bak}`);
    console.log(`[i] 如需回滚：node scripts/migrate-inline-images-to-attachments.mjs --rollback "${bak}"`);

    if (!fs.existsSync(attachmentsDir)) {
      fs.mkdirSync(attachmentsDir, { recursive: true });
      console.log(`[i] 已创建附件目录:   ${attachmentsDir}`);
    }
  }

  const db = new Database(dbPath);
  try {
    // 确认 attachments 表存在（老库可能未跑过 initSchema）
    const hasAttachments = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attachments'")
      .get();
    if (!hasAttachments) {
      console.error(`[x] 数据库中没有 attachments 表，请先启动一次后端以建表。`);
      process.exit(1);
    }

    // 选出候选笔记：content 里包含 "data:image" 字样。用 LIKE 做粗筛，
    // 后面 JS 正则再精确匹配。
    let sql =
      "SELECT id, userId, content FROM notes WHERE content LIKE '%data:image%' AND isTrashed = 0";
    const params = [];
    if (args.ids && args.ids.length > 0) {
      sql += ` AND id IN (${args.ids.map(() => "?").join(",")})`;
      params.push(...args.ids);
    }
    sql += " ORDER BY updatedAt DESC";
    if (args.limit > 0) {
      sql += " LIMIT ?";
      params.push(args.limit);
    }

    const rows = db.prepare(sql).all(...params);
    console.log(`[i] 候选笔记（含 data:image 字样）: ${rows.length} 条`);

    // 预备 DB 语句
    const updateContent = db.prepare("UPDATE notes SET content = ? WHERE id = ?");
    const insertAtt = db.prepare(
      `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    let totalNotes = 0;
    let totalImages = 0;
    let totalBytesSaved = 0;
    let failures = 0;

    for (const row of rows) {
      const { content: newContent, writes } = prepareRewrites(
        row.content,
        row.id,
        row.userId,
        attachmentsDir,
      );
      if (writes.length === 0) continue;

      const originalSize = Buffer.byteLength(row.content, "utf8");
      const newSize = Buffer.byteLength(newContent, "utf8");
      const saved = originalSize - newSize;

      if (args.verbose || args.dryRun) {
        console.log(
          `[~] note=${row.id}  user=${row.userId}  imgs=${writes.length}  ` +
            `content: ${originalSize}B → ${newSize}B  (-${saved}B)`,
        );
      }

      if (args.dryRun) {
        totalNotes++;
        totalImages += writes.length;
        totalBytesSaved += saved;
        continue;
      }

      // APPLY：先落盘，再在单笔记事务内写 attachments + 更新 content。
      // 任一步失败时清理本轮已落盘的文件，保证不产生孤儿文件。
      const writtenFiles = [];
      try {
        for (const w of writes) {
          fs.writeFileSync(w.savePath, w.buffer);
          writtenFiles.push(w.savePath);
        }
        const tx = db.transaction(() => {
          for (const w of writes) {
            insertAtt.run(w.id, w.noteId, w.userId, w.filename, w.mime, w.size, w.filename);
          }
          updateContent.run(newContent, row.id);
        });
        tx();

        totalNotes++;
        totalImages += writes.length;
        totalBytesSaved += saved;
      } catch (err) {
        failures++;
        console.error(`[x] note=${row.id} 迁移失败: ${err?.message || err}`);
        // 回滚本轮磁盘文件
        for (const p of writtenFiles) {
          try { fs.unlinkSync(p); } catch { /* ignore */ }
        }
      }
    }

    console.log("");
    console.log(`========== 迁移摘要 (${args.dryRun ? "DRY-RUN" : "APPLIED"}) ==========`);
    console.log(`  处理笔记数       : ${totalNotes}`);
    console.log(`  抽取图片数       : ${totalImages}`);
    console.log(`  content 体积节省 : ${formatBytes(totalBytesSaved)}`);
    if (failures > 0) {
      console.log(`  ⚠️ 失败笔记数    : ${failures}`);
    }
    console.log("===============================================");

    if (args.dryRun) {
      console.log("[i] 这是 dry-run，没有任何写入。加 --apply 执行。");
    } else if (failures > 0) {
      console.log(`[!] 有 ${failures} 条笔记失败，可用 --rollback 恢复 DB；`);
      console.log(`    成功笔记对应的附件文件会留在 ${attachmentsDir}，回滚 DB 后需手动清理。`);
      process.exitCode = 1;
    } else {
      console.log("[✓] 迁移完成。");
    }
  } finally {
    db.close();
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---------- 回滚 ----------

async function runRollback(args) {
  const dbPath = resolveDbPath(args.db);
  const backupPath = path.resolve(args.rollback);

  if (!fs.existsSync(backupPath)) {
    console.error(`[x] 备份文件不存在: ${backupPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(dbPath)) {
    console.error(`[x] 数据库文件不存在: ${dbPath}`);
    process.exit(1);
  }

  const backupStat = fs.statSync(backupPath);
  const dbStat = fs.statSync(dbPath);

  console.log(`[i] 即将用备份覆盖数据库：`);
  console.log(`      backup : ${backupPath}  (${backupStat.size} bytes, ${backupStat.mtime.toISOString()})`);
  console.log(`      target : ${dbPath}  (${dbStat.size} bytes, ${dbStat.mtime.toISOString()})`);
  console.log(`[!] 回滚数据库**不会**删除已落盘的附件文件，需要自行清理 attachments 目录中`);
  console.log(`    迁移时生成的 <uuid>.<ext>（DB 里对应的行已被回滚，这些文件会变成孤儿）。`);
  console.log(`[!] 此操作**不可逆**，请务必先停止后端服务。`);

  if (!args.yes) {
    const ok = await confirmInteractive("确认继续回滚？(y/N) ");
    if (!ok) {
      console.log("[i] 已取消。");
      return;
    }
  }

  // 回滚前先保存一份当前 DB 作为安全副本
  const safetyBak = backupDb(dbPath);
  console.log(`[i] 当前数据库已保存为安全副本：${safetyBak}`);

  fs.copyFileSync(backupPath, dbPath);
  console.log(`[✓] 回滚完成：已用 ${path.basename(backupPath)} 覆盖数据库。`);
}

// ---------- 入口 ----------

(async () => {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }
  if (args.rollback) {
    await runRollback(args);
    return;
  }
  await runMigrate(args);
})().catch((err) => {
  console.error("[x] 脚本异常退出:", err);
  process.exit(1);
});
