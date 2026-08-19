// electron/settings.js
//
// 应用级设置持久化（mode / remoteUrl 等）。
//
// 文件位置：{userData}/nowen-data/settings.json
//   - 与 backend 的 SQLite 同目录，便于卸载时一并清理；
//   - 卸载默认保留 userData，所以"模式选择"会跨重装保持。
//
// 字段：
//   mode:        "full" | "lite"          // full=自带后端；lite=连远端
//   remoteUrl:   string                    // lite 模式下的远端基础 URL（例：http://192.168.1.10:3000）
//   hideMenuBar: boolean                   // Windows/Linux 是否隐藏原生菜单栏（Alt 可临时唤出）
//   offlineCacheDir: string                // 自定义 renderer 离线缓存目录；空字符串表示默认目录
//   offlineCacheMigrationSource: string    // 更换目录后，仅供下一次启动迁移使用
//   windowState: object | null              // 主窗口正常坐标、尺寸和最大化状态
//
// Local-first 演进字段（Phase 1 引入，尚未接管启动逻辑）：
//   runtime:              "local" | "remote"   // 数据运行时；桌面端最终恒为 local
//   syncEnabled:          boolean              // 是否启用可选同步
//   activeSyncProfileId:  string | null        // 当前生效的 SyncProfile
//   liteMigrationStatus:  "none" | "pending" | "running" | "failed" | "complete"
//
// 设计：
//   - 读：失败/字段缺失 → 默认值 { mode: "full", remoteUrl: "" }，永远不抛
//   - 写：原子写（先写 .tmp 再 rename），避免崩溃时半截 JSON 导致下次起不来
//   - 校验：mode 仅接受 "full" | "lite"；remoteUrl 仅接受 http(s) 开头
//
// 与 main.js 解耦：本模块**不直接**依赖 app.getPath，调用方传入 userData 路径。

const fs = require("fs");
const path = require("path");
const { normalizeStoredWindowState } = require("./window-state");

const DEFAULT_SETTINGS = Object.freeze({
  mode: "full",
  remoteUrl: "",
  hideMenuBar: true,
  offlineCacheDir: "",
  offlineCacheMigrationSource: "",
  windowState: null,
  // Local-first 字段不设默认值常量，而是每次由 mode/remoteUrl 派生，
  // 保证旧 settings.json 升级后语义与 legacy 模式严格一致。
});

const VALID_MODES = new Set(["full", "lite"]);
const VALID_RUNTIMES = new Set(["local", "remote"]);
const VALID_LITE_MIGRATION_STATUSES = new Set([
  "none",
  "pending",
  "running",
  "failed",
  "complete",
]);


let cachedFile = null; // 绝对路径
let cachedValue = null; // 内存缓存

function setSettingsPath(userDataPath) {
  cachedFile = path.join(userDataPath, "settings.json");
  cachedValue = null; // 改路径必须失效缓存
}

function getSettingsPath() {
  if (!cachedFile) {
    throw new Error("settings.js: setSettingsPath() must be called before reading/writing");
  }
  return cachedFile;
}

/**
 * 从 legacy 的 mode/remoteUrl 派生 Local-first 运行时字段。
 *
 * 这是 Phase 1 最关键的安全边界：
 *
 * - Legacy Full 本来就是"本地 SQLite 唯一数据源"，与 runtime=local + syncEnabled=false
 *   语义完全等价，可以直接映射，无需迁移、无需复制数据库。
 *
 * - Legacy Lite 的权威数据在远端服务器，本地 SQLite 是空的。若把它直接判为
 *   runtime=local，用户重启后会看到一个空知识库。因此 Lite 必须保持
 *   runtime=remote，直到 Phase 1 之后的迁移流程真正把 Snapshot 落到本地并校验通过。
 *
 * 已显式写入的 runtime 值优先于派生值，但 Lite + local 这种组合只有在迁移
 * 标记为 complete 时才被接受——否则一律回退到 remote 保护用户数据。
 */
