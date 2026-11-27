// 桌面热更新的状态机（壳代码，永不热更新）。
//
// 启动时决定这次运行哪个包（试运行中的新包 / 已验证可用的包 / 安装包自带的版本），
// 校验包内每个文件；新包在规定时间内没有被界面确认就绪、或主进程加载失败，就屏蔽它并退回。
// 下载、验签、解压、暂存也在这里完成，热更新层的 main.js 只负责界面和就绪信号。
// 所有外部能力都可注入，单测不依赖 Electron。说明见 docs/architecture/hot-update.md。
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const trust = require("./trust");
const { readZip } = require("./zip-reader");

const ENVELOPE_FILE = ".nowen-hot-update.json";
// 包里的后端没有自带依赖：启动前由壳建一个指向安装目录 backend/node_modules 的链接，
// CJS、ESM（import("sharp") 等）和子进程都能像在安装目录里一样解析（NODE_PATH 管不到 ESM）。
const BACKEND_MODULES_LINK = "backend/node_modules";
const MAX_TRIAL_ATTEMPTS = 2;
const DEFAULT_READY_TIMEOUT_MS = 180_000;
const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_BLOCKED = 50;

const DISABLED_MESSAGES = {
  "development-build": "开发环境不启用热更新",
  "microsoft-store-managed": "商店版由 Microsoft Store 管理更新",
  "no-runtime": "这个安装包不支持热更新",
  "no-public-key": "这个安装包没有配置热更新公钥",
  "invalid-public-key": "安装包里的热更新公钥无效",
  "loader-error": "热更新加载器出错，已使用安装包自带的版本",
};

function freshState(runtimeVersion) {
  return {
    schema: 1,
    runtimeVersion,
    maxSequence: 0,
    lastCheckAt: null,
    autoDownload: true,
    active: null,
    pending: null,
    trial: null,
    blocked: [],
    lastRollback: null,
  };
}

function entryOf(value) {
  return value && typeof value.bundleId === "string" && typeof value.version === "string"
    ? { bundleId: value.bundleId, version: value.version }
    : null;
}

function describeError(error) {
  return (error instanceof Error && error.message ? error.message : String(error || "未知错误")).slice(0, 300);
}

/** 递归列出目录里的常规文件（posix 相对路径，已排序）；除壳自己建的依赖链接外，遇到符号链接或其他类型直接报错。 */
function listFiles(root) {
  const files = [];
  const visit = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (rel === BACKEND_MODULES_LINK && entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), rel);
      else if (entry.isFile()) files.push(rel);
      else throw new Error(`热更新包里有非常规文件：${rel}`);
    }
  };
  visit(root, "");
  return files.sort();
}

