import { getDb } from "../db/schema";

const FALLBACK_SETTING_KEY = "imageHosting:fallbackToLocal";

/**
 * Whether clients may fall back to Nowen's attachment storage when the external image host fails.
 * Legacy installations did not persist this switch, so the compatibility default is true.
 */
export function readImageHostingFallbackToLocal(): boolean {
  try {
    const row = getDb()
      .prepare("SELECT value FROM system_settings WHERE key = ?")
      .get(FALLBACK_SETTING_KEY) as { value?: string } | undefined;
    if (!row) return true;
    const normalized = String(row.value ?? "").trim().toLowerCase();
    return normalized !== "false" && normalized !== "0";
  } catch (error) {
    console.warn("[image-hosting] read fallback policy failed; using safe default", error);
    return true;
  }
}

export function writeImageHostingFallbackToLocal(value: boolean): boolean {
  const normalized = value !== false;
  getDb().prepare(`
    INSERT INTO system_settings (key, value, updatedAt)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt
  `).run(FALLBACK_SETTING_KEY, normalized ? "true" : "false");
  return normalized;
}

export function deleteImageHostingFallbackPolicy(): void {
  getDb().prepare("DELETE FROM system_settings WHERE key = ?").run(FALLBACK_SETTING_KEY);
}
