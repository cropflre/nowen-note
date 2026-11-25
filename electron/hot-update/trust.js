// 热更新清单的验签、校验与接受规则（壳代码，永不热更新）。
//
// 格式与发版流水线 scripts/hot-update/lib/manifest.mjs、安卓端 frontend/src/lib/hotUpdate 一一对应：
//   签名信封 { schema: 1, payload: base64(清单 JSON), signatures: [{ keyId, algorithm, signature }] }
// 只信任安装包里写入的那一把公钥（按 keyId 匹配），算法 RSA-SHA256（PKCS#1 v1.5）。
"use strict";

const { constants, createHash, createPublicKey, verify } = require("node:crypto");

const SIGNATURE_ALGORITHM = "RSA-SHA256-PKCS1v15";
const MIN_RSA_BITS = 3072;
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
const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function publicKeyId(key) {
  return sha256Hex(key.export({ type: "spki", format: "der" })).slice(0, 16);
}

/** 读取安装包信任的公钥，并确认 keyId 与内容一致。 */
function loadTrustedKey(pem, keyId) {
  if (typeof pem !== "string" || !pem.includes("-----BEGIN PUBLIC KEY-----")) throw new Error("安装包里的热更新公钥格式无效");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "rsa" || !(key.asymmetricKeyDetails?.modulusLength >= MIN_RSA_BITS)) {
    throw new Error(`热更新公钥必须是至少 ${MIN_RSA_BITS} 位的 RSA 公钥`);
  }
  if (publicKeyId(key) !== keyId) throw new Error("热更新公钥与 keyId 不一致");
  return key;
}

function verifyBytes(key, data, signature) {
  if (typeof signature !== "string" || !BASE64.test(signature)) return false;
  try {
    return verify("sha256", data, { key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

function fail(message) {
  throw new Error(`热更新清单无效：${message}`);
}

function validateManifest(manifest, allowedOrigins) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("不是对象");
  for (const key of Object.keys(manifest)) if (!MANIFEST_KEYS.has(key)) fail(`未知字段 ${key}`);
  if (manifest.schema !== 1) fail("schema 必须为 1");
  if (manifest.target !== "android" && manifest.target !== "desktop") fail("target 无效");
  if (manifest.channel !== "stable") fail("channel 无效");
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) fail("version 必须为 X.Y.Z");
  if (typeof manifest.runtimeVersion !== "string" || !RUNTIME_VERSION.test(manifest.runtimeVersion)) fail("runtimeVersion 格式无效");
  if (typeof manifest.sha256 !== "string" || !HEX64.test(manifest.sha256)) fail("sha256 无效");
  if (manifest.bundleId !== `${manifest.version}-${manifest.sha256.slice(0, 8)}` || !BUNDLE_ID.test(manifest.bundleId)) fail("bundleId 与 version/sha256 不符");
  if (!Number.isSafeInteger(manifest.sequence) || manifest.sequence <= 0) fail("sequence 必须是正整数");
  if (typeof manifest.commit !== "string" || !COMMIT.test(manifest.commit)) fail("commit 必须是完整 SHA");
  if (typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) fail("createdAt 无效");
  if (!Number.isSafeInteger(manifest.size) || manifest.size <= 0 || manifest.size > MAX_BUNDLE_BYTES) fail("size 超出范围");
  if (typeof manifest.zipSignature !== "string" || !BASE64.test(manifest.zipSignature)) fail("zipSignature 无效");
  if (!Array.isArray(manifest.urls) || manifest.urls.length < 1 || manifest.urls.length > 4) fail("urls 数量无效");
  for (const url of manifest.urls) {
    let parsed;
    try { parsed = new URL(String(url)); } catch { fail(`url 无效：${String(url)}`); }
    if (!allowedOrigins.includes(parsed.origin) || parsed.username || parsed.password || parsed.search || parsed.hash) fail(`url 不在允许范围：${String(url)}`);
  }
  if (manifest.target === "desktop" && (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files) || !Object.keys(manifest.files).length)) {
    fail("桌面清单必须包含 files");
  }
  if (manifest.files !== undefined) {
    if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) fail("files 必须是对象");
    for (const [file, digest] of Object.entries(manifest.files)) {
      if (!file || typeof digest !== "string" || !HEX64.test(digest)) fail(`files 条目无效：${file}`);
    }
  }
  if (!Array.isArray(manifest.revokedBundleIds) || manifest.revokedBundleIds.length > 100) fail("revokedBundleIds 无效");
  for (const id of manifest.revokedBundleIds) if (typeof id !== "string" || !BUNDLE_ID.test(id)) fail(`revokedBundleIds 条目无效：${String(id)}`);
  return manifest;
}