/** 删除包目录：先单独删掉指向安装目录的依赖链接，再删目录，绝不会递归进安装目录。 */
function removeBundleDir(root) {
  const link = path.join(root, ...BACKEND_MODULES_LINK.split("/"));
  try {
    if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  } catch {
    /* 没有链接 */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

function createHotUpdateRuntime(options) {
  const {
    shellDir,
    stateDir,
    shellVersion,
    anchors,
    channel,
    backendModulesDir = null,
    fetch,
    relaunch,
    backupDatabase = () => undefined,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    log = () => undefined,
  } = options;
  let disabledReason = options.disabledReason || null;
  // 主进程加载后换成它自己的重启方式（先停后端再退出），见 setRelaunch。
  let relaunchNow = relaunch;
  let key = null;
  if (!disabledReason) {
    try {
      key = trust.loadTrustedKey(anchors.publicKeyPem, anchors.keyId);
    } catch (error) {
      disabledReason = "invalid-public-key";
      log(`[hot-update] ${describeError(error)}，热更新已停用`);
    }
  }
  const bundlesDir = path.join(stateDir, "bundles");
  const stateFile = path.join(stateDir, "state.json");
  const listeners = new Set();
  let state = freshState(anchors?.runtimeVersion ?? null);
  let current = null;
  let isTrial = false;
  let readyConfirmed = false;
  let readyTimer = null;
  let restartRequired = false;
  let inflight = null;
  let phase = disabledReason ? "disabled" : "idle";
  let message = disabledReason ? DISABLED_MESSAGES[disabledReason] || "热更新未启用" : "";

  const trustInfo = () => ({ key, keyId: anchors.keyId, allowedOrigins: channel.allowedOrigins });
  const bundleRoot = (bundleId) => path.join(bundlesDir, bundleId);
  const effectiveVersion = () => current?.version ?? shellVersion;

  const readState = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (parsed?.schema !== 1 || parsed.runtimeVersion !== anchors.runtimeVersion) return null;
      return {
        ...freshState(anchors.runtimeVersion),
        maxSequence: Number.isSafeInteger(parsed.maxSequence) ? parsed.maxSequence : 0,
        lastCheckAt: Number.isFinite(parsed.lastCheckAt) ? parsed.lastCheckAt : null,
        autoDownload: parsed.autoDownload !== false,
        active: entryOf(parsed.active),
        pending: entryOf(parsed.pending),
        trial: entryOf(parsed.trial) ? { ...entryOf(parsed.trial), attempts: Number(parsed.trial.attempts) || 0 } : null,
        blocked: Array.isArray(parsed.blocked) ? parsed.blocked.filter((id) => typeof id === "string").slice(-MAX_BLOCKED) : [],
        lastRollback: parsed.lastRollback && typeof parsed.lastRollback.bundleId === "string" ? parsed.lastRollback : null,
      };
    } catch {
      return null;
    }
  };
  const writeState = () => {
    fs.mkdirSync(stateDir, { recursive: true });
    const temporary = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(temporary, stateFile);
  };
  const block = (bundleId) => {
    state.blocked = [...state.blocked.filter((id) => id !== bundleId), bundleId].slice(-MAX_BLOCKED);
  };

  const getStatus = () => ({
    enabled: !disabledReason,
    disabledReason,
    shellVersion,
    runtimeVersion: anchors?.runtimeVersion ?? null,
    effectiveVersion: effectiveVersion(),
    bundleId: current?.bundleId ?? null,
    trial: isTrial && !readyConfirmed,
    pending: state.pending,
    restartRequired,
    phase,
    message,
    lastCheckAt: state.lastCheckAt,
    autoDownload: state.autoDownload,
    lastRollback: state.lastRollback,
  });
  const emit = () => {
    const snapshot = getStatus();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        /* 界面监听出错不影响状态机 */
      }
    }
    return snapshot;
  };
  const setStatus = (nextPhase, nextMessage) => {
    phase = nextPhase;
    message = nextMessage;
    return emit();
  };

  /** 校验已解压的包：签名清单、壳指纹，以及每个文件的 SHA-256 与清单逐一相等。 */
  const verifyBundle = (entry) => {
    try {
      const root = bundleRoot(entry.bundleId);
      const manifest = trust.openEnvelope(fs.readFileSync(path.join(root, ENVELOPE_FILE)), trustInfo());
      if (manifest.bundleId !== entry.bundleId || manifest.target !== "desktop" || manifest.runtimeVersion !== anchors.runtimeVersion) {
        throw new Error("清单与当前安装包不匹配");
      }
      const files = listFiles(root).filter((file) => file !== ENVELOPE_FILE);
      const expected = Object.keys(manifest.files).sort();
      if (files.length !== expected.length || files.some((file, index) => file !== expected[index])) throw new Error("文件列表与清单不一致");
      for (const file of expected) {
        if (trust.sha256Hex(fs.readFileSync(path.join(root, ...file.split("/")))) !== manifest.files[file]) throw new Error(`文件被改动：${file}`);
      }
      return manifest;
    } catch (error) {
      log(`[hot-update] 包 ${entry.bundleId} 校验失败：${describeError(error)}`);
      return null;
    }
  };

  const rollback = (entry, reason) => {
    block(entry.bundleId);
    if (state.trial?.bundleId === entry.bundleId) state.trial = null;
    if (state.active?.bundleId === entry.bundleId) state.active = null;
    if (state.pending?.bundleId === entry.bundleId) state.pending = null;
    state.lastRollback = { bundleId: entry.bundleId, version: entry.version, reason, at: now() };
    writeState();
    log(`[hot-update] 已屏蔽 ${entry.bundleId}：${reason}`);
  };

  const removeBundles = (keep) => {
    let names = [];
    try {
      names = fs.readdirSync(bundlesDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!keep.has(name)) removeBundleDir(path.join(bundlesDir, name));
    }
  };
  const prune = () => removeBundles(new Set([state.active?.bundleId, state.pending?.bundleId, state.trial?.bundleId, current?.bundleId].filter(Boolean)));

  /** 让包里的后端解析安装目录的依赖；安装目录变了（如 AppImage 每次挂载的位置不同）就重建链接。 */
  const linkBackendModules = (root) => {
    if (!backendModulesDir) return;
    const target = fs.realpathSync(backendModulesDir);
    const link = path.join(root, ...BACKEND_MODULES_LINK.split("/"));
    let existing = null;
    try {
      existing = fs.lstatSync(link);
    } catch {
      /* 还没有链接 */
    }
    if (existing) {
      if (!existing.isSymbolicLink()) throw new Error("包里不应自带 backend/node_modules");
      let resolved = null;
      try {
        resolved = fs.realpathSync(link);
      } catch {
        /* 旧链接指向的目录已不存在 */
      }
      if (resolved === target) return;
      fs.unlinkSync(link);
    }
    // Windows 用目录联接，不需要管理员权限；其他系统忽略这个参数。
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  };

  /** 启动前准备一个包：校验文件，再接上后端依赖。返回失败原因，成功返回 null。 */
  const prepare = (entry) => {
    if (!verifyBundle(entry)) return "文件校验失败";
    try {
      linkBackendModules(bundleRoot(entry.bundleId));
      return null;
    } catch (error) {
      log(`[hot-update] 包 ${entry.bundleId} 无法使用安装目录里的后端依赖：${describeError(error)}`);
      return "无法使用安装目录里的后端依赖";
    }
  };

  /** 启动时调用一次：决定这次运行哪个包。任何异常都退回安装包自带的版本。 */
  const selectBoot = () => {
    if (disabledReason) return null;
    const loaded = readState();
    if (!loaded) {
      // 首次运行，或者装了新的安装包（壳指纹变了）：旧包全部作废。
      removeBundles(new Set());
      state = freshState(anchors.runtimeVersion);
    } else {
      state = loaded;
    }
    // 即使壳指纹没变，如果用户装了更新（或同版本）的完整安装包，也不能让旧热更新包继续盖住新安装包。
    const isSupersededByShell = (entry) => Boolean(entry && trust.compareVersions(entry.version, shellVersion) <= 0);
    let superseded = false;
    if (isSupersededByShell(state.pending)) {
      state.pending = null;
      superseded = true;
    }
    if (isSupersededByShell(state.trial)) {
      state.trial = null;
      superseded = true;
    }
    if (isSupersededByShell(state.active)) {
      state.active = null;
      superseded = true;
    }
    if (isSupersededByShell(state.lastRollback)) {
      state.lastRollback = null;
      superseded = true;
    }
    if (superseded) {
      log(`[hot-update] 安装包 v${shellVersion} 已不低于旧热更新包，清理过期热更新`);
    }
    let candidate = null;
    let firstBoot = false;
    const fromVersion = state.active?.version ?? shellVersion;
    if (state.trial) {
      if (state.trial.attempts >= MAX_TRIAL_ATTEMPTS) {
        rollback(state.trial, `连续 ${MAX_TRIAL_ATTEMPTS} 次启动都没有完成`);
      } else {
        state.trial.attempts += 1;
        candidate = state.trial;
        isTrial = true;
      }
    } else if (state.pending) {
      state.trial = { ...state.pending, attempts: 1 };
      state.pending = null;
      candidate = state.trial;
      isTrial = true;
      firstBoot = true;
    }
    const problem = candidate && prepare(candidate);
    if (problem) {
      rollback(candidate, problem);
      candidate = null;
      isTrial = false;
    }
    if (!candidate && state.active && !state.blocked.includes(state.active.bundleId)) {
      const activeProblem = prepare(state.active);
      if (activeProblem) rollback(state.active, activeProblem);
      else candidate = state.active;
    }
    current = candidate ? { bundleId: candidate.bundleId, version: candidate.version, root: bundleRoot(candidate.bundleId) } : null;
    writeState();
    if (superseded) prune();
    if (firstBoot && current) {
      // 新包第一次启动前备份数据库：它的后端可能会升级表结构（DCC-013）。
      try {
        backupDatabase({ fromVersion, toVersion: current.version });
      } catch (error) {
        log(`[hot-update] 启动新包前备份失败：${describeError(error)}`);
      }
    }
    if (isTrial) {
      readyTimer = setTimer(() => {
        if (readyConfirmed || !current) return;
        rollback(current, "启动超时，界面没有完成加载");
        relaunchNow();
      }, readyTimeoutMs);
      readyTimer?.unref?.();
    }
    if (current) log(`[hot-update] 本次运行 ${current.bundleId}${isTrial ? `（试运行第 ${state.trial.attempts} 次）` : ""}`);
    return current;
  };

  /** 加载 bootstrap 之后的入口；热更新包的主进程代码在加载阶段出错时屏蔽它并重启。 */
  const loadEntry = (load) => {
    const electronDir = current ? path.join(current.root, "electron") : shellDir;
    try {
      load(electronDir);
    } catch (error) {
      if (!current) throw error;
      log(`[hot-update] ${current.bundleId} 主进程加载失败：${describeError(error)}`);
      rollback(current, "主进程启动失败");
      relaunchNow();
    }
  };

  const markReady = () => {
    if (readyConfirmed) return getStatus();
    readyConfirmed = true;
    if (readyTimer) clearTimer(readyTimer);
    if (current && isTrial && !disabledReason) {
      state.active = { bundleId: current.bundleId, version: current.version };
      state.trial = null;
      writeState();
      prune();
      log(`[hot-update] ${current.bundleId} 已确认可用`);
    }
    return emit();
  };

  /** 启动因网络、远端服务、用户取消等原因失败：这次不算新包的失败次数。 */
  const reportEnvironmentFailure = (reason) => {
    if (readyTimer) clearTimer(readyTimer);
    if (isTrial && state.trial && !disabledReason) {
      state.trial.attempts = Math.max(0, state.trial.attempts - 1);
      writeState();
      log(`[hot-update] 启动失败与新包无关（${reason}），不计入试运行次数`);
    }
  };

  /** 依次请求渠道地址；全部 404 表示这个安装包暂无热更新，返回 null。 */
  const fetchEnvelope = async () => {
    const urls = channel.urls(anchors.runtimeVersion);
    let notFound = 0;
    let lastError = null;
    for (const url of urls) {
      try {
        const target = new URL(url);
        target.searchParams.set("t", String(Math.floor(now() / 3_600_000)));
        const response = await fetch(target.toString());
        if (response.status === 404) {
          notFound += 1;
          continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
      } catch (error) {
        lastError = error;
      }
    }
    if (notFound === urls.length) return null;
    throw lastError || new Error("无法获取更新信息");
  };

  const downloadZip = async (manifest) => {
    let lastError = null;
    for (const url of manifest.urls) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const zip = Buffer.from(await response.arrayBuffer());
        if (zip.length !== manifest.size || trust.sha256Hex(zip) !== manifest.sha256) throw new Error("下载的文件大小或摘要不符");
        if (!trust.verifyBytes(key, zip, manifest.zipSignature)) throw new Error("下载的文件签名校验失败");
        return zip;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("下载失败");
  };

  /** 下载并解压到 bundles/<bundleId>；写盘前、写盘后各校验一次。 */
  const stage = async (manifest, envelope) => {
    const root = bundleRoot(manifest.bundleId);
    if (fs.existsSync(root) && verifyBundle({ bundleId: manifest.bundleId })) return;
    removeBundleDir(root);
    const entries = readZip(await downloadZip(manifest));
    const expected = Object.keys(manifest.files).sort();
    const actual = entries.map((entry) => entry.path).sort();
    if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) throw new Error("zip 内容与清单不一致");
    for (const entry of entries) {
      if (trust.sha256Hex(entry.data) !== manifest.files[entry.path]) throw new Error(`zip 内文件摘要不符：${entry.path}`);
    }
    const partial = `${root}.partial`;
    fs.rmSync(partial, { recursive: true, force: true });
    for (const entry of entries) {
      const target = path.join(partial, ...entry.path.split("/"));
      if (!target.startsWith(partial + path.sep)) throw new Error(`zip 条目路径不安全：${entry.path}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.data);
    }
    fs.writeFileSync(path.join(partial, ENVELOPE_FILE), envelope);
    fs.renameSync(partial, root);
    if (!verifyBundle({ bundleId: manifest.bundleId })) {
      removeBundleDir(root);
      throw new Error("解压后的文件校验失败");
    }
  };

  const runCheck = async ({ manual, retryBlocked }) => {
    if (disabledReason) return setStatus("disabled", DISABLED_MESSAGES[disabledReason] || "热更新未启用");
    if (!manual && !state.autoDownload) return getStatus();
    // 新包还在试运行时不叠加下一次更新，等它被确认可用。
    if (!manual && isTrial && !readyConfirmed) return getStatus();
    setStatus("checking", "正在检查更新…");
    try {
      const envelope = await fetchEnvelope();
      const checkedAt = now();
      if (!envelope) {
        state.lastCheckAt = checkedAt;
        writeState();
        return setStatus("up-to-date", "当前安装包暂无可用的热更新");
      }
      const manifest = trust.openEnvelope(envelope, trustInfo());
      if (retryBlocked) state.blocked = [];
      const decision = trust.decide({
        manifest,
        runtimeVersion: anchors.runtimeVersion,
        currentVersion: effectiveVersion(),
        maxSequence: state.maxSequence,
        blockedBundleIds: state.blocked,
        pendingBundleId: state.pending?.bundleId ?? null,
      });
      state.maxSequence = Math.max(state.maxSequence, manifest.sequence);
      state.lastCheckAt = checkedAt;
      writeState();
      if (decision.action === "skip") {
        if (current && manifest.revokedBundleIds.includes(current.bundleId)) {
          rollback(current, "版本已撤回");
          restartRequired = true;
          return setStatus("ready", "当前版本已被撤回，重启后恢复为可用的版本");
        }
        return setStatus("up-to-date", trust.describeSkip(decision.reason));
      }
      setStatus("downloading", `正在下载 v${manifest.version}…`);
      await stage(manifest, envelope);
      state.pending = { bundleId: manifest.bundleId, version: manifest.version };
      writeState();
      prune();
      restartRequired = true;
      return setStatus("ready", `新版本 v${manifest.version} 已下载，重启应用后生效`);
    } catch (error) {
      return setStatus("error", `检查更新失败：${describeError(error)}`);
    }
  };

  const api = {
    get bundle() {
      return current ? { ...current } : null;
    },
    get effectiveVersion() {
      return effectiveVersion();
    },
    /** 正在运行的版本已不低于 version：整包更新检查据此不再误报。 */
    covers(version) {
      return trust.compareVersions(effectiveVersion(), version) >= 0;
    },
    getStatus,
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check({ manual = false, retryBlocked = false } = {}) {
      inflight ??= runCheck({ manual, retryBlocked }).finally(() => {
        inflight = null;
      });
      return inflight;
    },
    apply() {
      if (!restartRequired && !state.pending) return false;
      relaunchNow();
      return true;
    },
    /** 主进程注册自己的重启：app.exit 不触发 before-quit，必须先停掉后端，否则旧后端会继续占着数据库。 */
    setRelaunch(handler) {
      if (typeof handler === "function") relaunchNow = handler;
    },
    markReady,
    reportEnvironmentFailure,
    setAutoDownload(enabled) {
      if (disabledReason) return getStatus();
      state.autoDownload = enabled !== false;
      writeState();
      return emit();
    },
    startScheduler() {
      if (disabledReason) return () => undefined;
      let timer = null;
      const run = (delay) => {
        timer = setTimer(() => {
          void api.check().finally(() => run(CHECK_INTERVAL_MS));
        }, delay);
        timer?.unref?.();
      };
      run(FIRST_CHECK_DELAY_MS);
      return () => clearTimer(timer);
    },
  };

  return { api, selectBoot, loadEntry, get bundle() { return current; } };
}

module.exports = { BACKEND_MODULES_LINK, ENVELOPE_FILE, MAX_TRIAL_ATTEMPTS, createHotUpdateRuntime, listFiles };
