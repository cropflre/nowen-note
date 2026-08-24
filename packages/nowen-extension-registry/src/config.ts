import crypto from "node:crypto";
import path from "node:path";

export type RegistryEnvironment = "development" | "production";

export type ArtifactStorageConfig =
  | { driver: "local"; root: string }
  | {
    driver: "s3";
    region: string;
    bucket: string;
    prefix: string;
    endpoint?: string;
    forcePathStyle: boolean;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };

export interface RegistryConfig {
  environment: RegistryEnvironment;
  port: number;
  dataRoot: string;
  publicUrl: URL;
  signerKeyId: string;
  signerSequence: number;
  signerValidFrom: string;
  signerValidUntil: string;
  signingPrivateKey: crypto.KeyObject;
  signingPublicKey: crypto.KeyObject;
  signingPublicKeyPem: string;
  initialRoot: {
    keyId: string;
    sequence: 0;
    publicKey: string;
    validFrom: string;
    validUntil: string;
  };
  configuredRootRotations: readonly Record<string, unknown>[];
  metadataTtlSeconds: number;
  sessionSecret: string;
  githubClientId: string;
  githubClientSecret: string;
  githubCallbackUrl: URL;
  allowedOrigins: ReadonlySet<string>;
  trustedProxies: ReadonlySet<string>;
  sessionTtlSeconds: number;
  artifactStorage: ArtifactStorageConfig;
  artifactCdnBaseUrl?: URL;
}

const DEVELOPMENT_DEFAULTS = {
  publicUrl: "http://localhost:4310",
  sessionSecret: "development-only-session-secret-change-me",
  githubClientId: "development-github-client-id",
  githubClientSecret: "development-github-client-secret",
  githubCallbackUrl: "http://localhost:4310/oauth/github/callback",
  allowedOrigins: "http://localhost:4310,http://localhost:5173",
  trustedProxies: "127.0.0.1,::1",
  signerKeyId: "development-registry-ed25519",
  signerSequence: "0",
  signerValidFrom: "1970-01-01T00:00:00.000Z",
  signerValidUntil: "9999-12-31T23:59:59.999Z",
} as const;

function required(env: NodeJS.ProcessEnv, name: string, developmentDefault?: string): string {
  const value = env[name]?.trim();
  if (value) return value;
  if (env.REGISTRY_ENV === "development" && developmentDefault !== undefined) return developmentDefault;
  throw new Error(`${name} is required`);
}

function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function parseNonNegativeInteger(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function parseTimestamp(raw: string, name: string): string {
  if (!Number.isFinite(Date.parse(raw))) throw new Error(`${name} must be an ISO timestamp`);
  return raw;
}

function parseRootRotations(raw: string | undefined): readonly Record<string, unknown>[] {
  if (!raw?.trim()) return [];
  if (raw.length > 256 * 1024) throw new Error("REGISTRY_ROOT_ROTATIONS_JSON exceeds 256KB");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("REGISTRY_ROOT_ROTATIONS_JSON must be valid JSON"); }
  if (!Array.isArray(parsed) || parsed.length > 32 || parsed.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new Error("REGISTRY_ROOT_ROTATIONS_JSON must be an array of at most 32 objects");
  }
  return parsed as Record<string, unknown>[];
}

function loadInitialRoot(
  env: NodeJS.ProcessEnv,
  environment: RegistryEnvironment,
  signer: { keyId: string; sequence: number; publicKey: string; validFrom: string; validUntil: string },
): RegistryConfig["initialRoot"] {
  const configured = ["REGISTRY_INITIAL_ROOT_KEY_ID", "REGISTRY_INITIAL_ROOT_PUBLIC_KEY", "REGISTRY_INITIAL_ROOT_VALID_FROM", "REGISTRY_INITIAL_ROOT_VALID_UNTIL"]
    .some((name) => Boolean(env[name]?.trim()));
  if (!configured && environment === "development" && signer.sequence === 0) {
    return { keyId: signer.keyId, sequence: 0, publicKey: signer.publicKey, validFrom: signer.validFrom, validUntil: signer.validUntil };
  }
  const keyId = required(env, "REGISTRY_INITIAL_ROOT_KEY_ID");
  const publicKeyRaw = required(env, "REGISTRY_INITIAL_ROOT_PUBLIC_KEY").replace(/\\n/g, "\n");
  const validFrom = parseTimestamp(required(env, "REGISTRY_INITIAL_ROOT_VALID_FROM"), "REGISTRY_INITIAL_ROOT_VALID_FROM");
  const validUntil = parseTimestamp(required(env, "REGISTRY_INITIAL_ROOT_VALID_UNTIL"), "REGISTRY_INITIAL_ROOT_VALID_UNTIL");
  if (Date.parse(validUntil) <= Date.parse(validFrom)) throw new Error("REGISTRY initial root validity window is invalid");
  let publicKey: crypto.KeyObject;
  try { publicKey = crypto.createPublicKey(publicKeyRaw); }
  catch { throw new Error("REGISTRY_INITIAL_ROOT_PUBLIC_KEY must be a valid public key"); }
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("REGISTRY_INITIAL_ROOT_PUBLIC_KEY must be Ed25519");
  return {
    keyId,
    sequence: 0,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    validFrom,
    validUntil,
  };
}

