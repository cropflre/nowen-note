import type { AISettings } from "./ai-client";
import { AppError } from "../lib/app-error";
import { getUserAISetting, getUserAISettings, isManualAIEnabled } from "./user-ai-settings";
import { resolveSharedChatSettings } from "./shared-ai-profiles";
import { resolveRemoteSharedChatSettings } from "./remote-shared-ai";

/** Shared connections are resolved for calls only, never persisted as personal settings. */
export function resolveUserChatSettings(userId: string): AISettings {
  if (!isManualAIEnabled(userId)) {
    throw new AppError("AI_CONFIG_DISABLED", "AI 已关闭，请先在 AI 设置中开启", { status: 409 });
  }
  const personal = getUserAISettings(userId);
  if (!getUserAISetting(userId, "ai_active_shared_profile_id")) return personal;
  const shared = resolveRemoteSharedChatSettings(userId) ?? resolveSharedChatSettings(userId);
  if (!shared) {
    throw new AppError("SHARED_AI_UNAVAILABLE", "当前共享配置不可用，请重新选择", { status: 403 });
  }
  return {
    ...personal, ...shared, shared_ai_user_id: userId,
    ai_embedding_profile_id: personal.ai_embedding_profile_id,
    ai_embedding_url: personal.ai_embedding_url,
    ai_embedding_key: personal.ai_embedding_key,
    ai_embedding_model: personal.ai_embedding_model,
  };
}
