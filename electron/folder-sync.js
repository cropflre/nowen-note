// electron/folder-sync.js
//
// 桌面端文件夹同步配置管理（Phase B）。
//
// 配置文件位置：{userData}/nowen-data/folder-sync.json
// 索引文件位置：{userData}/nowen-data/folder-sync-index-{folderId}.json
//
// 本阶段只做配置的 CRUD，不做文件扫描、不做上传、不做 fs.watch。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let configFilePath = null;
let dataDir = null;

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
    // 更新已有配置
    const idx = configs.findIndex((c) => c.folderId === input.folderId);
    if (idx >= 0) {
      configs[idx] = {
        ...configs[idx],
        ...input,
        updatedAt: now,
      };
      writeConfigs(configs);
      return { ok: true, config: configs[idx] };
    }
  }

  // 新增配置
  const config = {
    folderId: input.folderId || genId(),
    folderPath: input.folderPath || "",
    targetNotebookId: input.targetNotebookId || null,
    includeSubfolders: input.includeSubfolders !== false,
    fileTypes: input.fileTypes || [".md", ".txt", ".html", ".pdf", ".docx"],
    enabled: input.enabled !== false,
    lastSyncedAt: null,
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
  if (filtered.length === configs.length) {
    return { ok: false, error: "Config not found" };
  }
  writeConfigs(filtered);

  // 清理索引文件
  if (dataDir) {
    const indexFile = path.join(dataDir, `folder-sync-index-${folderId}.json`);
    try {
      if (fs.existsSync(indexFile)) fs.unlinkSync(indexFile);
    } catch { /* ignore */ }
  }

  return { ok: true };
}

// ---------- 索引占位 ----------

function getIndex(folderId) {
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

// ---------- 日志占位 ----------

function getLogs(folderId) {
  // Phase B: 返回空日志，后续实现扫描时再写入
  void folderId;
  return [];
}

// ---------- runNow 占位 ----------

function runNow(folderId) {
  void folderId;
  return {
    ok: false,
    code: "NOT_IMPLEMENTED",
    message: "Folder sync scan is not implemented yet",
  };
}

// ---------- 选择文件夹（由 main.js 调用 dialog 后传入） ----------

// selectFolder 本身需要 dialog，在 main.js 中实现，这里只导出配置逻辑。

module.exports = {
  setDataDir,
  readConfigs,
  saveConfig,
  removeConfig,
  getIndex,
  getLogs,
  runNow,
};
