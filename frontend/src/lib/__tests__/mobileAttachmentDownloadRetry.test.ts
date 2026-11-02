import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileSyncEngine } from '../mobileSyncEngine';
vi.mock('../authSession', () => ({ getAccessToken: () => 'token', fetchWithAuthRefresh: (...args: Parameters<typeof fetch>) => fetch(...args) }));
afterEach(() => { vi.unstubAllGlobals(); });

describe('offline attachment recovery', () => {
  it('DCC-003: retries a failed remote download with GET after engine recreation', async () => {
    const row = { id: 'a1', mimeType: 'image/png', size: 3, hash: null, transferStatus: 'pending_download', available: 0, localPath: null };
    const db = {
      query: vi.fn(async () => [row]),
      run: vi.fn(async (sql: string) => {
        if (sql.includes("transferStatus='failed'")) row.transferStatus = 'failed';
        if (sql.includes("transferStatus='ready'")) { row.transferStatus = 'ready'; row.available = 1; }
        return { changes: 1 };
      }),
    };
    const attachments = { exists: vi.fn(async () => false), save: vi.fn(async () => ({ path: 'local/a1', sha256: 'hash', size: 3 })), read: vi.fn(async () => { throw new Error('no local file'); }) };
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('png'));
    vi.stubGlobal('fetch', fetchImpl);
    const options = { db: db as never, attachments: attachments as never, serverUrl: 'https://nas.test', token: 'token', userId: 'u', profileId: 'p', deviceId: 'd' };
    const scope = { scopeKey: 'personal', workspaceId: null };
    const transfer = async () => {
      const engine = new MobileSyncEngine(options);
      const retry = vi.spyOn(engine, 'requestSync');
      const internal = engine as unknown as { stopped: boolean; transferAttachments: (scope: unknown) => Promise<void> };
      internal.stopped = false;
      await internal.transferAttachments(scope);
      if (row.transferStatus === 'failed') expect(retry).toHaveBeenCalledWith(1000);
      engine.stop();
    };
    await transfer();
    expect(row.transferStatus).toBe('failed');
    await transfer();
    expect(row.transferStatus).toBe('ready');
    expect(attachments.save).toHaveBeenCalledOnce();
    expect(attachments.read).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls).toHaveLength(2);
    expect(fetchImpl.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });
});