function parseUrl(raw: string, name: string, production: boolean): URL {
  const value = new URL(raw);
  if (!/^https?:$/.test(value.protocol)) throw new Error(`${name} must use http or https`);
  if (production && value.protocol !== "https:") throw new Error(`${name} must use https in production`);
  return value;
}

function parseBaseUrl(raw: string, name: string, production: boolean): URL {
  const value = parseUrl(raw, name, production);
  if (value.username || value.password || value.search || value.hash) throw new Error(`${name} cannot contain credentials, query, or fragment`);
  value.pathname = `${value.pathname.replace(/\/+$/g, "")}/`;
  return value;
}

function parseBoolean(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function loadArtifactStorage(env: NodeJS.ProcessEnv, environment: RegistryEnvironment, dataRoot: string): ArtifactStorageConfig {
  const configuredDriver = env.REGISTRY_ARTIFACT_STORE?.trim();
  if (configuredDriver && configuredDriver !== "local" && configuredDriver !== "s3") throw new Error("REGISTRY_ARTIFACT_STORE must be local or s3");
  const driver: "local" | "s3" = configuredDriver === "local" ? "local" : configuredDriver === "s3" ? "s3" : environment === "development" ? "local" : "s3";
  if (driver === "local") {
    if (environment !== "development") throw new Error("local artifact storage is only allowed with REGISTRY_ENV=development");
    return { driver, root: path.resolve(env.REGISTRY_LOCAL_ARTIFACT_ROOT?.trim() || path.join(dataRoot, "artifacts")) };
  }
  const region = required(env, "REGISTRY_S3_REGION");
  const bucket = required(env, "REGISTRY_S3_BUCKET");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("REGISTRY_S3_BUCKET is invalid");
  const prefix = (env.REGISTRY_S3_PREFIX || "").trim().replace(/^\/+|\/+$/g, "");
  if (prefix.split("/").some((segment) => segment === "." || segment === "..")) throw new Error("REGISTRY_S3_PREFIX is invalid");
  const endpoint = env.REGISTRY_S3_ENDPOINT?.trim();
  const endpointUrl = endpoint ? parseUrl(endpoint, "REGISTRY_S3_ENDPOINT", environment === "production") : undefined;
  const accessKeyId = required(env, "AWS_ACCESS_KEY_ID");
  const secretAccessKey = required(env, "AWS_SECRET_ACCESS_KEY");
  const sessionToken = env.AWS_SESSION_TOKEN?.trim();
  return {
    driver,
    region,
    bucket,
    prefix,
    ...(endpointUrl ? { endpoint: endpointUrl.toString() } : {}),
    forcePathStyle: parseBoolean(env.REGISTRY_S3_FORCE_PATH_STYLE, Boolean(endpointUrl), "REGISTRY_S3_FORCE_PATH_STYLE"),
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };
}

function parseList(raw: string, name: string): ReadonlySet<string> {
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`${name} must contain at least one value`);
  return new Set(values);
}

