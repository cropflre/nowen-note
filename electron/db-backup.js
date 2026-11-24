// 升级前的数据库快照：整包更新（updater.js）和热更新（hot-update/loader.js）共用。
// 把 nowen-note.db 及 -wal、-shm 复制到 <数据目录>/backups-pre-update/<时间戳>/，只保留最近 3 份。
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const KEEP_BACKUPS = 3;

/** @returns {string | null} 备份目录；没有数据库时返回 null */
function createPreUpdateBackup({ dataDir, fromVersion, toVersion, reason = "update", now = new Date() }) {
  if (!dataDir) return null;
  const dbPath = path.join(dataDir, "nowen-note.db");
  if (!fs.existsSync(dbPath)) return null;

  const root = path.join(dataDir, "backups-pre-update");
  const targetDir = path.join(root, now.toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(targetDir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = dbPath + suffix;
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(targetDir, `nowen-note.db${suffix}`));
  }
  fs.writeFileSync(
    path.join(targetDir, "update.json"),
    JSON.stringify({ fromVersion, toVersion, reason, createdAt: now.toISOString() }, null, 2),
    "utf8",
  );

  const directories = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const old of directories.slice(0, Math.max(0, directories.length - KEEP_BACKUPS))) {
    fs.rmSync(path.join(root, old), { recursive: true, force: true });
  }
  return targetDir;
}

module.exports = { createPreUpdateBackup };
