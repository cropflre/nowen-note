import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  buildReplacementCreatePayload,
  captureNetworkAttachments,
  createContainer,
  disconnectContainerNetworks,
  findManagedContainer,
  getContainerName,
  getDockerInfo,
  getUpdaterDiskStatus,
  imageRefForVersion,
  inspectContainer,
  inspectImage,
  normalizeArchitecture,
  pullImage,
  reconnectContainerNetworks,
  removeContainer,
  renameContainer,
  resolveDigest,
  startContainer,
  stopContainer,
  validateTargetVersion,
  type DockerContainerInspect,
  type DockerImageInspect,
  type SavedNetworkAttachment,
} from "./docker";

const STATE_DIR = path.resolve(process.env.NOWEN_UPDATER_STATE_DIR || "/var/lib/nowen-updater");
const JOBS_DIR = path.join(STATE_DIR, "jobs");
const APP_BASE_URL = (process.env.NOWEN_UPDATER_TARGET_URL || "http://nowen-note:3001").replace(/\/+$/, "");
const HEALTH_TIMEOUT_MS = Math.max(30_000, Number(process.env.NOWEN_UPDATER_HEALTH_TIMEOUT_MS) || 180_000);
const STABILITY_WINDOW_MS = Math.max(5_000, Number(process.env.NOWEN_UPDATER_STABILITY_WINDOW_MS) || 15_000);
const MIN_FREE_BYTES = Math.max(128 * 1024 * 1024, Number(process.env.NOWEN_UPDATER_MIN_FREE_BYTES) || 512 * 1024 * 1024);

export type UpdateJobPhase =
  | "queued"
  | "preparing_replacement"
  | "entering_maintenance"
  | "stopping_container"
  | "replacing_container"
  | "waiting_health"
  | "verifying_version"
  | "observing_stability"
  | "completed"
  | "cancelled"
  | "failed_before_replace"
  | "failed_after_replace"
  | "rolling_back_image"
  | "restoring_previous_container"
  | "verifying_rollback"
  | "rolled_back"
  | "rollback_failed"
  | "interrupted";

export type UpdateJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface UpdateLogEntry {
  at: string;
  phase: UpdateJobPhase;
  message: string;
  level: "info" | "warn" | "error";
}

export interface UpdateJob {
  id: string;
  status: UpdateJobStatus;
  phase: UpdateJobPhase;
  createdAt: string;
  updatedAt: string;
  targetVersion: string;
  targetImage: string;
  targetImageId: string;
  targetDigest: string | null;
  sourceVersion: string | null;
  sourceImage: string;
  sourceImageId: string;
  sourceDigest: string | null;
  oldContainerId: string | null;
  replacementContainerId: string | null;
  originalContainerName: string | null;
  rollbackContainerName: string | null;
  backup?: {
    filename: string;
    size: number;
    checksum: string;
    schemaVersion?: number | null;
  };
  rollbackMode: "image-only";
  rollbackDataSafe: false;
  cancelRequested: boolean;
  cancellable: boolean;
  error: string | null;
  rollbackError: string | null;
  logs: UpdateLogEntry[];
}

export interface UpdaterStatus {
  updaterVersion: string;
  instance: string;
  engine: {
    version: string | null;
    architecture: string | null;
    os: string | null;
    driver: string | null;
  };
  container: {
    id: string;
    name: string;
    state: string | null;
    image: string;
    imageId: string;
    digest: string | null;
    health: string | null;
  };
  activeJob: UpdateJob | null;
  recentJobs: UpdateJob[];
}

export interface UpdaterPreflight {
  ok: boolean;
  canApply: boolean;
  noOp: boolean;
  targetVersion: string;
  targetImage: string;
  targetImageId: string;
  targetDigest: string | null;
  currentImage: string;
  currentImageId: string;
  currentDigest: string | null;
  architecture: string;
  imageSize: number | null;
  disk: { freeBytes: number | null; totalBytes: number | null; minimumRequiredBytes: number; path: string };
  blockers: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
}

interface CreateJobInput {
  targetVersion: string;
  targetImageId: string;
  expectedCurrentImageId: string;
  backup?: UpdateJob["backup"];
}

const jobs = new Map<string, UpdateJob>();
let activeJobId: string | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function ensureStateDirs(): void {
  fs.mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
}

function jobPath(id: string): string {
  return path.join(JOBS_DIR, `${id}.json`);
}

