// Selected only by the HarmonyOS build. Values live in the system Asset Store,
// never in the browser fallback used by the third-party Web implementation.
interface HarmonySecureBridge {
  request(plugin: string, method: string, options: Record<string, unknown>): Promise<unknown>;
}

let prefix = "capacitor-storage_";
async function request(method: string, key: string, value?: unknown): Promise<unknown> {
  const bridge = (window as Window & { __harmonyBridge__?: HarmonySecureBridge }).__harmonyBridge__;
  if (!bridge) return Promise.reject(new Error("鸿蒙安全存储尚未就绪"));
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prefix + key));
  const alias = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  return bridge.request("SecureStorage", method, { key: alias, value });
}

export const SecureStorage = {
  async setKeyPrefix(value: string) { prefix = value; },
  async get(key: string) {
    const result = await request("get", key) as { value: unknown };
    return result.value;
  },
  async set(key: string, value: unknown) { await request("set", key, value); },
  async remove(key: string) { return (await request("remove", key) as { removed: boolean }).removed; },
};
