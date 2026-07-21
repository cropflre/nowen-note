import "../routes/user-migration-v2-register";

export const DEFAULT_NATIVE_CORS_ORIGINS = [
  "https://localhost",
  "http://localhost",
  "capacitor://localhost",
  "ionic://localhost",
  "null",
];

export const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "X-User-Id",
  "Authorization",
  "X-Sudo-Token",
  "X-Connection-Id",
  "X-Share-Session",
  "X-Requested-With",
  "X-Request-Id",
  "X-Export-Filename",
  "Idempotency-Key",
  "X-Client-Mutation-At",
];

export function resolveCorsOrigins(raw = process.env.CORS_ORIGINS): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function resolveCorsOrigin({
  origin,
  isProd,
  corsOrigins,
}: {
  origin?: string;
  isProd: boolean;
  corsOrigins: string[];
}): string {
  if (!isProd) return origin || "*";
  if (!origin) return "*";
  if (corsOrigins.includes(origin)) return origin;
  if (DEFAULT_NATIVE_CORS_ORIGINS.includes(origin)) return origin;
  return "";
}
