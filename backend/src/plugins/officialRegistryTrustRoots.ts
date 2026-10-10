import compiledTrustRoots from "./official-registry-trust-roots.json";

export interface OfficialRegistryTrustRoot {
  sourceId: string;
  sourceName: string;
  indexUrl: string;
  keyId: string;
  algorithm: "Ed25519";
  publicKey: string;
  sequence: number;
  state: "active" | "revoked";
  validFrom: string;
  validUntil: string;
}

const ROOT_FIELDS = new Set([
  "sourceId", "sourceName", "indexUrl", "keyId", "algorithm", "publicKey",
  "sequence", "state", "validFrom", "validUntil",
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function invalidRoot(index: number, message: string): never {
  throw Object.assign(new Error(`Official Registry 编译信任根无效 [${index}]: ${message}`), {
    code: "OFFICIAL_REGISTRY_TRUST_ROOT_INVALID",
  });
}

function normalizeCompiledRoot(value: unknown, index: number): OfficialRegistryTrustRoot {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidRoot(index, "必须是对象");
  const root = value as Record<string, unknown>;
  if (Object.keys(root).some((key) => !ROOT_FIELDS.has(key)) || Object.keys(root).length !== ROOT_FIELDS.size) {
    invalidRoot(index, "字段集合不合法");
  }
  if (typeof root.sourceId !== "string" || !ID_PATTERN.test(root.sourceId)) invalidRoot(index, "sourceId 不合法");
  if (typeof root.sourceName !== "string" || !root.sourceName.trim() || root.sourceName.length > 128) invalidRoot(index, "sourceName 不合法");
  if (typeof root.keyId !== "string" || !ID_PATTERN.test(root.keyId)) invalidRoot(index, "keyId 不合法");
  if (root.algorithm !== "Ed25519") invalidRoot(index, "algorithm 必须是 Ed25519");
  if (typeof root.publicKey !== "string" || !root.publicKey.trim() || root.publicKey.length > 8192
    || /PRIVATE KEY/.test(root.publicKey)) invalidRoot(index, "publicKey 不合法");
  if (!Number.isSafeInteger(root.sequence) || Number(root.sequence) < 0) invalidRoot(index, "sequence 不合法");
  if (root.state !== "active" && root.state !== "revoked") invalidRoot(index, "state 不合法");
  if (typeof root.validFrom !== "string" || typeof root.validUntil !== "string") invalidRoot(index, "有效期字段不合法");
  const validFrom = Date.parse(root.validFrom);
  const validUntil = Date.parse(root.validUntil);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validUntil) || validUntil <= validFrom) invalidRoot(index, "有效期不合法");
  if (typeof root.indexUrl !== "string") invalidRoot(index, "indexUrl 不合法");
  let url: URL;
  try { url = new URL(root.indexUrl); }
  catch { invalidRoot(index, "indexUrl 不是有效 URL"); }
  if (url!.protocol !== "https:" || url!.username || url!.password || url!.hash) {
    invalidRoot(index, "indexUrl 必须是无凭证、无片段的 HTTPS URL");
  }
  return Object.freeze({
    sourceId: root.sourceId,
    sourceName: root.sourceName,
    indexUrl: root.indexUrl,
    keyId: root.keyId,
    algorithm: "Ed25519" as const,
    publicKey: root.publicKey,
    sequence: Number(root.sequence),
    state: root.state,
    validFrom: root.validFrom,
    validUntil: root.validUntil,
  });
}

function loadCompiledRoots(): readonly OfficialRegistryTrustRoot[] {
  const input: unknown = compiledTrustRoots;
  if (!Array.isArray(input)) invalidRoot(-1, "根文件必须是数组");
  const roots = input.map(normalizeCompiledRoot);
  const coordinates = new Set<string>();
  const sources = new Set<string>();
  const activeBySource = new Map<string, number>();
  for (const root of roots) {
    const coordinate = `${root.sourceId}\u0000${root.keyId}`;
    if (coordinates.has(coordinate)) invalidRoot(-1, `重复根坐标 ${root.sourceId}/${root.keyId}`);
    coordinates.add(coordinate);
    sources.add(root.sourceId);
    if (root.state === "active") activeBySource.set(root.sourceId, (activeBySource.get(root.sourceId) || 0) + 1);
  }
  for (const sourceId of sources) {
    const count = activeBySource.get(sourceId) || 0;
    if (count !== 1) invalidRoot(-1, `source ${sourceId} 必须且只能有一个 active 编译根`);
  }
  return Object.freeze(roots);
}

/**
 * Official Registry 信任根只能从随发布包编译的 JSON 读取，不能由远端响应或管理 API 注入。
 * 开发源码默认保留空数组；正式发布必须先通过 scripts/generate-official-registry-trust-roots.mjs
 * 写入真实 Ed25519 公钥，再执行 scripts/verify-extension-ecosystem-rc1.mjs。
 */
export const OFFICIAL_REGISTRY_TRUST_ROOTS: readonly OfficialRegistryTrustRoot[] = loadCompiledRoots();

export const RESERVED_OFFICIAL_REGISTRY_SOURCE_IDS: ReadonlySet<string> = new Set([
  "official-v2",
  ...OFFICIAL_REGISTRY_TRUST_ROOTS.map((root) => root.sourceId),
]);

export function officialTrustRootsFor(sourceId: string): readonly OfficialRegistryTrustRoot[] {
  return OFFICIAL_REGISTRY_TRUST_ROOTS.filter((root) => root.sourceId === sourceId);
}
