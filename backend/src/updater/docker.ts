import http from "http";
import fs from "fs";
import path from "path";

export const OFFICIAL_IMAGE_REPOSITORY = (
  process.env.NOWEN_UPDATER_ALLOWED_IMAGE || "cropflre/nowen-note"
).trim();
export const MANAGED_INSTANCE = (process.env.NOWEN_UPDATER_INSTANCE || "nowen-note").trim();
export const MANAGED_CONTAINER_NAME = (process.env.NOWEN_UPDATER_CONTAINER_NAME || "nowen-note").trim();
export const DOCKER_SOCKET = process.env.NOWEN_DOCKER_SOCKET || "/var/run/docker.sock";

export interface DockerContainerSummary {
  Id: string;
  Names?: string[];
  Image?: string;
  ImageID?: string;
  State?: string;
  Status?: string;
  Labels?: Record<string, string>;
}

export interface DockerContainerInspect {
  Id: string;
  Name: string;
  Image: string;
  Config: Record<string, any> & {
    Image?: string;
    Env?: string[];
    Labels?: Record<string, string>;
    Healthcheck?: Record<string, any>;
  };
  HostConfig: Record<string, any>;
  NetworkSettings: {
    Networks?: Record<string, {
      Aliases?: string[] | null;
      Links?: string[] | null;
      IPAMConfig?: Record<string, any> | null;
      NetworkID?: string;
      EndpointID?: string;
      Gateway?: string;
      IPAddress?: string;
      IPPrefixLen?: number;
      IPv6Gateway?: string;
      GlobalIPv6Address?: string;
      GlobalIPv6PrefixLen?: number;
      MacAddress?: string;
      DriverOpts?: Record<string, string> | null;
    }>;
  };
  State: {
    Status?: string;
    Running?: boolean;
    Restarting?: boolean;
    ExitCode?: number;
    Error?: string;
    Health?: { Status?: string; FailingStreak?: number; Log?: any[] };
  };
}

export interface DockerImageInspect {
  Id: string;
  RepoTags?: string[];
  RepoDigests?: string[];
  Architecture?: string;
  Os?: string;
  Size?: number;
  Config?: Record<string, any> & { Healthcheck?: Record<string, any> };
}

export interface DockerInfo {
  Architecture?: string;
  DockerRootDir?: string;
  ServerVersion?: string;
  Driver?: string;
  OperatingSystem?: string;
  OSType?: string;
  NCPU?: number;
  MemTotal?: number;
}

export class DockerApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
  ) {
    super(message);
    this.name = "DockerApiError";
  }
}

function normalizeBody(body: unknown): Buffer | undefined {
  if (body === undefined) return undefined;
  return Buffer.from(JSON.stringify(body), "utf8");
}

export async function dockerRequest<T = any>(
  method: string,
  requestPath: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<T> {
  const payload = normalizeBody(body);
  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path: requestPath,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": payload.length,
            }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const statusCode = res.statusCode || 500;
          if (statusCode < 200 || statusCode >= 300) {
            let detail = raw;
            try {
              const parsed = JSON.parse(raw) as { message?: string };
              detail = parsed.message || raw;
            } catch {
              // Keep raw response for diagnostics.
            }
            reject(new DockerApiError(`Docker API ${method} ${requestPath} failed: ${detail}`, statusCode, raw));
            return;
          }
          if (!raw) {
            resolve(undefined as T);
            return;
          }
          try {
            resolve(JSON.parse(raw) as T);
          } catch {
            resolve(raw as T);
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Docker API timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function pullImage(imageRef: string, onProgress?: (message: string) => void): Promise<void> {
  const split = splitImageRef(imageRef);
  const query = new URLSearchParams({ fromImage: split.repository, tag: split.tag });
  const requestPath = `/images/create?${query.toString()}`;

  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path: requestPath,
        method: "POST",
      },
      (res) => {
        let buffer = "";
        let fatalMessage = "";
        const statusCode = res.statusCode || 500;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line) as {
                status?: string;
                id?: string;
                progress?: string;
                error?: string;
                errorDetail?: { message?: string };
              };
              if (event.error || event.errorDetail?.message) {
                fatalMessage = event.errorDetail?.message || event.error || "image pull failed";
              }
              const summary = [event.status, event.id, event.progress].filter(Boolean).join(" ");
              if (summary) onProgress?.(summary.slice(0, 500));
            } catch {
              onProgress?.(line.slice(0, 500));
            }
          }
        });
        res.on("end", () => {
          if (buffer.trim()) {
            try {
              const event = JSON.parse(buffer) as { error?: string; errorDetail?: { message?: string } };
              fatalMessage = event.errorDetail?.message || event.error || fatalMessage;
            } catch {
              // Ignore a partial trailing progress line.
            }
          }
          if (statusCode < 200 || statusCode >= 300 || fatalMessage) {
            reject(new Error(fatalMessage || `Docker image pull failed with HTTP ${statusCode}`));
            return;
          }
          resolve();
        });
      },
    );
    req.setTimeout(20 * 60_000, () => req.destroy(new Error("Docker image pull timed out")));
    req.on("error", reject);
    req.end();
  });
}

