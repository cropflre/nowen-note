// electron/folder-sync.js
//
// Desktop folder -> Nowen one-way projection.
// The main process owns filesystem access, scan budgets and the local index.
// Renderer code only receives bounded metadata/content and performs authenticated uploads.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

let configFilePath = null;
let dataDir = null;

const PREFS_MESSAGE_PREFIX = "__NOWEN_FOLDER_SYNC_PREFS__:";
const DEFAULT_FILE_TYPES = [".md", ".txt", ".html", ".pdf", ".docx"];
const DEFAULT_ADVANCED = Object.freeze({
  conflictPolicy: "protect",
  deletionPolicy: "keep",
  extractAttachmentText: true,
  excludePatterns: [],
});

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", ".next",
  ".vite", "__pycache__", ".cache", ".turbo",
]);
const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const IGNORED_PREFIXES = ["~$"];
const IGNORED_EXTS = [".tmp", ".temp", ".swp", ".swo"];

const TEXT_EXTS = new Set([".md", ".txt", ".markdown", ".html", ".htm"]);
const BINARY_UPLOAD_EXTS = new Set([".pdf", ".docx"]);
const PENDING_STATUSES = new Set(["new", "changed", "renamed", "error", "conflict"]);

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_FILES = 10_000;
const MAX_TOTAL_READ_BYTES = 1024 * 1024 * 1024;
const MAX_LOG_ENTRIES = 200;
const MAX_EXCLUDE_PATTERNS = 10;
const MAX_EXCLUDE_PATTERN_LENGTH = 64;

function setDataDir(dir) {
  dataDir = dir;
  configFilePath = path.join(dir, "folder-sync.json");
}

function genId() {
  return crypto.randomBytes(8).toString("hex");
}

function normalizeSlashes(value) {
  return String(value || "").replace(/\\/g, "/");
}

function sanitizeExcludePatterns(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const pattern = normalizeSlashes(raw.trim()).slice(0, MAX_EXCLUDE_PATTERN_LENGTH);
    if (!pattern || pattern.startsWith("#") || seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
    if (out.length >= MAX_EXCLUDE_PATTERNS) break;
  }
  return out;
}

function normalizeAdvanced(input) {
  const value = input && typeof input === "object" ? input : {};
  return {
    conflictPolicy: ["protect", "copy", "overwrite"].includes(value.conflictPolicy)
      ? value.conflictPolicy
      : DEFAULT_ADVANCED.conflictPolicy,
    deletionPolicy: ["keep", "trash", "detach"].includes(value.deletionPolicy)
      ? value.deletionPolicy
      : DEFAULT_ADVANCED.deletionPolicy,
    extractAttachmentText: typeof value.extractAttachmentText === "boolean"
      ? value.extractAttachmentText
      : DEFAULT_ADVANCED.extractAttachmentText,
    excludePatterns: sanitizeExcludePatterns(value.excludePatterns),
  };
}

function normalizeFileTypes(fileTypes) {
  const source = Array.isArray(fileTypes) && fileTypes.length ? fileTypes : DEFAULT_FILE_TYPES;
  return [...new Set(source
    .filter((item) => typeof item === "string")
    .map((item) => item.toLowerCase().trim())
    .filter(Boolean)
    .map((item) => item.startsWith(".") ? item : `.${item}`))];
}

function normalizeConfig(raw) {
  const advanced = normalizeAdvanced(raw);
  return {
    ...raw,
    folderId: typeof raw?.folderId === "string" ? raw.folderId : genId(),
    folderPath: typeof raw?.folderPath === "string" ? raw.folderPath : "",
    targetNotebookId: typeof raw?.targetNotebookId === "string" ? raw.targetNotebookId : null,
    includeSubfolders: raw?.includeSubfolders !== false,
    fileTypes: normalizeFileTypes(raw?.fileTypes),
    enabled: raw?.enabled !== false,
    intervalMinutes: Number.isFinite(raw?.intervalMinutes) ? raw.intervalMinutes : null,
    ...advanced,
  };
}

