import {
  nowenInstanceIdentityRepository,
} from "../repositories/nowenInstanceIdentityRepository";

const VALID_INSTANCE_ID = /^[A-Za-z0-9._:-]{8,160}$/;

function normalized(value: unknown): string | null {
  const candidate = String(value || "").trim();
  return candidate && VALID_INSTANCE_ID.test(candidate) ? candidate : null;
}

/**
 * Legacy synchronous accessor used by SQLite module-load compatibility code.
 * PostgreSQL mode deliberately avoids touching SQLite; actual exports use the async accessor below.
 */
export function getNowenInstanceId(): string {
  const configured = normalized(process.env.NOWEN_INSTANCE_ID);
  if (configured) return configured;
  if (process.env.DB_DRIVER === "postgres") return "";
  return normalized(nowenInstanceIdentityRepository.getOrCreateSync()) || "";
}

export async function getNowenInstanceIdAsync(): Promise<string> {
  const configured = normalized(process.env.NOWEN_INSTANCE_ID);
  if (configured) return configured;
  const persisted = await nowenInstanceIdentityRepository.getOrCreateAsync();
  return normalized(persisted) || persisted;
}

/** The existing exporter reads NOWEN_INSTANCE_ID while building manifest.json. */
export function ensureNowenInstanceEnvironment(): string {
  const id = getNowenInstanceId();
  if (id && !normalized(process.env.NOWEN_INSTANCE_ID)) process.env.NOWEN_INSTANCE_ID = id;
  return id;
}

/** Runtime-provider path used before every stable package export. */
export async function ensureNowenInstanceEnvironmentAsync(): Promise<string> {
  const id = await getNowenInstanceIdAsync();
  if (!normalized(process.env.NOWEN_INSTANCE_ID)) process.env.NOWEN_INSTANCE_ID = id;
  return id;
}
