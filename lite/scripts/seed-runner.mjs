/**
 * 播种执行器 —— **必须在 nowen-note 容器内运行**。
 *
 * ⚠️ 为什么不能用 `sqlite3` CLI 直接喂 SQL：
 *    库里的 notes_search_ai / notes_search_ad / notes_search_au 三个触发器
 *    调用了**应用运行时才注册**的自定义函数 `nowen_search_normalize`，
 *    裸 sqlite3 没有这个函数 → 每条 INSERT 都报
 *    "no such function: nowen_search_normalize" ✗
 *
 * 这里用容器自带的 better-sqlite3 打开库，并把函数注册成**与应用完全同一份实现**
 * （直接 require 应用的构建产物，不自己重写，避免两边行为漂移）。
 *
 * 环境变量：
 *   SEED_SQL  要执行的 SQL 文件（默认 /app/data/seed-nowen-test.sql）
 *   NOWEN_DB  目标数据库（默认 /app/data/nowen-note.db）
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire("/app/backend/");
const Database = require("better-sqlite3");
const { normalizeSearchText } = require("/app/backend/dist/lib/searchQuery.js");

const sqlPath = process.env.SEED_SQL || "/app/data/seed-nowen-test.sql";
const dbPath = process.env.NOWEN_DB || "/app/data/nowen-note.db";
const username = "nowen";

const sql = readFileSync(sqlPath, "utf8");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 10000"); // 应用正在跑，等它让出写锁

// 与应用同一份实现 —— 触发器、FTS、搜索都依赖它
db.function("nowen_search_normalize", { deterministic: true }, (v) =>
  normalizeSearchText(v === null || v === undefined ? "" : String(v)),
);

const uid = db.prepare("SELECT id FROM users WHERE username = ?").get(username)?.id;
if (!uid) {
  console.error(`  ✗ 找不到用户 ${username}，先建账号再播种`);
  process.exit(1);
}

const count = () => ({
  notebooks: db.prepare(
    "SELECT COUNT(*) c FROM notebooks WHERE userId = ? AND isDeleted = 0").get(uid).c,
  notes: db.prepare(
    "SELECT COUNT(*) c FROM notes WHERE userId = ? AND isTrashed = 0").get(uid).c,
  trash: db.prepare("SELECT COUNT(*) c FROM notes WHERE userId = ?").get(uid).c,
});

const before = count();
console.log(`  改动前：笔记本 ${before.notebooks} / 笔记 ${before.notes}`);

db.exec(sql); // SQL 自带 BEGIN/COMMIT

const after = count();
console.log(`  改动后：笔记本 ${after.notebooks} / 笔记 ${after.notes}`);

// 关键自检：userId 必须真的挂上了（早期版本会把子查询当字符串插进去，
// 结果造出一堆 userId 是文字 "(SELECT ...)" 的孤儿数据）
const orphans = db.prepare(
  "SELECT COUNT(*) c FROM notebooks WHERE userId LIKE '(SELECT%' OR userId = ''").get().c;
if (orphans > 0) {
  console.error(`  ✗ 有 ${orphans} 个笔记本的 userId 不是真 id —— SQL 拼装有问题`);
  process.exit(2);
}
const perFormat = db.prepare(
  `SELECT contentFormat f, COUNT(*) c FROM notes WHERE userId = ? GROUP BY contentFormat ORDER BY c DESC`,
).all(uid);
console.log("  格式分布：" + perFormat.map((r) => `${r.f} ${r.c}`).join(" / "));
const empty = db.prepare(
  `SELECT COUNT(*) c FROM notebooks nb WHERE nb.userId = ? AND nb.isDeleted = 0
     AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.notebookId = nb.id AND n.isTrashed = 0)`,
).get(uid).c;
console.log(`  空笔记本：${empty} 个`);
db.close();
console.log("  ✓ 播种完成");
