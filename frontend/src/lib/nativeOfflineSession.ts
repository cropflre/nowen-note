import { isAndroidNativeRuntime } from './mobileLocalMode';

/** Expiration only; explicit revocation and malformed tokens never qualify. */
export function shouldRetainNativeOfflineSession(code: unknown, token: string | null): boolean {
  if (!token || !isAndroidNativeRuntime()) return false;
  if (code !== 'REFRESH_TOKEN_INVALID' && code !== 'TOKEN_INVALID') return false;
  try {
    const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const data = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    return typeof data.userId === 'string' && typeof data.exp === 'number' && Number.isFinite(data.exp)
      && (code === 'REFRESH_TOKEN_INVALID' || data.exp * 1000 <= Date.now());
  } catch { return false; }
}

export const isExpiredNativeSession = (token: string | null): boolean => shouldRetainNativeOfflineSession('TOKEN_INVALID', token);

export const MOBILE_SYNC_AUTH_REQUIRED_EVENT = 'nowen:mobile-sync-auth-required';
