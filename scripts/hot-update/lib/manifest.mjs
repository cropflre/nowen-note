// 热更新清单与签名信封。
//
// 发布到外面的只有两种文件：
//   nowen-hot-<target>-<version>.zip         热更新包本体
//   nowen-hot-<target>-<runtimeVersion>.json 签名信封：{ schema, payload: base64(清单 JSON), signatures }
// 清单和签名放在同一个文件里，R2 渠道地址覆盖时是一次原子写入，客户端不会读到"新清单 + 旧签名"。
import { createHash } from "node:crypto";
import { SIGNATURE_ALGORITHM, verifyBytes } from "./keys.mjs";

export const TARGETS = ["android", "desktop"];
export const CHANNEL = "stable";
export const REPOSITORY = "cropflre/nowen-note";
export const DOWNLOAD_ORIGIN = "https://download.nowen.cn";
export const ALLOWED_URL_HOSTS = ["download.nowen.cn", "github.com"];
export const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const RUNTIME_VERSION = /^e[1-9]\d{0,5}-[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const BUNDLE_ID = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[0-9a-f]{8}$/;
const MANIFEST_KEYS = [
  "schema", "target", "channel", "version", "runtimeVersion", "bundleId", "sequence", "commit", "createdAt",
  "size", "sha256", "zipSignature", "urls", "files", "revokedBundleIds",
];

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function assetNames(target, version, runtimeVersion) {
  return { zip: `nowen-hot-${target}-${version}.zip`, manifest: `nowen-hot-${target}-${runtimeVersion}.json` };
}

export function bundleUrls(tag, zipName) {
  return [
    `${DOWNLOAD_ORIGIN}/hot/${tag}/${zipName}`,
    `https://github.com/${REPOSITORY}/releases/download/${tag}/${zipName}`,
  ];
}

/** 客户端固定读取的渠道地址（R2 上就地覆盖）。 */
export function channelPointerKey(target, runtimeVersion) {
  return `hot/${CHANNEL}/${target}/${runtimeVersion}.json`;
}

function fail(message) {
  throw new Error(`热更新清单无效：${message}`);
}

/** 按固定字段顺序重建对象，保证序列化结果稳定。 */
export function orderManifest(manifest) {
  const ordered = {};
  for (const key of MANIFEST_KEYS) if (manifest[key] !== undefined) ordered[key] = manifest[key];
  return ordered;
}

/**
 * 严格校验清单字段。draft=true 时允许 zipSignature 为 null（签名前的草稿）。
 * 只认识的字段才放行，避免客户端把未签名约定的字段当真。
 */
export function validateManifest(manifest, { draft = false } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("不是对象");
  for (const key of Object.keys(manifest)) if (!MANIFEST_KEYS.includes(key)) fail(`未知字段 ${key}`);
  if (manifest.schema !== 1) fail("schema 必须为 1");
  if (!TARGETS.includes(manifest.target)) fail("target 无效");
  if (manifest.channel !== CHANNEL) fail("channel 无效");
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) fail("version 必须为 X.Y.Z");
  if (typeof manifest.runtimeVersion !== "string" || !RUNTIME_VERSION.test(manifest.runtimeVersion)) fail("runtimeVersion 格式无效");
  if (typeof manifest.sha256 !== "string" || !HEX64.test(manifest.sha256)) fail("sha256 无效");
  if (manifest.bundleId !== `${manifest.version}-${manifest.sha256.slice(0, 8)}` || !BUNDLE_ID.test(manifest.bundleId)) fail("bundleId 与 version/sha256 不符");
  if (!Number.isSafeInteger(manifest.sequence) || manifest.sequence <= 0) fail("sequence 必须是正整数");
  if (typeof manifest.commit !== "string" || !COMMIT.test(manifest.commit)) fail("commit 必须是完整 SHA");
  if (typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) fail("createdAt 无效");
  if (!Number.isSafeInteger(manifest.size) || manifest.size <= 0 || manifest.size > MAX_BUNDLE_BYTES) fail("size 超出范围");
  if (draft ? manifest.zipSignature !== null : typeof manifest.zipSignature !== "string" || !BASE64.test(manifest.zipSignature)) {
    fail("zipSignature 无效");
  }
  if (!Array.isArray(manifest.urls) || manifest.urls.length < 1 || manifest.urls.length > 4) fail("urls 数量无效");
  for (const url of manifest.urls) {
    let parsed;
    try { parsed = new URL(url); } catch { fail(`url 无效：${url}`); }
    if (parsed.protocol !== "https:" || !ALLOWED_URL_HOSTS.includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      fail(`url 不在允许范围：${url}`);
    }
  }
  if (manifest.target === "desktop") {
    if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files) || !Object.keys(manifest.files).length) fail("桌面清单必须包含 files");
  }
  if (manifest.files !== undefined) {
    if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) fail("files 必须是对象");
    for (const [file, digest] of Object.entries(manifest.files)) {
      if (typeof digest !== "string" || !HEX64.test(digest) || !file) fail(`files 条目无效：${file}`);
    }
  }
  if (!Array.isArray(manifest.revokedBundleIds) || manifest.revokedBundleIds.length > 100) fail("revokedBundleIds 无效");
  for (const id of manifest.revokedBundleIds) if (typeof id !== "string" || !BUNDLE_ID.test(id)) fail(`revokedBundleIds 条目无效：${id}`);
  return manifest;
}

