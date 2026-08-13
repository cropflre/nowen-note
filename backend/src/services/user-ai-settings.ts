import type { DatabaseAdapter } from "../db/adapters/types";
import {
  createUserAISettingsRepository,
  userAISettingsRepository,
  type UserAISettingEntry,
  type UserAISetting,
} from "../repositories/userAISettingsRepository";
import type { AISettings } from "./ai-client";

export const GUARDED_USER_AI_KEYS = [
  "ai_provider",
  "ai_api_url",
  "ai_api_key",
  "ai_model",
  "ai_embedding_profile_id",
  "ai_embedding_url",
  "ai_embedding_key",
  "ai_embedding_model",
] as const;

const USER_AI_SETTING_KEYS = new Set([
  ...GUARDED_USER_AI_KEYS,
  "ai_profiles_v1",
  "ai_active_profile_id",
  "ai_manual_enabled",
]);

const AI_DEFAULTS: AISettings = {
  ai_provider: "openai",
  ai_api_url: "https://api.openai.com/v1",
  ai_api_key: "",
  ai_model: "gpt-4o-mini",
  ai_embedding_profile_id: "",
  ai_embedding_url: "",
  ai_embedding_key: "",
  ai_embedding_model: "",
};

const OLLAMA_DOCKER_URL = process.env.OLLAMA_URL || "";

function requireUserId(userId: string): void {
  if (!userId.trim()) throw new Error("userId is required");
}

function isAllowedKey(key: string): boolean {
  return USER_AI_SETTING_KEYS.has(key) || key.startsWith("ai_disabled_backup_");
}

function validateEntries(entries: UserAISettingEntry[]): void {
  const invalid = entries.find((entry) => !isAllowedKey(entry.key));
  if (invalid) throw new Error(`Unsupported user AI setting key: ${invalid.key}`);
}

function buildAISettings(rows: Pick<UserAISetting, "key" | "value">[]): AISettings {
  const settings: AISettings = { ...AI_DEFAULTS };
  for (const row of rows) {
    (settings as unknown as Record<string, string>)[row.key] = row.value;
  }

  if (
    OLLAMA_DOCKER_URL
    && settings.ai_provider === "ollama"
    && settings.ai_api_url.includes("localhost:11434")
  ) {
    settings.ai_api_url = settings.ai_api_url.replace(
      /http:\/\/localhost:11434/,
      OLLAMA_DOCKER_URL,
    );
  }
  return settings;
}

export function getUserAISetting(userId: string, key: string): string {
  requireUserId(userId);
  if (!isAllowedKey(key)) throw new Error(`Unsupported user AI setting key: ${key}`);
  return userAISettingsRepository.get(userId, key)?.value || "";
}

export function getUserAISettings(userId: string): AISettings {
  requireUserId(userId);
  const rows = userAISettingsRepository.getMany(userId, [...GUARDED_USER_AI_KEYS]);
  return buildAISettings(rows);
}

/**
 * Adapter-backed variant for async runtimes (notably PostgreSQL runtime-only).
 * Supplying the adapter is intentional: it prevents an async route from falling
 * through the legacy synchronous getDb()/SQLite path.
 */
export async function getUserAISettingsAsync(
  userId: string,
  adapter?: DatabaseAdapter,
): Promise<AISettings> {
  requireUserId(userId);
  const repository = adapter
    ? createUserAISettingsRepository(adapter, "CURRENT_TIMESTAMP")
    : userAISettingsRepository;
  const rows = await repository.getManyAsync(userId, [...GUARDED_USER_AI_KEYS]);
  return buildAISettings(rows);
}

export function setUserAISetting(userId: string, key: string, value: string): void {
  setUserAISettings(userId, [{ key, value }]);
}

export function setUserAISettings(userId: string, entries: UserAISettingEntry[]): void {
  requireUserId(userId);
  validateEntries(entries);
  userAISettingsRepository.setMany(userId, entries);
}

export function isManualAIEnabled(userId: string): boolean {
  return getUserAISetting(userId, "ai_manual_enabled") !== "false";
}

export function setGuardedUserAISettings(
  userId: string,
  entries: UserAISettingEntry[],
): void {
  requireUserId(userId);
  validateEntries(entries);
  const guardedKeys = new Set<string>(GUARDED_USER_AI_KEYS);
  const allowedEntries = isManualAIEnabled(userId)
    ? entries
    : entries.filter((entry) => !guardedKeys.has(entry.key));
  userAISettingsRepository.setMany(userId, allowedEntries);
}
