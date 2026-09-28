import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface BackupFileMetaStats {
  count?: number;
  bytes?: number;
}

export interface DirectoryStats {
  count: number;
  bytes: number;
}

export interface AttachmentRestoreAudit {
  metaCount: number | null;
  metaBytes: number | null;
  archiveCount: number;
  stagedCount?: number;
  stagedBytes?: number;
  dbRows: number;
  dbDistinctPaths: number;
  missingDbPaths: string[];
  objectStorageEnabled: boolean;
}

export interface RestoreDirectoryEntry {
  stagedDir: string;
  destDir: string;
}

type ReplacementMode = "rename" | "in-place";

interface DirectoryReplacement {
  mode: ReplacementMode;
  destDir: string;
  backupDirPath: string | null;
  destExisted: boolean;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeRelativePath(value: string): string {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function isSafeRelativePath(value: string): boolean {
  const normalized = normalizeRelativePath(value);
  if (!normalized || normalized.includes("\0")) return false;
  const parts = normalized.split("/");
  return !parts.some((part) => !part || part === "." || part === "..");
}

export function getDirectoryStats(root: string): DirectoryStats {
  let count = 0;
  let bytes = 0;

  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(absolute);
      count += 1;
      bytes += stat.size;
    }
  };

  walk(root);
  return { count, bytes };
}

function clearDirectoryContents(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    fs.rmSync(path.join(dir, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
    });
  }
}

function copyDirectoryContents(source: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  if (!fs.existsSync(source)) return;

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyDirectoryContents(src, dst);
      continue;
    }
    if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(src);
      try {
        fs.rmSync(dst, { recursive: true, force: true });
      } catch {
        // ignore cleanup
      }
      fs.symlinkSync(link, dst);
      continue;
    }
    if (!entry.isFile()) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    try {
      fs.chmodSync(dst, fs.statSync(src).mode & 0o777);
    } catch {
      // chmod is platform-specific
    }
  }
}

function isRenameFallbackError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EBUSY"
    || code === "EXDEV"
    || code === "EPERM"
    || code === "EACCES"
    || code === "ENOTEMPTY";
}

function restoreDirectoryReplacement(replacement: DirectoryReplacement): void {
  if (replacement.mode === "rename") {
    if (fs.existsSync(replacement.destDir)) {
      fs.rmSync(replacement.destDir, { recursive: true, force: true });
    }
    if (replacement.backupDirPath && fs.existsSync(replacement.backupDirPath)) {
      fs.renameSync(replacement.backupDirPath, replacement.destDir);
    } else if (replacement.destExisted) {
      throw new Error("恢复目录快照缺失: " + replacement.destDir);
    }
    return;
  }

  if (!replacement.destExisted) {
    if (fs.existsSync(replacement.destDir)) {
      fs.rmSync(replacement.destDir, { recursive: true, force: true });
    }
    return;
  }

  fs.mkdirSync(replacement.destDir, { recursive: true });
  clearDirectoryContents(replacement.destDir);
  if (!replacement.backupDirPath || !fs.existsSync(replacement.backupDirPath)) {
    throw new Error("恢复目录快照缺失: " + replacement.destDir);
  }
  copyDirectoryContents(replacement.backupDirPath, replacement.destDir);
}

function replaceDirectoryInPlace(
  stagedDir: string,
  destDir: string,
  restoreId: string,
): DirectoryReplacement {
  const destExisted = fs.existsSync(destDir);
  const backupDirPath = stagedDir + ".live-before-restore-" + restoreId;
  fs.rmSync(backupDirPath, { recursive: true, force: true });
  fs.mkdirSync(backupDirPath, { recursive: true });

  if (destExisted) {
    copyDirectoryContents(destDir, backupDirPath);
  } else {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const replacement: DirectoryReplacement = {
    mode: "in-place",
    destDir,
    backupDirPath,
    destExisted,
  };

  try {
    // Preserve the mount-point directory itself (uid/gid/mode/inode); only replace contents.
    clearDirectoryContents(destDir);
    copyDirectoryContents(stagedDir, destDir);

    const expected = getDirectoryStats(stagedDir);
    const actual = getDirectoryStats(destDir);
    if (expected.count !== actual.count || expected.bytes !== actual.bytes) {
      throw new Error(
        "原位目录同步校验失败: "
        + destDir
        + " expected="
        + expected.count
        + "/"
        + expected.bytes
        + " actual="
        + actual.count
        + "/"
        + actual.bytes,
      );
    }
    return replacement;
  } catch (error) {
    try {
      restoreDirectoryReplacement(replacement);
    } catch {
      // keep primary error
    }
    throw error;
  }
}

function moveDirectoryFromStaging(
  stagedDir: string,
  destDir: string,
  restoreId: string,
): DirectoryReplacement {
  const backupDirPath = destDir + ".before-restore." + restoreId;
  const destExisted = fs.existsSync(destDir);
  let movedOld = false;
  let movedNew = false;

  try {
    if (destExisted) {
      try {
        fs.renameSync(destDir, backupDirPath);
        movedOld = true;
      } catch (error) {
        if (!isRenameFallbackError(error)) throw error;
        return replaceDirectoryInPlace(stagedDir, destDir, restoreId);
      }
    }

    try {
      fs.renameSync(stagedDir, destDir);
      movedNew = true;
      return {
        mode: "rename",
        destDir,
        backupDirPath: movedOld ? backupDirPath : null,
        destExisted,
      };
    } catch (error) {
      if (movedOld && fs.existsSync(backupDirPath) && !fs.existsSync(destDir)) {
        fs.renameSync(backupDirPath, destDir);
        movedOld = false;
      }
      if (!isRenameFallbackError(error)) throw error;
      return replaceDirectoryInPlace(stagedDir, destDir, restoreId);
    }
  } catch (error) {
    try {
      if (movedNew && fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true });
      }
      if (movedOld && fs.existsSync(backupDirPath) && !fs.existsSync(destDir)) {
        fs.renameSync(backupDirPath, destDir);
      }
    } catch {
      // Caller will keep the primary restore error.
    }
    throw error;
  }
}

