// electron/setupWindow.js
//
// "选择服务器"窗口（首启 Lite / 菜单"切换到轻量模式…" / "更换服务器…"时弹出）。
//
// 行为：
//   - 提供两条路径：手动输入 URL；从 mDNS 发现的服务列表里挑。
//   - 用户点"使用此服务器"后，主进程把 mode=lite + remoteUrl 写入 settings.json
//     然后 relaunch 应用（最干净的方式：让 main.js 在 ready 时直接走 lite 分支）。
//   - 用户点"取消" → 关闭窗口（如果当前还没有有效的 lite 配置且模式已是 lite，
//     调用方自行决定回退到 full 还是退出）。
//
// 实现细节：
//   - 单独 BrowserWindow，frame:true 保留系统标题栏（HIG: 设置类窗口走系统外观）。
//   - 内嵌 HTML/JS（无前端构建依赖），通过 ipcRenderer 与主进程通信；
//     这是个"配置 UI"，没必要拉进 React。
//   - 通过 webPreferences.preload 暴露受限 API：
//       discoveryStart / discoveryStop / discoveryOnUpdate / probe / submit / cancel
//     不复用主窗口的 preload.js，避免 setup 阶段意外拿到业务 API。

const { BrowserWindow, ipcMain, app } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");

let setupWin = null;

