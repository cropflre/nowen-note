// 热更新签名用的 RSA 密钥工具。
//
// 算法由安卓插件决定：@capawesome/capacitor-live-update 用 Signature.getInstance("SHA256withRSA")
// 校验 zip，公钥是 X.509 SubjectPublicKeyInfo（PEM "BEGIN PUBLIC KEY"），签名是 base64。
// Node 的 RSA_PKCS1_PADDING + sha256 与之等价；清单信封也用同一算法，客户端只需一套验签逻辑。
import { constants, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

export const SIGNATURE_ALGORITHM = "RSA-SHA256-PKCS1v15";
export const MIN_RSA_BITS = 3072;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function assertRsaKey(key) {
  if (key.asymmetricKeyType !== "rsa") throw new Error("热更新只支持 RSA 密钥（安卓插件按 SHA256withRSA 验签）");
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (!Number.isInteger(bits) || bits < MIN_RSA_BITS) throw new Error(`RSA 密钥长度至少 ${MIN_RSA_BITS} 位`);
  return key;
}

export function loadPublicKey(pem) {
  if (typeof pem !== "string" || !pem.includes("-----BEGIN PUBLIC KEY-----")) {
    throw new Error("公钥必须是 X.509 SubjectPublicKeyInfo PEM（-----BEGIN PUBLIC KEY-----）");
  }
  return assertRsaKey(createPublicKey(pem));
}

export function loadPrivateKey(pem) {
  // GitHub Secret 有时被粘贴成字面量 \n；只在完全没有真实换行时还原。
  const text = typeof pem === "string" && !pem.includes("\n") ? pem.replace(/\\n/g, "\n") : pem;
  if (typeof text !== "string" || !text.includes("PRIVATE KEY-----")) throw new Error("私钥必须是 PEM 格式");
  return assertRsaKey(createPrivateKey(text));
}

/** 公钥 id：SPKI DER 的 SHA-256 前 16 位十六进制。 */
export function publicKeyId(key) {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
}

export function toPublicPem(key) {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  return publicKey.export({ type: "spki", format: "pem" });
}

export function signBytes(privateKey, data) {
  return sign("sha256", data, { key: privateKey, padding: constants.RSA_PKCS1_PADDING }).toString("base64");
}

export function verifyBytes(publicKey, data, signature) {
  if (typeof signature !== "string" || !BASE64.test(signature)) return false;
  try {
    return verify("sha256", data, { key: publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function generateRsaKeyPair() {
  return generateKeyPairSync("rsa", { modulusLength: MIN_RSA_BITS, publicExponent: 0x10001 });
}

/** @returns {Map<string, import("node:crypto").KeyObject>} keyId -> 公钥 */
export function parseTrustedKeys(data) {
  if (!data || data.schema !== 1 || !Array.isArray(data.keys)) throw new Error("公钥列表格式无效（需要 { schema: 1, keys: [] }）");
  const keys = new Map();
  for (const entry of data.keys) {
    const key = loadPublicKey(entry?.pem);
    const id = publicKeyId(key);
    if (entry.id !== id) throw new Error(`公钥 id 与内容不符：${String(entry.id)}（应为 ${id}）`);
    if (keys.has(id)) throw new Error(`公钥重复：${id}`);
    keys.set(id, key);
  }
  return keys;
}

export async function loadTrustedKeys(file) {
  return parseTrustedKeys(JSON.parse(await readFile(file, "utf8")));
}
