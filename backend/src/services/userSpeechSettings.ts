import { userAISettingsRepository } from "../repositories/userAISettingsRepository";

export interface SpeechSettings { apiUrl: string; apiKey: string; model: string; language: string | null }
const keys = ["speech_api_url", "speech_api_key", "speech_model", "speech_language"];

export function getUserSpeechSettings(userId: string): SpeechSettings {
  const values = Object.fromEntries(userAISettingsRepository.getMany(userId, keys).map((row) => [row.key, row.value]));
  return { apiUrl: values.speech_api_url || "", apiKey: values.speech_api_key || "", model: values.speech_model || "whisper-1", language: values.speech_language || null };
}

export function setUserSpeechSettings(userId: string, settings: Omit<SpeechSettings, "apiKey"> & { apiKey?: string }): void {
  const entries = [
    { key: keys[0], value: settings.apiUrl },
    { key: keys[2], value: settings.model },
    { key: keys[3], value: settings.language || "" },
  ];
  // 不返回密钥；省略 apiKey 表示保留，空字符串表示主动清除。
  if (settings.apiKey !== undefined) entries.push({ key: keys[1], value: settings.apiKey });
  userAISettingsRepository.setMany(userId, entries);
}

export function publicSpeechSettings(settings: SpeechSettings) {
  return { apiUrl: settings.apiUrl, model: settings.model, language: settings.language, apiKeySet: !!settings.apiKey, configured: !!settings.apiUrl && !!settings.model };
}
