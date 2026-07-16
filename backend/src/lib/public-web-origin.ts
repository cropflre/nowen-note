import { getDb } from "../db/schema";

export const PUBLIC_WEB_ORIGIN_KEY = "site_public_web_origin";
export const PUBLIC_WEB_ORIGIN_SOURCE_KEY = "site_public_web_origin_source";

export type RuntimePublicWebOriginSource = "settings" | "environment" | "current";

export interface RuntimePublicWebOriginResolution {
  origin: string;
  source: RuntimePublicWebOriginSource;
}

export function normalizePublicWebOrigin(value: unknown): string {
  const trimmed = String(value ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password || url.search || url.hash) return "";

    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname === "/" ? "" : pathname}`;
  } catch {
    return "";
  }
}

export function readPublicWebOriginEnv(env: NodeJS.ProcessEnv = process.env): string {
  return normalizePublicWebOrigin(
    env.PUBLIC_WEB_ORIGIN || env.NOWEN_PUBLIC_WEB_ORIGIN || "",
  );
}

/**
 * Resolve the server-side runtime origin without touching storage.
 *
 * Priority:
 *   explicit administrator setting -> container environment -> current request origin fallback.
 * A value previously materialized from an environment variable is deliberately ignored when the
 * variable disappears, so removing PUBLIC_WEB_ORIGIN does not leave a stale public URL behind.
 */
export function resolveRuntimePublicWebOrigin(input: {
  storedOrigin?: unknown;
  storedSource?: unknown;
  envOrigin?: unknown;
}): RuntimePublicWebOriginResolution {
  const storedOrigin = normalizePublicWebOrigin(input.storedOrigin);
  const storedSource = String(input.storedSource || "").trim();
  const envOrigin = normalizePublicWebOrigin(input.envOrigin);

  if (storedOrigin && storedSource === "settings") {
    return { origin: storedOrigin, source: "settings" };
  }
  if (envOrigin) {
    return { origin: envOrigin, source: "environment" };
  }
  // Backward compatibility: a manually inserted value without source metadata is treated as an
  // administrator setting. Environment-materialized values are not retained after env removal.
  if (storedOrigin && storedSource !== "environment") {
    return { origin: storedOrigin, source: "settings" };
  }
  return { origin: "", source: "current" };
}

function readSetting(key: string): string {
  const row = getDb()
    .prepare("SELECT value FROM system_settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value || "";
}

function writeSettings(entries: Array<{ key: string; value: string }>): void {
  if (entries.length === 0) return;
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO system_settings (key, value, "updatedAt")
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      "updatedAt" = datetime('now')
  `);
  db.transaction(() => {
    for (const entry of entries) upsert.run(entry.key, entry.value);
  })();
}

export function syncRuntimePublicWebOriginSetting(
  env: NodeJS.ProcessEnv = process.env,
): RuntimePublicWebOriginResolution {
  const storedOrigin = readSetting(PUBLIC_WEB_ORIGIN_KEY);
  const storedSource = readSetting(PUBLIC_WEB_ORIGIN_SOURCE_KEY);
  const rawEnv = env.PUBLIC_WEB_ORIGIN || env.NOWEN_PUBLIC_WEB_ORIGIN || "";
  const envOrigin = normalizePublicWebOrigin(rawEnv);

  if (String(rawEnv).trim() && !envOrigin) {
    console.warn(
      "[public-web-origin] ignoring invalid PUBLIC_WEB_ORIGIN; expected an http(s) origin without credentials, query or hash",
    );
  }

  const resolved = resolveRuntimePublicWebOrigin({
    storedOrigin,
    storedSource,
    envOrigin,
  });
  writeSettings([
    { key: PUBLIC_WEB_ORIGIN_KEY, value: resolved.origin },
    { key: PUBLIC_WEB_ORIGIN_SOURCE_KEY, value: resolved.source },
  ]);
  return resolved;
}

export function resolvePublicWebOriginSettingUpdate(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { entries: Array<{ key: string; value: string }> } | { error: string } {
  const raw = String(value ?? "").trim();
  const normalized = normalizePublicWebOrigin(raw);
  if (raw && !normalized) {
    return {
      error: "公开分享域名必须是有效的 HTTP/HTTPS 地址，且不能包含账号、查询参数或锚点",
    };
  }

  if (normalized) {
    return {
      entries: [
        { key: PUBLIC_WEB_ORIGIN_KEY, value: normalized },
        { key: PUBLIC_WEB_ORIGIN_SOURCE_KEY, value: "settings" },
      ],
    };
  }

  const envOrigin = readPublicWebOriginEnv(env);
  return {
    entries: [
      { key: PUBLIC_WEB_ORIGIN_KEY, value: envOrigin },
      { key: PUBLIC_WEB_ORIGIN_SOURCE_KEY, value: envOrigin ? "environment" : "current" },
    ],
  };
}
