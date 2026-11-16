import { systemSettingsRepository } from "../repositories";

/**
 * Instance-wide switch for the AI conversation archive. It is off until an administrator turns it on in
 * Settings → Switches, so the archive API, the navigation entry and browser capture stay unavailable by default.
 * Data-safety rules for archives that already exist (notebook deletion, account transfer) do not depend on it.
 */
export const AI_MEMORY_FEATURE_KEY = "feature_ai_memory_enabled";

export function isAIMemoryEnabled(): boolean {
  return systemSettingsRepository.get(AI_MEMORY_FEATURE_KEY)?.value === "true";
}
