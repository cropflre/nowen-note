import { z } from "zod";
import { AppError } from "../lib/app-error";
import { resolveSharedProfileSettings } from "./shared-ai-profiles";
import { requestAIChat, type ChatMessage } from "./ai-client";
import { aiOutboundFetch } from "./ai-outbound-fetch";
import { buildAIHeaders } from "./ai-provider-config";
import { redactSharedAIResponse } from "./shared-ai-response";

const toolCall = z.object({ id: z.string().max(200), type: z.literal("function"), function: z.object({ name: z.string().max(100), arguments: z.string().max(100_000) }).strict() }).strict();
const message = z.object({ role: z.enum(["system", "user", "assistant", "tool"]), content: z.string().max(500_000).nullable(), tool_calls: z.array(toolCall).max(12).optional(), tool_call_id: z.string().max(200).optional() }).strict();
const invocation = z.object({
  messages: z.array(message).min(1).max(128),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(32768).optional(),
  stream: z.boolean().optional(),
  response_format: z.object({ type: z.literal("json_object") }).strict().optional(),
  tools: z.array(z.object({ type: z.literal("function"), function: z.object({ name: z.string().max(100), description: z.string().max(4000), parameters: z.record(z.unknown()) }).strict() }).strict()).max(64).optional(),
  tool_choice: z.literal("required").optional(),
}).strict();

/** Only model input crosses this channel. It cannot select an upstream or execute server tools. */
export async function createSharedAIInvocationResponse(userId: string, profileId: string, rawBody: unknown, signal?: AbortSignal): Promise<Response> {
  const parsed = invocation.safeParse(rawBody);
  if (!parsed.success || JSON.stringify(rawBody).length > 1_000_000) throw new AppError("AI_SHARED_INVALID_INPUT", "共享模型请求参数无效", { status: 400 });
  const body = parsed.data;
  const settings = resolveSharedProfileSettings(userId, profileId);
  let response: Response;
  if (body.tools?.length) {
    if (settings.ai_provider === "anthropic") throw new AppError("TOOL_CALLING_UNSUPPORTED", "此模型不支持当前 Agent 工具调用协议", { status: 400 });
    const host = new URL(settings.ai_api_url).hostname;
    const deepseek = settings.ai_provider === "deepseek" || host === "api.deepseek.com";
    const bailian = ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"].includes(host) || host.endsWith(".maas.aliyuncs.com");
    response = await aiOutboundFetch(`${settings.ai_api_url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST", headers: buildAIHeaders(settings.ai_provider, settings.ai_api_key, settings.ai_custom_headers),
      body: JSON.stringify({ ...body, model: settings.ai_model, ...(bailian ? { enable_thinking: false } : deepseek ? { thinking: { type: "disabled" } } : {}) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000), redirect: "error",
    });
  } else {
    response = await requestAIChat(settings, body.messages as ChatMessage[], { temperature: body.temperature, max_tokens: body.max_tokens, response_format: body.response_format, signal }, body.stream);
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new AppError("AI_SHARED_UPSTREAM_ERROR", "共享模型服务请求失败，请联系管理员检查配置", { status: response.status >= 500 ? 502 : response.status });
  }
  return redactSharedAIResponse(response, settings);
}
