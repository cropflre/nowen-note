import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getDb } from "../db/schema";

const ai = new Hono();

// ===== AI 设置管理 =====

export interface AISettings {
  ai_provider: string;       // "openai" | "ollama" | "custom" | "qwen" | "deepseek" | "gemini" | "doubao"
  ai_api_url: string;        // API 端点
  ai_api_key: string;        // API Key（Ollama 可为空）
  ai_model: string;          // 模型名称
}

const AI_DEFAULTS: AISettings = {
  ai_provider: "openai",
  ai_api_url: "https://api.openai.com/v1",
  ai_api_key: "",
  ai_model: "gpt-4o-mini",
};

// 不需要 API Key 的 Provider
const NO_KEY_PROVIDERS = ["ollama"];

// Docker 环境下 Ollama 使用内部 URL
const OLLAMA_DOCKER_URL = process.env.OLLAMA_URL || "";

function getAISettings(): AISettings {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM system_settings WHERE key LIKE 'ai_%'").all() as { key: string; value: string }[];
  const result: AISettings = { ...AI_DEFAULTS };
  for (const row of rows) {
    (result as any)[row.key] = row.value;
  }
  // Docker 环境下自动替换 Ollama localhost URL 为内部容器 URL
  if (OLLAMA_DOCKER_URL && result.ai_provider === "ollama" && result.ai_api_url.includes("localhost:11434")) {
    result.ai_api_url = result.ai_api_url.replace(/http:\/\/localhost:11434/, OLLAMA_DOCKER_URL);
  }
  return result;
}

// GET /api/ai/settings
ai.get("/settings", (c) => {
  const settings = getAISettings();
  // 不返回完整 API Key，只返回掩码
  return c.json({
    ...settings,
    ai_api_key: settings.ai_api_key ? "sk-****" + settings.ai_api_key.slice(-4) : "",
    ai_api_key_set: !!settings.ai_api_key,
  });
});

// PUT /api/ai/settings
ai.put("/settings", async (c) => {
  const body = await c.req.json() as Partial<AISettings>;
  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO system_settings (key, value, updatedAt)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')
  `);

  const tx = db.transaction(() => {
    if (body.ai_provider !== undefined) {
      upsert.run("ai_provider", body.ai_provider);
    }
    if (body.ai_api_url !== undefined) {
      upsert.run("ai_api_url", body.ai_api_url.replace(/\/+$/, ""));
    }
    if (body.ai_api_key !== undefined && !body.ai_api_key.includes("****")) {
      upsert.run("ai_api_key", body.ai_api_key);
    }
    if (body.ai_model !== undefined) {
      upsert.run("ai_model", body.ai_model);
    }
  });
  tx();

  const settings = getAISettings();
  return c.json({
    ...settings,
    ai_api_key: settings.ai_api_key ? "sk-****" + settings.ai_api_key.slice(-4) : "",
    ai_api_key_set: !!settings.ai_api_key,
  });
});

// ===== AI 连接测试 =====
ai.post("/test", async (c) => {
  const settings = getAISettings();
  if (!settings.ai_api_url) {
    return c.json({ success: false, error: "未配置 API 地址" }, 400);
  }
  if (!NO_KEY_PROVIDERS.includes(settings.ai_provider) && !settings.ai_api_key) {
    return c.json({ success: false, error: "未配置 API Key" }, 400);
  }

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (settings.ai_api_key) {
      headers["Authorization"] = `Bearer ${settings.ai_api_key}`;
    }

    const res = await fetch(`${settings.ai_api_url}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: settings.ai_model,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const err = await res.text();
      return c.json({ success: false, error: `API 返回 ${res.status}: ${err.slice(0, 200)}` }, 400);
    }

    return c.json({ success: true, message: "连接成功" });
  } catch (err: any) {
    return c.json({ success: false, error: err.message || "连接失败" }, 500);
  }
});

// ===== 获取模型列表 =====
ai.get("/models", async (c) => {
  const settings = getAISettings();
  if (!settings.ai_api_url) {
    return c.json({ models: [] });
  }

  try {
    const headers: Record<string, string> = {};
    if (settings.ai_api_key) {
      headers["Authorization"] = `Bearer ${settings.ai_api_key}`;
    }

    const res = await fetch(`${settings.ai_api_url}/models`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return c.json({ models: [] });
    }

    const data = await res.json();
    const models = (data.data || data.models || []).map((m: any) => ({
      id: m.id || m.name,
      name: m.id || m.name,
    }));
    return c.json({ models });
  } catch {
    return c.json({ models: [] });
  }
});

// ===== AI 写作助手（流式 SSE） =====