export function validateTargetVersion(input: unknown): string {
  const value = String(input || "").trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("目标版本格式无效");
  }
  return value;
}

export function imageRefForVersion(version: string): string {
  return `${OFFICIAL_IMAGE_REPOSITORY}:v${validateTargetVersion(version)}`;
}

export function splitImageRef(imageRef: string): { repository: string; tag: string } {
  const lastSlash = imageRef.lastIndexOf("/");
  const lastColon = imageRef.lastIndexOf(":");
  if (lastColon <= lastSlash) return { repository: imageRef, tag: "latest" };
  return { repository: imageRef.slice(0, lastColon), tag: imageRef.slice(lastColon + 1) };
}

export function normalizeArchitecture(raw: string | undefined): string {
  const value = (raw || "").toLowerCase();
  if (["x86_64", "x86-64", "amd64"].includes(value)) return "amd64";
  if (["aarch64", "arm64", "arm64v8"].includes(value)) return "arm64";
  return value;
}

export function resolveDigest(image: DockerImageInspect): string | null {
  const prefix = `${OFFICIAL_IMAGE_REPOSITORY}@sha256:`;
  return image.RepoDigests?.find((item) => item.startsWith(prefix)) || image.RepoDigests?.[0] || null;
}

export async function getDockerInfo(): Promise<DockerInfo> {
  return dockerRequest<DockerInfo>("GET", "/info");
}

export async function inspectImage(refOrId: string): Promise<DockerImageInspect> {
  return dockerRequest<DockerImageInspect>("GET", `/images/${encodeURIComponent(refOrId)}/json`);
}

export async function inspectContainer(id: string): Promise<DockerContainerInspect> {
  return dockerRequest<DockerContainerInspect>("GET", `/containers/${encodeURIComponent(id)}/json`);
}

export async function findManagedContainer(): Promise<DockerContainerInspect> {
  const labels = [
    "com.nowen-note.managed=true",
    "com.nowen-note.role=app",
    "com.nowen-note.project=nowen-note",
    `com.nowen-note.instance=${MANAGED_INSTANCE}`,
  ];
  const filters = encodeURIComponent(JSON.stringify({ label: labels }));
  const list = await dockerRequest<DockerContainerSummary[]>("GET", `/containers/json?all=1&filters=${filters}`);
  const exactName = `/${MANAGED_CONTAINER_NAME}`;
  const exactMatches = list.filter((item) => (item.Names || []).includes(exactName));
  const runningMatches = list.filter((item) => item.State === "running");
  const selected = exactMatches.length === 1
    ? exactMatches[0]
    : list.length === 1
      ? list[0]
      : runningMatches.length === 1
        ? runningMatches[0]
        : null;
  if (!selected) {
    throw new Error(`受管 Nowen Note 活动容器无法唯一确定：候选 ${list.length} 个`);
  }
  const container = await inspectContainer(selected.Id);
  assertManagedContainer(container);
  return container;
}

export function assertManagedContainer(container: DockerContainerInspect): void {
  const labels = container.Config.Labels || {};
  const valid =
    labels["com.nowen-note.managed"] === "true" &&
    labels["com.nowen-note.role"] === "app" &&
    labels["com.nowen-note.project"] === "nowen-note" &&
    labels["com.nowen-note.instance"] === MANAGED_INSTANCE;
  if (!valid) throw new Error("目标容器缺少 Nowen Note 受管标签，已拒绝操作");

  const configuredImage = container.Config.Image || "";
  if (!configuredImage.startsWith(`${OFFICIAL_IMAGE_REPOSITORY}:`) && !configuredImage.startsWith(`${OFFICIAL_IMAGE_REPOSITORY}@`)) {
    throw new Error(`目标容器镜像不在允许仓库：${configuredImage}`);
  }
}

