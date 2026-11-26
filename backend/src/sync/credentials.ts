/**
 * 远端同步凭据存储。
 *
 * 为什么不放数据库：
 * - 数据库会被备份、导出、迁移到其他设备。Access Token 跟着走等于凭据泄漏；
 * - 用户换机恢复备份后，旧 token 多半已失效，反而要额外写"恢复后清 token"逻辑；
 * - 凭据是**设备本地**的运行时状态，与知识库内容不是同一生命周期。
 *
 * 因此落在数据目录下的独立文件，权限 0600，与 Desktop 本地账号密钥
 * (.local_account_secret) 的处理方式保持一致。
 *
 * 安全约束：
 * - 本模块是唯一读写 token 的地方，其他模块只能拿到构造好的 client；
 * - token 绝不进入任何日志（[sync-v2] 日志用白名单字段，天然挡住）。
 */

import fs from "node:fs";
import path from "node:path";

import { SyncRemoteClient } from "./remote";
import { SyncBlobClient } from "./blob";
import { SyncError } from "./errors";
import type { RemoteCredentials } from "./remote";

const DATA_DIR = process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data");
const CREDENTIALS_FILE = path.join(DATA_DIR, ".sync_credentials.json");

interface StoredCredential {
  profileId: string;
  serverUrl: string;
  token: string;
  /** 30 天 Refresh Token：用于 Access Token（默认 15 分钟）过期后自动无感续期。 */
  refreshToken?: string | null;
  /** 远端用户标识，仅用于展示与校验，不参与鉴权。 */
  remoteUserId?: string | null;
  updatedAt: string;
}

type CredentialFile = Record<string, StoredCredential>;

function readFile(): CredentialFile {
  try {
    const raw = fs.readFileSync(CREDENTIALS_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CredentialFile;
    }
  } catch {
    // 文件不存在或损坏：视为"尚未授权"。
    // 这里绝不能抛错——凭据缺失只应导致同步暂停，不能让 Backend 起不来。
  }
  return {};
}

function writeFile(data: CredentialFile): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CREDENTIALS_FILE}.tmp`;
  // 原子写：崩在中途也不会留下半截 JSON 导致下次读不出任何凭据。
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, CREDENTIALS_FILE);
  try {
    fs.chmodSync(CREDENTIALS_FILE, 0o600);
  } catch {
    // Windows 上 chmod 基本无效，忽略即可。
  }
}

/** 保存某个 Profile 的远端凭据。同一 Profile 重复保存会覆盖旧 token。 */
export function saveRemoteCredential(input: {
  profileId: string;
  serverUrl: string;
  token: string;
  refreshToken?: string | null;
  remoteUserId?: string | null;
}): void {
  const data = readFile();
  const previous = data[input.profileId];
  const nextServerUrl = input.serverUrl.replace(/\/+$/, "");
  const nextRefreshToken = input.refreshToken !== undefined
    ? (input.refreshToken ? input.refreshToken : null)
    : (previous && previous.serverUrl === nextServerUrl ? (previous.refreshToken ?? null) : null);
  data[input.profileId] = {
    profileId: input.profileId,
    serverUrl: nextServerUrl,
    token: input.token,
    refreshToken: nextRefreshToken,
    remoteUserId: input.remoteUserId ?? previous?.remoteUserId ?? null,
    updatedAt: new Date().toISOString(),
  };
  writeFile(data);
}

/** 换取新凭据，供已绑定同步和首次下载共用。 */
export async function exchangeRemoteRefreshToken(
  serverUrl: string,
  refreshToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ token: string; refreshToken: string } | null> {
  const signal = AbortSignal.timeout(15_000);
  let response: Response;
  let payload: { token?: unknown; refreshToken?: unknown } | null = null;
  try {
    response = await fetchImpl(`${serverUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      signal,
    });
    if (response.ok) {
      payload = await response.json().catch(() => null);
      signal.throwIfAborted();
    }
  } catch {
    throw new SyncError("NETWORK_UNAVAILABLE", "刷新同步凭据时网络不可用");
  }
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new SyncError("SERVER_ERROR", `刷新同步凭据失败（HTTP ${response.status}）`);
  const token = typeof payload?.token === "string" ? payload.token.trim() : "";
  if (!token) throw new SyncError("SERVER_ERROR", "刷新同步凭据响应缺少有效 Token");
  const nextRefresh = typeof payload?.refreshToken === "string" ? payload.refreshToken.trim() : "";
  return { token, refreshToken: nextRefresh || refreshToken };
}

