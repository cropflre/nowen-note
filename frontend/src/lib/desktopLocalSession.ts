import type { User } from '@/types';

interface DesktopStartupBridge {
  getAppInfo?: () => Promise<{ runtime?: string; localRuntimeAvailable?: boolean; localMigrationComplete?: boolean; localServerUrl?: string | null } | null>;
  getLocalAuth: () => Promise<{ token: string; refreshToken?: string; user: User } | null>;
  startLiteMigration?: (serverUrl: string, token: string) => Promise<{ok:boolean;error?:string;progress?:{stage:string;error?:string|null}} >;
}

type DesktopDownloadBridge = Pick<DesktopStartupBridge,'getAppInfo'|'startLiteMigration'>;
const downloads = new WeakMap<DesktopDownloadBridge, {serverUrl:string;token:string;work:Promise<boolean>}>();

/** Every remote desktop login establishes the local copy before opening editors. */
export async function automaticallyDownloadDesktopCopy(bridge: DesktopDownloadBridge, serverUrl: string, token: string, pendingWrites: () => number): Promise<boolean> {
  const info = await bridge.getAppInfo?.();
  if (!info || info.localRuntimeAvailable === false || !bridge.startLiteMigration || !serverUrl || !token) return false;
  if (info.runtime === 'local' && info.localServerUrl?.replace(/\/$/,'') === serverUrl.replace(/\/$/,'')) return false;
  if (pendingWrites() > 0) throw new Error('请保持连接，正在等待旧版客户端的待同步修改上传。本机修改仍保留。');
  const existing = downloads.get(bridge);
  if (existing?.serverUrl === serverUrl && existing.token === token) return existing.work;
  const work = (async () => {
    const result = await bridge.startLiteMigration!(serverUrl,token);
    if (!result.ok || result.progress?.stage !== 'complete') throw new Error(result.progress?.error || result.error || '首次自动下载尚未完成，恢复连接后将自动重试。');
    return true;
  })();
  const entry = {serverUrl,token,work}; downloads.set(bridge,entry);
  try { return await work; } finally { if (downloads.get(bridge) === entry) downloads.delete(bridge); }
}

/** Replace a remote session only after a completed, persisted migration. */
export async function getDesktopStartupSession(bridge: DesktopStartupBridge, existingToken: string | null, preferCloud: boolean) {
  if (preferCloud) return null;
  const info = await bridge.getAppInfo?.();
  const migrated = info?.runtime === 'local' && info.localMigrationComplete === true;
  if (!migrated && existingToken) return null;
  const auth = await bridge.getLocalAuth();
  if (!auth) return null;
  const serverUrl = migrated ? info?.localServerUrl : null;
  if (migrated && (!serverUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(serverUrl))) return null;
  return { ...auth, serverUrl };
}

/** Complete the address/credential handoff before providers can issue requests. */
export async function initializeDesktopLocalSession(): Promise<void> {
  const bridge = (window as Window & {nowenDesktop?: DesktopStartupBridge & {isDesktop?: boolean}}).nowenDesktop;
  if (!bridge?.isDesktop || !bridge.getLocalAuth) return;
  const { getAccessToken, storeAuthTokens } = await import('./authSession');
  const auth = await getDesktopStartupSession(bridge,getAccessToken(),localStorage.getItem('nowen-prefer-cloud') === '1');
  if (!auth) return;
  if (auth.serverUrl) {
    const { setServerUrl } = await import('./api');
    setServerUrl(auth.serverUrl);
    localStorage.removeItem('nowen-prefer-cloud');
  }
  storeAuthTokens({token:auth.token,refreshToken:auth.refreshToken ?? null});
}
