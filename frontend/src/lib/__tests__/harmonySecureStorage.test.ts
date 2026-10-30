import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SecureStorage } from '../harmonySecureStorage';

const request = vi.fn();
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  Object.assign(window, { __harmonyBridge__: { request } });
  request.mockReset();
  await SecureStorage.setKeyPrefix('test:');
  localStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); });

it('stores secrets only through the system bridge with stable hashed aliases and isolated prefixes', async () => {
  request.mockResolvedValue({});
  await SecureStorage.set('server:user', { token: 'private-token' });
  const alias = request.mock.calls[0][2].key;
  expect(alias).toMatch(/^[a-f0-9]{64}$/);
  expect(request).toHaveBeenLastCalledWith('SecureStorage', 'set', { key: alias, value: { token: 'private-token' } });
  request.mockResolvedValue({ value: 'private-token' });
  expect(await SecureStorage.get('server:user')).toBe('private-token');
  expect(request.mock.calls[1][2].key).toBe(alias);
  await SecureStorage.setKeyPrefix('other-account:');
  await SecureStorage.get('server:user');
  expect(request.mock.calls[2][2].key).not.toBe(alias);
  expect(localStorage.length).toBe(0);
});

it('preserves native failures instead of falling back to plaintext browser storage', async () => {
  request.mockRejectedValue(new Error('Device locked'));
  await expect(SecureStorage.set('token', 'secret')).rejects.toThrow('Device locked');
  expect(localStorage.length).toBe(0);
  Object.assign(window, { __harmonyBridge__: undefined });
  await expect(SecureStorage.get('token')).rejects.toThrow('尚未就绪');
});

it('returns missing values and removal results from the native store', async () => {
  request.mockResolvedValueOnce({ value: null }).mockResolvedValueOnce({ removed: true }).mockResolvedValueOnce({ removed: false });
  expect(await SecureStorage.get('absent')).toBeNull();
  expect(await SecureStorage.remove('token')).toBe(true);
  expect(await SecureStorage.remove('token')).toBe(false);
});
