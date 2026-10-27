import { afterEach, expect, it, vi } from 'vitest';
import { getDesktopStartupSession, initializeDesktopLocalSession } from '../desktopLocalSession';
import { fetchWithAuthRefresh, storeAuthTokens, getAccessToken } from '../authSession';
import { refreshAccessToken } from '../authSession';
import { shouldRetainNativeOfflineSession } from '../nativeOfflineSession';
const nativeWindow = window as Window & {Capacitor?: {isNativePlatform: () => boolean; getPlatform: () => string}};
vi.mock('../api',()=>({setServerUrl:(url:string)=>localStorage.setItem('nowen-server-url',url)}));

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); delete nativeWindow.Capacitor; });

it('DCC-006: providers start only after migrated desktop address and credentials are replaced together', async () => {
  const desktopWindow = window as Window & {nowenDesktop?: object};
  desktopWindow.nowenDesktop = {
    isDesktop:true,
    getAppInfo:async()=>({runtime:'local',localMigrationComplete:true,localServerUrl:'http://127.0.0.1:12345'}),
    getLocalAuth:async()=>({token:'local-credential',refreshToken:'local-refresh',user:{id:'local'}}),
  };
  localStorage.setItem('nowen-server-url','https://nas.test');
  storeAuthTokens({token:'remote-credential',refreshToken:'remote-refresh'});
  try {
    await initializeDesktopLocalSession();
    expect(localStorage.getItem('nowen-server-url')).toBe('http://127.0.0.1:12345');
    expect(getAccessToken()).toBe('local-credential');
    expect(localStorage.getItem('nowen-refresh-token')).toBe('local-refresh');
  } finally { delete desktopWindow.nowenDesktop; }
});

it('DCC-006: a completed desktop migration replaces NAS auth with local credentials and address', async () => {
  const auth = { token: 'local-token', user: { id: 'local-user' } as never };
  const bridge = {
    getAppInfo: async () => ({ runtime: 'local', localMigrationComplete: true, localServerUrl: 'http://127.0.0.1:12345' }),
    getLocalAuth: vi.fn(async () => auth),
  };
  expect(await getDesktopStartupSession(bridge, 'nas-token', true)).toEqual({ ...auth, serverUrl: 'http://127.0.0.1:12345' });
  bridge.getAppInfo = async () => ({ runtime: 'remote', localMigrationComplete: false, localServerUrl: '' });
  bridge.getLocalAuth.mockClear();
  expect(await getDesktopStartupSession(bridge, 'nas-token', true)).toBeNull();
  expect(bridge.getLocalAuth).not.toHaveBeenCalled();
});

it('DCC-009: native expiration retains the bound token for offline access, revocation still clears it', async () => {
  nativeWindow.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
  const expired = `header.${btoa(JSON.stringify({userId:'u',exp:1}))}.signature`;
  for (const [code, retained] of [['REFRESH_TOKEN_INVALID', true], ['TOKEN_REVOKED', false], ['SESSION_REVOKED', false]] as const) {
    storeAuthTokens({ token: expired, refreshToken: `refresh-${code}` });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({code}), {status:401})));
    const response = await fetchWithAuthRefresh('https://nas.test/api/me', {headers:{Authorization:`Bearer ${expired}`}}, 'https://nas.test/api');
    expect(response.status).toBe(401);
    expect(getAccessToken()).toBe(retained ? expired : null);
  }
});

it('a proactive native refresh rejection retains local access before the JWT expires', async () => {
  nativeWindow.Capacitor = {isNativePlatform:()=>true,getPlatform:()=> 'android'};
  const token=`header.${btoa(JSON.stringify({userId:'u',exp:Math.floor(Date.now()/1000)+60}))}.signature`;
  storeAuthTokens({token,refreshToken:'expired-refresh'});
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({code:'REFRESH_TOKEN_INVALID'},{status:401})));
  let failure: unknown;
  try { await refreshAccessToken('https://nas.test/api'); } catch (error) { failure=error; }
  expect(failure).toMatchObject({terminal:true,code:'REFRESH_TOKEN_INVALID'});
  expect(getAccessToken()).toBe(token);
  expect(shouldRetainNativeOfflineSession((failure as {code:string}).code, token)).toBe(true);
  expect(shouldRetainNativeOfflineSession('SESSION_REVOKED',token)).toBe(false);
});
