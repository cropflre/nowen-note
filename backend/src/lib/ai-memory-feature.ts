import { systemSettingsRepository } from "../repositories";

/**
 * Instance-wide switch for the AI conversation archive. It is on unless an administrator turned it off in
 * Settings → AI Assistant; only a stored "false" disables the archive API, the navigation entry and browser capture.
 * Data-safety rules for archives that already exist (notebook deletion, account transfer) do not depend on it.
 */
export const AI_MEMORY_FEATURE_KEY = "feature_ai_memory_enabled";

export function isAIMemoryEnabled(): boolean {
  return systemSettingsRepository.get(AI_MEMORY_FEATURE_KEY)?.value !== "false";
}
