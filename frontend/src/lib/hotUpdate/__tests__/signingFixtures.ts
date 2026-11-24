// 用发版流水线自己的脚本（scripts/hot-update/lib）生成签名信封，保证客户端和流水线格式真正互通。
import { generateKeyPairSync } from "node:crypto";
// @ts-expect-error 流水线脚本是无类型的 .mjs
import { publicKeyId, signBytes, SIGNATURE_ALGORITHM, toPublicPem } from "../../../../../scripts/hot-update/lib/keys.mjs";
// @ts-expect-error 流水线脚本是无类型的 .mjs
import { encodeEnvelope, orderManifest, serializeManifest, sha256Hex } from "../../../../../scripts/hot-update/lib/manifest.mjs";

export const RUNTIME = "e1-0123456789abcdef";
export const PRODUCTION_ORIGINS = ["https://download.nowen.cn", "https://github.com"];

export function createSigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  return { privateKey, publicKeyPem: toPublicPem(publicKey) as string, keyId: publicKeyId(publicKey) as string };
}

export type SigningKey = ReturnType<typeof createSigningKey>;

export function manifestFor(version: string, overrides: Record<string, unknown> = {}) {
  const zip = Buffer.from(`zip ${version}`);
  const sha256 = sha256Hex(zip) as string;
  return {
    schema: 1,
    target: "android",
    channel: "stable",
    version,
    runtimeVersion: RUNTIME,
    bundleId: `${version}-${sha256.slice(0, 8)}`,
    sequence: 1795000000,
    commit: "a".repeat(40),
    createdAt: "2026-11-22T00:00:00.000Z",
    size: zip.length,
    sha256,
    zipSignature: "c2lnbmF0dXJl",
    urls: [
      `https://download.nowen.cn/hot/v${version}/nowen-hot-android-${version}.zip`,
      `https://github.com/cropflre/nowen-note/releases/download/v${version}/nowen-hot-android-${version}.zip`,
    ],
    revokedBundleIds: [],
    ...overrides,
  };
}

/** 按流水线 sign.mjs 的方式签名：payload 是清单 JSON 字节，信封里带 keyId。 */
export function sealEnvelope(manifest: Record<string, unknown>, key: SigningKey, options: { keyId?: string; payload?: Buffer } = {}): string {
  const payload = options.payload ?? (serializeManifest(orderManifest(manifest)) as Buffer);
  const signatures = [{ keyId: options.keyId ?? key.keyId, algorithm: SIGNATURE_ALGORITHM, signature: signBytes(key.privateKey, payload) }];
  return (encodeEnvelope(payload, signatures) as Buffer).toString("utf8");
}
