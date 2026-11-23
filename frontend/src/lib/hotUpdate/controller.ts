// 安卓热更新调度：检查签名清单 → 判断 → 下载 → 下次启动生效，以及启动后的 ready() 确认。
//
// 所有平台相关能力都通过 HotUpdateEnvironment 注入，单测可以完整替换；
// 真实环境见 ./environment.ts。只有安卓启用，iOS、桌面、网页都不会调用插件。
import { openHotUpdateEnvelope } from "./envelope";
import { decideHotUpdate, describeSkip, isCurrentBundleRevoked } from "./policy";

export interface HotUpdateRuntimeInfo {
  runtimeVersion: string;
  publicKey: string;
  keyId: string;
  versionName: string | null;
  versionCode: string | null;
}

/** @capawesome/capacitor-live-update 里用到的那部分接口 */
export interface LiveUpdateBridge {
  ready(): Promise<{ currentBundleId: string | null; previousBundleId: string | null; rollback: boolean }>;
  getCurrentBundle(): Promise<{ bundleId: string | null }>;
  getNextBundle(): Promise<{ bundleId: string | null }>;
  getBundles(): Promise<{ bundleIds: string[] }>;
  getBlockedBundles(): Promise<{ bundleIds: string[] }>;
  clearBlockedBundles(): Promise<void>;
  downloadBundle(options: { artifactType: "zip"; bundleId: string; url: string; signature: string }): Promise<void>;
  setNextBundle(options: { bundleId: string | null }): Promise<void>;
  reload(): Promise<void>;
  reset(): Promise<void>;
}

export class HotUpdateHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "HotUpdateHttpError";
  }
}

export interface HotUpdateEnvironment {
  isSupported(): boolean;
  runtime(): Promise<HotUpdateRuntimeInfo | null>;
  liveUpdate(): Promise<LiveUpdateBridge>;
  /** 非 2xx 时抛 HotUpdateHttpError */
  fetchText(url: string): Promise<string>;
  connectionType(): Promise<string>;
  onResume(listener: () => void): () => void;
  notify(kind: "error" | "info", message: string): void;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  now(): number;
  wait(ms: number): Promise<void>;
  currentVersion: string;
  channel: { urls(runtimeVersion: string): string[]; allowedOrigins: readonly string[] };
}

export type HotUpdatePhase = "unsupported" | "disabled" | "idle" | "checking" | "downloading" | "ready" | "up-to-date" | "error";

export interface HotUpdatePending {
  /** null 表示重启后恢复为安装包自带的版本（当前包被撤回） */
  bundleId: string | null;
  version: string;
}

export interface HotUpdateSnapshot {
  phase: HotUpdatePhase;
  message: string;
  runtime: HotUpdateRuntimeInfo | null;
  currentVersion: string;
  /** null 表示正在运行安装包自带的版本 */
  currentBundleId: string | null;
  pending: HotUpdatePending | null;
  lastCheckAt: number | null;
  autoDownload: boolean;
}

interface PersistedState {
  maxSequence: number;
  lastCheckAt: number | null;
  pending: HotUpdatePending | null;
}

const STATE_KEY = "nowen-hot-update-state";
const AUTO_DOWNLOAD_KEY = "nowen-hot-update-auto-download";
const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RESUME_CHECK_AFTER_MS = 60 * 60 * 1000;
const RELOAD_GRACE_MS = 1500;

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 200);
  return "未知错误";
}

