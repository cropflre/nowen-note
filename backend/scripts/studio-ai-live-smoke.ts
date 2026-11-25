/**
 * Explicit opt-in live AI provider smoke.
 *
 * Usage (from backend/):
 *   STUDIO_AI_SMOKE_URL=https://provider.example/v1 \
 *   STUDIO_AI_SMOKE_MODEL=your-model STUDIO_AI_SMOKE_KEY=... \
 *   node --import tsx scripts/studio-ai-live-smoke.ts
 *
 * Only synthetic inputs leave this process. No database or production user
 * credentials are loaded, and neither the key nor upstream response is logged.
 */
import { callAIChat, type AISettings } from "../src/services/ai-client.js";
import { buildStudioAIChatMessages, parsePersonalAIResponse } from "../src/plugins/personalStudioAI.js";

const baseUrl = (process.env.STUDIO_AI_SMOKE_URL || "").trim();
const model = (process.env.STUDIO_AI_SMOKE_MODEL || "").trim();
const provider = (process.env.STUDIO_AI_SMOKE_PROVIDER || "openai").trim();
const key = process.env.STUDIO_AI_SMOKE_KEY || "";
const local = provider === "ollama" || provider === "lmstudio";
if (!baseUrl || !model || (!local && !key)) {
  process.stderr.write("Studio live smoke requires STUDIO_AI_SMOKE_URL, STUDIO_AI_SMOKE_MODEL and STUDIO_AI_SMOKE_KEY (unless ollama/lmstudio).\n");
  process.exitCode = 2;
} else {
  const config: AISettings = {
    ai_provider: provider, ai_api_url: baseUrl, ai_api_key: key, ai_model: model,
    ai_embedding_profile_id: "", ai_embedding_url: "", ai_embedding_key: "", ai_embedding_model: "",
  };
  try {
    const response = await callAIChat(config, buildStudioAIChatMessages(
      "Create a simple personal project tracker with project title and completion checkbox. Keep the app tiny."
    ), { temperature: 0.2, max_tokens: 1200, timeout_ms: 25000 });
    const spec = parsePersonalAIResponse(response);
    if (!spec.fields.some(f => f.type === "text") || spec.items.length !== 0) throw new Error("SCHEMA_EXPECTATION_FAILED");
    process.stdout.write("STUDIO_LIVE_SMOKE_PASS: provider contract, strict AppSpec schema, no code or records accepted.\n");
  } catch {
    // Never expose response or credential-bearing upstream exceptions in CI logs.
    process.stderr.write("STUDIO_LIVE_SMOKE_FAILED: check provider compatibility, model output and private diagnostics.\n");
    process.exitCode = 1;
  }
}