type AIAction = "continue" | "rewrite" | "polish" | "shorten" | "expand" | "translate_en" | "translate_zh" | "summarize" | "explain" | "fix_grammar" | "title" | "tags";

const ACTION_PROMPTS: Record<AIAction, string> = {
  continue: "请根据上下文，自然流畅地续写以下内容。不要重复已有内容，直接输出续写部分：",
  rewrite: "请用不同的表达方式改写以下内容，保持原意不变：",
  polish: "请对以下内容进行润色，使其更加专业流畅，保持原意：",
  shorten: "请将以下内容精简压缩，保留核心要点，去除冗余：",
  expand: "请对以下内容进行扩展，增加更多细节和解释，使其更充实：",
  translate_en: "请将以下内容翻译为英文，保持原意和风格：",
  translate_zh: "请将以下内容翻译为中文，保持原意和风格：",
  summarize: "请为以下内容生成一个简洁的摘要（100字以内）：",
  explain: "请用通俗易懂的语言解释以下内容：",
  fix_grammar: "请修正以下内容中的语法和拼写错误，只返回修正后的文本：",
  title: "请根据以下笔记内容，生成一个简洁准确的标题（10字以内），只返回标题文本，不要加引号或其他标点：",
  tags: "请根据以下笔记内容，推荐3-5个标签关键词。每个标签用逗号分隔，只返回标签文本，不要加#号：",
};