export function loadRegistryConfig(env: NodeJS.ProcessEnv = process.env): RegistryConfig {
  const environment = env.REGISTRY_ENV === "development" ? "development" : "production";
  if (env.REGISTRY_ENV && env.REGISTRY_ENV !== "development" && env.REGISTRY_ENV !== "production") {
    throw new Error("REGISTRY_ENV must be development or production");
  }
  const production = environment === "production";
  const dataRoot = path.resolve(env.REGISTRY_DATA?.trim() || "data");
  const publicUrl = parseUrl(required(env, "REGISTRY_PUBLIC_URL", DEVELOPMENT_DEFAULTS.publicUrl), "REGISTRY_PUBLIC_URL", production);
  const callback = parseUrl(required(env, "GITHUB_OAUTH_CALLBACK_URL", DEVELOPMENT_DEFAULTS.githubCallbackUrl), "GITHUB_OAUTH_CALLBACK_URL", production);
  const allowedOrigins = parseList(required(env, "REGISTRY_ALLOWED_ORIGINS", DEVELOPMENT_DEFAULTS.allowedOrigins), "REGISTRY_ALLOWED_ORIGINS");
  for (const origin of allowedOrigins) {
    const parsed = parseUrl(origin, "REGISTRY_ALLOWED_ORIGINS", production);
    if (parsed.origin !== origin) throw new Error("REGISTRY_ALLOWED_ORIGINS entries must be origins without paths");
  }
  let signingPrivateKeyPem = env.REGISTRY_SIGNING_PRIVATE_KEY?.trim().replace(/\\n/g, "\n") || "";
  if (!signingPrivateKeyPem && environment === "development") signingPrivateKeyPem = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  if (!signingPrivateKeyPem) throw new Error("REGISTRY_SIGNING_PRIVATE_KEY is required");
  let signingPrivateKey: crypto.KeyObject;
  try {
    signingPrivateKey = crypto.createPrivateKey(signingPrivateKeyPem);
  } catch {
    throw new Error("REGISTRY_SIGNING_PRIVATE_KEY must be a valid private key");
  }
  if (signingPrivateKey.asymmetricKeyType !== "ed25519") throw new Error("REGISTRY_SIGNING_PRIVATE_KEY must be an Ed25519 private key");
  const signingPublicKey = crypto.createPublicKey(signingPrivateKey);
  if (signingPublicKey.asymmetricKeyType !== "ed25519") throw new Error("REGISTRY signing public key must be Ed25519");
  const signingPublicKeyPem = signingPublicKey.export({ type: "spki", format: "pem" }).toString();
  const signerSequence = parseNonNegativeInteger(required(env, "REGISTRY_SIGNER_SEQUENCE", DEVELOPMENT_DEFAULTS.signerSequence), "REGISTRY_SIGNER_SEQUENCE");
  const signerValidFrom = parseTimestamp(required(env, "REGISTRY_SIGNER_VALID_FROM", DEVELOPMENT_DEFAULTS.signerValidFrom), "REGISTRY_SIGNER_VALID_FROM");
  const signerValidUntil = parseTimestamp(required(env, "REGISTRY_SIGNER_VALID_UNTIL", DEVELOPMENT_DEFAULTS.signerValidUntil), "REGISTRY_SIGNER_VALID_UNTIL");
  if (Date.parse(signerValidUntil) <= Date.parse(signerValidFrom)) throw new Error("REGISTRY signer validity window is invalid");
  const sessionSecret = required(env, "REGISTRY_SESSION_SECRET", DEVELOPMENT_DEFAULTS.sessionSecret);
  if (production && sessionSecret.length < 32) throw new Error("REGISTRY_SESSION_SECRET must contain at least 32 characters in production");

  const trustedProxies = parseList(required(env, "REGISTRY_TRUSTED_PROXIES", DEVELOPMENT_DEFAULTS.trustedProxies), "REGISTRY_TRUSTED_PROXIES");
  if (trustedProxies.has("*")) throw new Error("REGISTRY_TRUSTED_PROXIES cannot contain a wildcard");
  if (production && callback.origin !== publicUrl.origin) throw new Error("GITHUB_OAUTH_CALLBACK_URL must use the REGISTRY_PUBLIC_URL origin");

  const signerKeyId = required(env, "REGISTRY_SIGNER_KEY_ID", DEVELOPMENT_DEFAULTS.signerKeyId);
  const initialRoot = loadInitialRoot(env, environment, {
    keyId: signerKeyId,
    sequence: signerSequence,
    publicKey: signingPublicKeyPem,
    validFrom: signerValidFrom,
    validUntil: signerValidUntil,
  });

  return Object.freeze({
    environment,
    port: parsePositiveInteger(env.PORT, 4310, "PORT"),
    dataRoot,
    publicUrl,
    signerKeyId,
    signerSequence,
    signerValidFrom,
    signerValidUntil,
    signingPrivateKey,
    signingPublicKey,
    signingPublicKeyPem,
    initialRoot,
    configuredRootRotations: parseRootRotations(env.REGISTRY_ROOT_ROTATIONS_JSON),
    metadataTtlSeconds: parsePositiveInteger(env.REGISTRY_METADATA_TTL_SECONDS, 60 * 60, "REGISTRY_METADATA_TTL_SECONDS"),
    sessionSecret,
    githubClientId: required(env, "GITHUB_CLIENT_ID", DEVELOPMENT_DEFAULTS.githubClientId),
    githubClientSecret: required(env, "GITHUB_CLIENT_SECRET", DEVELOPMENT_DEFAULTS.githubClientSecret),
    githubCallbackUrl: callback,
    allowedOrigins,
    trustedProxies,
    sessionTtlSeconds: parsePositiveInteger(env.REGISTRY_SESSION_TTL_SECONDS, 7 * 24 * 60 * 60, "REGISTRY_SESSION_TTL_SECONDS"),
    artifactStorage: loadArtifactStorage(env, environment, dataRoot),
    ...(env.REGISTRY_ARTIFACT_CDN_BASE_URL?.trim()
      ? { artifactCdnBaseUrl: parseBaseUrl(env.REGISTRY_ARTIFACT_CDN_BASE_URL.trim(), "REGISTRY_ARTIFACT_CDN_BASE_URL", production) }
      : {}),
  });
}
