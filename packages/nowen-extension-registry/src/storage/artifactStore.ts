export interface ArtifactStore {
  stage(operationId: string, bytes: Buffer): Promise<string>;
  commit(stagedKey: string, sha256: string): Promise<string>;
  read(key: string): Promise<ReadableStream<Uint8Array> | NodeJS.ReadableStream>;
  exists(key: string): Promise<boolean>;
  removeStaged(stagedKey: string): Promise<void>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STAGED_KEY_PATTERN = /^staging\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}-[a-f0-9-]{36}\.nowen-plugin$/;

export function assertSha256(value: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error("artifact sha256 is invalid");
}

export function artifactKeyForDigest(sha256: string): string {
  assertSha256(sha256);
  return `sha256/${sha256.slice(0, 2)}/${sha256}.nowen-plugin`;
}

export function assertArtifactKey(key: string): void {
  const match = /^sha256\/([a-f0-9]{2})\/([a-f0-9]{64})\.nowen-plugin$/.exec(key);
  if (!match || match[1] !== match[2]!.slice(0, 2)) throw new Error("artifact storage key is invalid");
}

export function assertStagedKey(key: string): void {
  if (!STAGED_KEY_PATTERN.test(key)) throw new Error("staged artifact key is invalid");
}

export function createStagedKey(operationId: string, nonce: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) throw new Error("artifact operation id is invalid");
  const key = `staging/${operationId}-${nonce}.nowen-plugin`;
  assertStagedKey(key);
  return key;
}