function deriveRuntimeFields(raw, mode) {
  const stored = raw && typeof raw === "object" ? raw : {};

  const liteMigrationStatus =
    typeof stored.liteMigrationStatus === "string"
      && VALID_LITE_MIGRATION_STATUSES.has(stored.liteMigrationStatus)
      ? stored.liteMigrationStatus
      : "none";

  // legacy 语义：full → local，lite → remote
  const derivedRuntime = mode === "lite" ? "remote" : "local";

  let runtime = derivedRuntime;
  if (typeof stored.runtime === "string" && VALID_RUNTIMES.has(stored.runtime)) {
    runtime = stored.runtime;
  }

  // 保护：lite 数据还在远端时不允许声称 local。
  if (mode === "lite" && runtime === "local" && liteMigrationStatus !== "complete") {
    runtime = "remote";
  }

  // full 模式的数据库就在本机，不存在"远端权威"的情况。
  if (mode === "full") {
    runtime = "local";
  }

  const syncEnabled =
    typeof stored.syncEnabled === "boolean"
      ? stored.syncEnabled
      // legacy lite 连着远端服务器，语义上等价于"已开启同步"；
      // legacy full 是纯本地，等价于"未开启同步"。
      : mode === "lite";

  let activeSyncProfileId =
    typeof stored.activeSyncProfileId === "string" && stored.activeSyncProfileId.trim()
      ? stored.activeSyncProfileId.trim()
      : null;
  // 未启用同步时不保留 profile 指针，避免关闭同步后引擎仍被误唤醒。
  if (!syncEnabled) activeSyncProfileId = null;

  return { runtime, syncEnabled, activeSyncProfileId, liteMigrationStatus };
}

function normalize(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === "object") {
    if (typeof raw.mode === "string" && VALID_MODES.has(raw.mode)) {
      out.mode = raw.mode;
    }
    if (typeof raw.remoteUrl === "string" && /^https?:\/\//i.test(raw.remoteUrl)) {
      // 去尾部斜杠，避免 loadURL 拼接时双斜杠
      out.remoteUrl = raw.remoteUrl.replace(/\/+$/, "");
    }
    if (typeof raw.hideMenuBar === "boolean") {
      out.hideMenuBar = raw.hideMenuBar;
    }
    if (typeof raw.offlineCacheDir === "string" && path.isAbsolute(raw.offlineCacheDir)) {
      out.offlineCacheDir = path.resolve(raw.offlineCacheDir);
    }
    if (typeof raw.offlineCacheMigrationSource === "string" && path.isAbsolute(raw.offlineCacheMigrationSource)) {
      out.offlineCacheMigrationSource = path.resolve(raw.offlineCacheMigrationSource);
    }
    out.windowState = normalizeStoredWindowState(raw.windowState);
  }
  // 一致性：lite 模式但 url 为空 → 退回 full（防止用户手编 settings.json 出错卡死）
  if (out.mode === "lite" && !out.remoteUrl) {
    out.mode = "full";
  }

  // Local-first 字段在 mode 归一化之后派生，确保与最终 mode 一致。
  Object.assign(out, deriveRuntimeFields(raw, out.mode));
  return out;
}


function readSettings() {
  if (cachedValue) return cachedValue;
  const file = getSettingsPath();
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      cachedValue = normalize(raw);
      return cachedValue;
    }
  } catch (e) {
    console.warn("[settings] read failed, fallback to defaults:", e?.message || e);
  }
  // 兜底也走 normalize：否则文件缺失/损坏时返回的对象缺少 runtime 等派生字段，
  // 调用方读到 undefined 会误判为"非 local 运行时"。
  cachedValue = normalize(null);
  return cachedValue;
}

function writeSettings(patch) {
  const file = getSettingsPath();
  const merged = normalize({ ...readSettings(), ...patch });

  // 确保目录存在
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    console.error("[settings] mkdir failed:", e?.message || e);
  }

  // 原子写：tmp + rename
  const tmp = file + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf8");
    fs.renameSync(tmp, file);
    cachedValue = merged;
    return merged;
  } catch (e) {
    console.error("[settings] write failed:", e?.message || e);
    // 写失败时仍更新内存缓存，下次重启会重新读默认值
    cachedValue = merged;
    throw e;
  }
}

/**
 * Renderer 是否应该把数据源指向本机 Embedded Backend。
 *
 * Phase 1 只提供判定，不改变 main.js 的既有选路：目前它仍等价于
 * `mode !== "lite"`，因此行为零变化。后续 Phase 让 Lite 完成迁移后，
 * 同一个函数会自然返回 true，届时 Renderer 才切到 localhost。
 *
 * 之所以集中在这里而不是在 main.js 里散落 if：Local-first 的目标是
 * 底层只有一种数据模式，业务代码不应长期维护 localMode / syncMode 两套分支。
 */
function shouldUseLocalRuntime(settings) {
  const value = settings || readSettings();
  return value.runtime === "local";
}

/**
 * Legacy Lite 是否仍需迁移才能进入 Local-first。
 *
 * 迁移失败或未开始时必须继续允许旧 Lite 正常使用，不能出现半迁移状态。
 */
function needsLiteMigration(settings) {
  const value = settings || readSettings();
  return value.mode === "lite" && value.liteMigrationStatus !== "complete";
}

module.exports = {
  DEFAULT_SETTINGS,
  setSettingsPath,
  readSettings,
  writeSettings,
  shouldUseLocalRuntime,
  needsLiteMigration,
};
