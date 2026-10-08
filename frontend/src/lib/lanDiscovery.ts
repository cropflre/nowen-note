/**
 * 统一的局域网服务发现客户端（mDNS / Bonjour / Zeroconf）
 *
 * 架构：
 *   后端（backend/src/services/discovery.ts）通过 bonjour-service 在
 *   `_nowen-note._tcp.local.` 上广播自己。客户端只需用任意 mDNS 浏览器
 *   订阅同一个 service type 即可发现局域网内所有 nowen-note 后端。
 *
 * 三种运行环境分别用不同实现，但对外暴露同一个接口：
 *
 *   - Electron 桌面端：复用 main 进程已有的 bonjour-service 浏览器，
 *     通过 `window.nowenDesktop.discovery` 桥接（preload 注入）
 *
 *   - Capacitor 原生（Android / iOS）：调用社区插件
 *     `@capacitor-community/zeroconf`，Android 内部走 NsdManager，
 *     iOS 走 NetService。需要 Wi-Fi multicast lock，权限要求见 README。
 *
 *   - 普通浏览器 / Web：浏览器没有 mDNS API，能力直接判定为不可用，
 *     调用方应保留"手填服务器地址"作为兜底（项目里已有 ServerAddressInput）。
 *
 * 设计要点：
 *   - 形状对齐 Electron 现有数据结构（见 electron/discovery.js: normalizeService），
 *     这样 LanDiscoveryPanel 不需要为每个平台单独写适配。
 *   - start() 是幂等的；同一个进程多次 start 等价于一次。stop() 也是。
 *   - 订阅者全部 unsubscribe 后，自动 stop 浏览器（省电、省 UDP 广播流量）。
 *   - 任何底层 API 失败一律降级成 "available=false"，不抛给上层。
 */

import { Capacitor } from "@capacitor/core";

// ---- 公开接口 ----

export interface DiscoveredService {
  /** mDNS 实例名，例如 "nowen-note@hostname" */
  name: string;
  /** 原始 host（一般是 ".local" 域名），可能为空 */
  host: string;
  /** 端口 */
  port: number;
  /** 已解析到的地址，IPv4 在前 IPv6 在后；可能为空（极少数实现只给 host） */
  addresses: string[];
  /** 取出的首个 IPv4，便于直接显示；为空表示没解析到 v4 地址 */
  ipv4: string;
  /** mDNS TXT 记录，约定字段：v / https / name / path */
  txt: Record<string, string>;
  /** 最近一次发现/更新时间戳 */
  lastSeen: number;
}

export interface StartResult {
  /** 是否真正启动了浏览器（false 表示当前环境不支持） */
  ok: boolean;
  /** 当前环境是否具备发现能力（用于 UI 切换"扫描中" vs "不支持"） */
  available: boolean;
}

export interface LanDiscovery {
  /** 是否在当前运行环境可用 */
  isAvailable(): boolean;
  /** 启动浏览器（多次调用幂等） */
  start(): Promise<StartResult>;
  /** 停止浏览器（多次调用幂等） */
  stop(): Promise<void>;
  /**
   * 订阅服务列表更新；返回取消订阅函数。
   * 订阅时会立即收到一次当前快照（即使为空数组）。
   */
  onUpdate(cb: (list: DiscoveredService[]) => void): () => void;
}

// ---- 工具：从 Capacitor / Electron 原始 service 归一化为 DiscoveredService ----

function pickV4(addresses: string[] | undefined | null): string {
  if (!addresses) return "";
  return addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || "";
}

function sortV4First(addresses: string[] | undefined | null): string[] {
  if (!addresses || addresses.length === 0) return [];
  const v4 = addresses.filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  const v6 = addresses.filter((a) => a.includes(":"));
  // 兜底：可能既不是 v4 也不是 v6（极端情况主机名），追加在末尾
  const others = addresses.filter((a) => !v4.includes(a) && !v6.includes(a));
  return [...v4, ...v6, ...others];
}

// ============================================================================
// 实现 1：Electron —— 直接转发 main 进程的 bonjour-service
// ============================================================================

interface ElectronDiscoveryBridge {
  start(): Promise<StartResult>;
  stop(): Promise<void> | void;
  list?: () => Promise<DiscoveredService[]>;
  onUpdate(cb: (list: DiscoveredService[]) => void): () => void;
}

function getElectronBridge(): ElectronDiscoveryBridge | null {
  if (typeof window === "undefined") return null;
  const desktop: any = (window as any).nowenDesktop;
  return desktop && desktop.discovery ? (desktop.discovery as ElectronDiscoveryBridge) : null;
}

