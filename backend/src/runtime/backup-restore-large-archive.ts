import fs from "fs";
import path from "path";
import crypto from "crypto";
import Database from "better-sqlite3";
import { pipeline } from "node:stream/promises";
import {
  closeDb,
  getCodeSchemaVersion,
  getDb,
  getDbPath,
} from "../db/schema.js";
import { BackupManager, type RestoreResult } from "../services/backup.js";
import { quarantineRestoredPlugins } from "../plugins/pluginService.js";
import { quarantineRestoredAutomations } from "../automation/recovery.js";

const unzipper = require("unzipper");

const PATCH_FLAG = Symbol.for("nowen.backupLargeArchiveRestore.patched");
// backup.ts 当前格式版本。运行时补丁只接管 v2+ ZIP，不改变旧 JSON/db-only 语义。
const BACKUP_FORMAT_VERSION = 2;
const MAX_META_BYTES = 2 * 1024 * 1024;

interface StreamingZipEntry {
  path: string;
  type?: string;
  vars?: {
    uncompressedSize?: number;
  };
  stream(): NodeJS.ReadableStream;
}

interface StreamingZipDirectory {
  files: StreamingZipEntry[];
}

interface FullBackupMeta {
  formatVersion?: number;
  schemaVersion?: number;
  createdAt?: string;
  tables?: Record<string, number>;
  files?: {
    attachments?: { count?: number; bytes?: number };
    fonts?: { count?: number; bytes?: number };
    plugins?: { count?: number; bytes?: number };
  };
}

interface BackupManagerInternals {
  backupDir: string;
  dataDir: string;
  getBackupPath(filename: string): string | null;
}

interface PatchableBackupPrototype {
  restoreFromBackup: BackupManager["restoreFromBackup"];
  [PATCH_FLAG]?: boolean;
}

