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

/**
 * Official Registry 信任根必须随客户端编译发布，不能由远端响应或管理 API 注入。
 * 发布版本在写入真实根之前保持空数组，此时 Official Registry 会明确 fail closed。
 */
export const OFFICIAL_REGISTRY_TRUST_ROOTS: readonly OfficialRegistryTrustRoot[] = Object.freeze([]);

export const RESERVED_OFFICIAL_REGISTRY_SOURCE_IDS: ReadonlySet<string> = new Set([
  "official-v2",
  ...OFFICIAL_REGISTRY_TRUST_ROOTS.map((root) => root.sourceId),
]);

export function officialTrustRootsFor(sourceId: string): readonly OfficialRegistryTrustRoot[] {
  return OFFICIAL_REGISTRY_TRUST_ROOTS.filter((root) => root.sourceId === sourceId);
}