export function getContainerName(container: DockerContainerInspect): string {
  return container.Name.replace(/^\//, "");
}

const HOST_CONFIG_KEYS = [
  "Binds", "ContainerIDFile", "LogConfig", "NetworkMode", "PortBindings", "RestartPolicy",
  "AutoRemove", "VolumeDriver", "VolumesFrom", "CapAdd", "CapDrop", "CgroupnsMode", "Dns",
  "DnsOptions", "DnsSearch", "ExtraHosts", "GroupAdd", "IpcMode", "Cgroup", "Links",
  "OomScoreAdj", "PidMode", "Privileged", "PublishAllPorts", "ReadonlyRootfs", "SecurityOpt",
  "StorageOpt", "Tmpfs", "UTSMode", "UsernsMode", "ShmSize", "Sysctls", "Runtime", "Isolation",
  "MaskedPaths", "ReadonlyPaths", "Init", "CpuShares", "Memory", "NanoCpus", "CgroupParent",
  "BlkioWeight", "BlkioWeightDevice", "BlkioDeviceReadBps", "BlkioDeviceWriteBps",
  "BlkioDeviceReadIOps", "BlkioDeviceWriteIOps", "CpuPeriod", "CpuQuota", "CpuRealtimePeriod",
  "CpuRealtimeRuntime", "CpusetCpus", "CpusetMems", "Devices", "DeviceCgroupRules", "DeviceRequests",
  "MemoryReservation", "MemorySwap", "MemorySwappiness", "OomKillDisable", "PidsLimit", "Ulimits",
  "CpuCount", "CpuPercent", "IOMaximumIOps", "IOMaximumBandwidth",
] as const;

function pickHostConfig(source: Record<string, any>): Record<string, any> {
  const target: Record<string, any> = {};
  for (const key of HOST_CONFIG_KEYS) {
    if (source[key] !== undefined && source[key] !== null) target[key] = source[key];
  }
  target.AutoRemove = false;
  return target;
}

function pickConfig(source: Record<string, any>, imageRef: string): Record<string, any> {
  const keys = [
    "Hostname", "Domainname", "User", "AttachStdin", "AttachStdout", "AttachStderr", "ExposedPorts",
    "Tty", "OpenStdin", "StdinOnce", "Env", "Cmd", "Healthcheck", "ArgsEscaped", "Volumes",
    "WorkingDir", "Entrypoint", "NetworkDisabled", "MacAddress", "OnBuild", "Labels", "StopSignal",
    "StopTimeout", "Shell",
  ];
  const target: Record<string, any> = { Image: imageRef };
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) target[key] = source[key];
  }
  return target;
}

export interface SavedNetworkAttachment {
  name: string;
  aliases: string[];
  links: string[];
  ipamConfig?: Record<string, any> | null;
  driverOpts?: Record<string, string> | null;
}

export function captureNetworkAttachments(container: DockerContainerInspect): SavedNetworkAttachment[] {
  const containerId = container.Id;
  const currentName = getContainerName(container);
  return Object.entries(container.NetworkSettings.Networks || {}).map(([name, endpoint]) => {
    const preservedIpam = endpoint.IPAMConfig || (endpoint.IPAddress || endpoint.GlobalIPv6Address
      ? {
          IPv4Address: endpoint.IPAddress || undefined,
          IPv6Address: endpoint.GlobalIPv6Address || undefined,
        }
      : undefined);
    return {
      name,
      aliases: (endpoint.Aliases || []).filter((alias) => alias && alias !== containerId && alias !== currentName),
      links: endpoint.Links || [],
      ipamConfig: preservedIpam,
      driverOpts: endpoint.DriverOpts || undefined,
    };
  });
}

function envMap(values: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(values)) return map;
  for (const item of values) {
    if (typeof item !== "string") continue;
    const index = item.indexOf("=");
    const key = index >= 0 ? item.slice(0, index) : item;
    const value = index >= 0 ? item.slice(index + 1) : "";
    if (key) map.set(key, value);
  }
  return map;
}

