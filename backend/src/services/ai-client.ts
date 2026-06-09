/**
 * AI Client 适配层
 *
 * 统一不同 AI provider 的调用方式，兼容 OpenAI 格式和多种非标准格式。
 * 供 /api/ai/chat、/api/ai/test 等路由复用。
 */

// ===== 类型定义 =====

export interface AISettings {
  ai_provider: string;
  ai_api_url: string;
  ai_api_key: string;
  ai_model: string;
  ai_embedding_url: string;
  ai_embedding_key: string;
  ai_embedding_model: string;
}

export interface ChatMessage {
  role: string;
  content: string;
}

export interface CallAIOptions {
  temperature?: number;
  max_tokens?: number;
  timeout_ms?: number;
}

// ===== 核心函数 =====

/**
 * 向上游发 non-stream 请求，返回完整文本。
 * 兼容 OpenAI / Gemini / 通义 / 豆包 / DeepSeek 等常见响应格式。
 */
export async function callAIChat(
  settings: AISettings,
  messages: ChatMessage[],
  options: CallAIOptions = {},
): Promise<string> {
  const baseUrl = settings.ai_api_url.replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.ai_api_key) {
    headers["Authorization"] = `Bearer ${settings.ai_api_key}`;
  }

  const body: Record<string, unknown> = {
    model: settings.ai_model,
    messages,
    stream: false,
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.max_tokens !== undefined) body.max_tokens = options.max_tokens;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeout_ms ?? 30000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `AI 服务错误 (${settings.ai_provider}): ${res.status} ${sanitizeError(errText)}`,
    );
  }

  const data = (await res.json()) as Record<string, unknown>;
  const text = extractTextFromChatCompletion(data);
  return text;
}

/**
 * 向上游发 stream 请求，逐块 yield 文本片段。
 * 返回 AsyncGenerator，调用方用 for await 消费。
 */
export async function* callAIChatStream(
  settings: AISettings,
  messages: ChatMessage[],
  options: CallAIOptions = {},
): AsyncGenerator<string, void, undefined> {
  const baseUrl = settings.ai_api_url.replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.ai_api_key) {
    headers["Authorization"] = `Bearer ${settings.ai_api_key}`;
  }

  const body: Record<string, unknown> = {
    model: settings.ai_model,
    messages,
    stream: true,
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.max_tokens !== undefined) body.max_tokens = options.max_tokens;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeout_ms ?? 60000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `AI 服务错误 (${settings.ai_provider}): ${res.status} ${sanitizeError(errText)}`,
    );
  }

  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("AI 服务未返回可读流");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;
        try {
          const json = JSON.parse(data);
          const content = parseOpenAIStreamDelta(json);
          if (content) yield content;
        } catch {
          // skip malformed JSON
        }
      }
    }
    // 收尾 buffer
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data: ")) {
        const data = trimmed.slice(6);
        if (data !== "[DONE]") {
          try {
            const json = JSON.parse(data);
            const content = parseOpenAIStreamDelta(json);
            if (content) yield content;
          } catch { /* skip */ }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ===== 文本提取 =====

/**
 * 从 chat completion JSON 响应中提取文本。
 * 兼容多种 provider 的返回格式。
 */
export function extractTextFromChatCompletion(data: Record<string, unknown>): string {
  // 1. OpenAI standard: choices[0].message.content
  const choices = data.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0] as Record<string, unknown>;
    // non-stream: message.content
    const message = choice.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === "string" && message.content) {
      return message.content;
    }
    // stream frame: delta.content
    const delta = choice.delta as Record<string, unknown> | undefined;
    // DeepSeek reasoning model: reasoning_content (thinking tokens)
    if (message && typeof message.reasoning_content === "string" && message.reasoning_content) {
      return message.reasoning_content;
    }
    if (delta && typeof delta.content === "string" && delta.content) {
      return delta.content;
    }
    // DeepSeek reasoning model stream: delta.reasoning_content
    if (delta && typeof (delta as any).reasoning_content === "string" && (delta as any).reasoning_content) {
      return (delta as any).reasoning_content;
    }
    if (typeof choice.text === "string" && choice.text) {
      return choice.text;
    }
  }

  // 2. output_text (部分 proxy)
  if (typeof data.output_text === "string" && data.output_text) {
    return data.output_text;
  }

  // 3. output.text (某些 API)
  const output = data.output as Record<string, unknown> | undefined;
  if (output && typeof output.text === "string" && output.text) {
    return output.text;
  }

  // 4. 顶层 response / content / text
  if (typeof data.response === "string" && data.response) return data.response;
  if (typeof data.content === "string" && data.content) return data.content;
  if (typeof data.text === "string" && data.text) return data.text;

  // 5. Gemini: candidates[0].content.parts[].text
  const candidates = data.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    const cand = candidates[0] as Record<string, unknown>;
    const contentObj = cand.content as Record<string, unknown> | undefined;
    if (contentObj && Array.isArray(contentObj.parts)) {
      const parts = contentObj.parts as Record<string, unknown>[];
      const text = parts
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("");
      if (text) return text;
    }
  }

  return "";
}

// ===== 流式帧解析 =====

/**
 * 从单个 SSE data JSON 中提取 delta.content。
 * 返回字符串或空字符串。
 */
function parseOpenAIStreamDelta(json: Record<string, unknown>): string {
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const choice = choices[0] as Record<string, unknown>;
  const delta = choice.delta as Record<string, unknown> | undefined;
  if (delta && typeof delta.content === "string") return delta.content;
  if (delta && typeof delta.reasoning_content === "string") return delta.reasoning_content;
  // 某些 provider 在最后一个 chunk 只有 finish_reason 无 content
  return "";
}

// ===== 错误处理 =====

/**
 * 清理错误文本，移除可能的 API Key 片段。
 */
function sanitizeError(text: string): string {
  // 移除常见 API key 格式
  return text
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "sk-****")
    .replace(/Bearer\s+[a-zA-Z0-9_.-]{20,}/g, "Bearer ****")
    .slice(0, 300);
}