export function createHotUpdateController(env: HotUpdateEnvironment) {
  const listeners = new Set<() => void>();
  let runtimePromise: Promise<HotUpdateRuntimeInfo | null> | null = null;
  let inflight: Promise<HotUpdateSnapshot> | null = null;
  let readyConfirmed = false;

  const readState = (): PersistedState => {
    try {
      const parsed = JSON.parse(env.storage?.getItem(STATE_KEY) || "{}");
      const pending = parsed.pending && typeof parsed.pending.version === "string"
        ? { bundleId: typeof parsed.pending.bundleId === "string" ? parsed.pending.bundleId : null, version: parsed.pending.version }
        : null;
      return {
        maxSequence: Number.isSafeInteger(parsed.maxSequence) ? parsed.maxSequence : 0,
        lastCheckAt: Number.isFinite(parsed.lastCheckAt) ? parsed.lastCheckAt : null,
        pending,
      };
    } catch {
      return { maxSequence: 0, lastCheckAt: null, pending: null };
    }
  };
  const writeState = (patch: Partial<PersistedState>) => {
    try {
      env.storage?.setItem(STATE_KEY, JSON.stringify({ ...readState(), ...patch }));
    } catch {
      /* 存储不可用时只是失去去重和防重放记录，不影响安全性：签名和版本判断仍然生效 */
    }
  };
  const readAutoDownload = () => {
    try {
      return env.storage?.getItem(AUTO_DOWNLOAD_KEY) !== "0";
    } catch {
      return true;
    }
  };

  const initial = readState();
  let snapshot: HotUpdateSnapshot = {
    phase: env.isSupported() ? "idle" : "unsupported",
    message: "",
    runtime: null,
    currentVersion: env.currentVersion,
    currentBundleId: null,
    pending: initial.pending,
    lastCheckAt: initial.lastCheckAt,
    autoDownload: readAutoDownload(),
  };
  const set = (patch: Partial<HotUpdateSnapshot>): HotUpdateSnapshot => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
    return snapshot;
  };
  const loadRuntime = async () => {
    runtimePromise ??= env.runtime().catch(() => null);
    const runtime = await runtimePromise;
    if (runtime !== snapshot.runtime) set({ runtime });
    return runtime;
  };

  /** 依次请求渠道地址；全部 404 表示这个安装包暂无热更新，返回 null。 */
  const fetchEnvelope = async (runtimeVersion: string): Promise<string | null> => {
    const urls = env.channel.urls(runtimeVersion);
    let notFound = 0;
    let lastError: unknown = null;
    for (const url of urls) {
      try {
        return await env.fetchText(url);
      } catch (error) {
        if (error instanceof HotUpdateHttpError && error.status === 404) notFound += 1;
        else lastError = error;
      }
    }
    if (notFound === urls.length) return null;
    throw lastError ?? new Error("无法获取更新信息");
  };

  const runCheck = async (manual: boolean, retryBlocked: boolean): Promise<HotUpdateSnapshot> => {
    if (!env.isSupported()) return set({ phase: "unsupported", message: "当前平台不支持热更新" });
    const runtime = await loadRuntime();
    if (!runtime?.runtimeVersion) return set({ phase: "disabled", message: "这个安装包不支持热更新" });
    if (!runtime.publicKey || !runtime.keyId) return set({ phase: "disabled", message: "这个安装包没有配置热更新公钥" });
    if (!manual) {
      if (!readAutoDownload()) return snapshot;
      const type = await env.connectionType().catch(() => "unknown");
      // 自动下载只在 Wi-Fi 下进行；手动检查不受限制。
      if (type !== "wifi") return snapshot;
    }
    set({ phase: "checking", message: "正在检查更新…" });
    try {
      const text = await fetchEnvelope(runtime.runtimeVersion);
      const state = readState();
      const now = env.now();
      if (text === null) {
        writeState({ lastCheckAt: now });
        return set({ phase: "up-to-date", message: "当前安装包暂无可用的热更新", lastCheckAt: now });
      }
      const manifest = await openHotUpdateEnvelope(text, {
        publicKeyPem: runtime.publicKey,
        keyId: runtime.keyId,
        allowedOrigins: env.channel.allowedOrigins,
      });
      const liveUpdate = await env.liveUpdate();
      // 数据库保护页的重试：本地库已被新包升级时，被屏蔽的新包可能是唯一能打开数据的版本，允许用户主动再试。
      if (retryBlocked) await liveUpdate.clearBlockedBundles();
      const [current, blocked] = await Promise.all([liveUpdate.getCurrentBundle(), liveUpdate.getBlockedBundles()]);
      const decision = decideHotUpdate({
        manifest,
        target: "android",
        runtimeVersion: runtime.runtimeVersion,
        currentVersion: env.currentVersion,
        maxSequence: state.maxSequence,
        blockedBundleIds: blocked.bundleIds,
        pendingBundleId: state.pending?.bundleId ?? null,
      });
      writeState({ maxSequence: Math.max(state.maxSequence, manifest.sequence), lastCheckAt: now });
      set({ currentBundleId: current.bundleId, lastCheckAt: now });
      if (decision.action === "skip") {
        if (isCurrentBundleRevoked(manifest, current.bundleId)) {
          await liveUpdate.reset();
          const pending = { bundleId: null, version: runtime.versionName || "" };
          writeState({ pending });
          return set({ phase: "ready", pending, message: "当前版本已被撤回，重启后恢复为安装包自带的版本" });
        }
        return set({ phase: "up-to-date", message: describeSkip(decision.reason) });
      }
      set({ phase: "downloading", message: `正在下载 v${manifest.version}…` });
      const { bundleIds } = await liveUpdate.getBundles();
      if (!bundleIds.includes(manifest.bundleId)) {
        let downloadError: unknown = null;
        let downloaded = false;
        for (const url of manifest.urls) {
          try {
            // 插件用安装包里的公钥按 SHA256withRSA 校验 zip，签名不对会拒绝并报错。
            await liveUpdate.downloadBundle({ artifactType: "zip", bundleId: manifest.bundleId, url, signature: manifest.zipSignature });
            downloaded = true;
            break;
          } catch (error) {
            downloadError = error;
          }
        }
        if (!downloaded) throw downloadError ?? new Error("下载失败");
      }
      await liveUpdate.setNextBundle({ bundleId: manifest.bundleId });
      const pending = { bundleId: manifest.bundleId, version: manifest.version };
      writeState({ pending });
      return set({ phase: "ready", pending, message: `新版本 v${manifest.version} 已下载，重启应用后生效` });
    } catch (error) {
      return set({ phase: "error", message: `检查更新失败：${describeError(error)}` });
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * 每次启动都要调用：界面渲染完成、本地库正常打开之后确认这个包可用。
     * 不调用的话，插件会在 10 秒后退回安装包自带的版本并屏蔽这个包。
     */
    async confirmReady(): Promise<void> {
      if (!env.isSupported() || readyConfirmed) return;
      readyConfirmed = true;
      const liveUpdate = await env.liveUpdate();
      const result = await liveUpdate.ready();
      const state = readState();
      let pending = state.pending;
      if (result.rollback) {
        pending = null;
        env.notify("error", "更新后启动失败，已恢复到安装包自带的版本");
      } else if (pending && pending.bundleId === result.currentBundleId) {
        pending = null;
      } else if (pending) {
        const next = await liveUpdate.getNextBundle();
        if (next.bundleId !== pending.bundleId) pending = null;
      }
      if (pending !== state.pending) writeState({ pending });
      set({
        currentBundleId: result.currentBundleId,
        pending,
        phase: pending ? "ready" : snapshot.phase,
        message: pending ? `新版本 v${pending.version} 已下载，重启应用后生效` : snapshot.message,
      });
      void loadRuntime();
    },

    check({ manual = false, retryBlocked = false }: { manual?: boolean; retryBlocked?: boolean } = {}): Promise<HotUpdateSnapshot> {
      inflight ??= runCheck(manual, retryBlocked).finally(() => {
        inflight = null;
      });
      return inflight;
    },

    /** 立即重启以应用已下载的版本。给编辑器一点时间完成保存（离开页面时它也会同步写草稿）。 */
    async apply(): Promise<void> {
      if (!readState().pending) return;
      const active = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
      active?.blur?.();
      await env.wait(RELOAD_GRACE_MS);
      await (await env.liveUpdate()).reload();
    },

    setAutoDownload(enabled: boolean) {
      try {
        env.storage?.setItem(AUTO_DOWNLOAD_KEY, enabled ? "1" : "0");
      } catch {
        /* 存储不可用时本次会话仍按新值生效 */
      }
      set({ autoDownload: enabled });
    },

    /** 启动后约 30 秒检查一次，之后每 6 小时一次；回到前台时距上次检查超过 1 小时也检查。 */
    startScheduler(): () => void {
      if (!env.isSupported()) return () => undefined;
      const first = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
      const interval = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
      const removeResume = env.onResume(() => {
        const last = readState().lastCheckAt;
        if (last === null || env.now() - last > RESUME_CHECK_AFTER_MS) void this.check();
      });
      return () => {
        clearTimeout(first);
        clearInterval(interval);
        removeResume();
      };
    },
  };
}

export type HotUpdateController = ReturnType<typeof createHotUpdateController>;