function resolveEnvironmentOverrides(
  currentEnv: unknown,
  oldImageEnv: unknown,
): string[] {
  const current = envMap(currentEnv);
  const defaults = envMap(oldImageEnv);
  const immutableBuildKeys = new Set([
    "NOWEN_APP_VERSION",
    "NOWEN_BUILD_TIME",
    "NOWEN_FRONTEND_BUILD_ID",
  ]);
  const overrides: string[] = [];
  for (const [key, value] of current) {
    if (immutableBuildKeys.has(key)) continue;
    if (defaults.has(key) && defaults.get(key) === value) continue;
    overrides.push(`${key}=${value}`);
  }
  return overrides;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function buildReplacementCreatePayload(
  current: DockerContainerInspect,
  imageRef: string,
  networks: SavedNetworkAttachment[],
  oldImage: DockerImageInspect,
  targetImage: DockerImageInspect,
): Record<string, any> {
  const endpoints: Record<string, any> = {};
  for (const network of networks) {
    endpoints[network.name] = {
      Aliases: network.aliases,
      Links: network.links,
      IPAMConfig: network.ipamConfig || undefined,
      DriverOpts: network.driverOpts || undefined,
    };
  }

  const config = pickConfig(current.Config, imageRef);
  config.Env = resolveEnvironmentOverrides(current.Config.Env, oldImage.Config?.Env);
  if (config.Env.length === 0) delete config.Env;

  for (const key of ["Cmd", "Entrypoint", "WorkingDir", "User", "StopSignal", "Shell", "ExposedPorts", "Volumes"]) {
    if (sameJson(current.Config[key], oldImage.Config?.[key])) delete config[key];
  }
  if (targetImage.Config?.Healthcheck) config.Healthcheck = targetImage.Config.Healthcheck;
  else delete config.Healthcheck;

  return {
    ...config,
    HostConfig: pickHostConfig(current.HostConfig),
    NetworkingConfig: { EndpointsConfig: endpoints },
  };
}

export async function stopContainer(id: string, timeoutSeconds = 30): Promise<void> {
  await dockerRequest("POST", `/containers/${encodeURIComponent(id)}/stop?t=${timeoutSeconds}`, undefined, (timeoutSeconds + 10) * 1000);
}

export async function startContainer(id: string): Promise<void> {
  await dockerRequest("POST", `/containers/${encodeURIComponent(id)}/start`);
}

export async function renameContainer(id: string, name: string): Promise<void> {
  await dockerRequest("POST", `/containers/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(name)}`);
}

export async function removeContainer(id: string, force = false): Promise<void> {
  await dockerRequest("DELETE", `/containers/${encodeURIComponent(id)}?force=${force ? "1" : "0"}&v=1`);
}

export async function createContainer(name: string, payload: Record<string, any>): Promise<string> {
  const result = await dockerRequest<{ Id: string; Warnings?: string[] }>(
    "POST",
    `/containers/create?name=${encodeURIComponent(name)}`,
    payload,
  );
  if (!result.Id) throw new Error("Docker 未返回新容器 ID");
  return result.Id;
}

export async function disconnectContainerNetworks(id: string, networks: SavedNetworkAttachment[]): Promise<void> {
  for (const network of networks) {
    try {
      await dockerRequest("POST", `/networks/${encodeURIComponent(network.name)}/disconnect`, {
        Container: id,
        Force: true,
      });
    } catch (error) {
      if (!(error instanceof DockerApiError)) throw error;
      const harmless = error.statusCode === 404 || /not connected|is not connected/i.test(error.responseBody);
      if (!harmless) throw error;
    }
  }
}

export async function reconnectContainerNetworks(id: string, networks: SavedNetworkAttachment[]): Promise<void> {
  const current = await inspectContainer(id);
  const alreadyConnected = new Set(Object.keys(current.NetworkSettings.Networks || {}));
  for (const network of networks) {
    if (alreadyConnected.has(network.name)) continue;
    await dockerRequest("POST", `/networks/${encodeURIComponent(network.name)}/connect`, {
      Container: id,
      EndpointConfig: {
        Aliases: network.aliases,
        Links: network.links,
        IPAMConfig: network.ipamConfig || undefined,
        DriverOpts: network.driverOpts || undefined,
      },
    });
  }
}

export function getUpdaterDiskStatus(): { freeBytes: number | null; totalBytes: number | null; path: string } {
  const stateDir = process.env.NOWEN_UPDATER_STATE_DIR || "/var/lib/nowen-updater";
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const stat = fs.statfsSync(stateDir);
    return {
      freeBytes: Number(stat.bavail) * Number(stat.bsize),
      totalBytes: Number(stat.blocks) * Number(stat.bsize),
      path: path.resolve(stateDir),
    };
  } catch {
    return { freeBytes: null, totalBytes: null, path: path.resolve(stateDir) };
  }
}