/**
 * Replace live directories as one transaction.
 *
 * Fast path uses rename. Docker/NAS mount points often reject moving the directory root
 * (EBUSY/EXDEV/EPERM/EACCES), so the fallback snapshots contents and synchronizes in-place,
 * preserving the mounted root directory and its ownership/mode. The optional verifier runs
 * before snapshots are deleted; verifier failure rolls every directory back.
 */
export async function replaceDirectoriesFromStagingSafe(
  entries: RestoreDirectoryEntry[],
  restoreId: string,
  verify?: () => void | Promise<void>,
): Promise<void> {
  const replacements: DirectoryReplacement[] = [];
  try {
    for (const entry of entries) {
      replacements.push(moveDirectoryFromStaging(entry.stagedDir, entry.destDir, restoreId));
    }

    if (verify) await verify();

    for (const replacement of replacements) {
      if (replacement.backupDirPath && fs.existsSync(replacement.backupDirPath)) {
        fs.rmSync(replacement.backupDirPath, { recursive: true, force: true });
      }
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const replacement of replacements.reverse()) {
      try {
        restoreDirectoryReplacement(replacement);
      } catch (rollbackError) {
        rollbackErrors.push(formatError(rollbackError));
      }
    }
    const suffix = rollbackErrors.length > 0
      ? "；目录回滚异常: " + rollbackErrors.join(" | ")
      : "";
    throw new Error("文件目录恢复失败: " + formatError(error) + suffix);
  }
}

function readObjectStorageEnabled(db: Database.Database): boolean {
  try {
    const row = db
      .prepare("SELECT value FROM system_settings WHERE key = ?")
      .get("attachmentStorage:config") as { value?: string } | undefined;
    if (!row?.value) return false;
    const parsed = JSON.parse(row.value) as { enabled?: boolean };
    return parsed.enabled === true;
  } catch {
    return false;
  }
}

function readAttachmentRows(db: Database.Database): { rows: number; paths: string[] } {
  try {
    const rows = (db.prepare(
      "SELECT COUNT(*) AS count FROM attachments WHERE path IS NOT NULL AND path <> ''",
    ).get() as { count: number }).count;
    const paths = (db.prepare(
      "SELECT DISTINCT path FROM attachments WHERE path IS NOT NULL AND path <> ''",
    ).all() as Array<{ path: string }>).map((row) => normalizeRelativePath(row.path));
    return { rows, paths };
  } catch {
    return { rows: 0, paths: [] };
  }
}

export function auditAttachmentBackup(
  dbPath: string,
  archiveRelativePaths: Iterable<string>,
  meta: BackupFileMetaStats | undefined,
): AttachmentRestoreAudit {
  const archivePaths = new Set<string>();
  for (const raw of archiveRelativePaths) {
    const normalized = normalizeRelativePath(raw);
    if (!normalized || normalized === ".keep") continue;
    if (!isSafeRelativePath(normalized)) {
      throw new Error("附件归档包含非法路径: " + raw);
    }
    archivePaths.add(normalized);
  }

  const metaCount = Number.isFinite(meta?.count) ? Number(meta?.count) : null;
  const metaBytes = Number.isFinite(meta?.bytes) ? Number(meta?.bytes) : null;
  if (metaCount !== null && metaCount !== archivePaths.size) {
    throw new Error(
      "附件归档数量校验失败: meta=" + metaCount + ", archive=" + archivePaths.size,
    );
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const attachmentRows = readAttachmentRows(db);
    const objectStorageEnabled = readObjectStorageEnabled(db);
    const missingDbPaths = objectStorageEnabled
      ? []
      : attachmentRows.paths.filter((attachmentPath) => (
        !isSafeRelativePath(attachmentPath) || !archivePaths.has(attachmentPath)
      ));

    if (missingDbPaths.length > 0) {
      const sample = missingDbPaths.slice(0, 8).join(", ");
      throw new Error(
        "附件一致性校验失败: backup DB 有 "
        + missingDbPaths.length
        + " 个附件路径未出现在 full ZIP 中"
        + (sample ? "（示例: " + sample + "）" : ""),
      );
    }

    return {
      metaCount,
      metaBytes,
      archiveCount: archivePaths.size,
      dbRows: attachmentRows.rows,
      dbDistinctPaths: attachmentRows.paths.length,
      missingDbPaths,
      objectStorageEnabled,
    };
  } finally {
    db.close();
  }
}

export function verifyStagedAttachmentStats(
  stagedDir: string,
  audit: AttachmentRestoreAudit,
): AttachmentRestoreAudit {
  const staged = getDirectoryStats(stagedDir);
  if (staged.count !== audit.archiveCount) {
    throw new Error(
      "附件 staging 数量校验失败: archive="
      + audit.archiveCount
      + ", staging="
      + staged.count,
    );
  }
  if (audit.metaCount !== null && staged.count !== audit.metaCount) {
    throw new Error(
      "附件 staging 数量校验失败: meta="
      + audit.metaCount
      + ", staging="
      + staged.count,
    );
  }
  if (audit.metaBytes !== null && staged.bytes !== audit.metaBytes) {
    throw new Error(
      "附件 staging 字节校验失败: meta="
      + audit.metaBytes
      + ", staging="
      + staged.bytes,
    );
  }
  return { ...audit, stagedCount: staged.count, stagedBytes: staged.bytes };
}