class ElectronDiscovery implements LanDiscovery {
  private bridge: ElectronDiscoveryBridge;
  private subscribers = 0;
  constructor(bridge: ElectronDiscoveryBridge) {
    this.bridge = bridge;
  }
  isAvailable() {
    return true;
  }
  start() {
    return Promise.resolve(this.bridge.start()).catch(() => ({ ok: false, available: false }));
  }
  async stop() {
    try {
      await Promise.resolve(this.bridge.stop());
    } catch {
      /* ignore */
    }
  }
  onUpdate(cb: (list: DiscoveredService[]) => void): () => void {
    this.subscribers++;
    const off = this.bridge.onUpdate(cb);
    return () => {
      off();
      this.subscribers--;
      if (this.subscribers === 0) void this.stop();
    };
  }
}

// ============================================================================
// 实现 2：Capacitor —— @mhaberler/capacitor-zeroconf-nsd
// ============================================================================
//
// 该插件 watch 事件每条形如：
//   {
//     action: "added" | "resolved" | "removed",
//     service: {
//       domain: "local.",
//       type: "_nowen-note._tcp.",
//       name: "nowen-note@hostname",
//       hostname: "hostname.local.",   // Android 上有时是空串
//       port: 3001,
//       ipv4Addresses: ["192.168.1.10"],
//       ipv6Addresses: ["fe80::..."],
//       txtRecord: { v: "1.0.0", https: "0", ... }
//     }
//   }
//
// 我们维护一个 Map<name, DiscoveredService>，订阅者拿到的总是全量列表。
// 内部用动态 import 避免在 Web/Electron 下也强制加载这个 native-only 插件。
//
// 关于停止扫描：
//   - watch(request, cb) 返回 Promise<CallbackID> 字符串。
//   - 取消必须调用 unwatch(request)，传入相同的 type/domain（plugin 内部按 type+domain
//     去重对应一个 ANNOUNCEMENT 监听器，多次 watch 同 type 不会重复广播）。

interface ZeroconfWatchRequest {
  type: string;
  domain: string;
}
interface ZeroconfPluginShape {
  watch(
    request: ZeroconfWatchRequest,
    callback: (result: any) => void,
  ): Promise<string>;
  unwatch(request: ZeroconfWatchRequest): Promise<void>;
  close?(): Promise<void>;
}

const ZEROCONF_TYPE = "_nowen-note._tcp.";
const ZEROCONF_DOMAIN = "local.";

class CapacitorDiscovery implements LanDiscovery {
  private plugin: ZeroconfPluginShape | null = null;
  private services = new Map<string, DiscoveredService>();
  private listeners = new Set<(list: DiscoveredService[]) => void>();
  private starting: Promise<StartResult> | null = null;
  private stopping: Promise<void> | null = null;
  private started = false;

  isAvailable() {
    // 只判定原生平台；插件加载失败会在 start() 中降级
    return Capacitor.isNativePlatform();
  }

  private async loadPlugin(): Promise<ZeroconfPluginShape | null> {
    if (this.plugin) return this.plugin;
    try {
      // 保留动态加载，但必须让 Vite 打包插件，原生 WebView 无法解析裸模块路径。
      const mod: any = await import("@mhaberler/capacitor-zeroconf-nsd");
      // 该插件命名导出 ZeroConf（C 大写）
      const plugin = mod.ZeroConf || mod.Zeroconf || mod.default || mod;
      if (!plugin || typeof plugin.watch !== "function") {
        console.warn("[lanDiscovery] zeroconf plugin shape unexpected:", Object.keys(mod || {}));
        return null;
      }
      this.plugin = plugin as ZeroconfPluginShape;
      return this.plugin;
    } catch (e) {
      console.warn("[lanDiscovery] zeroconf plugin load failed:", e);
      return null;
    }
  }

  private snapshot(): DiscoveredService[] {
    return Array.from(this.services.values()).sort(
      (a, b) => (b.lastSeen || 0) - (a.lastSeen || 0),
    );
  }

  private broadcast() {
    const list = this.snapshot();
    for (const cb of this.listeners) {
      try {
        cb(list);
      } catch {
        /* ignore listener error */
      }
    }
  }

