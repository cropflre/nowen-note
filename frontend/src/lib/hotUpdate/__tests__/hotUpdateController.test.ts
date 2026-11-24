// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHotUpdateController, HotUpdateHttpError, type HotUpdateEnvironment, type LiveUpdateBridge } from "../controller";
import { createSigningKey, manifestFor, PRODUCTION_ORIGINS, RUNTIME, sealEnvelope } from "./signingFixtures";

const key = createSigningKey();
const other = createSigningKey();
const R2 = `https://download.nowen.cn/hot/stable/android/${RUNTIME}.json`;
const GITHUB = `https://github.com/cropflre/nowen-note/releases/latest/download/nowen-hot-android-${RUNTIME}.json`;

function setup(options: { supported?: boolean; connection?: string; currentVersion?: string; publicKey?: string; storage?: Map<string, string> } = {}) {
  const storage = options.storage ?? new Map<string, string>();
  const live = {
    current: null as string | null,
    next: null as string | null,
    bundles: new Set<string>(),
    blocked: [] as string[],
    readyResult: { currentBundleId: null as string | null, previousBundleId: null as string | null, rollback: false },
    downloads: [] as Array<{ url: string; bundleId: string; signature: string; artifactType: string }>,
    failingUrls: new Set<string>(),
    resets: 0,
    reloads: 0,
  };
  const bridge: LiveUpdateBridge = {
    ready: async () => live.readyResult,
    getCurrentBundle: async () => ({ bundleId: live.current }),
    getNextBundle: async () => ({ bundleId: live.next }),
    getBundles: async () => ({ bundleIds: [...live.bundles] }),
    getBlockedBundles: async () => ({ bundleIds: live.blocked }),
    clearBlockedBundles: async () => {
      live.blocked = [];
    },
    downloadBundle: async (download) => {
      live.downloads.push(download);
      if (live.failingUrls.has(download.url)) throw new Error("ERROR_SIGNATURE_VERIFICATION_FAILED");
      live.bundles.add(download.bundleId);
    },
    setNextBundle: async ({ bundleId }) => {
      live.next = bundleId;
    },
    reload: async () => {
      live.reloads += 1;
    },
    reset: async () => {
      live.resets += 1;
      live.next = null;
    },
  };
  const responses = new Map<string, string | number>();
  const fetched: string[] = [];
  const notices: Array<{ kind: string; message: string }> = [];
  const resumeListeners = new Set<() => void>();
  const clock = { now: 1_800_000_000_000 };
  const env: HotUpdateEnvironment = {
    isSupported: () => options.supported ?? true,
    runtime: async () => ({ runtimeVersion: RUNTIME, publicKey: options.publicKey ?? key.publicKeyPem, keyId: key.keyId, versionName: "1.6.2", versionCode: "10602" }),
    liveUpdate: async () => bridge,
    fetchText: async (url) => {
      fetched.push(url);
      const response = responses.get(url);
      if (response === undefined) throw new Error("network down");
      if (typeof response === "number") throw new HotUpdateHttpError(response);
      return response;
    },
    connectionType: async () => options.connection ?? "wifi",
    onResume: (listener) => {
      resumeListeners.add(listener);
      return () => resumeListeners.delete(listener);
    },
    notify: (kind, message) => notices.push({ kind, message }),
    storage: { getItem: (name) => storage.get(name) ?? null, setItem: (name, value) => void storage.set(name, value) },
    now: () => clock.now,
    wait: async () => undefined,
    currentVersion: options.currentVersion ?? "1.6.2",
    channel: { urls: () => [R2, GITHUB], allowedOrigins: PRODUCTION_ORIGINS },
  };
  const controller = createHotUpdateController(env);
  return { controller, live, responses, fetched, notices, storage, clock, resume: () => [...resumeListeners].forEach((listener) => listener()) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("检查与下载", () => {
  it("签名清单通过后下载、设为下次启动的版本，并记住等待重启的包", async () => {
    const t = setup();
    const manifest = manifestFor("1.6.3");
    t.responses.set(R2, sealEnvelope(manifest, key));
    const snapshot = await t.controller.check({ manual: true });
    expect(snapshot.phase).toBe("ready");
    expect(snapshot.pending).toEqual({ bundleId: manifest.bundleId, version: "1.6.3" });
    expect(t.live.next).toBe(manifest.bundleId);
    expect(t.live.downloads).toEqual([{ artifactType: "zip", bundleId: manifest.bundleId, url: manifest.urls[0], signature: manifest.zipSignature }]);
    expect(JSON.parse(t.storage.get("nowen-hot-update-state")!)).toMatchObject({ maxSequence: manifest.sequence, pending: { bundleId: manifest.bundleId } });
  });

  it("第一个下载地址失败时换下一个；R2 渠道不可用时用 GitHub 备用渠道", async () => {
    const t = setup();
    const manifest = manifestFor("1.6.3");
    t.responses.set(GITHUB, sealEnvelope(manifest, key));
    t.live.failingUrls.add(manifest.urls[0]);
    expect((await t.controller.check({ manual: true })).phase).toBe("ready");
    expect(t.fetched).toEqual([R2, GITHUB]);
    expect(t.live.downloads.map((item) => item.url)).toEqual(manifest.urls);
  });

  it("签名不对、所有下载地址都失败时报错，不会改动下次启动的版本", async () => {
    const t = setup();
    t.responses.set(R2, sealEnvelope(manifestFor("1.6.3"), other));
    const rejected = await t.controller.check({ manual: true });
    expect(rejected.phase).toBe("error");
    expect(rejected.message).toContain("没有安装包信任的签名");
    expect(t.live.downloads).toEqual([]);

    const manifest = manifestFor("1.6.3");
    t.responses.set(R2, sealEnvelope(manifest, key));
    for (const url of manifest.urls) t.live.failingUrls.add(url);
    const failed = await t.controller.check({ manual: true });
    expect(failed.phase).toBe("error");
    expect(failed.message).toContain("ERROR_SIGNATURE_VERIFICATION_FAILED");
    expect(t.live.next).toBeNull();
    expect(failed.pending).toBeNull();
  });

  it("两个渠道都 404 表示这个安装包暂无热更新", async () => {
    const t = setup();
    t.responses.set(R2, 404);
    t.responses.set(GITHUB, 404);
    const snapshot = await t.controller.check({ manual: true });
    expect(snapshot.phase).toBe("up-to-date");
    expect(snapshot.message).toContain("暂无可用的热更新");
  });

  it("见过更新的清单后，旧清单被重放也不会下载（防降级）", async () => {
    const storage = new Map<string, string>();
    const first = setup({ storage });
    first.responses.set(R2, sealEnvelope(manifestFor("1.6.4", { sequence: 300 }), key));
    expect((await first.controller.check({ manual: true })).phase).toBe("ready");

    const replay = setup({ storage });
    replay.responses.set(R2, sealEnvelope(manifestFor("1.6.3", { sequence: 200 }), key));
    const snapshot = await replay.controller.check({ manual: true });
    expect(snapshot.phase).toBe("up-to-date");
    expect(replay.live.downloads).toEqual([]);
  });

  it("插件屏蔽过的包、壳不同的包、不更高的版本都不下载", async () => {
    const blocked = setup();
    const manifest = manifestFor("1.6.3");
    blocked.live.blocked = [manifest.bundleId];
    blocked.responses.set(R2, sealEnvelope(manifest, key));
    expect((await blocked.controller.check({ manual: true })).message).toContain("跳过");

    const retried = setup();
    retried.live.blocked = [manifest.bundleId];
    retried.responses.set(R2, sealEnvelope(manifest, key));
    expect((await retried.controller.check({ manual: true, retryBlocked: true })).phase).toBe("ready");
    expect(retried.live.blocked).toEqual([]);

    const shell = setup();
    shell.responses.set(R2, sealEnvelope(manifestFor("1.6.3", { runtimeVersion: "e2-0123456789abcdef" }), key));
    expect((await shell.controller.check({ manual: true })).message).toContain("新的安装包");

    const same = setup({ currentVersion: "1.6.3" });
    same.responses.set(R2, sealEnvelope(manifestFor("1.6.3"), key));
    expect((await same.controller.check({ manual: true })).message).toBe("当前已是最新版本");
    for (const t of [blocked, shell, same]) expect(t.live.downloads).toEqual([]);
  });

  it("当前运行的包被撤回时，重启后退回安装包自带的版本", async () => {
    const t = setup({ currentVersion: "1.6.3" });
    const manifest = manifestFor("1.6.3");
    t.live.current = manifest.bundleId;
    t.responses.set(R2, sealEnvelope({ ...manifest, revokedBundleIds: [manifest.bundleId] }, key));
    const snapshot = await t.controller.check({ manual: true });
    expect(t.live.resets).toBe(1);
    expect(snapshot.phase).toBe("ready");
    expect(snapshot.pending).toEqual({ bundleId: null, version: "1.6.2" });
  });

  it("没有配置公钥或不是安卓时直接停用，不发任何请求", async () => {
    const noKey = setup({ publicKey: "" });
    expect((await noKey.controller.check({ manual: true })).phase).toBe("disabled");
    const ios = setup({ supported: false });
    expect((await ios.controller.check({ manual: true })).phase).toBe("unsupported");
    expect([...noKey.fetched, ...ios.fetched]).toEqual([]);
  });

  it("自动检查只在 Wi-Fi 且开关打开时进行；手动检查不受限制", async () => {
    const cellular = setup({ connection: "cellular" });
    cellular.responses.set(R2, sealEnvelope(manifestFor("1.6.3"), key));
    await cellular.controller.check();
    expect(cellular.fetched).toEqual([]);
    expect((await cellular.controller.check({ manual: true })).phase).toBe("ready");

    const off = setup();
    off.controller.setAutoDownload(false);
    await off.controller.check();
    expect(off.fetched).toEqual([]);
    expect(off.controller.getSnapshot().autoDownload).toBe(false);
  });

  it("同时触发的检查只发一次请求", async () => {
    const t = setup();
    t.responses.set(R2, sealEnvelope(manifestFor("1.6.3"), key));
    await Promise.all([t.controller.check({ manual: true }), t.controller.check({ manual: true })]);
    expect(t.fetched).toEqual([R2]);
  });
});

describe("启动确认与重启", () => {
  it("新包启动失败被回退时提示用户，并清掉等待中的记录", async () => {
    const t = setup({ storage: new Map([["nowen-hot-update-state", JSON.stringify({ maxSequence: 1, pending: { bundleId: "1.6.3-aaaaaaaa", version: "1.6.3" } })]]) });
    t.live.readyResult = { currentBundleId: null, previousBundleId: "1.6.3-aaaaaaaa", rollback: true };
    await t.controller.confirmReady();
    expect(t.notices).toEqual([{ kind: "error", message: "更新后启动失败，已恢复到安装包自带的版本" }]);
    expect(t.controller.getSnapshot().pending).toBeNull();
    expect(JSON.parse(t.storage.get("nowen-hot-update-state")!).pending).toBeNull();
  });

  it("等待中的包已经生效时清掉记录；还没重启时保持等待", async () => {
    const applied = setup();
    applied.storage.set("nowen-hot-update-state", JSON.stringify({ pending: { bundleId: "1.6.3-aaaaaaaa", version: "1.6.3" } }));
    const appliedFresh = setup({ storage: applied.storage });
    appliedFresh.live.readyResult = { currentBundleId: "1.6.3-aaaaaaaa", previousBundleId: null, rollback: false };
    await appliedFresh.controller.confirmReady();
    expect(appliedFresh.controller.getSnapshot()).toMatchObject({ pending: null, currentBundleId: "1.6.3-aaaaaaaa" });

    const waiting = setup({ storage: new Map([["nowen-hot-update-state", JSON.stringify({ pending: { bundleId: "1.6.3-aaaaaaaa", version: "1.6.3" } })]]) });
    waiting.live.next = "1.6.3-aaaaaaaa";
    await waiting.controller.confirmReady();
    expect(waiting.controller.getSnapshot()).toMatchObject({ phase: "ready", pending: { bundleId: "1.6.3-aaaaaaaa" } });
    // 每次启动只确认一次
    waiting.live.readyResult = { currentBundleId: null, previousBundleId: null, rollback: true };
    await waiting.controller.confirmReady();
    expect(waiting.notices).toEqual([]);
  });

  it("立即重启：有等待中的包才 reload", async () => {
    const t = setup();
    await t.controller.apply();
    expect(t.live.reloads).toBe(0);
    t.responses.set(R2, sealEnvelope(manifestFor("1.6.3"), key));
    await t.controller.check({ manual: true });
    await t.controller.apply();
    expect(t.live.reloads).toBe(1);
  });

  it("调度：启动 30 秒后检查，之后每 6 小时；回到前台距上次超过 1 小时才再查", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.responses.set(R2, 404);
    t.responses.set(GITHUB, 404);
    const stop = t.controller.startScheduler();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(t.fetched).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.fetched).toEqual([R2, GITHUB]);
    t.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fetched).toHaveLength(2);
    t.clock.now += 61 * 60 * 1000;
    t.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fetched).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(t.fetched).toHaveLength(6);
    stop();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(t.fetched).toHaveLength(6);
  });
});
