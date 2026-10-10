import crypto from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OUTPUT = path.join(ROOT, "backend/src/plugins/official-registry-trust-roots.json");
const EXPECTED_FIELDS = [
  "sourceId", "sourceName", "indexUrl", "keyId", "algorithm", "publicKey",
  "sequence", "state", "validFrom", "validUntil",
];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fail(message) {
  throw new Error(`Official Registry 信任根无效: ${message}`);
}

function exactObject(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`[${index}] 必须是对象`);
  const keys = Object.keys(value).sort();
  const expected = [...EXPECTED_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, offset) => key !== expected[offset])) {
    fail(`[${index}] 字段必须严格为 ${expected.join(", ")}`);
  }
}

function validatePublicKey(value, index) {
  if (typeof value !== "string" || !value.trim() || value.length > 8192 || /PRIVATE KEY/.test(value)) {
    fail(`[${index}] publicKey 必须是公开 Ed25519 PEM，不能包含私钥`);
  }
  let key;
  try { key = crypto.createPublicKey(value); }
  catch { fail(`[${index}] publicKey 无法解析`); }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") fail(`[${index}] publicKey 必须是 Ed25519`);
  return key.export({ type: "spki", format: "pem" }).toString();
}

function validateHttpsUrl(value, index) {
  if (typeof value !== "string") fail(`[${index}] indexUrl 必须是字符串`);
  let url;
  try { url = new URL(value); }
  catch { fail(`[${index}] indexUrl 不是有效 URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    fail(`[${index}] indexUrl 必须是无凭证、无片段的 HTTPS URL`);
  }
  return url.href;
}

export function validateTrustRoots(input, { requireNonEmpty = true } = {}) {
  if (!Array.isArray(input)) fail("根文档必须是数组");
  if (requireNonEmpty && input.length === 0) fail("正式发布至少需要一个 Official Registry 信任根");
  const coordinates = new Set();
  const sourceIds = new Set();
  const activeBySource = new Map();
  const roots = input.map((raw, index) => {
    exactObject(raw, index);
    if (typeof raw.sourceId !== "string" || !ID_PATTERN.test(raw.sourceId)) fail(`[${index}] sourceId 不合法`);
    if (typeof raw.sourceName !== "string" || !raw.sourceName.trim() || raw.sourceName.length > 128) fail(`[${index}] sourceName 不合法`);
    if (typeof raw.keyId !== "string" || !ID_PATTERN.test(raw.keyId)) fail(`[${index}] keyId 不合法`);
    if (raw.algorithm !== "Ed25519") fail(`[${index}] algorithm 必须是 Ed25519`);
    if (!Number.isSafeInteger(raw.sequence) || raw.sequence < 0) fail(`[${index}] sequence 必须是非负安全整数`);
    if (raw.state !== "active" && raw.state !== "revoked") fail(`[${index}] state 只能是 active/revoked`);
    if (typeof raw.validFrom !== "string" || typeof raw.validUntil !== "string") fail(`[${index}] 有效期必须是 ISO 时间字符串`);
    const validFrom = Date.parse(raw.validFrom);
    const validUntil = Date.parse(raw.validUntil);
    if (!Number.isFinite(validFrom) || !Number.isFinite(validUntil) || validUntil <= validFrom) fail(`[${index}] 有效期无效`);
    const coordinate = `${raw.sourceId}\u0000${raw.keyId}`;
    if (coordinates.has(coordinate)) fail(`[${index}] 重复 root 坐标 ${raw.sourceId}/${raw.keyId}`);
    coordinates.add(coordinate);
    sourceIds.add(raw.sourceId);
    if (raw.state === "active") activeBySource.set(raw.sourceId, (activeBySource.get(raw.sourceId) || 0) + 1);
    return {
      sourceId: raw.sourceId,
      sourceName: raw.sourceName.trim(),
      indexUrl: validateHttpsUrl(raw.indexUrl, index),
      keyId: raw.keyId,
      algorithm: "Ed25519",
      publicKey: validatePublicKey(raw.publicKey, index),
      sequence: raw.sequence,
      state: raw.state,
      validFrom: new Date(validFrom).toISOString(),
      validUntil: new Date(validUntil).toISOString(),
    };
  });
  for (const sourceId of sourceIds) {
    if ((activeBySource.get(sourceId) || 0) !== 1) fail(`source ${sourceId} 必须且只能配置一个 active 根`);
  }
  return roots.sort((left, right) => left.sourceId.localeCompare(right.sourceId)
    || left.sequence - right.sequence || left.keyId.localeCompare(right.keyId));
}

export function renderTrustRoots(roots) {
  return `${JSON.stringify(roots, null, 2)}\n`;
}

async function atomicWrite(target, content) {
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o644 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseArgs(argv) {
  const result = { input: process.env.NOWEN_OFFICIAL_REGISTRY_TRUST_ROOTS_FILE || "", output: DEFAULT_OUTPUT, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check") result.check = true;
    else if (value === "--input") result.input = argv[++index] || "";
    else if (value.startsWith("--input=")) result.input = value.slice("--input=".length);
    else if (value === "--output") result.output = argv[++index] || "";
    else if (value.startsWith("--output=")) result.output = value.slice("--output=".length);
    else fail(`未知参数 ${value}`);
  }
  if (!result.input) fail("缺少 --input，或未设置 NOWEN_OFFICIAL_REGISTRY_TRUST_ROOTS_FILE");
  if (!result.output) fail("--output 不能为空");
  return result;
}

export async function generateTrustRoots(options) {
  const inputPath = path.resolve(options.input);
  const outputPath = path.resolve(options.output || DEFAULT_OUTPUT);
  const parsed = JSON.parse(await readFile(inputPath, "utf8"));
  const content = renderTrustRoots(validateTrustRoots(parsed));
  if (options.check) {
    const current = await readFile(outputPath, "utf8").catch(() => null);
    if (current !== content) throw new Error(`Official Registry 编译信任根未同步: ${path.relative(ROOT, outputPath)}`);
    return outputPath;
  }
  await atomicWrite(outputPath, content);
  return outputPath;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const target = await generateTrustRoots(options);
    console.log(`${options.check ? "已验证" : "已生成"} Official Registry 信任根: ${path.relative(ROOT, target)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
