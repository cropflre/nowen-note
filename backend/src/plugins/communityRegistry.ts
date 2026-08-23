import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { getDb } from "../db/schema.js";
import { nowenVersionSatisfies } from "./manifest.js";
import { PACKAGE_LIMITS } from "./packageValidator.js";
import type { PluginTrustLevel } from "./types.js";

export interface RegistrySource { id: string; name: string; url: string; official?: boolean }
export interface RegistryVersion { version: string; download: string; sha256: string; nowen: string }
export interface RegistryPlugin {
  id: string; name: string; description?: string; category?: string; keywords?: string[];
  latestVersion: string; trustLevel?: PluginTrustLevel; repository?: string; homepage?: string;
  author?: { name?: string; url?: string }; versions: RegistryVersion[];
}

const DEFAULT_SOURCE: RegistrySource = {
  id: "official",
  name: "Official Registry",
  url: "https://raw.githubusercontent.com/cropflre/nowen-plugin-registry/main/registry.json",
  official: true,
};
const SETTINGS_KEY = "plugins:registrySources";

function privateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const value = address.toLowerCase();
  return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:");
}

async function validateRemoteUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (url.protocol !== "https:") throw Object.assign(new Error("Registry 只允许 HTTPS"), { code: "REGISTRY_URL_DENIED" });
  if (url.hostname === "localhost" || (net.isIP(url.hostname) && privateAddress(url.hostname))) throw new Error("Registry 禁止访问私有网络");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((item) => privateAddress(item.address))) throw new Error("Registry 地址解析到私有网络");
  return url;
}

export async function safeRegistryFetch(urlValue: string, maxBytes: number): Promise<Buffer> {
  let url = await validateRemoteUrl(urlValue);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error("Registry 重定向无效或过多");
      url = await validateRemoteUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`Registry 请求失败: HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxBytes) throw Object.assign(new Error("Registry 响应超过大小限制"), { code: "REGISTRY_PAYLOAD_TOO_LARGE" });
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxBytes) throw Object.assign(new Error("Registry 响应超过大小限制"), { code: "REGISTRY_PAYLOAD_TOO_LARGE" });
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Registry 请求失败");
}

export function validateRegistryCatalog(value: unknown): RegistryPlugin[] {
  const root = value as { plugins?: unknown };
  if (!root || !Array.isArray(root.plugins)) throw new Error("Registry JSON 缺少 plugins 数组");
  return root.plugins.map((raw) => {
    const plugin = raw as RegistryPlugin;
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(plugin.id || "") || !plugin.name || !Array.isArray(plugin.versions)) throw new Error("Registry 插件条目无效");
    for (const version of plugin.versions) {
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version.version || "") || !/^[a-f0-9]{64}$/i.test(version.sha256 || "") || !version.download || !version.nowen) {
        throw new Error(`Registry 版本条目无效: ${plugin.id}`);
      }
    }
    return { ...plugin, trustLevel: ["official", "verified", "community"].includes(plugin.trustLevel || "") ? plugin.trustLevel : "community" };
  });
}

export function verifyRegistryChecksum(bytes: Buffer, expected: string): void {
  const checksum = crypto.createHash("sha256").update(bytes).digest("hex");
  if (checksum.toLowerCase() !== expected.toLowerCase()) {
    throw Object.assign(new Error("Registry 插件 SHA256 不匹配"), { code: "REGISTRY_CHECKSUM_MISMATCH" });
  }
}

export class CommunityRegistry {
  listSources(): RegistrySource[] {
    const row = getDb().prepare("SELECT value FROM system_settings WHERE key=?").get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return [DEFAULT_SOURCE];
    try { return [DEFAULT_SOURCE, ...(JSON.parse(row.value) as RegistrySource[])]; } catch { return [DEFAULT_SOURCE]; }
  }

  setSources(sources: RegistrySource[]): RegistrySource[] {
    const cleaned = sources.filter((item) => item.id !== "official").map((item) => {
      const url = new URL(item.url);
      if (url.protocol !== "https:") throw new Error("Registry Source 只允许 HTTPS");
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(item.id) || !item.name.trim()) throw new Error("Registry Source id 或 name 无效");
      return { id: item.id, name: item.name.trim(), url: url.href };
    });
    if (new Set(cleaned.map((item) => item.id)).size !== cleaned.length) throw new Error("Registry Source id 不能重复");
    getDb().prepare(`INSERT INTO system_settings(key,value,updatedAt) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`)
      .run(SETTINGS_KEY, JSON.stringify(cleaned), new Date().toISOString());
    return this.listSources();
  }

  async catalog(sourceId = "official"): Promise<RegistryPlugin[]> {
    const source = this.listSources().find((item) => item.id === sourceId);
    if (!source) throw Object.assign(new Error("Registry Source 不存在"), { code: "REGISTRY_SOURCE_NOT_FOUND" });
    return validateRegistryCatalog(JSON.parse((await safeRegistryFetch(source.url, 2 * 1024 * 1024)).toString("utf8")));
  }

  async download(sourceId: string, pluginId: string, requestedVersion?: string): Promise<{ bytes: Buffer; plugin: RegistryPlugin; version: RegistryVersion }> {
    const plugins = await this.catalog(sourceId);
    const plugin = plugins.find((item) => item.id === pluginId);
    if (!plugin) throw Object.assign(new Error("Registry 中不存在该插件"), { code: "REGISTRY_PLUGIN_NOT_FOUND" });
    const version = plugin.versions.find((item) => item.version === (requestedVersion || plugin.latestVersion));
    if (!version) throw Object.assign(new Error("Registry 中不存在该版本"), { code: "PLUGIN_VERSION_NOT_FOUND" });
    if (!nowenVersionSatisfies(version.nowen)) throw Object.assign(new Error(`插件版本与当前 Nowen 不兼容: ${version.nowen}`), { code: "PLUGIN_INCOMPATIBLE" });
    const bytes = await safeRegistryFetch(version.download, PACKAGE_LIMITS.compressedBytes);
    verifyRegistryChecksum(bytes, version.sha256);
    return { bytes, plugin, version };
  }
}