function readConfigs() {
  if (!configFilePath) return [];
  try {
    if (!fs.existsSync(configFilePath)) return [];
    const raw = JSON.parse(fs.readFileSync(configFilePath, "utf8"));
    return Array.isArray(raw) ? raw.map(normalizeConfig) : [];
  } catch (error) {
    console.warn("[folder-sync] read configs failed:", error?.message || error);
    return [];
  }
}

function writeConfigs(configs) {
  if (!configFilePath) return;
  fs.mkdirSync(path.dirname(configFilePath), { recursive: true });
  const tmp = `${configFilePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(configs, null, 2), "utf8");
  fs.renameSync(tmp, configFilePath);
}

function saveConfig(input) {
  const configs = readConfigs();
  const now = new Date().toISOString();
  if (input?.folderId) {
    const index = configs.findIndex((item) => item.folderId === input.folderId);
    if (index >= 0) {
      configs[index] = normalizeConfig({ ...configs[index], ...input, updatedAt: now });
      writeConfigs(configs);
      return { ok: true, config: configs[index] };
    }
  }

  const config = normalizeConfig({
    folderId: input?.folderId || genId(),
    folderPath: input?.folderPath || "",
    targetNotebookId: input?.targetNotebookId || null,
    includeSubfolders: input?.includeSubfolders !== false,
    fileTypes: input?.fileTypes || DEFAULT_FILE_TYPES,
    enabled: input?.enabled !== false,
    intervalMinutes: input?.intervalMinutes ?? null,
    lastSyncedAt: null,
    lastScanAt: null,
    lastScanStats: null,
    createdAt: now,
    updatedAt: now,
    ...normalizeAdvanced(input),
  });
  configs.push(config);
  writeConfigs(configs);
  return { ok: true, config };
}

function removeConfig(folderId) {
  const configs = readConfigs();
  const filtered = configs.filter((item) => item.folderId !== folderId);
  if (filtered.length === configs.length) return { ok: false, error: "Config not found" };
  writeConfigs(filtered);
  if (dataDir) {
    try {
      const indexPath = path.join(dataDir, `folder-sync-index-${folderId}.json`);
      if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
    } catch { /* best effort */ }
  }
  return { ok: true };
}

function applyAdvancedPreferences(folderId, input) {
  const configs = readConfigs();
  const index = configs.findIndex((item) => item.folderId === folderId);
  if (index < 0) return { ok: false, error: "Config not found" };
  configs[index] = normalizeConfig({
    ...configs[index],
    ...normalizeAdvanced(input),
    updatedAt: new Date().toISOString(),
  });
  writeConfigs(configs);
  return { ok: true, config: configs[index] };
}

function isDangerousRoot(value) {
  const normalized = path.resolve(value || "");
  if (/^[A-Za-z]:\\?$/.test(normalized)) return true;
  if (normalized === path.parse(normalized).root) return true;
  const home = path.resolve(os.homedir());
  return normalized === home;
}

function checkPathBoundary(rootPath, candidatePath, expectDirectory = false) {
  let rootRealPath;
  let candidateStat;
  let candidateRealPath;
  try {
    rootRealPath = fs.realpathSync(rootPath);
    candidateStat = fs.lstatSync(candidatePath);
    if (candidateStat.isSymbolicLink()) return { ok: false, reason: "Symbolic link or junction is not allowed" };
    if (expectDirectory ? !candidateStat.isDirectory() : !candidateStat.isFile()) {
      return { ok: false, reason: expectDirectory ? "Not a directory" : "Not a regular file" };
    }
    candidateRealPath = fs.realpathSync(candidatePath);
  } catch (error) {
    return { ok: false, reason: error?.message || "Cannot resolve path" };
  }

  const relative = path.relative(path.normalize(rootRealPath), path.normalize(candidateRealPath));
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return { ok: false, reason: "Path escapes the configured root" };
  }
  return { ok: true, rootRealPath, fileRealPath: candidateRealPath };
}

function globToRegExp(pattern) {
  const normalized = normalizeSlashes(pattern).replace(/^\.\//, "");
  let source = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        source += ".*";
        i += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  if (normalized.endsWith("/")) return new RegExp(`^${source}.*$`, "i");
  return new RegExp(`^${source}$`, "i");
}

function matchesExcludePattern(relativePath, pattern) {
  const rel = normalizeSlashes(relativePath).replace(/^\/+/, "");
  const clean = normalizeSlashes(pattern).replace(/^\/+/, "");
  if (!clean) return false;
  const regex = globToRegExp(clean);
  if (regex.test(rel)) return true;
  if (!clean.includes("/")) {
    if (regex.test(path.posix.basename(rel))) return true;
    return rel.split("/").some((part) => regex.test(part));
  }
  return false;
}

function readNowenIgnore(folderPath) {
  const ignorePath = path.join(folderPath, ".nowenignore");
  try {
    const boundary = checkPathBoundary(folderPath, ignorePath);
    if (!boundary.ok) return [];
    const stat = fs.statSync(ignorePath);
    if (stat.size > 32 * 1024) return [];
    return sanitizeExcludePatterns(fs.readFileSync(ignorePath, "utf8").split(/\r?\n/));
  } catch {
    return [];
  }
}

function shouldIgnoreFile(name) {
  if (IGNORED_FILES.has(name) || name.startsWith(".")) return true;
  if (IGNORED_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  return IGNORED_EXTS.includes(path.extname(name).toLowerCase());
}

function computeHash(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function computeSourcePathHash(folderId, relativePath) {
  return crypto.createHash("sha256").update(`${folderId}:${normalizeSlashes(relativePath)}`).digest("hex");
}

function scanFolder(config, oldIndex) {
  const results = [];
  const oldMap = new Map(oldIndex.map((item) => [normalizeSlashes(item.relativePath), item]));
  const typeSet = new Set(normalizeFileTypes(config.fileTypes));
  const patterns = sanitizeExcludePatterns([
    ...(config.excludePatterns || []),
    ...readNowenIgnore(config.folderPath),
  ]);
  const budget = { files: 0, readBytes: 0, maxFiles: MAX_SCAN_FILES, maxReadBytes: MAX_TOTAL_READ_BYTES };
  let complete = true;
  let stopped = false;

  function pushError(relativePath, error) {
    results.push({ relativePath: normalizeSlashes(relativePath), status: "error", error: String(error || "Unknown scan error").slice(0, 300) });
  }

  function walk(dir, relBase) {
    if (stopped) return;
    let entries;
    try {
      const boundary = checkPathBoundary(config.folderPath, dir, true);
      if (!boundary.ok) {
        complete = false;
        pushError(relBase || ".", boundary.reason);
        return;
      }
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      complete = false;
      pushError(relBase || ".", `Cannot read directory: ${error?.message || error}`);
      return;
    }

    for (const entry of entries) {
      if (stopped) break;
      const fullPath = path.join(dir, entry.name);
      const relativePath = normalizeSlashes(relBase ? `${relBase}/${entry.name}` : entry.name);

      if (entry.isDirectory()) {
        if (!config.includeSubfolders || entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
        if (patterns.some((pattern) => matchesExcludePattern(`${relativePath}/`, pattern))) continue;
        const boundary = checkPathBoundary(config.folderPath, fullPath, true);
        if (!boundary.ok) {
          pushError(relativePath, boundary.reason);
          continue;
        }
        walk(fullPath, relativePath);
        continue;
      }

      if (!entry.isFile() || shouldIgnoreFile(entry.name)) continue;
      if (patterns.some((pattern) => matchesExcludePattern(relativePath, pattern))) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!typeSet.has(ext)) continue;

      budget.files += 1;
      if (budget.files > MAX_SCAN_FILES) {
        complete = false;
        stopped = true;
        pushError(relativePath, `Scan file limit exceeded (${MAX_SCAN_FILES})`);
        break;
      }

      try {
        const boundary = checkPathBoundary(config.folderPath, fullPath);
        if (!boundary.ok) {
          results.push({ relativePath, status: "skipped", error: boundary.reason });
          continue;
        }
        const stat = fs.statSync(boundary.fileRealPath);
        if (stat.size > MAX_FILE_SIZE) {
          results.push({
            relativePath,
            filename: entry.name,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            status: "skipped",
            error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB > 50MB)`,
          });
          continue;
        }

        const previous = oldMap.get(relativePath);
        let sha256 = "";
        if (previous?.sha256 && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
          sha256 = previous.sha256;
        } else {
          if (budget.readBytes + stat.size > MAX_TOTAL_READ_BYTES) {
            complete = false;
            stopped = true;
            pushError(relativePath, "Scan read budget exceeded (1GB)");
            break;
          }
          budget.readBytes += stat.size;
          sha256 = computeHash(boundary.fileRealPath);
        }

        results.push({
          relativePath,
          filename: entry.name,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256,
          status: "new",
          sourcePathHash: previous?.sourcePathHash || computeSourcePathHash(config.folderId, relativePath),
        });
      } catch (error) {
        pushError(relativePath, error?.message || error);
      }
    }
  }

  walk(config.folderPath, "");
  return { results, complete, budget };
}