ai.post("/chat", async (c) => {
  const settings = getAISettings();
  if (!settings.ai_api_url) {
    return c.json({ error: "未配置 AI 服务" }, 400);
  }
  if (!NO_KEY_PROVIDERS.includes(settings.ai_provider) && !settings.ai_api_key) {
    return c.json({ error: "未配置 API Key" }, 400);
  }

  const { action, text, context } = await c.req.json() as {
    action: AIAction;
    text: string;
    context?: string;
  };

  if (!action || !text) {
    return c.json({ error: "参数不完整" }, 400);
  }

  const systemPrompt = ACTION_PROMPTS[action];
  if (!systemPrompt) {
    return c.json({ error: "不支持的操作类型" }, 400);
  }

  const messages: { role: string; content: string }[] = [
    { role: "system", content: "你是一个专业的写作助手，帮助用户优化笔记内容。请直接输出结果，不要添加额外的解释或前缀。" },
  ];

  if (context) {
    messages.push({ role: "system", content: `笔记上下文：\n${context.slice(0, 2000)}` });
  }

  messages.push({ role: "user", content: `${systemPrompt}\n\n${text}` });

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.ai_api_key) {
    headers["Authorization"] = `Bearer ${settings.ai_api_key}`;
  }

  try {
    const res = await fetch(`${settings.ai_api_url}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: settings.ai_model,
        messages,
        stream: true,
        temperature: action === "fix_grammar" ? 0.1 : 0.7,
        max_tokens: action === "title" ? 50 : action === "tags" ? 100 : action === "summarize" ? 300 : 2000,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return c.json({ error: `AI 服务错误: ${res.status} ${err.slice(0, 200)}` }, 502);
    }

    // SSE streaming
    return streamSSE(c, async (stream) => {
      const reader = res.body!.getReader();
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
            if (data === "[DONE]") {
              await stream.writeSSE({ data: "[DONE]", event: "done" });
              return;
            }
            try {
              const json = JSON.parse(data);
              const content = json.choices?.[0]?.delta?.content;
              if (content) {
                await stream.writeSSE({ data: content, event: "message" });
              }
            } catch {
              // skip malformed JSON
            }
          }
        }
        await stream.writeSSE({ data: "[DONE]", event: "done" });
      } catch (err) {
        await stream.writeSSE({ data: "流式传输中断", event: "error" });
      }
    });
  } catch (err: any) {
    return c.json({ error: err.message || "AI 请求失败" }, 500);
  }
});

// ===== 知识库问答 RAG =====
ai.post("/ask", async (c) => {
  const settings = getAISettings();
  if (!settings.ai_api_url) {
    return c.json({ error: "未配置 AI 服务" }, 400);
  }
  if (!NO_KEY_PROVIDERS.includes(settings.ai_provider) && !settings.ai_api_key) {
    return c.json({ error: "未配置 API Key" }, 400);
  }

  const { question, history } = await c.req.json() as {
    question: string;
    history?: { role: string; content: string }[];
  };

  if (!question) {
    return c.json({ error: "请输入问题" }, 400);
  }

  // 1. 使用 FTS5 检索相关笔记
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";

  // 将问题分词为搜索关键词（简单拆分）
  const keywords = question
    .replace(/[?？!！。，,.\s]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(k => k.length > 1)
    .slice(0, 5);

  let relatedNotes: { id: string; title: string; snippet: string }[] = [];

  if (keywords.length > 0) {
    // FTS5 OR 查询
    const ftsQuery = keywords.map(k => `"${k.replace(/"/g, "")}"`).join(" OR ");
    try {
      const ftsResults = db.prepare(`
        SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?
      `).all(ftsQuery) as { rowid: number }[];

      if (ftsResults.length > 0) {
        const rowids = ftsResults.map(r => r.rowid).slice(0, 10);
        const placeholders = rowids.map(() => "?").join(",");
        const notes = db.prepare(`
          SELECT id, title, contentText FROM notes
          WHERE rowid IN (${placeholders}) AND userId = ? AND isTrashed = 0
          ORDER BY updatedAt DESC
          LIMIT 5
        `).all(...rowids, userId) as { id: string; title: string; contentText: string }[];

        relatedNotes = notes.map(n => ({
          id: n.id,
          title: n.title,
          snippet: n.contentText.slice(0, 500),
        }));
      }
    } catch {
      // FTS query failed, continue without context
    }
  }

  // 如果 FTS 没结果，尝试 LIKE 模糊匹配
  if (relatedNotes.length === 0 && keywords.length > 0) {
    try {
      const likeClauses = keywords.slice(0, 3).map(() => "contentText LIKE ?").join(" OR ");
      const likeParams = keywords.slice(0, 3).map(k => `%${k}%`);
      const notes = db.prepare(`
        SELECT id, title, contentText FROM notes
        WHERE userId = ? AND isTrashed = 0 AND (${likeClauses})
        ORDER BY updatedAt DESC
        LIMIT 5
      `).all(userId, ...likeParams) as { id: string; title: string; contentText: string }[];

      relatedNotes = notes.map(n => ({
        id: n.id,
        title: n.title,
        snippet: n.contentText.slice(0, 500),
      }));
    } catch {
      // fallback failed
    }
  }

  // 2. 构建 RAG prompt
  let contextBlock = "";
  if (relatedNotes.length > 0) {
    contextBlock = relatedNotes.map((n, i) =>
      `【笔记 ${i + 1}】标题: ${n.title}\n${n.snippet}`
    ).join("\n\n---\n\n");
  }

  const systemPrompt = relatedNotes.length > 0
    ? `你是一个智能知识库助手。请基于用户的知识库笔记内容来回答问题。如果笔记中包含相关信息，请引用并标明来源笔记标题。如果笔记中没有相关信息，可以基于你的知识回答，但请说明这不是来自知识库的内容。\n\n以下是与问题相关的笔记内容：\n\n${contextBlock}`
    : "你是一个智能知识库助手。用户的知识库中暂未找到与问题相关的内容。请基于你的知识回答问题，并告知用户这些信息不是来自其知识库。";

  const messages: { role: string; content: string }[] = [
    { role: "system", content: systemPrompt },
  ];

  // 添加历史消息
  if (history && history.length > 0) {
    messages.push(...history.slice(-6)); // 最多保留最近 6 条历史
  }

  messages.push({ role: "user", content: question });

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.ai_api_key) {
    headers["Authorization"] = `Bearer ${settings.ai_api_key}`;
  }

  try {
    const res = await fetch(`${settings.ai_api_url}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: settings.ai_model,
        messages,
        stream: true,
        temperature: 0.7,
        max_tokens: 2000,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return c.json({ error: `AI 服务错误: ${res.status} ${err.slice(0, 200)}` }, 502);
    }

    // SSE streaming with references
    return streamSSE(c, async (stream) => {
      // 先发送参考笔记信息
      if (relatedNotes.length > 0) {
        await stream.writeSSE({
          data: JSON.stringify(relatedNotes.map(n => ({ id: n.id, title: n.title }))),
          event: "references",
        });
      }

      const reader = res.body!.getReader();
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
            if (data === "[DONE]") {
              await stream.writeSSE({ data: "[DONE]", event: "done" });
              return;
            }
            try {
              const json = JSON.parse(data);
              const content = json.choices?.[0]?.delta?.content;
              if (content) {
                await stream.writeSSE({ data: content, event: "message" });
              }
            } catch {
              // skip malformed JSON
            }
          }
        }
        await stream.writeSSE({ data: "[DONE]", event: "done" });
      } catch (err) {
        await stream.writeSSE({ data: "流式传输中断", event: "error" });
      }
    });
  } catch (err: any) {
    return c.json({ error: err.message || "AI 请求失败" }, 500);
  }
});

export default ai;
