/**
 * AI 输出清洗工具库
 *
 * 统一处理 AI 模型输出中的推理内容（<think>...</think>）、
 * Markdown 代码块包裹、多余解释语等，确保写入笔记的数据是干净的。
 *
 * 兼容 OpenAI / DeepSeek / Qwen / MiniMax / Ollama 等 OpenAI-compatible Provider。
 */

const FINAL_MARKER_RE = /(?:^|\n)\s*(最终答案|最终标题|标题|答案|Final|Answer|Result)\s*[:：]\s*/gi;
const QUOTE_RE = /^[\s"'"'"''''「」『』《》#*`\-\:：]+|[\s"'"'"''''「」『』《》#*`\-\:：。.!！?？]+$/g;

/** 判断一行是否像推理过程（启发式） */
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

/**
 * 优先提取最终答案标记后的内容，再做推理清洗
 */
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

/**
 * 从 AI 输出中提取不含推理过程的短标题
 */
export function extractAiTitle(raw: string, maxLength = 20): string {
  const answer = extractFinalAnswer(raw);
  const candidates = answer
    .split(/\n+/)
    .map((line) => cleanOneLineTitle(line))
    .filter(Boolean)
    .filter((line) => !isLikelyReasoningLine(line));

  let title = candidates[0] || cleanOneLineTitle(answer);
  if (!title || isLikelyReasoningLine(title)) return "";

  // 如果模型仍返回解释句，优先取句号、冒号后更像标题的一段
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

/**
 * 从 AI 输出中解析标签数组
 *
 * 兼容以下格式：
 * - JSON 数组：["会计", "暂估成本"]
 * - 逗号/顿号分隔：会计、暂估成本、冲暂估
 * - 列表格式：- 会计\n- 暂估成本
 * - 混合格式（带推理内容）
 */
export function parseAiTags(raw: string, maxTags = 8): string[] {
  const cleaned = stripAiReasoning(raw);
  if (!cleaned) return [];

  // 1. 尝试 JSON 数组解析
  const jsonArrayMatch = cleaned.match(/\[[\s\S]*?\]/);
  if (jsonArrayMatch) {
    try {
      const arr = JSON.parse(jsonArrayMatch[0]);
      if (Array.isArray(arr)) {
        return arr
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim().replace(/^#+/, "").replace(/^["']|["']$/g, ""))
          .filter((t) => t.length > 0 && t.length <= 20)
          .slice(0, maxTags);
      }
    } catch {
      // JSON 解析失败，继续其他格式
    }
  }

  // 2. 尝试按分隔符拆分（逗号、顿号、换行、列表符号）
  const tagNames = [
    ...new Set(
      cleaned
        .split(/[,，、\n;；\-\*•]+/)
        .map((s) =>
          s
            .replace(/^#+/, "")
            .replace(/^["']|["']$/g, "")
            .replace(/^\s*\d+[.、)]\s*/, "")
            .trim()
        )
        .filter((t) => t.length > 0 && t.length <= 20 && !isLikelyReasoningLine(t))
    ),
  ].slice(0, maxTags);

  return tagNames;
}

/**
 * 从 AI 输出中提取干净的总结文本
 */
export function extractAiSummary(raw: string): string {
  const cleaned = stripAiReasoning(raw);
  if (!cleaned) return "";

  // 移除常见前缀
  return cleaned
    .replace(/^\s*(总结|摘要|以下是总结|以下是摘要|Summary|TL;DR)\s*[:：]\s*/im, "")
    .replace(/^\s*[-*•]\s*/gm, "")
    .trim();
}

/**
 * 从 OpenAI-compatible / Gemini 等响应中抽最终助手文本，不拼 reasoning_content
 */
export function normalizeAiAssistantMessage(data: Record<string, unknown>): string {
  return extractFinalAnswer(extractTextFromChatCompletion(data));
}

/**
 * 从 chat completion JSON 响应中提取文本
 * 兼容多种 provider 的返回格式
 */
function extractTextFromChatCompletion(data: Record<string, unknown>): string {
  // 1. OpenAI standard: choices[0].message.content
  const choices = data.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0] as Record<string, unknown>;
    const message = choice.message as Record<string, unknown> | undefined;
    if (message) {
      const content = readContentPart(message.content);
      if (content) return content;
    }
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (delta) {
      const content = readContentPart(delta.content);
      if (content) return content;
    }
    if (typeof choice.text === "string" && choice.text) {
      return choice.text;
    }
  }

  // 2. output_text
  if (typeof data.output_text === "string" && data.output_text) {
    return data.output_text;
  }

  // 3. output.text
  const output = data.output as Record<string, unknown> | undefined;
  if (output) {
    const text = readContentPart(output.text);
    if (text) return text;
  }

  // 4. 顶层字段
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

function readContentPart(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const obj = part as Record<string, unknown>;
          if (typeof obj.text === "string") return obj.text;
          if (typeof obj.content === "string") return obj.content;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/** 从笔记内容中提取标题（用于无 AI 场景的降级） */
export function fallbackTitleFromContent(content: string, maxLength = 20): string {
  const line =
    (content || "")
      .replace(/<[^>]+>/g, " ")
      .split(/\n+/)
      .map((item) => item.replace(/^#+\s*/, "").trim())
      .find(Boolean) || "";

  const title = cleanOneLineTitle(line.split(/[。.!！?？；;]/)[0] || line);
  return title.length > maxLength ? title.slice(0, maxLength) : title;
}
