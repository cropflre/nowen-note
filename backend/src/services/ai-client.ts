import { buildAIHeaders, readAIResponse, redactAICredentials } from "./ai-provider-config";
import { aiOutboundFetch } from "./ai-outbound-fetch.js";
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
  ai_custom_headers?: string;
  ai_model: string;
  ai_embedding_profile_id: string;
  ai_embedding_url: string;
  ai_embedding_key: string;
  ai_embedding_model: string;
  ai_embedding_timeout_seconds?: string;
}

export interface ChatMessage {
  role: string;
  content: string;
}

export interface CallAIOptions {
  temperature?: number;
  max_tokens?: number;
  timeout_ms?: number;
  signal?: AbortSignal;
  response_format?: { type: "json_object" };
}

const FINAL_MARKER_RE = /(?:^|\n)\s*(最终答案|最终标题|标题|答案|Final|Answer|Result)\s*[:：]\s*/gi;
const QUOTE_RE = /^[\s"'"'"''''「」『』《》#*`\-\:：]+|[\s"'"'"''''「」『』《》#*`\-\:：。.!！?？]+$/g;

function isLikelyReasoningLine(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  return [
    /^思考过程\s*[:：]?/,
    /^推理过程\s*[:：]?/,
    /^分析过程\s*[:：]?/,
    /^首先[，,].*(用户|我需要|我们需要|要求)/,
    /^用户(要求|想要|希望|需要)/,
    /^我(需要|会|应该|将|先|可以)/,
    /^我们(需要|可以|应该|先)/,
    /^接下来[，,]/,
    /^根据(用户|提供的|以上)/,
    /标题长度在\s*20\s*字以内/,
    /只返回标题文本/,
    /不要加引号或其他标点/,
  ].some((re) => re.test(s));
}

/**
 * 核心清洗函数：移除 AI 推理内容
 *
 * 处理顺序：
 * 1. 移除 BOM、统一换行符
 * 2. 移除 <think>...</think> 和 <reasoning>...</reasoning> 标签（支持多行、大小写混合）
 * 3. 移除未闭合的 think/reasoning 标签到末尾或最终答案标记
 * 4. 移除残留的闭合标签
 * 5. 移除 Markdown 代码围栏包裹的 reasoning/think
 * 6. 移除中文显式推理段（思考过程/推理过程/分析过程）
 * 7. 按行过滤推理内容
 * 8. 清理多余空行
 */
export function stripAiReasoning(raw: string): string {
  if (!raw) return "";
  let text = String(raw).replace(/^﻿/, "").replace(/\r\n/g, "\n");

  // 1. XML/类 XML 思考块：<think>...</think>、<reasoning>...</reasoning>
  //    支持大小写混合、标签前后有空格、多行内容
  text = text.replace(/<\s*(think|reasoning|思考|推理)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");

  // 2. 没有闭合标签时，先移除到最终答案标记前；如果没有标记，则移除到结尾
  text = text.replace(/<\s*(think|reasoning|思考|推理)[^>]*>[\s\S]*?(?=(?:最终答案|最终标题|标题|答案|Final|Answer|Result)\s*[:：]|$)/gi, "");

  // 3. 移除残留的闭合标签
  text = text.replace(/<\s*\/\s*(think|reasoning|思考|推理)\s*>/gi, "");

  // 4. Markdown 代码围栏里的 reasoning / think
  text = text.replace(/```\s*(think|reasoning|思考|推理)[\s\S]*?```/gi, "");

  // 5. 中文显式推理段：有最终标记时只删除标记前的推理段
  text = text.replace(/(?:^|\n)\s*(思考过程|推理过程|分析过程)\s*[:：][\s\S]*?(?=(?:\n\s*)?(最终答案|最终标题|标题|答案|Final|Answer|Result)\s*[:：])/gi, "\n");

  // 6. 按行过滤推理内容
  return text
    .split("\n")
    .filter((line) => !isLikelyReasoningLine(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 优先提取最终答案标记后的内容，再做推理清洗。 */
export function extractFinalAnswer(raw: string): string {
  const stripped = stripAiReasoning(raw);
  if (!stripped) return "";

  let match: RegExpExecArray | null;
  let lastEnd = -1;
  FINAL_MARKER_RE.lastIndex = 0;
  while ((match = FINAL_MARKER_RE.exec(stripped)) !== null) {
    lastEnd = FINAL_MARKER_RE.lastIndex;
  }

  const picked = lastEnd >= 0 ? stripped.slice(lastEnd) : stripped;
  return stripAiReasoning(picked)
    .replace(/^\s*[-*•]\s*/gm, "")
    .trim();
}

function cleanOneLineTitle(line: string): string {
  return line
    .replace(/^\s*(最终标题|标题|最终答案|答案|Final|Answer|Result)\s*[:：]\s*/i, "")
    .replace(/^#+\s*/, "")
    .replace(QUOTE_RE, "")
    .replace(/\s+/g, "")
    .trim();
}

/** 从 AI 输出中提取不含推理过程的短标题。 */
export function extractAiTitle(raw: string, maxLength = 20): string {
  const answer = extractFinalAnswer(raw);
  const candidates = answer
    .split(/\n+/)
    .map((line) => cleanOneLineTitle(line))
    .filter(Boolean)
    .filter((line) => !isLikelyReasoningLine(line));

  let title = candidates[0] || cleanOneLineTitle(answer);
  if (!title || isLikelyReasoningLine(title)) return "";

  // 如果模型仍返回解释句，优先取句号、冒号后更像标题的一段。
  title = title
    .replace(/^这篇笔记(主要)?(讲述|介绍|讨论|关于)/, "")
    .replace(/^根据内容(可知|来看)?/, "")
    .replace(/^可以命名为/, "")
    .replace(/^建议标题为/, "");

  const sentence = title.split(/[。.!！?？；;]/).find((part) => part.trim()) || title;
  title = cleanOneLineTitle(sentence);

  if (!title || isLikelyReasoningLine(title)) return "";
  return title.length > maxLength ? title.slice(0, maxLength) : title;
}

/** 从 OpenAI-compatible / Gemini 等响应中抽最终助手文本，不拼 reasoning_content。 */
export function normalizeAiAssistantMessage(data: Record<string, unknown>): string {
  return extractFinalAnswer(extractTextFromChatCompletion(data));
}

// ===== 核心函数 =====

/** Shared request builder for chat, document processing and structured AI features. */
export async function requestAIChat(
  settings: AISettings,
  messages: ChatMessage[],
  options: CallAIOptions = {},
  stream = false,
): Promise<Response> {
  const anthropic = settings.ai_provider === "anthropic";
  const baseUrl = settings.ai_api_url.replace(/\/+$/, "");
  const body: Record<string, unknown> = {
    model: settings.ai_model,
    messages: anthropic ? messages.filter((message) => message.role !== "system") : messages,
    stream,
  };
  if (anthropic) {
    const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    if (system) body.system = system;
    body.max_tokens = options.max_tokens ?? 4096;
  } else {
    if (options.max_tokens !== undefined) body.max_tokens = options.max_tokens;
    if (options.response_format) body.response_format = options.response_format;
  }
  if (options.temperature !== undefined) body.temperature = options.temperature;
  const deadline = AbortSignal.timeout(options.timeout_ms ?? (stream ? 60000 : 30000));
  try {
    const response = await aiOutboundFetch(`${baseUrl}/${anthropic ? "messages" : "chat/completions"}`, {
      method: "POST",
      headers: buildAIHeaders(settings.ai_provider, settings.ai_api_key, settings.ai_custom_headers),
      body: JSON.stringify(body),
      signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
      // A redirect must not forward gateway credentials to another origin.
      redirect: "error",
    });
    if (response.ok) return response;
    const detail = redactAICredentials(await response.text().catch(() => ""), settings.ai_api_key, settings.ai_custom_headers);
    return new Response(sanitizeError(detail), { status: response.status, statusText: response.statusText });
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
    throw new Error(sanitizeError(redactAICredentials((error as Error)?.message || error, settings.ai_api_key, settings.ai_custom_headers)));
  }
}

/** Non-streaming text shared by every provider. */
export async function callAIChat(
  settings: AISettings,
  messages: ChatMessage[],
  options: CallAIOptions = {},
): Promise<string> {
  const res = await requestAIChat(settings, messages, options);
  if (!res.ok) throw new Error(`AI 服务错误 (${settings.ai_provider}): ${res.status} ${await res.text()}`);
  return normalizeAiAssistantMessage(await readAIResponse(res));
}

/** Text deltas only; thinking and tool-use blocks are never exposed as final text. */
export async function* callAIChatStream(
  settings: AISettings,
  messages: ChatMessage[],
  options: CallAIOptions = {},
): AsyncGenerator<string, void, undefined> {
  const res = await requestAIChat(settings, messages, options, true);
  if (!res.ok) throw new Error(`AI 服务错误 (${settings.ai_provider}): ${res.status} ${await res.text()}`);
  const reader = res.body?.getReader();
  if (!reader) throw new Error("AI 服务未返回可读流");
  const decoder = new TextDecoder();
  let buffer = "";
  function parseLine(line: string): { text?: string; done?: boolean } {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return {};
    const data = trimmed.slice(5).trimStart();
    if (data === "[DONE]") return { done: true };
    let json: Record<string, any>;
    try { json = JSON.parse(data); } catch { return {}; }
    if (json.type === "error" || json.error) {
      throw new Error(sanitizeError(redactAICredentials(json.error?.message || "AI 流式请求失败", settings.ai_api_key, settings.ai_custom_headers)));
    }
    if (settings.ai_provider === "anthropic") {
      if (json.type === "message_stop") return { done: true };
      if (json.type === "content_block_start" && json.content_block?.type === "text") return { text: json.content_block.text };
      return { text: json.type === "content_block_delta" && json.delta?.type === "text_delta" ? json.delta.text : "" };
    }
    return { text: parseOpenAIStreamDelta(json) };
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = done ? "" : lines.pop() || "";
      for (const line of lines) {
        const parsed = parseLine(line);
        if (parsed.done) return;
        if (parsed.text) yield parsed.text;
      }
      if (done) break;
    }
  } catch (error) {
    throw new Error(sanitizeError(redactAICredentials((error as Error)?.message || error, settings.ai_api_key, settings.ai_custom_headers)));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// ===== 文本提取 =====

function readContentPart(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const obj = part as Record<string, unknown>;
        if (typeof obj.text === "string") return obj.text;
        if (typeof obj.content === "string") return obj.content;
      }
      return "";
    }).join("");
  }
  return "";
}

/**
 * 从 chat completion JSON 响应中提取文本。
 * 兼容多种 provider 的返回格式。
 */
export function extractTextFromChatCompletion(data: Record<string, unknown>): string {
  // Anthropic Messages: only visible text blocks, never thinking/tool blocks.
  if (Array.isArray(data.content)) {
    return data.content.filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text).join("");
  }
  // 1. OpenAI standard: choices[0].message.content
  const choices = data.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0] as Record<string, unknown>;
    // non-stream: message.content
    const message = choice.message as Record<string, unknown> | undefined;
    if (message) {
      const messageContent = readContentPart(message.content);
      if (messageContent) return messageContent;
    }
    // stream frame: delta.content
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (delta) {
      const deltaContent = readContentPart(delta.content);
      if (deltaContent) return deltaContent;
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
  if (output) {
    const outputText = readContentPart(output.text);
    if (outputText) return outputText;
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
  if (delta) {
    const content = readContentPart(delta.content);
    if (content) return content;
  }
  // 关键：不要返回 delta.reasoning_content / message.reasoning_content。
  // DeepSeek、MiMo 等推理模型会把思考过程放到这些字段里，前端不应展示、保存或插入。
  return "";
}

// ===== 错误处理 =====

/**
 * 清理错误文本，移除可能的 API Key 片段。
 */
export function sanitizeError(text: unknown): string {
  // 移除常见 API key 格式
  return String(text || "")
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "sk-****")
    .replace(/Bearer\s+[a-zA-Z0-9_.-]{20,}/g, "Bearer ****")
    .slice(0, 300);
}
