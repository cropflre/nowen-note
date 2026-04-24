// electron/discovery.js
//
// 局域网服务发现（mDNS / Bonjour 客户端）
//
// 设计：
//   - 主进程维持一个可复用的 Bonjour 实例和一个 browser（type=nowen-note tcp）。
//   - renderer 调 `discovery:start` 开启扫描，`discovery:stop` 关闭；
//     `discovery:list` 返回当前已知的服务快照。
//   - 发现变化时主动通过 IPC `discovery:update` 推送全量列表到 renderer，
//     避免 renderer 自己维护增删的边界情况（up/down/host 改 IP 等）。
//
// 健壮性：
//   - bonjour-service 依赖可选。加载失败时所有 API 都返回"空结果但不报错"，
//     这样前端 UI 至少能显示"未发现，请手动填写"而不是白屏。
//   - 多网卡环境下同一 name 可能出现在多个 address 下；统一按 `name` 去重，
//     并在一条里列出所有 addresses，让 UI 决定首选 IP。
//   - 扫描器有默认"陈旧阈值"。如果一台机器离线 30 秒仍没 down 事件（mDNS
//     天然弱保证），UI 可以通过 list 看到它的 lastSeen，再决定是否隐藏。

const { ipcMain } = require("electron");

let bonjour = null;
let browser = null;
let available = null; // null = 未探测，true/false = 已探测结果

// key = service.fqdn 或 service.name；value = { name, host, addresses, port, txt, lastSeen }
const services = new Map();
// renderer webContents，subscribe 后用于推送
const subscribers = new Set();

function tryInitBonjour() {
  if (available !== null) return available;
  try {
    const { Bonjour } = require("bonjour-service");
    bonjour = new Bonjour();
    available = true;
    return true;
  } catch (e) {
    console.warn(
      "[discovery] bonjour-service not available, LAN discovery disabled:",
      e && e.message ? e.message : e,
    );
    available = false;
    return false;
  }
}

function snapshot() {
  return Array.from(services.values()).sort((a, b) => {
    // 按最近发现时间倒序，老的往后排
    return (b.lastSeen || 0) - (a.lastSeen || 0);
  });
}

function broadcast() {
  const list = snapshot();
  for (const wc of subscribers) {
    try {
      if (!wc.isDestroyed()) wc.send("discovery:update", list);
    } catch {
      /* renderer 已销毁，下次 cleanup */
    }
  }
}

function normalizeService(svc) {
  // bonjour-service 里 svc 形如：
  //   { name, type, protocol, port, host, addresses: [ "192.168.x.x", "fe80::..."], txt: {...} }
  // addresses 里同时包含 IPv4 和 IPv6，客户端用 IPv4 就够了，但保留全量以备可选。
  const v4 = (svc.addresses || []).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  const v6 = (svc.addresses || []).filter((a) => a.includes(":"));
  return {
    name: svc.name || "",
    host: svc.host || "",
    port: svc.port || 0,
    addresses: [...v4, ...v6], // IPv4 在前
    ipv4: v4[0] || "",
    txt: svc.txt || {},
    lastSeen: Date.now(),
  };
}

function startBrowser() {
  if (!tryInitBonjour()) return false;
  if (browser) return true;

  try {
    browser = bonjour.find({ type: "nowen-note", protocol: "tcp" });
    browser.on("up", (svc) => {
      const norm = normalizeService(svc);
      services.set(norm.name, norm);
      broadcast();
    });
    browser.on("down", (svc) => {
      const name = svc && svc.name;
      if (name && services.delete(name)) broadcast();
    });
    browser.on("error", (err) => {
      console.warn("[discovery] browser error:", err && err.message);
    });
    // 某些实现里需要显式 start()；bonjour-service 里 find 已经启动，调 update 只是强制刷新一次。
    try {
      browser.update();
    } catch {
      /* no-op */
    }
    console.log("[discovery] browser started for _nowen-note._tcp.local.");
    return true;
  } catch (err) {
    console.warn("[discovery] start browser failed:", err && err.message);
    return false;
  }
}

function stopBrowser() {
  if (browser) {
    try {
      browser.stop();
    } catch {
      /* ignore */
    }
    browser = null;
  }
  services.clear();
}

function shutdown() {
  stopBrowser();
  if (bonjour) {
    try {
      bonjour.destroy();
    } catch {
      /* ignore */
    }
    bonjour = null;
  }
  subscribers.clear();
  available = null;
}

/**
 * 注册主进程 IPC 入口。在 app.whenReady() 之后调用。
 */
function registerDiscoveryIpc() {
  ipcMain.removeHandler("discovery:start");
  ipcMain.handle("discovery:start", (event) => {
    const wc = event.sender;
    subscribers.add(wc);
    // renderer 销毁时自动清理，避免内存泄漏 + 僵尸推送
    wc.once("destroyed", () => subscribers.delete(wc));

    const ok = startBrowser();
    // 订阅后立即发一次当前快照，哪怕是空数组，让 UI 可以切到"未发现"状态
    try {
      wc.send("discovery:update", snapshot());
    } catch {
      /* ignore */
    }
    return { ok, available: !!available };
  });

  ipcMain.removeHandler("discovery:stop");
  ipcMain.handle("discovery:stop", (event) => {
    subscribers.delete(event.sender);
    // 没有订阅者了就停掉浏览器，省电省 UDP 流量
    if (subscribers.size === 0) stopBrowser();
    return { ok: true };
  });

  ipcMain.removeHandler("discovery:list");
  ipcMain.handle("discovery:list", () => snapshot());
}

module.exports = {
  registerDiscoveryIpc,
  shutdown,
};
