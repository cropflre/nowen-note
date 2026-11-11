import type { User } from '@/types';
import type { LiteMigrationDiagnostic } from './desktopBridge';

/** 后端迁移进度中与首次下载失败处理有关的部分；stage 保持宽松，兼容旧版后端与既有的测试桩。 */
interface DownloadProgress {
  stage: string;
  error?: string | null;
  errorCode?: string | null;
  retryable?: boolean | null;
  diagnostic?: LiteMigrationDiagnostic | null;
}

interface DesktopStartupBridge {
  getAppInfo?: () => Promise<{ runtime?: string; localRuntimeAvailable?: boolean; localMigrationComplete?: boolean; localServerUrl?: string | null } | null>;
  getLocalAuth: () => Promise<{ token: string; refreshToken?: string; user: User } | null>;
  startLiteMigration?: (serverUrl: string, token: string) => Promise<{ok:boolean;error?:string;progress?:DownloadProgress} >;
}

/**
 * 首次下载失败。retryable=false 表示同一份数据再试必然得到同样的结果（例如目录结构无法自动合并），
 * 调用方应停止自动重试，只保留「继续在线使用」和手动重试。
 */
export class DesktopDownloadError extends Error {
  readonly retryable: boolean;
  readonly code: string | null;
  /** 可直接展示给用户转交支持人员的脱敏诊断；后端保证不含任何笔记内容或凭据。 */
  readonly diagnostic: string | null;
  constructor(message: string, options: { retryable?: boolean; code?: string | null; diagnostic?: string | null } = {}) {
    super(message);
    this.name = 'DesktopDownloadError';
    this.retryable = options.retryable !== false;
    this.code = options.code ?? null;
    this.diagnostic = options.diagnostic ?? null;
  }
}

function formatDiagnostic(progress: DownloadProgress | undefined): string | null {
  const d = progress?.diagnostic;
  const parts = [progress?.errorCode, d?.stage, d?.step, d?.reason, d?.sqliteCode,
    d?.entityType && d?.entityId ? `${d.entityType}:${d.entityId}` : null,
    d?.parentState ? `parent=${d.parentState}` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

type DesktopDownloadBridge = Pick<DesktopStartupBridge,'getAppInfo'|'startLiteMigration'>;
const downloads = new WeakMap<DesktopDownloadBridge, {serverUrl:string;token:string;work:Promise<boolean>}>();

/** Reasons the confirmed reset (/auth/desktop/reset-local) repairs: it re-enables, unlocks and re-promotes the account, or creates it. */
export function needsLocalAccountRecovery(error: string) {
  return [
    'LOCAL_ACCOUNT_REQUIRES_MANUAL_LOGIN','LOCAL_ACCOUNT_NOT_FOUND','LOCAL_ACCOUNT_DISABLED','ACCOUNT_LOCKED',
    'local-account-unavailable',
  ].includes(error);
}

/** The local backend or its desktop secret failed. A reset needs the same secret and backend, so it cannot help. */
export function isLocalAccountBootstrapFailure(error: string) {
  return error === 'BACKEND_UNAVAILABLE' || /^HTTP_\d{3}$/.test(error);
}

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
    if (!result.ok || result.progress?.stage !== 'complete') {
      throw new DesktopDownloadError(result.progress?.error || result.error || '首次自动下载尚未完成，恢复连接后将自动重试。', {
        retryable: result.progress?.retryable !== false,
        code: result.progress?.errorCode,
        diagnostic: formatDiagnostic(result.progress),
      });
    }
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
