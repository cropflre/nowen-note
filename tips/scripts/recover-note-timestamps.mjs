/**
 * 恢复被「笔记迁移整理」刷新的 updatedAt —— **必须在 nowen-note 容器内运行**。
 *
 * 背景：2026-10-07 08:09/08:10(UTC) 的一次迁移把该账号**全部**笔记的 updatedAt
 * 刷成了那一刻（1734 篇只剩两个时间戳），createdAt 与内容都完好。
 *
 * 恢复来源：升级前的备份 `nowen-note-v1.4.16-preupgrade.db`（比迁移早约 14 小时），
 * 里面的 updatedAt 分布是自然的。
 *
 * ⚠️ 只回填**内容与备份完全一致**的笔记：
 *    内容不同的那些说明是真编辑过，回填会把真实编辑时间也抹掉。
 *
 * ⚠️ 为什么不能直接用 sqlite3 CLI：notes 的 search 触发器调用了应用运行时
 *    才注册的 nowen_search_normalize，裸 CLI 每条 UPDATE 都会报 no such function。
 *
 * 环境变量：
 *   SEED_SQL 不用；这里用
 *   NOWEN_DB    目标库（默认 /app/data/nowen-note.db）
 *   SOURCE_DB   升级前备份（默认 /app/data/tsfix-source.db）
 *   OWNER       账号名（默认 pph）
 *   DRY_RUN     1 = 只统计不写入
 */
import { createRequire } from "node:module";

const require = createRequire("/app/backend/");
const Database = require("better-sqlite3");
const { normalizeSearchText } = require("/app/backend/dist/lib/searchQuery.js");

const dbPath = process.env.NOWEN_DB || "/app/data/nowen-note.db";
const srcPath = process.env.SOURCE_DB || "/app/data/tsfix-source.db";
const owner = process.env.OWNER || "pph";
const dryRun = process.env.DRY_RUN === "1";

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 15000");
// 与应用同一份实现，否则触发器会拦下每一条 UPDATE
db.function("nowen_search_normalize", { deterministic: true }, (v) =>
  normalizeSearchText(v === null || v === undefined ? "" : String(v)),
);

db.exec(`ATTACH DATABASE '${srcPath}' AS bk`);

const ownerId = db.prepare("SELECT id FROM users WHERE username = ?").get(owner)?.id;
if (!ownerId) {
  console.error(`  ✗ 找不到账号 ${owner}`);
  process.exit(1);
}

const total = db
  .prepare("SELECT COUNT(*) c FROM notes WHERE userId = ? AND isTrashed = 0")
  .get(ownerId).c;

/** 内容一致 = 可以安全回填 */
const eligible = db
  .prepare(
    `SELECT COUNT(*) c FROM notes n
       JOIN bk.notes b ON b.id = n.id AND b.content = n.content
      WHERE n.userId = ? AND n.isTrashed = 0`,
  )
  .get(ownerId).c;

/** 有 id 但内容不同 → 真编辑过，跳过 */
const contentDiffers = db
  .prepare(
    `SELECT COUNT(*) c FROM notes n
       JOIN bk.notes b ON b.id = n.id AND b.content <> n.content
      WHERE n.userId = ? AND n.isTrashed = 0`,
  )
  .get(ownerId).c;

/** 备份里没有 → 迁移之后新建的，跳过 */
const notInBackup = db
  .prepare(
    `SELECT COUNT(*) c FROM notes n
      WHERE n.userId = ? AND n.isTrashed = 0
        AND NOT EXISTS (SELECT 1 FROM bk.notes b WHERE b.id = n.id)`,
  )
  .get(ownerId).c;

const todayBefore = db
  .prepare(
    `SELECT COUNT(*) c FROM notes
      WHERE userId = ? AND isTrashed = 0 AND substr(updatedAt,1,10) = '2026-10-07'`,
  )
  .get(ownerId).c;

console.log(`  未删除笔记 ${total} 篇`);
console.log(`  可安全回填（内容一致）${eligible} 篇`);
console.log(`  跳过·内容已变（真编辑过）${contentDiffers} 篇`);
console.log(`  跳过·备份里没有（新建）${notInBackup} 篇`);
console.log(`  修复前停留在 2026-10-07 的：${todayBefore} 篇`);

if (dryRun) {
  console.log("  （DRY_RUN=1，未写入）");
  process.exit(0);
}

const run = db.transaction(() => {
  const info = db
    .prepare(
      `UPDATE notes
          SET updatedAt = (SELECT b.updatedAt FROM bk.notes b WHERE b.id = notes.id)
        WHERE userId = ?
          AND isTrashed = 0
          AND EXISTS (
            SELECT 1 FROM bk.notes b
             WHERE b.id = notes.id AND b.content = notes.content
          )`,
    )
    .run(ownerId);
  return info.changes;
});

const changed = run();
const todayAfter = db
  .prepare(
    `SELECT COUNT(*) c FROM notes
      WHERE userId = ? AND isTrashed = 0 AND substr(updatedAt,1,10) = '2026-10-07'`,
  )
  .get(ownerId).c;

console.log(`  ✓ 已回填 ${changed} 篇`);
console.log(`  修复后停留在 2026-10-07 的：${todayAfter} 篇（应只剩今天真正动过的那几篇）`);
console.log("  新的 updatedAt 分布（Top 6）：");
for (const r of db
  .prepare(
    `SELECT substr(updatedAt,1,10) d, COUNT(*) c FROM notes
      WHERE userId = ? AND isTrashed = 0 GROUP BY d ORDER BY c DESC LIMIT 6`,
  )
  .all(ownerId)) {
  console.log(`    ${r.d}  ${r.c} 篇`);
}
db.exec("DETACH DATABASE bk");
db.close();