interface DirectoryReplacement {
  destDir: string;
  backupDirPath: string | null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeZipPath(value: string): string {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function safeArchiveRelativePath(value: string): string {
  const normalized = normalizeZipPath(value);
  if (!normalized || normalized.includes("\0")) return "";
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return "";
  return parts.join("/");
}

function isDirectoryEntry(entry: StreamingZipEntry): boolean {
  return entry.type === "Directory" || normalizeZipPath(entry.path).endsWith("/");
}

function findZipEntry(directory: StreamingZipDirectory, target: string): StreamingZipEntry | null {
  const normalizedTarget = normalizeZipPath(target);
  return directory.files.find((entry) => (
    !isDirectoryEntry(entry) && normalizeZipPath(entry.path) === normalizedTarget
  )) || null;
}

async function openZipFile(filePath: string): Promise<StreamingZipDirectory> {
  return unzipper.Open.file(filePath) as Promise<StreamingZipDirectory>;
}

function hasZipMagic(filePath: string): boolean {
  const fd = fs.openSync(filePath, "r");
  try {
    const magic = Buffer.allocUnsafe(2);
    const bytesRead = fs.readSync(fd, magic, 0, magic.length, 0);
    return bytesRead === 2 && magic[0] === 0x50 && magic[1] === 0x4b;
  } finally {
    fs.closeSync(fd);
  }
}

async function readSmallEntry(entry: StreamingZipEntry, maxBytes: number): Promise<Buffer> {
  const declaredSize = Number(entry.vars?.uncompressedSize ?? 0);
  if (declaredSize > maxBytes) {
    throw new Error(`zip 内 ${entry.path} 过大（>${maxBytes} bytes），拒绝载入内存`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const source = entry.stream() as unknown as AsyncIterable<Buffer | string | Uint8Array>;
  for await (const rawChunk of source) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`zip 内 ${entry.path} 过大（>${maxBytes} bytes），拒绝载入内存`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function streamEntryToFile(entry: StreamingZipEntry, destPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  try {
    await pipeline(
      entry.stream() as never,
      fs.createWriteStream(destPath, { flags: "w" }),
    );
  } catch (error) {
    try { fs.rmSync(destPath, { force: true }); } catch { /* ignore cleanup */ }
    throw error;
  }
}

async function extractDirectoryStreaming(
  directory: StreamingZipDirectory,
  zipFolder: string,
  destDir: string,
): Promise<number> {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  const prefix = normalizeZipPath(zipFolder).replace(/\/+$/, "") + "/";
  let count = 0;

  for (const entry of directory.files) {
    if (isDirectoryEntry(entry)) continue;
    const archivePath = normalizeZipPath(entry.path);
    if (!archivePath.startsWith(prefix)) continue;

    const relative = archivePath.slice(prefix.length);
    if (!relative || relative === ".keep") continue;
    const safeRelative = safeArchiveRelativePath(relative);
    if (!safeRelative) {
      throw new Error(`zip 包含非法路径：${entry.path}`);
    }

    const target = path.resolve(destDir, safeRelative);
    const root = path.resolve(destDir);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`zip 路径越界：${entry.path}`);
    }

    await streamEntryToFile(entry, target);
    count++;
  }

  return count;
}

function listAllTables(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'",
    )
    .all() as { name: string }[];
  return rows
    .map((row) => row.name)
    .filter((name) => (
      !name.endsWith("_data")
      && !name.endsWith("_idx")
      && !name.endsWith("_content")
      && !name.endsWith("_docsize")
      && !name.endsWith("_config")
    ));
}

function cleanupWalShm(dbPath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = dbPath + suffix;
    if (!fs.existsSync(sidecar)) continue;
    try { fs.unlinkSync(sidecar); } catch { /* keep primary error */ }
  }
}

function checkSqliteIntegrity(dbPath: string, label: string): void {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (row.integrity_check !== "ok") {
      throw new Error(`${label}完整性检查失败: ${row.integrity_check}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("完整性检查失败")) throw error;
    throw new Error(`${label}完整性检查失败: ${formatError(error)}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function verifyCurrentDbUsable(curDbPath: string): void {
  const current = getDb();
  const integrity = (current.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  if (integrity !== "ok") {
    throw new Error(`恢复后完整性检查失败: ${integrity}`);
  }
  closeDb();
  cleanupWalShm(curDbPath);
}

function replaceDbFile(tmpDb: string, curDbPath: string): void {
  try {
    fs.renameSync(tmpDb, curDbPath);
  } catch (renameError) {
    const code = (renameError as NodeJS.ErrnoException)?.code;
    if (code !== "EXDEV" && code !== "EPERM") throw renameError;
    fs.copyFileSync(tmpDb, curDbPath);
    try { fs.unlinkSync(tmpDb); } catch { /* ignore temp cleanup */ }
  }
  cleanupWalShm(curDbPath);
}

function rollbackDb(curDbPath: string, safetyBak: string, reason: unknown): never {
  try {
    closeDb();
    if (!fs.existsSync(safetyBak)) {
      throw new Error(`恢复前安全备份不存在: ${safetyBak}`);
    }
    fs.copyFileSync(safetyBak, curDbPath);
    cleanupWalShm(curDbPath);
    verifyCurrentDbUsable(curDbPath);
  } catch (rollbackError) {
    throw new Error(
      `恢复失败，且自动回滚失败，请立即停止服务并手动使用 *.before-restore.*.bak 恢复数据库。`
      + `原始错误: ${formatError(reason)}；回滚错误: ${formatError(rollbackError)}`,
    );
  }
  throw new Error(`恢复失败，已自动回滚到恢复前数据库: ${formatError(reason)}`);
}

function restoreDirectoryReplacement(replacement: DirectoryReplacement): void {
  if (fs.existsSync(replacement.destDir)) {
    fs.rmSync(replacement.destDir, { recursive: true, force: true });
  }
  if (replacement.backupDirPath && fs.existsSync(replacement.backupDirPath)) {
    fs.renameSync(replacement.backupDirPath, replacement.destDir);
  }
}

function moveDirectoryFromStaging(
  stagedDir: string,
  destDir: string,
  restoreId: string,
): DirectoryReplacement {
  const backupDirPath = `${destDir}.before-restore.${restoreId}`;
  let movedOld = false;
  let movedNew = false;

  try {
    if (fs.existsSync(destDir)) {
      fs.renameSync(destDir, backupDirPath);
      movedOld = true;
    }
    fs.renameSync(stagedDir, destDir);
    movedNew = true;
    return { destDir, backupDirPath: movedOld ? backupDirPath : null };
  } catch (error) {
    try {
      if (movedNew && fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true });
      }
      if (movedOld && fs.existsSync(backupDirPath) && !fs.existsSync(destDir)) {
        fs.renameSync(backupDirPath, destDir);
      }
    } catch {
      // The DB rollback path will still preserve the primary restore error.
    }
    throw error;
  }
}

function replaceDirectoriesFromStaging(
  entries: { stagedDir: string; destDir: string }[],
  restoreId: string,
): void {
  const replacements: DirectoryReplacement[] = [];
  try {
    for (const entry of entries) {
      replacements.push(moveDirectoryFromStaging(entry.stagedDir, entry.destDir, restoreId));
    }
    for (const replacement of replacements) {
      if (replacement.backupDirPath && fs.existsSync(replacement.backupDirPath)) {
        fs.rmSync(replacement.backupDirPath, { recursive: true, force: true });
      }
    }
  } catch (error) {
    for (const replacement of replacements.reverse()) {
      try { restoreDirectoryReplacement(replacement); } catch { /* keep primary error */ }
    }
    throw new Error(`文件目录恢复失败: ${formatError(error)}`);
  }
}

async function readAndValidateMeta(directory: StreamingZipDirectory): Promise<FullBackupMeta> {
  const metaEntry = findZipEntry(directory, "meta.json");
  if (!metaEntry) throw new Error("zip 备份缺少 meta.json，文件可能已损坏");

  let meta: FullBackupMeta;
  try {
    meta = JSON.parse((await readSmallEntry(metaEntry, MAX_META_BYTES)).toString("utf8")) as FullBackupMeta;
  } catch (error) {
    throw new Error(`meta.json 解析失败：${formatError(error)}`);
  }

  if (meta.formatVersion && meta.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new Error([
      "无法恢复：备份格式版本高于当前程序。",
      `  备份格式版本：${meta.formatVersion}（备份产生时间 ${meta.createdAt || "unknown"}）`,
      `  当前程序支持的最高格式版本：${BACKUP_FORMAT_VERSION}`,
      "  请升级 nowen-note 到该备份产生时的版本或更新后再恢复；",
    ].join("\n"));
  }

  const codeMaxSchema = getCodeSchemaVersion();
  if (meta.schemaVersion && meta.schemaVersion > codeMaxSchema) {
    throw new Error([
      "无法恢复：备份 schema 版本高于当前程序。",
      `  备份 schema 版本：${meta.schemaVersion}`,
      `  当前程序支持的最高 schema 版本：${codeMaxSchema}`,
      `  备份产生时间：${meta.createdAt || "unknown"}`,
      "",
      "原因：该备份是从更新版本的 nowen-note 产生的，错误地被灌到了旧程序。",
      "解决方案：升级 nowen-note 到与该备份同版或更新后再试。",
      "提示：不要手动修改 meta.json 来绕过此检查，将造成数据不一致。",
    ].join("\n"));
  }

  return meta;
}

async function buildDryRun(
  manager: BackupManagerInternals,
  directory: StreamingZipDirectory,
  dbEntry: StreamingZipEntry,
  meta: FullBackupMeta,
): Promise<RestoreResult> {
  const tmpDb = path.join(
    manager.backupDir,
    `.nowen-dryrun-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.db`,
  );

  try {
    await streamEntryToFile(dbEntry, tmpDb);
    checkSqliteIntegrity(tmpDb, "备份文件");

    const backupDb = new Database(tmpDb, { readonly: true, fileMustExist: true });
    try {
      const currentDb = getDb() as unknown as Database.Database;
      const tables = listAllTables(backupDb).map((name) => {
        let willClear = 0;
        try {
          willClear = (currentDb.prepare(`SELECT COUNT(*) as c FROM ${name}`).get() as { c: number }).c;
        } catch {
          // Current database may not have a table from an older backup yet.
        }
        const willInsert = (backupDb.prepare(`SELECT COUNT(*) as c FROM ${name}`).get() as { c: number }).c;
        return { name, willClear, willInsert };
      });

      return {
        success: true,
        dryRun: {
          tables,
          files: {
            attachments: meta.files?.attachments?.count ?? 0,
            fonts: meta.files?.fonts?.count ?? 0,
            plugins: meta.files?.plugins?.count ?? 0,
          },
          schemaVersion: meta.schemaVersion ?? 1,
        },
      };
    } finally {
      backupDb.close();
    }
  } finally {
    try { fs.rmSync(tmpDb, { force: true }); } catch { /* ignore */ }
  }
}

async function restoreZipStreaming(
  manager: BackupManagerInternals,
  filePath: string,
  dryRun: boolean,
): Promise<RestoreResult> {
  const directory = await openZipFile(filePath);
  const meta = await readAndValidateMeta(directory);
  const dbEntry = findZipEntry(directory, "db.sqlite");
  if (!dbEntry) throw new Error("zip 备份缺少 db.sqlite");

  if (dryRun) {
    return buildDryRun(manager, directory, dbEntry, meta);
  }

  const restoreId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const tmpDb = path.join(manager.backupDir, `.nowen-restore-${restoreId}.db`);
  const stagingRoot = path.join(manager.dataDir, `.nowen-restore-staging-${restoreId}`);
  const stagedAttachments = path.join(stagingRoot, "attachments");
  const stagedFonts = path.join(stagingRoot, "fonts");
  const hasInstalledLayout = directory.files.some((entry) => normalizeZipPath(entry.path).startsWith("plugins/installed/"));
  const stagedPlugins = path.join(stagingRoot, hasInstalledLayout ? "plugins-installed" : "plugins-legacy");
  const stagedSecret = path.join(stagingRoot, ".jwt_secret");
  const stagedPluginSecretKey = path.join(stagingRoot, ".plugin_secret_key");

  try {
    // All archive IO happens before the current database or live file directories are touched.
    await streamEntryToFile(dbEntry, tmpDb);
    checkSqliteIntegrity(tmpDb, "备份文件");

    const attachmentCount = await extractDirectoryStreaming(directory, "attachments", stagedAttachments);
    const fontCount = await extractDirectoryStreaming(directory, "fonts", stagedFonts);
    const pluginCount = await extractDirectoryStreaming(directory, hasInstalledLayout ? "plugins/installed" : "plugins", stagedPlugins);

    const secretEntry = findZipEntry(directory, ".jwt_secret");
    if (secretEntry) {
      await streamEntryToFile(secretEntry, stagedSecret);
    }
    const pluginSecretKeyEntry = findZipEntry(directory, ".plugin_secret_key");
    if (pluginSecretKeyEntry) await streamEntryToFile(pluginSecretKeyEntry, stagedPluginSecretKey);

    const curDbPath = getDbPath();
    const safetyBak = curDbPath + `.before-restore.${Date.now()}.bak`;

    // Closing the connection checkpoints WAL before the pre-restore copy is taken.
    closeDb();
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!fs.existsSync(curDbPath)) {
      throw new Error(`当前数据库不存在，拒绝执行破坏性恢复: ${curDbPath}`);
    }
    fs.copyFileSync(curDbPath, safetyBak);

    try {
      replaceDbFile(tmpDb, curDbPath);
      verifyCurrentDbUsable(curDbPath);
      replaceDirectoriesFromStaging([
        { stagedDir: stagedAttachments, destDir: path.join(manager.dataDir, "attachments") },
        { stagedDir: stagedFonts, destDir: path.join(manager.dataDir, "fonts") },
        { stagedDir: stagedPlugins, destDir: hasInstalledLayout ? path.join(manager.dataDir, "plugins", "installed") : path.join(manager.dataDir, "plugins") },
      ], restoreId);
    } catch (error) {
      rollbackDb(curDbPath, safetyBak, error);
    }

    // Preserve existing semantics: secret restoration is warning-only after DB/files succeed.
    if (secretEntry && fs.existsSync(stagedSecret)) {
      const secretPath = path.join(manager.dataDir, ".jwt_secret");
      try {
        fs.copyFileSync(stagedSecret, secretPath);
        try { fs.chmodSync(secretPath, 0o600); } catch { /* Windows */ }
      } catch (error) {
        console.warn(
          "[Backup] .jwt_secret 恢复失败，已保留当前密钥:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    if (pluginSecretKeyEntry && fs.existsSync(stagedPluginSecretKey)) {
      const target = path.join(manager.dataDir, ".plugin_secret_key");
      fs.copyFileSync(stagedPluginSecretKey, target);
      try { fs.chmodSync(target, 0o600); } catch { /* Windows */ }
    } else {
      try { getDb().prepare("DELETE FROM plugin_secrets").run(); } catch { /* old backup */ }
    }

    // 流式大备份与普通恢复遵守同一供应链边界：恢复代码进入 quarantine，授权清零。
    quarantineRestoredPlugins();
    quarantineRestoredAutomations();

    const stats: Record<string, number> = {
      attachments: attachmentCount,
      fonts: fontCount,
      plugins: pluginCount,
    };
    for (const [table, count] of Object.entries(meta.tables ?? {})) {
      stats[table] = typeof count === "number" ? count : -1;
    }
    return { success: true, stats };
  } finally {
    try { fs.rmSync(tmpDb, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function installLargeArchiveRestorePatch(): void {
  const prototype = BackupManager.prototype as unknown as PatchableBackupPrototype;
  if (prototype[PATCH_FLAG]) return;
  prototype[PATCH_FLAG] = true;

  const nativeRestore = prototype.restoreFromBackup;
  prototype.restoreFromBackup = async function restoreFromBackupStreaming(
    this: BackupManager,
    filename: string,
    opts: { dryRun?: boolean } = {},
  ): Promise<RestoreResult> {
    const manager = this as unknown as BackupManagerInternals;
    const filePath = manager.getBackupPath(filename);
    if (!filePath) return { success: false, error: "备份文件不存在" };

    let isZip = false;
    try {
      isZip = hasZipMagic(filePath);
    } catch (error) {
      return { success: false, error: formatError(error) };
    }

    if (!isZip) {
      return nativeRestore.call(this, filename, opts);
    }

    try {
      return await restoreZipStreaming(manager, filePath, !!opts.dryRun);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOSPC") {
        return { success: false, error: "恢复失败：磁盘空间不足，请释放空间后重试" };
      }
      return { success: false, error: formatError(error) };
    }
  } as BackupManager["restoreFromBackup"];
}

installLargeArchiveRestorePatch();