/**
 * 探测 URL 是否可达（GET /api/health 优先，失败则 GET / 兜底）。
 * 主进程探测可避免 renderer 的 mixed-content / CORS / 自签证书问题。
 *
 * @param {string} url 形如 "http://192.168.1.10:3000"
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
function probeUrl(url) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return resolve({ ok: false, error: "URL 格式不正确" });
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      return resolve({ ok: false, error: "仅支持 http(s)" });
    }

    const lib = parsed.protocol === "https:" ? https : http;
    const tryPath = (p, cb) => {
      const req = lib.request(
        {
          method: "GET",
          host: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: p,
          timeout: 4000,
          // 自签证书也允许（用户输入的局域网地址常见自签）
          rejectUnauthorized: false,
        },
        (res) => {
          // 任何 < 500 都视为"可达"——/api/health 应是 200，但兜底页可能 200/302/404 都算 alive
          res.resume();
          cb({ ok: res.statusCode < 500, status: res.statusCode });
        }
      );
      req.on("error", (e) => cb({ ok: false, error: e.message }));
      req.on("timeout", () => {
        req.destroy();
        cb({ ok: false, error: "连接超时" });
      });
      req.end();
    };

    // 先试 /api/health；不通就试 /
    tryPath("/api/health", (r1) => {
      if (r1.ok) return resolve(r1);
      tryPath("/", (r2) => resolve(r2.ok ? r2 : r1));
    });
  });
}

const HTML = String.raw`
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>选择服务器 - Nowen Note</title>
<style>
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --border: #30363d;
    --text: #e6edf3;
    --muted: #7d8590;
    --accent: #58a6ff;
    --accent-hover: #79b8ff;
    --danger: #f85149;
    --ok: #3fb950;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; height: 100%;
    background: var(--bg); color: var(--text);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  .wrap { padding: 20px 22px; display: flex; flex-direction: column; gap: 14px; height: 100%; }
  h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: 0.3px; }
  .sub { color: var(--muted); font-size: 12px; margin-top: -8px; }
  .field { display: flex; gap: 8px; align-items: center; }
  input[type="text"] {
    flex: 1; background: var(--panel); color: var(--text);
    border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px; font-size: 13px; outline: none;
    transition: border-color .15s;
  }
  input[type="text"]:focus { border-color: var(--accent); }
  button {
    background: var(--panel); color: var(--text);
    border: 1px solid var(--border); border-radius: 6px;
    padding: 7px 14px; font-size: 13px; cursor: pointer;
    transition: background .12s, border-color .12s;
  }
  button:hover { background: #1f242c; }
  button.primary {
    background: var(--accent); color: #0d1117; border-color: var(--accent); font-weight: 600;
  }
  button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  button:disabled { opacity: .5; cursor: not-allowed; }

  .section-title { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.6px; margin-top: 4px; }

  .lan-list {
    flex: 1; min-height: 120px;
    border: 1px solid var(--border); border-radius: 6px;
    background: var(--panel); overflow: auto;
  }
  .lan-empty { padding: 18px; color: var(--muted); text-align: center; font-size: 12px; }
  .lan-item {
    padding: 9px 12px; border-bottom: 1px solid var(--border);
    cursor: pointer; display: flex; flex-direction: column; gap: 2px;
  }
  .lan-item:last-child { border-bottom: none; }
  .lan-item:hover { background: #1f242c; }
  .lan-item.active { background: #1f6feb33; }
  .lan-name { font-weight: 500; }
  .lan-addr { color: var(--muted); font-size: 12px; font-family: ui-monospace, monospace; }

  .footer { display: flex; gap: 8px; justify-content: space-between; align-items: center; }
  .status {
    flex: 1; font-size: 12px; min-height: 16px;
  }
  .status.err { color: var(--danger); }
  .status.ok { color: var(--ok); }
  .actions { display: flex; gap: 8px; }
</style>
</head>
<body>
<div class="wrap">
  <div>
    <h1>切换到轻量模式</h1>
    <div class="sub">连接到一个已经部署好的 Nowen Note 服务（Docker / 团队服务器）。本机将不再启动后端，也不创建本地数据库。</div>
  </div>

  <div class="section-title">服务器地址</div>
  <div class="field">
    <input id="url" type="text" placeholder="https://fnos.net/user:3001 或 http://192.168.1.10:3001" autocomplete="off" spellcheck="false" />
    <button id="probe">测试连接</button>
  </div>

  <div class="section-title">局域网发现 <span id="lanState" style="text-transform:none;color:var(--muted);font-weight:normal;"></span></div>
  <div class="lan-list" id="lanList">
    <div class="lan-empty">正在扫描局域网…</div>
  </div>

  <div class="footer">
    <div id="status" class="status"></div>
    <div class="actions">
      <button id="cancel">取消</button>
      <button id="ok" class="primary" disabled>使用此服务器</button>
    </div>
  </div>
</div>

<script>
  const $ = (id) => document.getElementById(id);
  const urlEl = $("url"), probeBtn = $("probe"), okBtn = $("ok"), cancelBtn = $("cancel");
  const lanList = $("lanList"), lanState = $("lanState"), statusEl = $("status");

  let lanItems = [];          // 当前列表
  let selectedKey = null;     // 选中的 mDNS 项 key（name），null 表示用手动输入
  let lastProbeOk = false;    // 最后一次探测是否成功（决定 OK 按钮是否可点）

  function setStatus(text, kind) {
    statusEl.className = "status" + (kind ? " " + kind : "");
    statusEl.textContent = text || "";
  }

  function currentUrl() {
    return urlEl.value.trim().replace(/\/+$/, "");
  }

  // URL 输入变化 → 重置探测状态、清掉 LAN 选中
  urlEl.addEventListener("input", () => {
    lastProbeOk = false; okBtn.disabled = true;
    selectedKey = null; renderLan();
    setStatus("");
  });

  function renderLan() {
    if (!lanItems.length) {
      lanList.innerHTML = '<div class="lan-empty">未发现局域网内的 Nowen Note 服务（确保服务端开启了 mDNS 广播）。</div>';
      return;
    }
    lanList.innerHTML = "";
    for (const it of lanItems) {
      const div = document.createElement("div");
      div.className = "lan-item" + (selectedKey === it.name ? " active" : "");
      const url = buildUrlFromService(it);
      div.innerHTML =
        '<div class="lan-name">' + escapeHtml(it.name || it.host || "(unnamed)") + '</div>' +
        '<div class="lan-addr">' + escapeHtml(url) + '</div>';
      div.addEventListener("click", () => {
        selectedKey = it.name;
        urlEl.value = url;
        lastProbeOk = false; okBtn.disabled = true;
        setStatus("");
        renderLan();
      });
      div.addEventListener("dblclick", () => {
        // 双击 = 选中并立刻探测
        if (urlEl.value !== url) urlEl.value = url;
        doProbe();
      });
      lanList.appendChild(div);
    }
  }

  function buildUrlFromService(svc) {
    const proto = (svc.txt && (svc.txt.scheme || svc.txt.secure === "1" ? "https" : "http")) || "http";
    const host = svc.ipv4 || (svc.addresses && svc.addresses[0]) || svc.host || "";
    const port = svc.port || 80;
    const pth = (svc.txt && svc.txt.path) ? svc.txt.path.replace(/\/+$/, "") : "";
    return proto + "://" + host + ":" + port + pth;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  async function doProbe() {
    const url = currentUrl();
    if (!url) { setStatus("请输入服务器地址", "err"); return; }
    probeBtn.disabled = true; okBtn.disabled = true;
    setStatus("测试中…");
    try {
      const r = await window.setupApi.probe(url);
      if (r.ok) {
        lastProbeOk = true;
        okBtn.disabled = false;
        setStatus("连接成功（HTTP " + (r.status ?? "?") + "）", "ok");
      } else {
        lastProbeOk = false;
        okBtn.disabled = true;
        setStatus("连接失败：" + (r.error || ("HTTP " + r.status)), "err");
      }
    } catch (e) {
      lastProbeOk = false;
      okBtn.disabled = true;
      setStatus("测试异常：" + (e && e.message || e), "err");
    } finally {
      probeBtn.disabled = false;
    }
  }

  probeBtn.addEventListener("click", doProbe);
  urlEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doProbe();
  });

  okBtn.addEventListener("click", () => {
    if (!lastProbeOk) return;
    window.setupApi.submit(currentUrl());
  });
  cancelBtn.addEventListener("click", () => window.setupApi.cancel());

  // 启动局域网发现
  (async () => {
    try {
      const r = await window.setupApi.discoveryStart();
      if (!r.available) {
        lanState.textContent = "（mDNS 不可用）";
      }
    } catch (e) {
      lanState.textContent = "（启动失败）";
    }
  })();

  window.setupApi.discoveryOnUpdate((list) => {
    lanItems = Array.isArray(list) ? list : [];
    lanState.textContent = lanItems.length ? "（已发现 " + lanItems.length + " 个）" : "";
    renderLan();
  });

  // 预填初始 URL（如果调用方传了 initialUrl）
  window.setupApi.getInitial().then((init) => {
    if (init && init.url) urlEl.value = init.url;
    urlEl.focus();
  });
</script>
</body>
</html>
`;

const PRELOAD_JS = `
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("setupApi", {
  probe: (url) => ipcRenderer.invoke("setup:probe", url),
  submit: (url) => ipcRenderer.send("setup:submit", url),
  cancel: () => ipcRenderer.send("setup:cancel"),
  getInitial: () => ipcRenderer.invoke("setup:get-initial"),
  discoveryStart: () => ipcRenderer.invoke("discovery:start"),
  discoveryOnUpdate: (cb) => {
    const wrap = (_e, payload) => cb(payload);
    ipcRenderer.on("discovery:update", wrap);
    return () => ipcRenderer.removeListener("discovery:update", wrap);
  },
});
`;

let preloadPath = null;
function ensurePreload() {
  if (preloadPath && fs.existsSync(preloadPath)) return preloadPath;
  // 写到 userData 目录避免污染应用安装目录（asar 打包后只读）
  const tmpDir = app.getPath("userData");
  fs.mkdirSync(tmpDir, { recursive: true });
  preloadPath = path.join(tmpDir, "setup-preload.js");
  fs.writeFileSync(preloadPath, PRELOAD_JS, "utf8");
  return preloadPath;
}

/**
 * 打开 setup 窗口。
 * @param {{ initialUrl?: string, parent?: Electron.BrowserWindow | null }} opts
 * @returns {Promise<{ ok: true, url: string } | { ok: false, reason: "cancelled" | "closed" }>}
 */