  private handleEvent = (result: any) => {
    if (!result || !result.service) return;
    const svc = result.service;
    const name: string = svc.name || svc.fullName || "";
    if (!name) return;
    const action: string = result.action || "";

    if (action === "removed") {
      if (this.services.delete(name)) this.broadcast();
      return;
    }

    // added / resolved 都按"upsert"处理；resolved 才有完整 IP，
    // 但 added 也先入库，列表里至少能看到一条。
    const v4: string[] = svc.ipv4Addresses || [];
    const v6: string[] = svc.ipv6Addresses || [];
    const addresses = sortV4First([...v4, ...v6]);
    const next: DiscoveredService = {
      name,
      host: (svc.hostname || "").replace(/\.$/, ""),
      port: Number(svc.port) || 0,
      addresses,
      ipv4: pickV4(addresses),
      txt: (svc.txtRecord || {}) as Record<string, string>,
      lastSeen: Date.now(),
    };

    // resolved 事件相比 added 更新；如果 resolved 没拿到 IP（极少），
    // 不要拿空地址覆盖之前 added 时已有的内容
    const prev = this.services.get(name);
    if (prev && next.addresses.length === 0 && prev.addresses.length > 0) {
      next.addresses = prev.addresses;
      next.ipv4 = prev.ipv4;
      if (!next.host) next.host = prev.host;
    }

    this.services.set(name, next);
    this.broadcast();
  };

  async start(): Promise<StartResult> {
    if (!this.isAvailable()) return { ok: false, available: false };
    if (this.stopping) await this.stopping;
    if (this.started) return { ok: true, available: true };
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const plugin = await this.loadPlugin();
      if (!plugin) {
        this.starting = null;
        return { ok: false, available: false };
      }
      try {
        await plugin.watch(
          { type: ZEROCONF_TYPE, domain: ZEROCONF_DOMAIN },
          this.handleEvent,
        );
        this.started = true;
        // 订阅后立即推一次快照（即使是空），让 UI 能从"未订阅"切到"扫描中"。
        this.broadcast();
        return { ok: true, available: true };
      } catch (err) {
        console.warn("[lanDiscovery] zeroconf watch failed:", err);
        this.starting = null;
        return { ok: false, available: false };
      } finally {
        this.starting = null;
      }
    })();

    return this.starting;
  }

  async stop(): Promise<void> {
    if (this.starting) await this.starting;
    if (this.stopping) return this.stopping;
    if (!this.started) {
      this.services.clear();
      return;
    }
    this.started = false;
    this.stopping = (async () => {
      try {
        if (this.plugin) {
          await this.plugin.unwatch({ type: ZEROCONF_TYPE, domain: ZEROCONF_DOMAIN });
        }
      } catch (e) {
        console.warn("[lanDiscovery] zeroconf stop failed:", e);
      } finally {
        this.services.clear();
        this.broadcast();
        this.stopping = null;
      }
    })();
    return this.stopping;
  }

  onUpdate(cb: (list: DiscoveredService[]) => void): () => void {
    this.listeners.add(cb);
    // 立即推一次（包括首次订阅时的空数组），避免 UI 卡在 "available=null" 状态
    try {
      cb(this.snapshot());
    } catch {
      /* ignore */
    }
    return () => {
      this.listeners.delete(cb);
      // 没人订阅了就停（省电）。这里不 await：解订阅是同步的。
      void (async () => {
        if (this.starting) await this.starting;
        if (this.listeners.size === 0) await this.stop();
      })().catch(() => {});
    };
  }
}

// ============================================================================
// 实现 3：Web —— 不可用兜底，统一接口避免上层 if/else 判平台
// ============================================================================

class UnavailableDiscovery implements LanDiscovery {
  isAvailable() {
    return false;
  }
  async start(): Promise<StartResult> {
    return { ok: false, available: false };
  }
  async stop(): Promise<void> {
    /* no-op */
  }
  onUpdate(cb: (list: DiscoveredService[]) => void): () => void {
    // 立即推一次空，让面板可以切到"不支持"状态而不是无限 loading
    try {
      cb([]);
    } catch {
      /* ignore */
    }
    return () => {};
  }
}

// ============================================================================
// 工厂：按当前运行环境返回单例
// ============================================================================

let singleton: LanDiscovery | null = null;

export function getLanDiscovery(): LanDiscovery {
  if (singleton) return singleton;
  // Electron 桌面端优先（已有完整实现 + 在 main 进程就开始扫了，体验最好）
  const electron = getElectronBridge();
  if (electron) {
    singleton = new ElectronDiscovery(electron);
    return singleton;
  }
  // Capacitor 原生（Android / iOS）
  if (Capacitor.isNativePlatform()) {
    singleton = new CapacitorDiscovery();
    return singleton;
  }
  // 普通浏览器
  singleton = new UnavailableDiscovery();
  return singleton;
}
