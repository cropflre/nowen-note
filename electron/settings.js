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
//
// 设计：
//   - 读：失败/字段缺失 → 默认值 { mode: "full", remoteUrl: "" }，永远不抛
//   - 写：原子写（先写 .tmp 再 rename），避免崩溃时半截 JSON 导致下次起不来
//   - 校验：mode 仅接受 "full" | "lite"；remoteUrl 仅接受 http(s) 开头
//
// 与 main.js 解耦：本模块**不直接**依赖 app.getPath，调用方传入 userData 路径。

const fs = require("fs");
const path = require("path");

const DEFAULT_SETTINGS = Object.freeze({
  mode: "full",
  remoteUrl: "",
  hideMenuBar: false,
});

const VALID_MODES = new Set(["full", "lite"]);

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
  }
  // 一致性：lite 模式但 url 为空 → 退回 full（防止用户手编 settings.json 出错卡死）
  if (out.mode === "lite" && !out.remoteUrl) {
    out.mode = "full";
  }
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
  cachedValue = { ...DEFAULT_SETTINGS };
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

module.exports = {
  DEFAULT_SETTINGS,
  setSettingsPath,
  readSettings,
  writeSettings,
};