function openSetupWindow(opts = {}) {
  return new Promise((resolve) => {
    if (setupWin && !setupWin.isDestroyed()) {
      setupWin.focus();
      return resolve({ ok: false, reason: "cancelled" });
    }

    const preload = ensurePreload();
    setupWin = new BrowserWindow({
      width: 560,
      height: 520,
      title: "选择服务器",
      backgroundColor: "#0d1117",
      resizable: true,
      minimizable: false,
      maximizable: false,
      parent: opts.parent || undefined,
      modal: !!opts.parent,
      autoHideMenuBar: true,
      webPreferences: {
        preload,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    setupWin.setMenuBarVisibility(false);
    setupWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(HTML));

    let resolved = false;
    const cleanup = () => {
      ipcMain.removeHandler("setup:probe");
      ipcMain.removeHandler("setup:get-initial");
      ipcMain.removeAllListeners("setup:submit");
      ipcMain.removeAllListeners("setup:cancel");
    };

    ipcMain.removeHandler("setup:probe");
    ipcMain.handle("setup:probe", (_e, url) => probeUrl(String(url || "")));

    ipcMain.removeHandler("setup:get-initial");
    ipcMain.handle("setup:get-initial", () => ({ url: opts.initialUrl || "" }));

    ipcMain.removeAllListeners("setup:submit");
    ipcMain.on("setup:submit", (_e, url) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      const finalUrl = String(url || "").trim().replace(/\/+$/, "");
      try { setupWin.close(); } catch { /* ignore */ }
      resolve({ ok: true, url: finalUrl });
    });

    ipcMain.removeAllListeners("setup:cancel");
    ipcMain.on("setup:cancel", () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      try { setupWin.close(); } catch { /* ignore */ }
      resolve({ ok: false, reason: "cancelled" });
    });

    setupWin.on("closed", () => {
      setupWin = null;
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve({ ok: false, reason: "closed" });
      }
    });
  });
}

module.exports = { openSetupWindow };
