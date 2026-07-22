import { systemSettingsRepository } from "../repositories/systemSettingsRepository";

const FALLBACK_SETTING_KEY = "imageHosting:fallbackToLocal";

/**
 * Whether clients may fall back to Nowen's attachment storage when the external image host fails.
 * Legacy installations did not persist this switch, so the compatibility default is true.
 */
export async function readImageHostingFallbackToLocal(): Promise<boolean> {
  try {
    const row = await systemSettingsRepository.getAsync(FALLBACK_SETTING_KEY);
    if (!row) return true;
    const normalized = String(row.value ?? "").trim().toLowerCase();
    return normalized !== "false" && normalized !== "0";
  } catch (error) {
    console.warn("[image-hosting] read fallback policy failed; using safe default", error);
    return true;
  }
}

export async function writeImageHostingFallbackToLocal(value: boolean): Promise<boolean> {
  const normalized = value !== false;
  await systemSettingsRepository.setAsync(
    FALLBACK_SETTING_KEY,
    normalized ? "true" : "false",
  );
  return normalized;
}

export async function deleteImageHostingFallbackPolicy(): Promise<void> {
  await systemSettingsRepository.deleteAsync(FALLBACK_SETTING_KEY);
}
