// 热更新签名信封的解析与验签。
//
// 格式与发版流水线 scripts/hot-update/lib/manifest.mjs 一一对应：
//   { schema: 1, payload: base64(清单 JSON), signatures: [{ keyId, algorithm, signature }] }
// 公钥和 keyId 来自安装包（NowenHotUpdateRuntime 插件），不来自网页包本身。

export const HOT_UPDATE_SIGNATURE_ALGORITHM = "RSA-SHA256-PKCS1v15";
export type HotUpdateTarget = "android" | "desktop";

export interface HotUpdateManifest {
  schema: 1;
  target: HotUpdateTarget;
  channel: "stable";
  version: string;
  runtimeVersion: string;
  bundleId: string;
  sequence: number;
  commit: string;
  createdAt: string;
  size: number;
  sha256: string;
  zipSignature: string;
  urls: string[];
  files?: Record<string, string>;
  revokedBundleIds: string[];
}

export interface HotUpdateTrust {
  publicKeyPem: string;
  keyId: string;
  /** 允许的下载地址来源（协议 + 主机 + 端口），例如 https://download.nowen.cn */
  allowedOrigins: readonly string[];
}

export class HotUpdateVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HotUpdateVerificationError";
  }
}

const MANIFEST_KEYS = new Set([
  "schema", "target", "channel", "version", "runtimeVersion", "bundleId", "sequence", "commit", "createdAt",
  "size", "sha256", "zipSignature", "urls", "files", "revokedBundleIds",
]);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RUNTIME_VERSION = /^e[1-9]\d{0,5}-[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const BUNDLE_ID = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[0-9a-f]{8}$/;
const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;
const MAX_ENVELOPE_CHARS = 4 * 1024 * 1024;

function fail(message: string): never {
  throw new HotUpdateVerificationError(`热更新清单无效：${message}`);
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function publicKeyPemToDer(pem: string): Uint8Array {
  if (typeof pem !== "string" || !pem.includes("-----BEGIN PUBLIC KEY-----")) {
    throw new HotUpdateVerificationError("安装包里的热更新公钥格式无效");
  }
  return decodeBase64(pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, ""));
}

/** 与流水线同一套规则严格校验清单；只放行认识的字段和允许来源的下载地址。 */
export function validateHotUpdateManifest(value: unknown, allowedOrigins: readonly string[]): HotUpdateManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("不是对象");
  const manifest = value as Record<string, unknown>;
  for (const key of Object.keys(manifest)) if (!MANIFEST_KEYS.has(key)) fail(`未知字段 ${key}`);
  if (manifest.schema !== 1) fail("schema 必须为 1");
  if (manifest.target !== "android" && manifest.target !== "desktop") fail("target 无效");
  if (manifest.channel !== "stable") fail("channel 无效");
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) fail("version 必须为 X.Y.Z");
  if (typeof manifest.runtimeVersion !== "string" || !RUNTIME_VERSION.test(manifest.runtimeVersion)) fail("runtimeVersion 格式无效");
  if (typeof manifest.sha256 !== "string" || !HEX64.test(manifest.sha256)) fail("sha256 无效");
  if (manifest.bundleId !== `${manifest.version}-${manifest.sha256.slice(0, 8)}` || !BUNDLE_ID.test(manifest.bundleId)) {
    fail("bundleId 与 version/sha256 不符");
  }
  if (!Number.isSafeInteger(manifest.sequence) || (manifest.sequence as number) <= 0) fail("sequence 必须是正整数");
  if (typeof manifest.commit !== "string" || !COMMIT.test(manifest.commit)) fail("commit 必须是完整 SHA");
  if (typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) fail("createdAt 无效");
  if (!Number.isSafeInteger(manifest.size) || (manifest.size as number) <= 0 || (manifest.size as number) > MAX_BUNDLE_BYTES) {
    fail("size 超出范围");
  }
  if (typeof manifest.zipSignature !== "string" || !BASE64.test(manifest.zipSignature)) fail("zipSignature 无效");
  if (!Array.isArray(manifest.urls) || manifest.urls.length < 1 || manifest.urls.length > 4) fail("urls 数量无效");
  for (const url of manifest.urls) {
    let parsed: URL;
    try {
      parsed = new URL(String(url));
    } catch {
      fail(`url 无效：${String(url)}`);
    }
    if (!allowedOrigins.includes(parsed.origin) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      fail(`url 不在允许范围：${String(url)}`);
    }
  }
  if (manifest.target === "desktop" && (!manifest.files || typeof manifest.files !== "object")) fail("桌面清单必须包含 files");
  if (manifest.files !== undefined) {
    if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) fail("files 必须是对象");
    for (const [file, digest] of Object.entries(manifest.files as Record<string, unknown>)) {
      if (!file || typeof digest !== "string" || !HEX64.test(digest)) fail(`files 条目无效：${file}`);
    }
  }
  if (!Array.isArray(manifest.revokedBundleIds) || manifest.revokedBundleIds.length > 100) fail("revokedBundleIds 无效");
  for (const id of manifest.revokedBundleIds) {
    if (typeof id !== "string" || !BUNDLE_ID.test(id)) fail(`revokedBundleIds 条目无效：${String(id)}`);
  }
  return manifest as unknown as HotUpdateManifest;
}

/**
 * 验签并解析签名信封。只认安装包信任的那一把公钥（按 keyId 匹配），签名不对整体拒绝。
 */
export async function openHotUpdateEnvelope(
  text: string,
  trust: HotUpdateTrust,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<HotUpdateManifest> {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_ENVELOPE_CHARS) {
    throw new HotUpdateVerificationError("签名信封大小无效");
  }
  let envelope: { schema?: unknown; payload?: unknown; signatures?: unknown };
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new HotUpdateVerificationError("签名信封不是有效 JSON");
  }
  if (!envelope || envelope.schema !== 1 || typeof envelope.payload !== "string" || !BASE64.test(envelope.payload)) {
    throw new HotUpdateVerificationError("签名信封格式无效");
  }
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length < 1 || envelope.signatures.length > 4) {
    throw new HotUpdateVerificationError("签名信封缺少签名");
  }
  for (const item of envelope.signatures as Array<Record<string, unknown>>) {
    if (!item || typeof item.keyId !== "string" || !KEY_ID.test(item.keyId) || item.algorithm !== HOT_UPDATE_SIGNATURE_ALGORITHM ||
      typeof item.signature !== "string" || !BASE64.test(item.signature)) {
      throw new HotUpdateVerificationError("签名信封里的签名条目无效");
    }
  }
  const payload = decodeBase64(envelope.payload);
  // 只接受规范 base64，签名覆盖的字节必须唯一。
  if (encodeBase64(payload) !== envelope.payload) throw new HotUpdateVerificationError("签名信封 payload 不是规范 base64");
  const signature = (envelope.signatures as Array<{ keyId: string; signature: string }>).find((item) => item.keyId === trust.keyId);
  if (!signature) throw new HotUpdateVerificationError("签名信封没有安装包信任的签名");
  const key = await subtle.importKey("spki", publicKeyPemToDer(trust.publicKeyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!(await subtle.verify("RSASSA-PKCS1-v1_5", key, decodeBase64(signature.signature), payload))) {
    throw new HotUpdateVerificationError("签名校验失败");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new HotUpdateVerificationError("清单不是有效 JSON");
  }
  return validateHotUpdateManifest(manifest, trust.allowedOrigins);
}