function persistJob(job: UpdateJob): void {
  ensureStateDirs();
  job.updatedAt = nowIso();
  const target = jobPath(job.id);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(job, null, 2), { mode: 0o600 });
  fs.renameSync(temp, target);
  jobs.set(job.id, job);
}

function addLog(job: UpdateJob, message: string, level: UpdateLogEntry["level"] = "info"): void {
  job.logs.push({ at: nowIso(), phase: job.phase, message: message.slice(0, 1000), level });
  if (job.logs.length > 160) job.logs.splice(0, job.logs.length - 160);
  persistJob(job);
}

function setPhase(job: UpdateJob, phase: UpdateJobPhase, message?: string): void {
  job.phase = phase;
  job.status = ["completed"].includes(phase)
    ? "completed"
    : ["cancelled"].includes(phase)
      ? "cancelled"
      : ["failed_before_replace", "failed_after_replace", "rollback_failed", "interrupted"].includes(phase)
        ? "failed"
        : "running";
  job.cancellable = ["queued", "preparing_replacement", "entering_maintenance"].includes(phase);
  persistJob(job);
  if (message) addLog(job, message);
}

function publicJob(job: UpdateJob): UpdateJob {
  return JSON.parse(JSON.stringify(job)) as UpdateJob;
}

function loadJobs(): void {
  ensureStateDirs();
  const entries = fs.readdirSync(JOBS_DIR).filter((name) => name.endsWith(".json"));
  for (const name of entries) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, name), "utf8")) as UpdateJob;
      if (!parsed?.id) continue;
      const wasActive = parsed.status === "queued" || parsed.status === "running";
      if (wasActive) {
        parsed.status = "failed";
        parsed.phase = "interrupted";
        parsed.cancellable = false;
        parsed.error = "更新代理在任务执行期间重启；请检查受管容器状态后重新发起预检";
        parsed.logs = parsed.logs || [];
        parsed.logs.push({
          at: nowIso(),
          phase: "interrupted",
          level: "error",
          message: parsed.error,
        });
        persistJob(parsed);
      } else {
        jobs.set(parsed.id, parsed);
      }
    } catch (error) {
      console.warn("[updater] failed to load job state:", name, error);
    }
  }
}

loadJobs();

async function fetchJson<T>(url: string, timeoutMs = 8_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "nowen-note-updater" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function readApplicationVersion(): Promise<string | null> {
  try {
    const data = await fetchJson<{ appVersion?: string }>(`${APP_BASE_URL}/api/version`);
    return data.appVersion || null;
  } catch {
    return null;
  }
}

function getDigestSafe(image: DockerImageInspect): string | null {
  try {
    return resolveDigest(image);
  } catch {
    return null;
  }
}

export async function getUpdaterStatus(): Promise<UpdaterStatus> {
  const [engine, container] = await Promise.all([getDockerInfo(), findManagedContainer()]);
  const image = await inspectImage(container.Image);
  const recentJobs = Array.from(jobs.values())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5)
    .map(publicJob);
  const active = activeJobId ? jobs.get(activeJobId) || null : null;
  return {
    updaterVersion: process.env.NOWEN_APP_VERSION || "1",
    instance: process.env.NOWEN_UPDATER_INSTANCE || "nowen-note",
    engine: {
      version: engine.ServerVersion || null,
      architecture: normalizeArchitecture(engine.Architecture),
      os: engine.OperatingSystem || engine.OSType || null,
      driver: engine.Driver || null,
    },
    container: {
      id: container.Id,
      name: getContainerName(container),
      state: container.State.Status || null,
      image: container.Config.Image || "",
      imageId: container.Image,
      digest: getDigestSafe(image),
      health: container.State.Health?.Status || null,
    },
    activeJob: active ? publicJob(active) : null,
    recentJobs,
  };
}

