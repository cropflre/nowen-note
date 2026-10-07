import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { acquireNativeEncryptedWindow, onNativeEncryptedLifecycle } from "../nativeLifecycle";

const mocks = vi.hoisted(() => ({ native: false, platform: "web", acquire: vi.fn(), release: vi.fn(), add: vi.fn(), state: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => mocks.native, getPlatform: () => mocks.platform }, registerPlugin: () => ({ acquire: mocks.acquire, release: mocks.release }) }));
vi.mock("@capacitor/app", () => ({ App: { addListener: mocks.add, getState: mocks.state } }));
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
beforeEach(() => { mocks.native = true; mocks.platform = "android"; mocks.acquire.mockReset(); mocks.release.mockReset(); mocks.add.mockReset(); mocks.state.mockReset(); mocks.state.mockResolvedValue({ isActive: true }); });
afterEach(() => vi.restoreAllMocks());

it("Web does not request native protection or listeners", async () => {
  mocks.native = false; mocks.platform = "web";
  const release = await acquireNativeEncryptedWindow(); await release(); onNativeEncryptedLifecycle(vi.fn(), vi.fn())();
  expect(mocks.acquire).not.toHaveBeenCalled(); expect(mocks.add).not.toHaveBeenCalled();
});
it("a native window lease is not returned until protection has been acknowledged and each session has its own token", async () => {
  let finish!: () => void; mocks.acquire.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  let opened = false; const pending = acquireNativeEncryptedWindow().then((release) => { opened = true; return release; }); await flush();
  expect(opened).toBe(false); finish(); const release = await pending;
  const second = await acquireNativeEncryptedWindow();
  expect(mocks.acquire.mock.calls[0][0].token).not.toBe(mocks.acquire.mock.calls[1][0].token);
  await release(); await release(); expect(mocks.release).toHaveBeenCalledTimes(1); await second(); expect(mocks.release).toHaveBeenCalledTimes(2);
});
it("unavailable protection fails closed and a failed release remains retryable", async () => {
  mocks.acquire.mockRejectedValueOnce(new Error("Missing plugin")); await expect(acquireNativeEncryptedWindow()).rejects.toMatchObject({ code: "unavailable" });
  const release = await acquireNativeEncryptedWindow(); mocks.release.mockRejectedValueOnce(new Error("Bridge lost")); await expect(release()).rejects.toThrow(); await release();
  expect(mocks.release).toHaveBeenCalledTimes(2);
});
it("initial inactive state and background notifications lock; foreground checks the suspended idle deadline", async () => {
  let callback!: (value: { isActive: boolean }) => void; const remove = vi.fn(async () => {});
  mocks.add.mockImplementation(async (_name, listener) => { callback = listener; return { remove }; }); mocks.state.mockResolvedValue({ isActive: false });
  const background = vi.fn(); const foreground = vi.fn(); const stop = onNativeEncryptedLifecycle(background, foreground);
  await vi.waitFor(() => expect(background).toHaveBeenCalledTimes(1)); callback({ isActive: true }); expect(foreground).toHaveBeenCalledTimes(1);
  callback({ isActive: false }); expect(background).toHaveBeenCalledTimes(2); stop(); callback({ isActive: false }); expect(background).toHaveBeenCalledTimes(2); expect(remove).toHaveBeenCalledTimes(1);
});
it("a listener added after disposal is removed and cannot lock another account", async () => {
  let finish!: (value: { remove: () => Promise<void> }) => void; const remove = vi.fn(async () => {});
  mocks.add.mockImplementation(() => new Promise((resolve) => { finish = resolve; })); const background = vi.fn();
  const stop = onNativeEncryptedLifecycle(background, vi.fn()); await vi.waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(1)); stop(); finish({ remove });
  await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1)); expect(background).not.toHaveBeenCalled(); expect(mocks.state).not.toHaveBeenCalled();
});
it("failed subscription or state reads hide a live session but are ignored after disposal", async () => {
  mocks.add.mockRejectedValueOnce(new Error("Unavailable")); const background = vi.fn(); const stop = onNativeEncryptedLifecycle(background, vi.fn());
  await vi.waitFor(() => expect(background).toHaveBeenCalledTimes(1)); stop();
  const remove = vi.fn(async () => {}); mocks.add.mockResolvedValueOnce({ remove }); mocks.state.mockRejectedValueOnce(new Error("State unavailable"));
  const stopSecond = onNativeEncryptedLifecycle(background, vi.fn()); await vi.waitFor(() => expect(background).toHaveBeenCalledTimes(2)); stopSecond(); expect(remove).toHaveBeenCalledTimes(1);
});