/**
 * 验签并解析签名信封。只认安装包信任的 keyId；签名不对整体拒绝。
 * @param {Buffer} bytes
 * @param {{ key: import("node:crypto").KeyObject, keyId: string, allowedOrigins: string[] }} trust
 */
function openEnvelope(bytes, trust) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ENVELOPE_BYTES) throw new Error("签名信封大小无效");
  let envelope;
  try { envelope = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("签名信封不是有效 JSON"); }
  if (!envelope || envelope.schema !== 1 || typeof envelope.payload !== "string" || !BASE64.test(envelope.payload)) throw new Error("签名信封格式无效");
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length < 1 || envelope.signatures.length > 4) throw new Error("签名信封缺少签名");
  for (const item of envelope.signatures) {
    if (!item || !KEY_ID.test(item.keyId || "") || item.algorithm !== SIGNATURE_ALGORITHM || typeof item.signature !== "string" || !BASE64.test(item.signature)) {
      throw new Error("签名信封里的签名条目无效");
    }
  }
  const payload = Buffer.from(envelope.payload, "base64");
  if (payload.toString("base64") !== envelope.payload) throw new Error("签名信封 payload 不是规范 base64");
  const signature = envelope.signatures.find((item) => item.keyId === trust.keyId);
  if (!signature) throw new Error("签名信封没有安装包信任的签名");
  if (!verifyBytes(trust.key, payload, signature.signature)) throw new Error("签名校验失败");
  let manifest;
  try { manifest = JSON.parse(payload.toString("utf8")); } catch { throw new Error("清单不是有效 JSON"); }
  return validateManifest(manifest, trust.allowedOrigins);
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = SEMVER.exec(String(value));
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

/** 是否接受一个已验签的清单。规则与安卓端 frontend/src/lib/hotUpdate/policy.ts 相同。 */
function decide({ manifest, runtimeVersion, currentVersion, maxSequence, blockedBundleIds, pendingBundleId }) {
  if (manifest.target !== "desktop") return { action: "skip", reason: "target-mismatch" };
  if (manifest.runtimeVersion !== runtimeVersion) return { action: "skip", reason: "runtime-mismatch" };
  if (manifest.sequence < maxSequence) return { action: "skip", reason: "stale-sequence" };
  if (manifest.revokedBundleIds.includes(manifest.bundleId)) return { action: "skip", reason: "revoked" };
  if (blockedBundleIds.includes(manifest.bundleId)) return { action: "skip", reason: "blocked" };
  if (compareVersions(manifest.version, currentVersion) <= 0) return { action: "skip", reason: "not-newer" };
  if (pendingBundleId === manifest.bundleId) return { action: "skip", reason: "already-pending" };
  return { action: "download" };
}

function describeSkip(reason) {
  switch (reason) {
    case "not-newer":
    case "already-pending":
      return "当前已是最新版本";
    case "runtime-mismatch":
    case "target-mismatch":
      return "新版本需要安装新的安装包";
    case "blocked":
      return "上次更新启动失败，已跳过这个版本";
    case "revoked":
      return "这个版本已被撤回";
    case "stale-sequence":
      return "收到的版本信息比已知的旧，已忽略";
    default:
      return "";
  }
}

module.exports = {
  SIGNATURE_ALGORITHM,
  compareVersions,
  decide,
  describeSkip,
  loadTrustedKey,
  openEnvelope,
  publicKeyId,
  sha256Hex,
  validateManifest,
  verifyBytes,
};