export async function runUpdaterPreflight(targetVersionInput: unknown): Promise<UpdaterPreflight> {
  const targetVersion = validateTargetVersion(targetVersionInput);
  const targetImage = imageRefForVersion(targetVersion);
  const blockers: UpdaterPreflight["blockers"] = [];
  const warnings: UpdaterPreflight["warnings"] = [];

  const [engine, current] = await Promise.all([getDockerInfo(), findManagedContainer()]);
  if (!current.State.Running) {
    blockers.push({ code: "TARGET_NOT_RUNNING", message: "当前受管容器未处于运行状态" });
  }
  const networkMode = String(current.HostConfig.NetworkMode || "");
  if (networkMode.startsWith("container:")) {
    blockers.push({ code: "UNSUPPORTED_NETWORK_MODE", message: "container: 网络模式暂不支持在线重建" });
  }

  const disk = getUpdaterDiskStatus();
  if (disk.freeBytes !== null && disk.freeBytes < MIN_FREE_BYTES) {
    blockers.push({ code: "LOW_DISK_SPACE", message: `可用空间不足 ${Math.ceil(MIN_FREE_BYTES / 1024 / 1024)} MiB` });
  } else if (disk.freeBytes === null) {
    warnings.push({ code: "DISK_CAPACITY_UNKNOWN", message: "无法读取 Docker 数据盘可用容量，请手动确认磁盘空间" });
  }

  await pullImage(targetImage);
  const [currentImage, targetImageInspect] = await Promise.all([
    inspectImage(current.Image),
    inspectImage(targetImage),
  ]);
  const engineArch = normalizeArchitecture(engine.Architecture);
  const targetArch = normalizeArchitecture(targetImageInspect.Architecture);
  if (!engineArch || !["amd64", "arm64"].includes(engineArch)) {
    blockers.push({ code: "UNSUPPORTED_ARCH", message: `当前 Docker 架构不受支持：${engineArch || "unknown"}` });
  }
  if (engineArch && targetArch && engineArch !== targetArch) {
    blockers.push({ code: "IMAGE_ARCH_MISMATCH", message: `目标镜像架构 ${targetArch} 与宿主机 ${engineArch} 不匹配` });
  }
  if (!targetImageInspect.Config?.Healthcheck) {
    warnings.push({ code: "IMAGE_HEALTHCHECK_MISSING", message: "目标镜像未声明 Docker HEALTHCHECK，将依赖 HTTP 版本校验" });
  }

  const currentDigest = getDigestSafe(currentImage);
  const targetDigest = getDigestSafe(targetImageInspect);
  const noOp = current.Image === targetImageInspect.Id || (!!targetDigest && currentDigest === targetDigest);
  if (noOp) {
    warnings.push({ code: "ALREADY_TARGET_DIGEST", message: "当前实例已运行目标镜像 Digest，无需重复升级" });
  }

  return {
    ok: blockers.length === 0,
    canApply: blockers.length === 0 && !noOp,
    noOp,
    targetVersion,
    targetImage,
    targetImageId: targetImageInspect.Id,
    targetDigest,
    currentImage: current.Config.Image || "",
    currentImageId: current.Image,
    currentDigest,
    architecture: engineArch || targetArch || "unknown",
    imageSize: typeof targetImageInspect.Size === "number" ? targetImageInspect.Size : null,
    disk: { ...disk, minimumRequiredBytes: MIN_FREE_BYTES },
    blockers,
    warnings,
  };
}