export function buildDraftManifest({ target, version, runtimeVersion, commit, commitTime, zip, files, revokedBundleIds = [] }) {
  const sha256 = sha256Hex(zip);
  const names = assetNames(target, version, runtimeVersion);
  const manifest = orderManifest({
    schema: 1,
    target,
    channel: CHANNEL,
    version,
    runtimeVersion,
    bundleId: `${version}-${sha256.slice(0, 8)}`,
    // 用提交时间当序号：同一提交重复构建得到同一序号，后发版本的提交时间更晚。
    sequence: commitTime,
    commit,
    createdAt: new Date(commitTime * 1000).toISOString(),
    size: zip.length,
    sha256,
    zipSignature: null,
    urls: bundleUrls(`v${version}`, names.zip),
    files,
    revokedBundleIds: [...revokedBundleIds],
  });
  return validateManifest(manifest, { draft: true });
}

export function serializeManifest(manifest) {
  return Buffer.from(`${JSON.stringify(orderManifest(manifest), null, 2)}\n`, "utf8");
}

export function encodeEnvelope(payload, signatures) {
  return Buffer.from(`${JSON.stringify({ schema: 1, payload: payload.toString("base64"), signatures }, null, 2)}\n`, "utf8");
}

export function decodeEnvelope(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ENVELOPE_BYTES) throw new Error("签名信封大小无效");
  let envelope;
  try { envelope = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("签名信封不是有效 JSON"); }
  if (!envelope || envelope.schema !== 1 || typeof envelope.payload !== "string" || !BASE64.test(envelope.payload)) {
    throw new Error("签名信封格式无效");
  }
  const payload = Buffer.from(envelope.payload, "base64");
  // 只接受规范 base64，签名覆盖的字节必须唯一。
  if (payload.toString("base64") !== envelope.payload) throw new Error("签名信封 payload 不是规范 base64");
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length < 1 || envelope.signatures.length > 4) {
    throw new Error("签名信封缺少签名");
  }
  for (const item of envelope.signatures) {
    if (!item || !KEY_ID.test(item.keyId || "") || item.algorithm !== SIGNATURE_ALGORITHM || typeof item.signature !== "string" || !BASE64.test(item.signature)) {
      throw new Error("签名信封里的签名条目无效");
    }
  }
  return { payload, signatures: envelope.signatures };
}

/**
 * 验签并解析清单。必须至少有一个受信任公钥的签名；受信任公钥的签名只要有一个不通过就整体拒绝。
 * @param {Buffer} bytes
 * @param {Map<string, import("node:crypto").KeyObject>} trustedKeys
 */
export function openEnvelope(bytes, trustedKeys) {
  const { payload, signatures } = decodeEnvelope(bytes);
  const trusted = signatures.filter((item) => trustedKeys.has(item.keyId));
  if (!trusted.length) throw new Error("签名信封没有受信任公钥的签名");
  for (const item of trusted) {
    if (!verifyBytes(trustedKeys.get(item.keyId), payload, item.signature)) throw new Error(`签名校验失败（公钥 ${item.keyId}）`);
  }
  let manifest;
  try { manifest = JSON.parse(payload.toString("utf8")); } catch { throw new Error("清单不是有效 JSON"); }
  return { manifest: validateManifest(manifest), payload, keyIds: trusted.map((item) => item.keyId) };
}