const refreshInFlight = new Map<string, Promise<string | null>>();

/**
 * 使用持久化的 refreshToken 向远端换取新的 Access Token，并原子写回凭据文件。
 *
 * 并发去重：metadata / blob / realtime 同时遇 401 时只发起一次 /api/auth/refresh。
 * 区分错误类型：
 * - 401 / 403（refreshToken 本身失效或被吊销）→ 返回 null，由调用方转入 AUTH_EXPIRED；
 * - 网络波动 / 5xx → 抛出可重试的 NETWORK_UNAVAILABLE / SERVER_ERROR，绝不误踢用户重新登录。
 */
export function refreshRemoteCredential(
  profileId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string | null> {
  const existing = refreshInFlight.get(profileId);
  if (existing) return existing;

  const task = (async (): Promise<string | null> => {
    const stored = getRemoteCredential(profileId);
    if (!stored?.refreshToken) return null;

    const refreshed = await exchangeRemoteRefreshToken(stored.serverUrl, stored.refreshToken, fetchImpl);
    const current = getRemoteCredential(profileId);
    // 续期在途时退出或重新登录，旧响应不能覆盖当前凭据。
    if (current?.token !== stored.token || current.refreshToken !== stored.refreshToken
      || current.serverUrl !== stored.serverUrl || current.remoteUserId !== stored.remoteUserId) {
      return current?.token ?? null;
    }
    if (!refreshed) return null;

    saveRemoteCredential({
      profileId,
      serverUrl: stored.serverUrl,
      token: refreshed.token,
      refreshToken: refreshed.refreshToken,
      remoteUserId: stored.remoteUserId ?? null,
    });
    return refreshed.token;
  })().finally(() => {
    refreshInFlight.delete(profileId);
  });

  refreshInFlight.set(profileId, task);
  return task;
}

/** 读取某个 Profile 的凭据；未授权返回 null。 */
export function getRemoteCredential(profileId: string): StoredCredential | null {
  const data = readFile();
  const found = data[profileId];
  if (!found || typeof found.token !== "string" || !found.token) return null;
  return found;
}

/**
 * 删除某个 Profile 的凭据。
 *
 * 用于关闭同步与切换服务器。**只清凭据**，本地笔记、附件、
 * 未同步 Outbox、冲突记录一个字都不动（RULE 4）。
 */
export function clearRemoteCredential(profileId: string): void {
  const data = readFile();
  if (!(profileId in data)) return;
  delete data[profileId];
  writeFile(data);
}

/** 是否已为该 Profile 授权。UI 用它区分"未连接"与"令牌过期"。 */
export function hasRemoteCredential(profileId: string): boolean {
  return getRemoteCredential(profileId) !== null;
}

/**
 * 按 Profile 构造远端客户端。
 *
 * 返回 null 表示尚未授权 —— 调用方应把这理解为"同步暂停"，
 * 而不是错误：本地读写始终正常（RULE 2）。
 */
export function createRemoteClientForProfile(
  profileId: string,
  serverUrl: string,
): SyncRemoteClient | null {
  const stored = getRemoteCredential(profileId);
  if (!stored) return null;
  const credentials: RemoteCredentials = {
    // 以 Profile 表里的地址为准：用户可能改过地址而凭据文件还是旧的。
    serverUrl: serverUrl.replace(/\/+$/, ""),
    token: stored.token,
  };
  return new SyncRemoteClient(credentials, {
    getToken: () => getRemoteCredential(profileId)?.token ?? stored.token,
    refreshToken: () => refreshRemoteCredential(profileId),
  });
}

/**
 * 构造附件二进制通道客户端。
 *
 * 与 createRemoteClientForProfile 分开而不是合成一个对象：
 * 两条通道的超时、并发、重试语义完全不同（JSON 请求秒级，附件可能要一分钟），
 * 混在一起会让其中一方被迫接受另一方的参数。
 */
export function createBlobClientForProfile(
  profileId: string,
  serverUrl: string,
): SyncBlobClient | null {
  const stored = getRemoteCredential(profileId);
  if (!stored) return null;
  return new SyncBlobClient({
    serverUrl: serverUrl.replace(/\/+$/, ""),
    credential: {
      serverUrl: serverUrl.replace(/\/+$/, ""),
      token: stored.token,
    },
    getToken: () => getRemoteCredential(profileId)?.token ?? stored.token,
    refreshToken: () => refreshRemoteCredential(profileId),
  });
}