export function getJob(id: string): UpdateJob | null {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

export function requestJobCancellation(id: string): UpdateJob {
  const job = jobs.get(id);
  if (!job) throw new Error("更新任务不存在");
  if (!job.cancellable || !["queued", "running"].includes(job.status)) {
    throw new Error("当前阶段无法安全取消更新");
  }
  job.cancelRequested = true;
  addLog(job, "管理员请求取消；将在进入容器替换前停止任务", "warn");
  return publicJob(job);
}

function assertNotCancelled(job: UpdateJob): void {
  if (!job.cancelRequested) return;
  setPhase(job, "cancelled", "更新任务已在替换容器前取消，旧容器未受影响");
  throw new CancelledError();
}

class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

async function waitForReplacement(job: UpdateJob, containerId: string): Promise<void> {
  const startedAt = Date.now();
  let stableSince = 0;
  while (Date.now() - startedAt < HEALTH_TIMEOUT_MS) {
    const inspect = await inspectContainer(containerId);
    const health = inspect.State.Health?.Status;
    if (!inspect.State.Running && !inspect.State.Restarting) {
      throw new Error(`新容器已退出（exit=${inspect.State.ExitCode ?? "?"}）：${inspect.State.Error || "unknown"}`);
    }
    if (health === "unhealthy") {
      throw new Error(`新容器健康检查失败（failingStreak=${inspect.State.Health?.FailingStreak || 0}）`);
    }

    let versionOk = false;
    try {
      const healthPayload = await fetchJson<{ status?: string }>(`${APP_BASE_URL}/api/health`, 5_000);
      const versionPayload = await fetchJson<{ appVersion?: string; schemaVersion?: number | null; codeSchemaVersion?: number | null }>(
        `${APP_BASE_URL}/api/version`,
        5_000,
      );
      versionOk = healthPayload.status === "ok" && versionPayload.appVersion === job.targetVersion;
      if (
        versionPayload.schemaVersion !== null &&
        versionPayload.codeSchemaVersion !== null &&
        versionPayload.schemaVersion !== versionPayload.codeSchemaVersion
      ) {
        throw new Error(`新容器数据库 Schema 未就绪：${versionPayload.schemaVersion}/${versionPayload.codeSchemaVersion}`);
      }
    } catch (error) {
      stableSince = 0;
      addLog(job, `等待新服务就绪：${error instanceof Error ? error.message : String(error)}`, "warn");
    }

    const dockerHealthy = health ? health === "healthy" : true;
    if (dockerHealthy && versionOk) {
      if (!stableSince) {
        stableSince = Date.now();
        setPhase(job, "observing_stability", `版本已验证为 v${job.targetVersion}，进入稳定观察窗口`);
      }
      if (Date.now() - stableSince >= STABILITY_WINDOW_MS) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`新容器在 ${Math.round(HEALTH_TIMEOUT_MS / 1000)} 秒内未通过健康与版本校验`);
}

async function waitForRollback(job: UpdateJob): Promise<void> {
  const deadline = Date.now() + Math.min(HEALTH_TIMEOUT_MS, 120_000);
  while (Date.now() < deadline) {
    try {
      const health = await fetchJson<{ status?: string }>(`${APP_BASE_URL}/api/health`, 5_000);
      const version = await fetchJson<{ appVersion?: string }>(`${APP_BASE_URL}/api/version`, 5_000);
      if (health.status === "ok" && (!job.sourceVersion || version.appVersion === job.sourceVersion)) return;
    } catch {
      // Keep polling while the previous container starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("旧容器已启动，但未在超时内恢复健康或版本校验不匹配");
}

async function rollback(
  job: UpdateJob,
  oldContainer: DockerContainerInspect,
  networks: SavedNetworkAttachment[],
): Promise<void> {
  setPhase(job, "rolling_back_image", "升级失败，开始执行旧镜像容器回滚");
  if (job.replacementContainerId) {
    try {
      await removeContainer(job.replacementContainerId, true);
      addLog(job, "已移除失败的新容器");
    } catch (error) {
      addLog(job, `移除新容器失败，将继续尝试恢复旧容器：${error instanceof Error ? error.message : String(error)}`, "warn");
    }
  }

  setPhase(job, "restoring_previous_container", "恢复旧容器名称、网络与启动状态");
  await renameContainer(oldContainer.Id, job.originalContainerName!);
  await reconnectContainerNetworks(oldContainer.Id, networks);
  await startContainer(oldContainer.Id);

  setPhase(job, "verifying_rollback", "验证旧容器健康状态与原版本");
  await waitForRollback(job);
  job.rollbackDataSafe = false;
  setPhase(job, "rolled_back", "旧镜像容器已恢复；升级前备份仍保留，未自动覆盖数据库数据");
  job.status = "failed";
  job.cancellable = false;
  persistJob(job);
}

async function executeJob(job: UpdateJob): Promise<void> {
  let oldContainer: DockerContainerInspect | null = null;
  let networks: SavedNetworkAttachment[] = [];
  let replacementStarted = false;
  try {
    setPhase(job, "preparing_replacement", "重新校验受管容器与目标镜像");
    assertNotCancelled(job);
    oldContainer = await findManagedContainer();
    if (oldContainer.Image !== job.sourceImageId) {
      throw new Error("当前容器镜像已变化，预检结果失效，请重新执行预检");
    }
    const [oldImage, targetImage] = await Promise.all([
      inspectImage(oldContainer.Image),
      inspectImage(job.targetImage),
    ]);
    if (targetImage.Id !== job.targetImageId) {
      throw new Error("目标镜像 ID 已变化，拒绝使用过期预检结果");
    }
    job.sourceVersion = await readApplicationVersion();
    job.oldContainerId = oldContainer.Id;
    job.originalContainerName = getContainerName(oldContainer);
    job.rollbackContainerName = `${job.originalContainerName}-rollback-${job.id.slice(0, 8)}`;
    networks = captureNetworkAttachments(oldContainer);
    persistJob(job);

    setPhase(job, "entering_maintenance", "即将短暂中断服务；旧容器会保留到新版本验证成功");
    assertNotCancelled(job);

    setPhase(job, "stopping_container", "停止旧容器并保留原始镜像回滚点");
    await stopContainer(oldContainer.Id, 30);
    await renameContainer(oldContainer.Id, job.rollbackContainerName);
    await disconnectContainerNetworks(oldContainer.Id, networks);
    replacementStarted = true;

    setPhase(job, "replacing_container", "按原端口、卷、环境、网络和重启策略创建新容器");
    const createPayload = buildReplacementCreatePayload(oldContainer, job.targetImage, networks, oldImage, targetImage);
    const replacementId = await createContainer(job.originalContainerName, createPayload);
    job.replacementContainerId = replacementId;
    persistJob(job);
    await startContainer(replacementId);

    setPhase(job, "waiting_health", "等待新容器 running/healthy");
    await waitForReplacement(job, replacementId);

    setPhase(job, "verifying_version", `确认 /api/version 已切换到 v${job.targetVersion}`);
    const version = await fetchJson<{ appVersion?: string }>(`${APP_BASE_URL}/api/version`, 5_000);
    if (version.appVersion !== job.targetVersion) {
      throw new Error(`版本校验失败：期望 ${job.targetVersion}，实际 ${version.appVersion || "unknown"}`);
    }

    await removeContainer(oldContainer.Id, false);
    job.oldContainerId = null;
    setPhase(job, "completed", `在线升级完成：v${job.sourceVersion || "?"} → v${job.targetVersion}`);
    job.error = null;
    job.cancellable = false;
    persistJob(job);
  } catch (error) {
    if (error instanceof CancelledError) return;
    const message = error instanceof Error ? error.message : String(error);
    job.error = message;
    addLog(job, message, "error");
    if (!replacementStarted || !oldContainer) {
      setPhase(job, "failed_before_replace", "升级在替换容器前失败，旧容器继续运行");
      return;
    }
    setPhase(job, "failed_after_replace", "新容器未通过验证，将恢复旧容器");
    try {
      await rollback(job, oldContainer, networks);
    } catch (rollbackError) {
      job.rollbackError = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      addLog(job, `自动回滚失败：${job.rollbackError}`, "error");
      setPhase(job, "rollback_failed", "自动回滚失败，需要管理员通过 Docker/NAS 控制台人工恢复");
    }
  } finally {
    activeJobId = null;
    job.cancellable = false;
    persistJob(job);
  }
}

export async function createUpdateJob(input: CreateJobInput): Promise<UpdateJob> {
  if (activeJobId) throw new Error("已有更新任务正在执行");
  const targetVersion = validateTargetVersion(input.targetVersion);
  const current = await findManagedContainer();
  if (current.Image !== input.expectedCurrentImageId) {
    throw new Error("当前镜像与预检时不一致，请重新预检");
  }
  const targetImageRef = imageRefForVersion(targetVersion);
  const [currentImage, targetImage] = await Promise.all([
    inspectImage(current.Image),
    inspectImage(targetImageRef),
  ]);
  if (targetImage.Id !== input.targetImageId) {
    throw new Error("目标镜像已变化，请重新预检");
  }
  if (targetImage.Id === current.Image) throw new Error("当前已运行目标镜像，无需升级");

  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const job: UpdateJob = {
    id,
    status: "queued",
    phase: "queued",
    createdAt,
    updatedAt: createdAt,
    targetVersion,
    targetImage: targetImageRef,
    targetImageId: targetImage.Id,
    targetDigest: getDigestSafe(targetImage),
    sourceVersion: null,
    sourceImage: current.Config.Image || "",
    sourceImageId: current.Image,
    sourceDigest: getDigestSafe(currentImage),
    oldContainerId: null,
    replacementContainerId: null,
    originalContainerName: null,
    rollbackContainerName: null,
    backup: input.backup,
    rollbackMode: "image-only",
    rollbackDataSafe: false,
    cancelRequested: false,
    cancellable: true,
    error: null,
    rollbackError: null,
    logs: [],
  };
  jobs.set(id, job);
  activeJobId = id;
  persistJob(job);
  addLog(job, "更新任务已创建；执行过程不会接受任意容器、镜像或 Docker 参数");
  void executeJob(job);
  return publicJob(job);
}
