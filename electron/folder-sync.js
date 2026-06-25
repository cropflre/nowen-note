// electron/folder-sync.js
//
// 桌面端文件夹同步：配置 CRUD + 本地扫描 + SHA-256 索引 + 日志。
//
// 配置：{userData}/folder-sync.json
// 索引：{userData}/folder-sync-index-{folderId}.json
// 日志：{userData}/folder-sync-logs.json
//
// Phase C.1：只做本地扫描，不上传、不创建笔记、不改后端。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let configFilePath = null;
let dataDir = null;

// 忽略的目录名
const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build",
  ".next", ".vite", "__pycache__", ".cache", ".turbo",
]);
// 忽略的文件名
const IGNORED_FILES = new Set([
  ".DS_Store", "Thumbs.db", "desktop.ini",
]);
// 忽略的文件名前缀/后缀
const IGNORED_PREFIXES = ["~$"];
const IGNORED_EXTS = [".tmp", ".temp", ".swp", ".swo"];

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_LOG_ENTRIES = 200;

function setDataDir(dir) {
  dataDir = dir;
  configFilePath = path.join(dir, "folder-sync.json");
}

function genId() {
  return crypto.randomBytes(8).toString("hex");
}

// ---------- 配置 CRUD ----------

function readConfigs() {
  if (!configFilePath) return [];
  try {
    if (fs.existsSync(configFilePath)) {
      const raw = JSON.parse(fs.readFileSync(configFilePath, "utf8"));
      return Array.isArray(raw) ? raw : [];
    }
  } catch (e) {
    console.warn("[folder-sync] read configs failed:", e?.message || e);
  }
  return [];
}

function writeConfigs(configs) {
  if (!configFilePath) return;
  try {
    fs.mkdirSync(path.dirname(configFilePath), { recursive: true });
    const tmp = configFilePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(configs, null, 2), "utf8");
    fs.renameSync(tmp, configFilePath);
  } catch (e) {
    console.error("[folder-sync] write configs failed:", e?.message || e);
    throw e;
  }
}

function saveConfig(input) {
  const configs = readConfigs();
  const now = new Date().toISOString();

  if (input.folderId) {
    const idx = configs.findIndex((c) => c.folderId === input.folderId);
    if (idx >= 0) {
      configs[idx] = { ...configs[idx], ...input, updatedAt: now };
      writeConfigs(configs);
      return { ok: true, config: configs[idx] };
    }
  }

  const config = {
    folderId: input.folderId || genId(),
    folderPath: input.folderPath || "",
    targetNotebookId: input.targetNotebookId || null,
    includeSubfolders: input.includeSubfolders !== false,
    fileTypes: input.fileTypes || [".md", ".txt", ".html", ".pdf", ".docx"],
    enabled: input.enabled !== false,
    lastSyncedAt: null,
    lastScanAt: null,
    lastScanStats: null,
    createdAt: now,
    updatedAt: now,
  };
  configs.push(config);
  writeConfigs(configs);
  return { ok: true, config };
}

function removeConfig(folderId) {
  const configs = readConfigs();
  const filtered = configs.filter((c) => c.folderId !== folderId);
  if (filtered.length === configs.length) return { ok: false, error: "Config not found" };
  writeConfigs(filtered);
  if (dataDir) {
    try {
      const idx = path.join(dataDir, `folder-sync-index-${folderId}.json`);
      if (fs.existsSync(idx)) fs.unlinkSync(idx);
    } catch { /* ignore */ }
  }
  return { ok: true };
}

// ---------- 安全校验 ----------

function isDangerousRoot(p) {
  const normalized = path.resolve(p);
  // Windows: C:\ or D:\
  if (/^[A-Z]:\\?$/.test(normalized)) return true;
  // macOS/Linux: /
  if (normalized === "/") return true;
  // Home 目录本身
  const home = require("os").homedir();
  if (normalized === home || normalized === home.replace(/\/$/, "")) return true;
  return false;
}

function shouldIgnoreDir(name) {
  return IGNORED_DIRS.has(name) || name.startsWith(".");
}

