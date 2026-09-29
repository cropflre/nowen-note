import {
  normalizePublicWebOrigin,
} from "./public-web-origin";
import { getDb } from "../db/schema";

export const FILE_PUBLIC_ORIGIN_KEY = "site_file_public_origin";
export const FILE_PUBLIC_ORIGIN_SOURCE_KEY = "site_file_public_origin_source";

export type RuntimeFilePublicOriginSource = "settings" | "environment" | "inherit";

export interface RuntimeFilePublicOriginResolution {
  origin: string;
  source: RuntimeFilePublicOriginSource;
}

export function readFilePublicOriginEnv(env: NodeJS.ProcessEnv = process.env): string {
  return normalizePublicWebOrigin(
    env.FILE_PUBLIC_ORIGIN || env.NOWEN_FILE_PUBLIC_ORIGIN || "",
  );
}

export function resolveRuntimeFilePublicOrigin(input: {
  storedOrigin?: unknown;
  storedSource?: unknown;
  envOrigin?: unknown;
}): RuntimeFilePublicOriginResolution {
  const storedOrigin = normalizePublicWebOrigin(input.storedOrigin);
  const storedSource = String(input.storedSource || "").trim();
  const envOrigin = normalizePublicWebOrigin(input.envOrigin);

  if (storedOrigin && storedSource === "settings") {
    return { origin: storedOrigin, source: "settings" };
  }
  if (envOrigin) {
    return { origin: envOrigin, source: "environment" };
  }
  if (storedOrigin && storedSource !== "environment" && storedSource !== "inherit") {
    return { origin: storedOrigin, source: "settings" };
  }
  return { origin: "", source: "inherit" };
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

export function syncRuntimeFilePublicOriginSetting(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeFilePublicOriginResolution {
  const storedOrigin = readSetting(FILE_PUBLIC_ORIGIN_KEY);
  const storedSource = readSetting(FILE_PUBLIC_ORIGIN_SOURCE_KEY);
  const rawEnv = env.FILE_PUBLIC_ORIGIN || env.NOWEN_FILE_PUBLIC_ORIGIN || "";
  const envOrigin = normalizePublicWebOrigin(rawEnv);

  if (String(rawEnv).trim() && !envOrigin) {
    console.warn(
      "[file-public-origin] ignoring invalid FILE_PUBLIC_ORIGIN; expected an http(s) origin without credentials, query or hash",
    );
  }

  const resolved = resolveRuntimeFilePublicOrigin({
    storedOrigin,
    storedSource,
    envOrigin,
  });
  writeSettings([
    { key: FILE_PUBLIC_ORIGIN_KEY, value: resolved.origin },
    { key: FILE_PUBLIC_ORIGIN_SOURCE_KEY, value: resolved.source },
  ]);
  return resolved;
}

export function resolveFilePublicOriginSettingUpdate(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { entries: Array<{ key: string; value: string }> } | { error: string } {
  const raw = String(value ?? "").trim();
  const normalized = normalizePublicWebOrigin(raw);
  if (raw && !normalized) {
    return {
      error: "文件公开地址必须是有效的 HTTP/HTTPS 地址，且不能包含账号、查询参数或锚点",
    };
  }

  if (normalized) {
    return {
      entries: [
        { key: FILE_PUBLIC_ORIGIN_KEY, value: normalized },
        { key: FILE_PUBLIC_ORIGIN_SOURCE_KEY, value: "settings" },
      ],
    };
  }

  const envOrigin = readFilePublicOriginEnv(env);
  return {
    entries: [
      { key: FILE_PUBLIC_ORIGIN_KEY, value: envOrigin },
      { key: FILE_PUBLIC_ORIGIN_SOURCE_KEY, value: envOrigin ? "environment" : "inherit" },
    ],
  };
}
