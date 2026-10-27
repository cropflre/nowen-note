import type { User } from '@/types';

interface DesktopStartupBridge {
  getAppInfo?: () => Promise<{ runtime?: string; localMigrationComplete?: boolean; localServerUrl?: string | null } | null>;
  getLocalAuth: () => Promise<{ token: string; refreshToken?: string; user: User } | null>;
}

/** Replace a remote session only after a completed, persisted migration. */
export async function getDesktopStartupSession(bridge: DesktopStartupBridge, existingToken: string | null, preferCloud: boolean) {
  const info = await bridge.getAppInfo?.();
  const migrated = info?.runtime === 'local' && info.localMigrationComplete === true;
  if (!migrated && (existingToken || preferCloud)) return null;
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