function readIndex(folderId) {
  if (!dataDir) return [];
  const indexPath = path.join(dataDir, `folder-sync-index-${folderId}.json`);
  try {
    if (!fs.existsSync(indexPath)) return [];
    const raw = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeIndex(folderId, index) {
  if (!dataDir) return;
  const indexPath = path.join(dataDir, `folder-sync-index-${folderId}.json`);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const tmp = `${indexPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2), "utf8");
  fs.renameSync(tmp, indexPath);
}

function mergeIndex(oldIndex, scanResults, options = {}) {
  const complete = options.complete !== false;
  const folderId = options.folderId || "legacy";
  const now = new Date().toISOString();
  const oldByPath = new Map(oldIndex.map((item) => [normalizeSlashes(item.relativePath), item]));
  const scannedPaths = new Set(scanResults.map((item) => normalizeSlashes(item.relativePath)));
  const consumedOldPaths = new Set();
  const renameBuckets = new Map();

  for (const old of oldIndex) {
    const oldPath = normalizeSlashes(old.relativePath);
    if (scannedPaths.has(oldPath) || !old.sha256) continue;
    const key = `${old.sha256}:${Number(old.size || 0)}`;
    const bucket = renameBuckets.get(key) || [];
    bucket.push(old);
    renameBuckets.set(key, bucket);
  }

  const merged = [];
  for (const scan of scanResults) {
    const relativePath = normalizeSlashes(scan.relativePath);
    const direct = oldByPath.get(relativePath);

    if (scan.status === "skipped" || scan.status === "error") {
      if (direct) consumedOldPaths.add(relativePath);
      merged.push({
        ...direct,
        ...scan,
        relativePath,
        sourcePathHash: direct?.sourcePathHash || computeSourcePathHash(folderId, relativePath),
        lastScannedAt: now,
        lastSyncedAt: direct?.lastSyncedAt || null,
        noteId: direct?.noteId || null,
        attachmentId: direct?.attachmentId || null,
      });
      continue;
    }

    if (direct) {
      consumedOldPaths.add(relativePath);
      const sameHash = direct.sha256 === scan.sha256;
      const keepPending = sameHash && PENDING_STATUSES.has(direct.status);
      merged.push({
        ...direct,
        ...scan,
        relativePath,
        sourcePathHash: direct.sourcePathHash || scan.sourcePathHash || computeSourcePathHash(folderId, relativePath),
        status: sameHash ? (keepPending ? direct.status : "unchanged") : "changed",
        lastScannedAt: now,
        lastSyncedAt: direct.lastSyncedAt || null,
        noteId: direct.noteId || null,
        attachmentId: direct.attachmentId || null,
        error: keepPending ? direct.error : undefined,
      });
      continue;
    }

    const renameKey = `${scan.sha256}:${Number(scan.size || 0)}`;
    const candidates = (renameBuckets.get(renameKey) || []).filter((old) => !consumedOldPaths.has(normalizeSlashes(old.relativePath)));
    if (candidates.length === 1) {
      const old = candidates[0];
      consumedOldPaths.add(normalizeSlashes(old.relativePath));
      merged.push({
        ...old,
        ...scan,
        relativePath,
        filename: scan.filename || path.posix.basename(relativePath),
        previousRelativePath: normalizeSlashes(old.relativePath),
        sourcePathHash: old.sourcePathHash || computeSourcePathHash(folderId, old.relativePath),
        status: "renamed",
        lastScannedAt: now,
        lastSyncedAt: old.lastSyncedAt || null,
        error: undefined,
      });
      continue;
    }

    merged.push({
      ...scan,
      relativePath,
      filename: scan.filename || path.posix.basename(relativePath),
      sourcePathHash: scan.sourcePathHash || computeSourcePathHash(folderId, relativePath),
      status: "new",
      lastScannedAt: now,
      lastSyncedAt: null,
      noteId: null,
      attachmentId: null,
      error: undefined,
    });
  }

  for (const old of oldIndex) {
    const oldPath = normalizeSlashes(old.relativePath);
    if (consumedOldPaths.has(oldPath) || scannedPaths.has(oldPath)) continue;
    merged.push({
      ...old,
      relativePath: oldPath,
      sourcePathHash: old.sourcePathHash || computeSourcePathHash(folderId, oldPath),
      status: complete ? "deleted" : (old.status === "deleted" ? "deleted" : "unchanged"),
      lastScannedAt: now,
      error: complete ? undefined : old.error,
    });
  }
  return merged;
}

function readLogs() {
  if (!dataDir) return [];
  const logPath = path.join(dataDir, "folder-sync-logs.json");
  try {
    if (!fs.existsSync(logPath)) return [];
    const raw = JSON.parse(fs.readFileSync(logPath, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeLogs(logs) {
  if (!dataDir) return;
  const logPath = path.join(dataDir, "folder-sync-logs.json");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const tmp = `${logPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(logs.slice(-MAX_LOG_ENTRIES), null, 2), "utf8");
  fs.renameSync(tmp, logPath);
}

function appendLog(folderId, type, message, detail) {
  if (typeof message === "string" && message.startsWith(PREFS_MESSAGE_PREFIX)) {
    try {
      const payload = JSON.parse(message.slice(PREFS_MESSAGE_PREFIX.length));
      applyAdvancedPreferences(folderId, payload);
    } catch (error) {
      console.warn("[folder-sync] invalid preference control message:", error?.message || error);
    }
    return;
  }

  const logs = readLogs();
  logs.push({
    id: genId(),
    folderId,
    type: String(type || "info").slice(0, 64),
    message: String(message || "").slice(0, 1000),
    createdAt: new Date().toISOString(),
    detail: typeof detail === "string" ? detail.slice(0, 2000) : undefined,
  });
  writeLogs(logs);
}

function getLogs(folderId) {
  const logs = readLogs();
  return (folderId ? logs.filter((item) => item.folderId === folderId) : logs).slice(-50);
}

function runNow(folderId) {
  const configs = readConfigs();
  const config = configs.find((item) => item.folderId === folderId);
  if (!config) return { ok: false, code: "CONFIG_NOT_FOUND", message: "Sync config not found" };
  if (!config.folderPath || !fs.existsSync(config.folderPath)) {
    return { ok: false, code: "FOLDER_NOT_FOUND", message: "Configured folder does not exist" };
  }
  if (isDangerousRoot(config.folderPath)) {
    return { ok: false, code: "DANGEROUS_PATH", message: "System root and home directory cannot be scanned" };
  }
  const rootBoundary = checkPathBoundary(config.folderPath, config.folderPath, true);
  if (!rootBoundary.ok) return { ok: false, code: "UNSAFE_ROOT", message: rootBoundary.reason };

  const startedAt = Date.now();
  appendLog(folderId, "scan_started", "Folder scan started");
  try {
    const oldIndex = readIndex(folderId);
    const scan = scanFolder(config, oldIndex);
    const merged = mergeIndex(oldIndex, scan.results, { complete: scan.complete, folderId });
    writeIndex(folderId, merged);

    const stats = {
      total: merged.length,
      added: merged.filter((item) => item.status === "new").length,
      changed: merged.filter((item) => item.status === "changed" || item.status === "renamed").length,
      renamed: merged.filter((item) => item.status === "renamed").length,
      unchanged: merged.filter((item) => item.status === "unchanged" || item.status === "synced").length,
      deleted: merged.filter((item) => item.status === "deleted").length,
      skipped: merged.filter((item) => item.status === "skipped").length,
      conflicts: merged.filter((item) => item.status === "conflict").length,
      errors: merged.filter((item) => item.status === "error").length,
      durationMs: Date.now() - startedAt,
      complete: scan.complete,
      scannedFiles: scan.budget.files,
      readBytes: scan.budget.readBytes,
    };

    const configIndex = configs.findIndex((item) => item.folderId === folderId);
    if (configIndex >= 0) {
      configs[configIndex] = { ...configs[configIndex], lastScanAt: new Date().toISOString(), lastScanStats: stats };
      writeConfigs(configs);
    }
    appendLog(folderId, "scan_completed", `Scan complete: ${stats.total} indexed, ${stats.added} new, ${stats.changed} changed, ${stats.deleted} deleted`);
    return { ok: true, folderId, scannedAt: new Date().toISOString(), ...stats };
  } catch (error) {
    appendLog(folderId, "scan_failed", `Scan failed: ${error?.message || error}`);
    return { ok: false, code: "SCAN_FAILED", message: error?.message || String(error) };
  }
}

function getIndex(folderId) {
  return readIndex(folderId);
}

function makeCandidate(item, config, extra = {}) {
  const relativePath = normalizeSlashes(item.relativePath);
  return {
    action: extra.action || "upsert",
    relativePath,
    previousRelativePath: item.previousRelativePath || null,
    filename: item.filename || path.posix.basename(relativePath),
    sha256: item.sha256 || "",
    sourcePathHash: item.sourcePathHash || computeSourcePathHash(config.folderId, relativePath),
    size: Number(item.size || 0),
    mtimeMs: Number(item.mtimeMs || 0),
    ext: path.extname(relativePath).toLowerCase(),
    contentText: null,
    existingNoteId: item.noteId || null,
    attachmentId: item.attachmentId || null,
    skipReason: null,
    ...extra,
  };
}

function getPendingUploads(folderId) {
  const config = readConfigs().find((item) => item.folderId === folderId);
  if (!config) return { ok: false, error: "Config not found" };
  const index = readIndex(folderId);
  const pending = [];

  for (const item of index) {
    if (item.status === "deleted") {
      pending.push(makeCandidate(item, config, { action: "delete" }));
      continue;
    }
    if (!PENDING_STATUSES.has(item.status)) continue;

    const candidate = makeCandidate(item, config);
    const isText = TEXT_EXTS.has(candidate.ext);
    const isBinary = BINARY_UPLOAD_EXTS.has(candidate.ext);
    if (!isText && !isBinary) continue;

    const fullPath = path.join(config.folderPath, candidate.relativePath.replace(/\//g, path.sep));
    const boundary = checkPathBoundary(config.folderPath, fullPath);
    if (!boundary.ok) {
      pending.push({ ...candidate, skipReason: boundary.reason });
      continue;
    }

    if (isBinary) {
      pending.push(candidate);
      continue;
    }

    try {
      const stat = fs.statSync(boundary.fileRealPath);
      if (stat.size > MAX_TEXT_BYTES) {
        pending.push({ ...candidate, skipReason: `Text file exceeds 2MB (${(stat.size / 1024 / 1024).toFixed(1)}MB)` });
        continue;
      }
      pending.push({ ...candidate, contentText: fs.readFileSync(boundary.fileRealPath, "utf8") });
    } catch (error) {
      pending.push({ ...candidate, skipReason: `Read failed: ${error?.message || error}` });
    }
  }

  return {
    ok: true,
    folderId,
    config: {
      targetNotebookId: config.targetNotebookId,
      conflictPolicy: config.conflictPolicy,
      deletionPolicy: config.deletionPolicy,
      extractAttachmentText: config.extractAttachmentText,
    },
    pending,
  };
}

function markUploadResult(folderId, relativePath, result) {
  const index = readIndex(folderId);
  const itemIndex = index.findIndex((item) => normalizeSlashes(item.relativePath) === normalizeSlashes(relativePath));
  if (itemIndex < 0) return { ok: false, error: "Index entry not found" };
  const item = index[itemIndex];
  const now = new Date().toISOString();

  if (item.status === "deleted" && result.success) {
    index.splice(itemIndex, 1);
  } else if (result.skipped) {
    item.status = "skipped";
    item.lastSyncedAt = now;
    item.error = result.error || "Skipped";
    item.noteId = result.noteId || item.noteId;
    item.attachmentId = result.attachmentId || item.attachmentId;
  } else if (result.success) {
    item.status = "synced";
    item.lastSyncedAt = now;
    item.noteId = result.noteId || item.noteId;
    item.attachmentId = result.attachmentId || item.attachmentId;
    item.error = undefined;
    item.previousRelativePath = undefined;
  } else {
    const message = String(result.error || "Upload failed");
    item.status = message.startsWith("SYNC_CONFLICT:") ? "conflict" : "error";
    item.error = message.slice(0, 1000);
  }
  writeIndex(folderId, index);

  if (result.success) {
    const configs = readConfigs();
    const configIndex = configs.findIndex((config) => config.folderId === folderId);
    if (configIndex >= 0) {
      configs[configIndex].lastSyncedAt = now;
      writeConfigs(configs);
    }
  }
  appendLog(folderId, result.success ? "upload_success" : "upload_failed", result.success ? `${relativePath} synchronized` : `${relativePath}: ${result.error || "unknown error"}`);
  return { ok: true };
}

function getUploadFile(folderId, relativePath) {
  const config = readConfigs().find((item) => item.folderId === folderId);
  if (!config) return { ok: false, code: "CONFIG_NOT_FOUND", message: "Sync config not found" };
  if (!relativePath || path.isAbsolute(relativePath) || normalizeSlashes(relativePath).split("/").includes("..")) {
    return { ok: false, code: "UNSAFE_PATH", message: "Invalid relative path" };
  }
  const item = readIndex(folderId).find((entry) => normalizeSlashes(entry.relativePath) === normalizeSlashes(relativePath));
  if (!item) return { ok: false, code: "NOT_INDEXED", message: "File is not indexed" };
  if (!PENDING_STATUSES.has(item.status)) return { ok: false, code: "INVALID_STATUS", message: `File status is ${item.status}` };

  const fullPath = path.join(config.folderPath, normalizeSlashes(relativePath).replace(/\//g, path.sep));
  const boundary = checkPathBoundary(config.folderPath, fullPath);
  if (!boundary.ok) return { ok: false, code: "UNSAFE_PATH", message: boundary.reason };
  try {
    const stat = fs.statSync(boundary.fileRealPath);
    if (stat.size > MAX_FILE_SIZE) return { ok: false, code: "FILE_TOO_LARGE", message: "File exceeds 50MB" };
    const buffer = fs.readFileSync(boundary.fileRealPath);
    const ext = path.extname(relativePath).toLowerCase();
    const mimeTypes = {
      ".pdf": "application/pdf",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    return {
      ok: true,
      filename: item.filename || path.basename(relativePath),
      mimeType: mimeTypes[ext] || "application/octet-stream",
      size: buffer.length,
      buffer: buffer.toString("base64"),
    };
  } catch (error) {
    return { ok: false, code: "READ_FAILED", message: `Failed to read file: ${error?.message || error}` };
  }
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
  getUploadFile,
  appendLog,
  _test: {
    normalizeAdvanced,
    sanitizeExcludePatterns,
    matchesExcludePattern,
    mergeIndex,
    computeSourcePathHash,
    checkPathBoundary,
  },
};