function shouldIgnoreFile(name) {
  if (IGNORED_FILES.has(name)) return true;
  if (name.startsWith(".")) return true;
  for (const prefix of IGNORED_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  const ext = path.extname(name).toLowerCase();
  if (IGNORED_EXTS.includes(ext)) return true;
  return false;
}

// ---------- 扫描 ----------

function scanFolder(folderPath, fileTypes, includeSubfolders) {
  const results = [];
  const typeSet = new Set(fileTypes.map((e) => e.toLowerCase()));

  function walk(dir, relBase) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      results.push({ relativePath: relBase, error: `Cannot read directory: ${e.message}`, status: "error" });
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (shouldIgnoreDir(entry.name)) continue;
        if (includeSubfolders) {
          walk(fullPath, relPath);
        }
      } else if (entry.isFile()) {
        if (shouldIgnoreFile(entry.name)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!typeSet.has(ext)) continue;

        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > MAX_FILE_SIZE) {
            results.push({
              relativePath: relPath,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              status: "skipped",
              error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB > 50MB)`,
            });
            continue;
          }

          const sha256 = computeHash(fullPath);
          results.push({
            relativePath: relPath,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            sha256,
            status: "new", // 会在 mergeIndex 里更新
          });
        } catch (e) {
          results.push({
            relativePath: relPath,
            status: "error",
            error: e.message,
          });
        }
      }
    }
  }

  walk(folderPath, "");
  return results;
}

function computeHash(filePath) {
  const hash = crypto.createHash("sha256");
  const buf = fs.readFileSync(filePath);
  hash.update(buf);
  return hash.digest("hex");
}

// ---------- 索引合并 ----------

function readIndex(folderId) {
  if (!dataDir) return [];
  const indexFile = path.join(dataDir, `folder-sync-index-${folderId}.json`);
  try {
    if (fs.existsSync(indexFile)) {
      const raw = JSON.parse(fs.readFileSync(indexFile, "utf8"));
      return Array.isArray(raw) ? raw : [];
    }
  } catch { /* ignore */ }
  return [];
}

function writeIndex(folderId, index) {
  if (!dataDir) return;
  const indexFile = path.join(dataDir, `folder-sync-index-${folderId}.json`);
  try {
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    const tmp = indexFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2), "utf8");
    fs.renameSync(tmp, indexFile);
  } catch (e) {
    console.error("[folder-sync] write index failed:", e?.message || e);
  }
}

function mergeIndex(oldIndex, scanResults) {
  const oldMap = new Map(oldIndex.map((item) => [item.relativePath, item]));
  const scannedPaths = new Set(scanResults.map((r) => r.relativePath));
  const merged = [];
  const now = new Date().toISOString();

  // 处理扫描到的文件
  for (const scan of scanResults) {
    const old = oldMap.get(scan.relativePath);

    if (scan.status === "skipped" || scan.status === "error") {
      merged.push({ ...scan, lastScannedAt: now, lastSyncedAt: old?.lastSyncedAt || null, noteId: old?.noteId || null, attachmentId: old?.attachmentId || null });
      continue;
    }

    if (!old) {
      // 新文件
      merged.push({
        relativePath: scan.relativePath,
        size: scan.size,
        mtimeMs: scan.mtimeMs,
        sha256: scan.sha256,
        status: "new",
        lastScannedAt: now,
        lastSyncedAt: null,
        noteId: null,
        attachmentId: null,
      });
    } else if (old.sha256 === scan.sha256) {
      // 未变化
      merged.push({ ...old, status: "unchanged", lastScannedAt: now });
    } else {
      // 内容变化
      merged.push({
        ...old,
        size: scan.size,
        mtimeMs: scan.mtimeMs,
        sha256: scan.sha256,
        status: "changed",
        lastScannedAt: now,
      });
    }
  }

  // 标记已删除的文件（索引中有但扫描不到）
  for (const old of oldIndex) {
    if (!scannedPaths.has(old.relativePath)) {
      merged.push({ ...old, status: "deleted", lastScannedAt: now });
    }
  }

  return merged;
}

// ---------- 日志 ----------

function readLogs() {
  if (!dataDir) return [];
  const logFile = path.join(dataDir, "folder-sync-logs.json");
  try {
    if (fs.existsSync(logFile)) {
      const raw = JSON.parse(fs.readFileSync(logFile, "utf8"));
      return Array.isArray(raw) ? raw : [];
    }
  } catch { /* ignore */ }
  return [];
}

function writeLogs(logs) {
  if (!dataDir) return;
  const logFile = path.join(dataDir, "folder-sync-logs.json");
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const trimmed = logs.slice(-MAX_LOG_ENTRIES);
    const tmp = logFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), "utf8");
    fs.renameSync(tmp, logFile);
  } catch (e) {
    console.error("[folder-sync] write logs failed:", e?.message || e);
  }
}

function appendLog(folderId, type, message, detail) {
  const logs = readLogs();
  logs.push({
    id: genId(),
    folderId,
    type,
    message,
    createdAt: new Date().toISOString(),
    detail: detail || undefined,
  });
  writeLogs(logs);
}

function getLogs(folderId) {
  const all = readLogs();
  if (!folderId) return all.slice(-50);
  return all.filter((l) => l.folderId === folderId).slice(-50);
}

// ---------- runNow ----------

function runNow(folderId) {
  const configs = readConfigs();
  const config = configs.find((c) => c.folderId === folderId);
  if (!config) return { ok: false, code: "CONFIG_NOT_FOUND", message: "Sync config not found" };

  const folderPath = config.folderPath;
  if (!folderPath || !fs.existsSync(folderPath)) {
    return { ok: false, code: "FOLDER_NOT_FOUND", message: "Folder does not exist: " + folderPath };
  }

  if (isDangerousRoot(folderPath)) {
    return { ok: false, code: "DANGEROUS_PATH", message: "Cannot scan system root or home directory" };
  }

  const startTime = Date.now();
  appendLog(folderId, "scan_started", `Scanning ${folderPath}`);

  try {
    const scanResults = scanFolder(folderPath, config.fileTypes, config.includeSubfolders);
    const oldIndex = readIndex(folderId);
    const merged = mergeIndex(oldIndex, scanResults);
    writeIndex(folderId, merged);

    const stats = {
      total: merged.length,
      added: merged.filter((i) => i.status === "new").length,
      changed: merged.filter((i) => i.status === "changed").length,
      unchanged: merged.filter((i) => i.status === "unchanged").length,
      deleted: merged.filter((i) => i.status === "deleted").length,
      skipped: merged.filter((i) => i.status === "skipped").length,
      errors: merged.filter((i) => i.status === "error").length,
    };
    const durationMs = Date.now() - startTime;

    // 更新配置的 lastScanAt 和 stats
    const cfgIdx = configs.findIndex((c) => c.folderId === folderId);
    if (cfgIdx >= 0) {
      configs[cfgIdx].lastScanAt = new Date().toISOString();
      configs[cfgIdx].lastScanStats = { ...stats, durationMs };
      writeConfigs(configs);
    }

    appendLog(folderId, "scan_completed",
      `Scan complete: +${stats.added} ~${stats.changed} =${stats.unchanged} -${stats.deleted} skip${stats.skipped} err${stats.errors} (${durationMs}ms)`,
      stats
    );

    // 记录 skipped 和 error 详情
    for (const item of merged) {
      if (item.status === "skipped") {
        appendLog(folderId, "file_skipped", `${item.relativePath}: ${item.error}`);
      } else if (item.status === "error") {
        appendLog(folderId, "file_error", `${item.relativePath}: ${item.error}`);
      }
    }

    return {
      ok: true,
      folderId,
      scannedAt: new Date().toISOString(),
      ...stats,
      durationMs,
    };
  } catch (e) {
    appendLog(folderId, "scan_failed", `Scan failed: ${e.message}`);
    return { ok: false, code: "SCAN_FAILED", message: e.message };
  }
}

// ---------- 索引读取（给 renderer 用） ----------

function getIndex(folderId) {
  return readIndex(folderId);
}

// ---------- 待上传文件列表（方案 A：renderer 负责上传） ----------

const TEXT_EXTS = new Set([".md", ".txt", ".markdown", ".html", ".htm"]);
const MAX_CONTENT_BYTES = 2 * 1024 * 1024; // 2MB

function computeSourcePathHash(relativePath) {
  return crypto.createHash("sha256").update(relativePath).digest("hex");
}

/**
 * 返回需要上传的文本文件列表（status=new/changed 且为文本类型）。
 * renderer 收到后用 api.folderSync.importFile 逐个上传。
 */
function getPendingUploads(folderId) {
  const configs = readConfigs();
  const config = configs.find((c) => c.folderId === folderId);
  if (!config) return { ok: false, error: "Config not found" };

  const index = readIndex(folderId);
  const pending = [];

  for (const item of index) {
    if (item.status !== "new" && item.status !== "changed") continue;

    const ext = path.extname(item.relativePath).toLowerCase();
    if (!TEXT_EXTS.has(ext)) continue;

    // 读取文本内容
    const fullPath = path.join(config.folderPath, item.relativePath.replace(/\//g, path.sep));
    let contentText;
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > MAX_CONTENT_BYTES) {
        pending.push({
          relativePath: item.relativePath,
          filename: path.basename(item.relativePath),
          sha256: item.sha256,
          sourcePathHash: computeSourcePathHash(item.relativePath),
          size: item.size,
          mtimeMs: item.mtimeMs,
          ext,
          contentText: null,
          existingNoteId: item.noteId || null,
          skipReason: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB > 2MB)`,
        });
        continue;
      }
      contentText = fs.readFileSync(fullPath, "utf8");
    } catch (e) {
      pending.push({
        relativePath: item.relativePath,
        filename: path.basename(item.relativePath),
        sha256: item.sha256,
        sourcePathHash: computeSourcePathHash(item.relativePath),
        size: item.size,
        mtimeMs: item.mtimeMs,
        ext,
        contentText: null,
        existingNoteId: item.noteId || null,
        skipReason: `Read failed: ${e.message}`,
      });
      continue;
    }

    pending.push({
      relativePath: item.relativePath,
      filename: path.basename(item.relativePath),
      sha256: item.sha256,
      sourcePathHash: computeSourcePathHash(item.relativePath),
      size: item.size,
      mtimeMs: item.mtimeMs,
      ext,
      contentText,
      existingNoteId: item.noteId || null,
      skipReason: null,
    });
  }

  return { ok: true, folderId, config: { targetNotebookId: config.targetNotebookId }, pending };
}

/**
 * renderer 上传成功后回调，写回 noteId / lastSyncedAt / status。
 */
function markUploadResult(folderId, relativePath, result) {
  const index = readIndex(folderId);
  const item = index.find((i) => i.relativePath === relativePath);
  if (!item) return { ok: false, error: "Index entry not found" };

  const now = new Date().toISOString();
  if (result.skipped) {
    item.status = "synced";
    item.noteId = result.noteId || item.noteId;
    item.lastSyncedAt = now;
  } else if (result.success) {
    item.status = "synced";
    item.noteId = result.noteId;
    item.lastSyncedAt = now;
    item.error = undefined;
  } else {
    item.status = "error";
    item.error = result.error || "Upload failed";
  }

  writeIndex(folderId, index);

  // 日志
  if (result.success || result.skipped) {
    appendLog(folderId, "upload_success", `${relativePath} → ${result.noteId || "skipped"}`);
  } else {
    appendLog(folderId, "upload_failed", `${relativePath}: ${result.error || "unknown"}`);
  }

  return { ok: true };
}

module.exports = {
  setDataDir,
  readConfigs,
  saveConfig,
  removeConfig,
  getIndex,
  getLogs,
  runNow,
  getPendingUploads,
  markUploadResult,
};
