import { createHash } from "node:crypto";
import { z } from "zod";
import { aiOutboundFetch } from "../services/ai-outbound-fetch.js";
import type { AISettings } from "../services/ai-client.js";
import { buildAIHeaders, hasAIAuth } from "../services/ai-provider-config.js";

const evidence = new Map<string, { toolCalling: boolean; streaming: boolean; checkedAt: number }>();
const configurationKey = (settings: AISettings) => createHash("sha256").update(JSON.stringify(settings)).digest("hex");
export function agentModelCapabilities(settings: AISettings) {
  if (settings.ai_provider === "anthropic") return { chat: true, toolCalling: false, streaming: true, structuredOutput: "unverified", embedding: false, vision: "unverified", reasoning: "unverified", contextWindow: null };
  const observed = evidence.get(configurationKey(settings));
  return { chat: true, toolCalling: observed && Date.now() - observed.checkedAt < 3600000 ? observed.toolCalling : "unverified", streaming: observed?.streaming ?? "unverified", structuredOutput: "unverified", embedding: "unverified", vision: "unverified", reasoning: "unverified", contextWindow: null };
}
const callSchema = z.object({ id: z.string().min(1).max(200), type: z.literal("function"), function: z.object({ name: z.string().max(100), arguments: z.string().max(100_000) }) });
export type ToolCall = z.infer<typeof callSchema>;
export interface ToolDefinition { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface AgentMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }

/** Match the existing AI routes: local providers may run without an API key. */
export function agentModelConfigured(settings: AISettings): boolean {
  return Boolean(settings.ai_api_url.trim() && settings.ai_model.trim()
    && hasAIAuth(settings));
}

/** Incremental SSE parsing keeps separate indices and concatenates only protocol argument deltas. */
export async function readAgentResponse(response: Response): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("MODEL_REQUEST_FAILED");
  const streaming = response.headers.get("content-type")?.includes("text/event-stream");
  const decoder = new TextDecoder();
  let buffer = "", total = 0, done = false, usage: unknown;
  const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return;
    const value = line.slice(5).trim();
    if (!value) return;
    if (value === "[DONE]") { done = true; return; }
    const event = JSON.parse(value);
    if (event.usage) usage = event.usage;
    for (const delta of event.choices?.[0]?.delta?.tool_calls || []) {
      if (!Number.isInteger(delta.index) || delta.index < 0 || delta.index >= 12) throw new Error("INVALID_TOOL_CALL");
      const call = calls.get(delta.index) || { id: "", type: "function", function: { name: "", arguments: "" } };
      if (delta.id) call.id += delta.id;
      if (delta.type && delta.type !== "function") throw new Error("INVALID_TOOL_CALL");
      if (delta.function?.name) call.function.name += delta.function.name;
      if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
      calls.set(delta.index, call);
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > 400_000) throw new Error("MODEL_OUTPUT_LIMIT");
      buffer += decoder.decode(chunk.value, { stream: true });
      if (streaming) {
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) { consume(buffer.slice(0, end).replace(/\r$/, "")); buffer = buffer.slice(end + 1); }
      }
    }
    buffer += decoder.decode();
    if (!streaming) return JSON.parse(buffer);
    if (buffer.trim()) consume(buffer);
    if (!done) throw new Error("MODEL_REQUEST_FAILED");
    return { choices: [{ message: { tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value) } }], usage };
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Separate from legacy text extraction: tool arguments are never interpreted as Markdown. */
export async function callAgentModel(settings: AISettings, messages: AgentMessage[], tools: ToolDefinition[], signal: AbortSignal) {
  if (!agentModelConfigured(settings)) throw Object.assign(new Error("AI_NOT_CONFIGURED"), { code: "AI_NOT_CONFIGURED", status: 400 });
  if (settings.ai_provider === "anthropic") throw new Error("TOOL_CALLING_UNSUPPORTED");
  // DeepSeek rejects required tool_choice in thinking mode. Select by provider
  // or official endpoint, never by a guessed model-name capability.
  const deepseek = settings.ai_provider === "deepseek" || new URL(settings.ai_api_url).hostname === "api.deepseek.com";
  const response = await aiOutboundFetch(`${settings.ai_api_url.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: buildAIHeaders(settings.ai_provider, settings.ai_api_key, settings.ai_custom_headers),
    body: JSON.stringify({ model: settings.ai_model, messages, tools, tool_choice: "required", stream: true, max_tokens: 4096, ...(deepseek ? { thinking: { type: "disabled" } } : {}) }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
    redirect: "error",
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 400 || response.status === 422 ? "TOOL_CALLING_UNSUPPORTED" : "MODEL_REQUEST_FAILED"); }
  const data = await readAgentResponse(response);
  const calls = z.array(callSchema).min(1).max(12).safeParse(data?.choices?.[0]?.message?.tool_calls);
  if (evidence.size >= 256) evidence.delete(evidence.keys().next().value!);
  evidence.set(configurationKey(settings), { toolCalling: calls.success, streaming: response.headers.get("content-type")?.includes("text/event-stream") || false, checkedAt: Date.now() });
  if (!calls.success) throw new Error("TOOL_CALLING_UNSUPPORTED");
  if (new Set(calls.data.map(c => c.id)).size !== calls.data.length) throw new Error("INVALID_TOOL_CALL");
  return { calls: calls.data, usage: Number.isSafeInteger(data.usage?.total_tokens) && data.usage.total_tokens >= 0 ? data.usage.total_tokens : null };
}
