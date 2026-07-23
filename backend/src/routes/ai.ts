import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getDb } from "../db/schema";
import {
  getEmbeddingStats,
  rebuildAllEmbeddings,
  embedQuery,
} from "../services/embedding-worker";
import {
  isVecAvailable,
  knnSearch,
  reindexAllVectors,
} from "../services/vec-store";
import { getUserWorkspaceRole } from "../middleware/acl";
import { callAIChat, callAIChatStream, extractTextFromChatCompletion, sanitizeError, type AISettings } from "../services/ai-client";
import { aiCustomPromptsRepository } from "../repositories";
import { getUserAISettings, setGuardedUserAISettings } from "../services/user-ai-settings";

const ai = new Hono();

ai.use("*", async (c, next) => {
  if (!c.req.header("X-User-Id")) return c.json({ error: "Unauthorized" }, 401);
  await next();
});

// ============================================================
// scope 解析：把 ?workspaceId=xxx 归一成 (userId, workspaceId|null)
// ------------------------------------------------------------
//
// 全栈约定（与 notes/notebooks/tags/attachments 路由一致）：
//   query 缺省 / 'personal' / '' / 'null' / null  →  个人空间（DB 里 workspaceId IS NULL）
//   query = <uuid>                                  →  指定工作区
//
// 安全要点（v7 RAG 隔离修复）：
//   - 工作区 scope 必须校验"当前用户是该工作区成员"。否则只要前端构造一个
//     workspaceId query 就能通过 KNN 偷看别人工作区的笔记；
//   - 个人空间 scope 不需要额外校验——knnSearch 自身会按 m.userId === userId
//     过滤，永远只命中自己的个人笔记。
//
// 失败时抛 403（仅在工作区 scope 校验失败），调用方直接 return 该响应。
function resolveScope(
  c: any,
): { userId: string; workspaceId: string | null } | { error: Response } {
  const userId = c.req.header("X-User-Id") || "demo";
  const raw = (c.req.query("workspaceId") || "").trim();
  const ws = !raw || raw === "personal" || raw === "null" ? null : raw;

  if (ws !== null) {
    // 严格校验工作区成员身份；不存在 / 非成员 → 403
    const role = getUserWorkspaceRole(ws, userId);
    if (!role) {
      return {
        error: c.json(
          { error: "您不是该工作区的成员，无法访问其知识库" },
          403,
        ) as Response,
      };
    }
  }
  return { userId, workspaceId: ws };
}


// ===== 笔记本级知识库 scope =====
//
// 扩展 resolveScope：支持 notebookId 过滤 + 子笔记本递归。
// 返回 notebookIds（null = 不过滤，整个 workspace/个人空间）。
interface KnowledgeScope {
  userId: string;
  workspaceId: string | null;
  notebookIds: string[] | null; // null = 全空间
}

/**
 * 递归获取所有子孙笔记本 ID（含自身）。
 */
function getDescendantNotebookIds(db: any, rootIds: string[]): string[] {
  const result = [...rootIds];
  const queue = [...rootIds];
  while (queue.length > 0) {
    const batch = queue.splice(0);
    const ph = batch.map(() => "?").join(",");
    const rows = db.prepare(`SELECT id FROM notebooks WHERE parentId IN (${ph}) AND isDeleted = 0`).all(...batch) as { id: string }[];
    for (const r of rows) {
      result.push(r.id);
      queue.push(r.id);
    }
  }
  return result;
}

/**
 * 解析带笔记本范围的知识库 scope。
 * body.notebookId + body.includeChildren。
 * 权限校验：notebook 必须属于当前用户的当前 scope。
 */
function resolveKnowledgeScope(
  c: any,
  body: { notebookId?: string; includeChildren?: boolean },
): KnowledgeScope | { error: Response } {
  const base = resolveScope(c);
  if ("error" in base) return base;
  const { userId, workspaceId } = base;

  if (!body.notebookId) {
    return { userId, workspaceId, notebookIds: null };
  }

  const db = getDb();
  const nb = db.prepare("SELECT id, userId, workspaceId FROM notebooks WHERE id = ? AND isDeleted = 0").get(body.notebookId) as
    | { id: string; userId: string; workspaceId: string | null }
    | undefined;
  if (!nb) {
    return { error: c.json({ error: "笔记本不存在" }, 404) as Response };
  }

  // 权限校验：
  //   personal scope (workspaceId === null): notebook 必须是自己的 + workspaceId IS NULL
  //   workspace scope: notebook.workspaceId 必须匹配
  if (workspaceId === null) {
    if (nb.userId !== userId || nb.workspaceId !== null) {
      return { error: c.json({ error: "无权访问该笔记本" }, 403) as Response };
    }
  } else {
    if ((nb.workspaceId || null) !== workspaceId) {
      return { error: c.json({ error: "该笔记本不属于当前工作区" }, 403) as Response };
    }
  }

  let notebookIds = [nb.id];
  if (body.includeChildren) {
    notebookIds = getDescendantNotebookIds(db, notebookIds);
  }
  return { userId, workspaceId, notebookIds };
}

// ===== AI 设置管理 =====

// 不需要 API Key 的 Provider
const NO_KEY_PROVIDERS = ["ollama"];

function getAISettings(c: any): AISettings {
  return getUserAISettings(c.req.header("X-User-Id")!);
}

// GET /api/ai/settings
ai.get("/settings", (c) => {
  const settings = getAISettings(c);
  // 不返回完整 API Key，只返回掩码
  return c.json({
    ...settings,
    ai_api_key: settings.ai_api_key ? "sk-****" + settings.ai_api_key.slice(-4) : "",
    ai_api_key_set: !!settings.ai_api_key,
    ai_embedding_key: settings.ai_embedding_key ? "sk-****" + settings.ai_embedding_key.slice(-4) : "",
    ai_embedding_key_set: !!settings.ai_embedding_key,
  });
});

// PUT /api/ai/settings
ai.put("/settings", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const body = await c.req.json() as Partial<AISettings>;
  const entries: Array<{ key: string; value: string }> = [];
  if (body.ai_provider !== undefined) entries.push({ key: "ai_provider", value: body.ai_provider });
  if (body.ai_api_url !== undefined) entries.push({ key: "ai_api_url", value: body.ai_api_url.replace(/\/+$/, "") });
  if (body.ai_api_key !== undefined && !body.ai_api_key.includes("****")) entries.push({ key: "ai_api_key", value: body.ai_api_key });
  if (body.ai_model !== undefined) entries.push({ key: "ai_model", value: body.ai_model });
  if (body.ai_embedding_profile_id !== undefined) entries.push({ key: "ai_embedding_profile_id", value: body.ai_embedding_profile_id.trim() });
  if (body.ai_embedding_url !== undefined) entries.push({ key: "ai_embedding_url", value: body.ai_embedding_url.replace(/\/+$/, "") });
  if (body.ai_embedding_key !== undefined && !body.ai_embedding_key.includes("****")) entries.push({ key: "ai_embedding_key", value: body.ai_embedding_key });
  if (body.ai_embedding_model !== undefined) entries.push({ key: "ai_embedding_model", value: body.ai_embedding_model });
  setGuardedUserAISettings(userId, entries);

  const settings = getAISettings(c);
  return c.json({
    ...settings,
    ai_api_key: settings.ai_api_key ? "sk-****" + settings.ai_api_key.slice(-4) : "",
    ai_api_key_set: !!settings.ai_api_key,
    ai_embedding_key: settings.ai_embedding_key ? "sk-****" + settings.ai_embedding_key.slice(-4) : "",
    ai_embedding_key_set: !!settings.ai_embedding_key,
  });
});

// ===== AI 连接测试 =====
ai.post("/test", async (c) => {
  const settings = getAISettings(c);
  if (!settings.ai_api_url) {
    return c.json({ success: false, error: "未配置 API 地址" }, 400);
  }
  if (!NO_KEY_PROVIDERS.includes(settings.ai_provider) && !settings.ai_api_key) {
    return c.json({ success: false, error: "未配置 API Key" }, 400);
  }

  try {
    const text = await callAIChat(settings, [{ role: "user", content: "Hi" }], {
      max_tokens: 10,
      timeout_ms: 15000,
    });

    return c.json({
      success: true,
      message: text ? "连接成功" : "连接成功（模型未在本次测试中返回可展示文本）",
      ...(text ? { preview: text.slice(0, 100) } : {}),
    });
  } catch (err: any) {
    const msg = err?.message || "连接失败";
    // 补充 Ollama 原生 API 回退
    if (settings.ai_provider === "ollama" && /405|Method Not Allowed/i.test(msg)) {
      const ollamaBase = settings.ai_api_url.replace(/\/+$/, "").replace(/\/v1$/, "");
      try {
        const fallbackRes = await fetch(`${ollamaBase}/api/tags`, {
          method: "GET",
          signal: AbortSignal.timeout(10000),
        });
        if (fallbackRes.ok) {
          return c.json({
            success: true,
            message: "连接成功（Ollama 原生 API）。注意：当前 Ollama 版本可能不支持 OpenAI 兼容接口（/v1/chat/completions），请升级 Ollama 至 v0.1.14 或更高版本以获得完整功能支持。",
          });
        }
      } catch { /* 回退也失败，返回原始错误 */ }
    }

    return c.json({ success: false, error: msg }, 500);
  }
});

// ===== 获取模型列表 =====
ai.get("/models", async (c) => {
  const settings = getAISettings(c);
  if (!settings.ai_api_url) {
    return c.json({ models: [] });
  }

  try {
    const headers: Record<string, string> = {};
    if (settings.ai_api_key) {
      headers["Authorization"] = `Bearer ${settings.ai_api_key}`;
    }

    const res = await fetch(`${settings.ai_api_url.replace(/\/+$/, "")}/models`, {
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

type AIAction = "continue" | "rewrite" | "polish" | "shorten" | "expand" | "translate_en" | "translate_zh" | "summarize" | "explain" | "fix_grammar" | "title" | "tags" | "format_markdown" | "format_code" | "custom" | "mermaid_mindmap" | "mermaid_flowchart";

const ACTION_PROMPTS: Record<AIAction, string> = {
  continue: "请根据上下文，自然流畅地续写以下内容。不要重复已有内容，直接输出续写部分：",
  rewrite: "请用不同的表达方式改写以下内容，保持原意不变：",
  polish: "请对以下内容进行润色，使其更加专业流畅，保持原意：",
  shorten: "请将以下内容精简压缩，保留核心要点，去除冗余：",
  expand: "请对以下内容进行扩展，增加更多细节和解释，使其更充实：",
  translate_en: "请将以下内容翻译为英文，保持原意和风格：",
  translate_zh: "请将以下内容翻译为中文，保持原意和风格：",
  summarize: "请总结以下笔记内容，要求：\n1. 先给出 3-5 条要点\n2. 再给出一段简洁总结\n3. 不要编造原文没有的信息\n4. 保持结构清晰\n5. 用中文输出：",
  explain: "请用通俗易懂的语言解释以下内容：",
  fix_grammar: "请修正以下内容中的语法和拼写错误，只返回修正后的文本：",
  format_markdown: "请将以下内容按照规范的 Markdown 格式重新排版，合理使用标题、列表、代码块、表格、加粗、引用等格式元素，保持原意不变，使内容结构更清晰：",
  format_code: "请识别以下内容中的代码部分，用正确的编程语言标记包裹在代码块中（如 ```python），保持代码缩进和格式正确。如果内容本身就是纯代码，直接用代码块包裹并标注语言：",
  custom: "",
  title: "请根据以下笔记内容，生成一个简洁准确的标题（20字以内），只返回标题文本，不要加引号或其他标点：",
  tags: "请根据以下笔记内容，推荐3-5个标签关键词。每个标签用逗号分隔，只返回标签文本，不要加#号：",
  mermaid_mindmap: "请根据以下笔记内容，生成一个 Mermaid mindmap 思维导图。要求：只输出 Mermaid 源码，不要 Markdown 代码围栏，不要解释，第一行必须是 mindmap，节点不超过 50 个，层级不超过 4 层，不要编造原文没有的信息。节点文本中不要使用括号()、方括号[]、花括号{}、冒号:、竖线|等特殊字符，这些字符会导致 Mermaid 解析失败，改用中文顿号、逗号或文字描述代替：",
  mermaid_flowchart: "请根据以下笔记内容，生成一个 Mermaid 流程图。要求：只输出 Mermaid 源码，不要 Markdown 代码围栏，不要解释，第一行必须是 flowchart TD，节点不超过 50 个，层级不超过 4 层，不要编造原文没有的信息：",
};

ai.post("/chat", async (c) => {
  const settings = getAISettings(c);
  if (!settings.ai_api_url) {
    return c.json({ error: "未配置 AI 服务" }, 400);
  }
  if (!NO_KEY_PROVIDERS.includes(settings.ai_provider) && !settings.ai_api_key) {
    return c.json({ error: "未配置 API Key" }, 400);
  }

  const { action, text, context, customPrompt } = await c.req.json() as {
    action: AIAction;
    text: string;
    context?: string;
    customPrompt?: string;
  };

  if (!action || !text) {
    return c.json({ error: "参数不完整" }, 400);
  }

  // 自定义指令：使用用户传入的 prompt
  let systemPrompt: string;
  if (action === "custom") {
    if (!customPrompt?.trim()) {
      return c.json({ error: "请输入自定义指令" }, 400);
    }
    systemPrompt = customPrompt.trim() + "：";
  } else {
    systemPrompt = ACTION_PROMPTS[action];
    if (!systemPrompt) {
      return c.json({ error: "不支持的操作类型" }, 400);
    }
  }

  const messages: { role: string; content: string }[] = [
    { role: "system", content: "你是一个专业的写作助手，帮助用户优化笔记内容。请直接输出结果，不要添加额外的解释或前缀。" },
  ];

  if (context) {
    messages.push({ role: "system", content: `笔记上下文：\n${context.slice(0, 2000)}` });
  }

  messages.push({ role: "user", content: `${systemPrompt}\n\n${text}` });
  const temperature = action === "fix_grammar" ? 0.1 : action === "format_code" ? 0.2 : 0.7;
  const max_tokens = action === "title" ? 200 : action === "tags" ? 300 : action === "summarize" ? 800 : action === "mermaid_mindmap" ? 1500 : action === "mermaid_flowchart" ? 1500 : action === "custom" ? 4000 : 2000;

  // title / tags / summarize 短任务 → non-stream，更稳定
  const isShortAction = action === "title" || action === "tags" || action === "summarize" || action === "mermaid_mindmap" || action === "mermaid_flowchart";

  try {
    if (isShortAction) {
      // ---- non-stream 路径 ----
      const text = await callAIChat(settings, messages, { temperature, max_tokens });
      return streamSSE(c, async (stream) => {
        if (text) {
          await stream.writeSSE({ data: JSON.stringify({ t: text }), event: "message" });
        }
        await stream.writeSSE({ data: "[DONE]", event: "done" });
      });
    }
    // ---- stream 路径（写作助手等长文本 action） ----
    return streamSSE(c, async (stream) => {
      let hasContent = false;
      try {
        for await (const chunk of callAIChatStream(settings, messages, { temperature, max_tokens })) {
          hasContent = true;
          await stream.writeSSE({ data: JSON.stringify({ t: chunk }), event: "message" });
        }
      } catch (streamErr) {
        console.error("[AI] stream fallback to non-stream:", streamErr);
      }

      // fallback：stream 没有解析到任何内容，尝试 non-stream
      if (!hasContent) {
        try {
          const text = await callAIChat(settings, messages, { temperature, max_tokens });
          if (text) {
            await stream.writeSSE({ data: JSON.stringify({ t: text }), event: "message" });
          }
        } catch (nonStreamErr) {
          console.error("[AI] non-stream fallback failed:", nonStreamErr);
          await stream.writeSSE({ data: "AI 请求失败", event: "error" });
        }
      }

      await stream.writeSSE({ data: "[DONE]", event: "done" });
    });
  } catch (err: any) {
    return c.json({ error: err.message || "AI 请求失败" }, 500);
  }
});

// ===== ③ 文档智能解析 =====
/**
 * 从用户问题中提取检索关键词。
 *
 * 为什么要专门写：原实现只按空白/标点 split，对中文几乎不可用——中文句子
 * 通常整句没空格，split 后得到整句一个 token，然后用这个长 token 去做
 * FTS5 MATCH 或 LIKE %...% 基本永远命中不了任何笔记，导致"AI 无法根据笔记
 * 本库读取笔记"。
 *
 * 新策略：
 *   1. 拆分 CJK 字符块和 ASCII 词
 *   2. CJK 块做 bigram（相邻两字滑窗）展开，比如"前端性能" → ["前端","端性","性能"]
 *      —— 这是在 unicode61 默认 tokenizer 不支持中文分词前提下最通用的做法，
 *      大多数 2 字词都能覆盖，FTS5 前缀通配符再做一次兜底。
 *   3. 过滤停用词（语气词/疑问代词等对检索无贡献的词）
 *   4. 去重、截断到合理数量
 */
const STOP_WORDS = new Set([
  // 中文停用词（问答/口语）
  "的", "了", "和", "是", "在", "有", "我", "你", "他", "她", "它", "我们", "你们",
  "什么", "怎么", "如何", "为啥", "为什么", "哪个", "哪些", "哪里", "谁", "吗", "呢",
  "吧", "啊", "呀", "哦", "嗯", "一下", "一些", "这个", "那个", "这些", "那些",
  "请", "帮我", "给我", "告诉", "总结", "帮忙", "可以", "能", "要", "想", "知道",
  // 英文停用词
  "the", "a", "an", "is", "are", "was", "were", "do", "does", "did", "to", "of",
  "in", "on", "at", "for", "and", "or", "but", "with", "by", "from", "as", "it",
  "this", "that", "these", "those", "what", "how", "why", "where", "which", "who",
  "can", "could", "should", "would", "will", "please", "tell", "me", "my", "i",
]);

function extractKeywords(question: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (w: string) => {
    const lw = w.toLowerCase();
    if (lw.length < 2) return;
    if (STOP_WORDS.has(lw)) return;
    if (seen.has(lw)) return;
    seen.add(lw);
    out.push(lw);
  };

  // 正则同时匹配 CJK 连续块 与 ASCII 单词/数字串
  const re = /[\u4e00-\u9fff\u3400-\u4dbf]+|[a-zA-Z][a-zA-Z0-9_-]*|\d+/g;
  const matches = question.match(re) || [];

  for (const chunk of matches) {
    if (/^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test(chunk)) {
      // 中文块：整块 + bigram 展开
      if (chunk.length >= 2) add(chunk.length <= 4 ? chunk : chunk.slice(0, 4));
      for (let i = 0; i + 2 <= chunk.length; i++) {
        add(chunk.slice(i, i + 2));
      }
    } else {
      // ASCII / 数字：直接加
      add(chunk);
    }
  }

  // 限制规模，避免 FTS 查询过长
  return out.slice(0, 8);
}

ai.post("/ask", async (c) => {
  const settings = getAISettings(c);
  if (!settings.ai_api_url) {
    return c.json({ error: "未配置 AI 服务" }, 400);
  }
  if (!NO_KEY_PROVIDERS.includes(settings.ai_provider) && !settings.ai_api_key) {
    return c.json({ error: "未配置 API Key" }, 400);
  }

  const { question, history, notebookId, includeChildren } = await c.req.json() as {
    question: string; history?: { role: string; content: string }[]; notebookId?: string; includeChildren?: boolean;
  };

  if (!question) {
    return c.json({ error: "请输入问题" }, 400);
  }

  // 1. 检索相关笔记
  //
  //   优先级：向量召回（语义） > FTS5（关键词精确） > LIKE 兜底（容错） > 最近笔记（兜底兜底）
  //
  //   - 向量召回需要：sqlite-vec 加载成功 + embedding 配置完整 + 至少 indexed 过几篇笔记
  //   - 命中阈值：只要 vec 拿到 ≥1 个 hit 就直接用，不再触发后面的关键词路径
  //     （语义命中 1 篇通常远优于 FTS 命中 N 篇但都偏题）
  //   - 拿不到/失败时静默降级，与 Phase 1 行为完全一致
  //
  // 空间隔离（v7）：
  //   /ask 严格按 scope = (userId, workspaceId|null) 收敛检索范围：
  //     - 个人空间：仅命中当前用户在 workspaceId IS NULL 下的笔记
  //     - 工作区  ：仅命中该工作区下的笔记（不限作者，工作区成员共享）
  //   未通过 resolveScope 的成员校验直接 403，杜绝"用 query 偷看其他工作区"。
  const db = getDb();
  const scope = resolveKnowledgeScope(c, { notebookId, includeChildren });
  if ("error" in scope) return scope.error;
  const { userId, workspaceId, notebookIds } = scope;

  // 共享的 scope SQL 片段：notes 表与 ai 路由用相同列名
  // workspaceId 为 null 时用 IS NULL（不能用 = ?），所以分两套
  const wsClause = workspaceId === null ? "workspaceId IS NULL" : "workspaceId = ?";
  const wsParams: any[] = workspaceId === null ? [] : [workspaceId];

  // 笔记本范围 SQL 片段
  const nbClause = notebookIds ? `notebookId IN (${notebookIds.map(() => "?").join(",")})` : "";
  const nbParams: any[] = notebookIds ? [...notebookIds] : [];

  // relatedNotes 的 kind：
  //   - 'note'       普通笔记命中
  //   - 'attachment' 附件内容命中（v8 RAG Phase 3）
  // 前端"引用列表"会根据 kind 渲染不同图标；后端拼 prompt 时会用 `📎` 前缀
  // 让 LLM 明确这段内容来自附件，便于回答时区分"笔记原文"与"附件内容"。
  let relatedNotes: {
    id: string;
    title: string;
    snippet: string;
    kind?: "note" | "attachment";
    attachmentId?: string | null;
    attachmentFilename?: string | null;
  }[] = [];
  let retrieval: "vector" | "fts" | "like" | "recent" | "none" = "none";

  // ---- 路径 A：向量召回 ----
  if (isVecAvailable()) {
    try {
      const qvec = await embedQuery(userId, question);
      if (qvec) {
        // maxNotes 从 5 提到 8：附件 + 笔记混排时，让两类各自都能出现
        const hits = knnSearch(qvec, userId, workspaceId, notebookIds ? 300 : 30, 8, notebookIds);
        if (hits.length > 0) {
          relatedNotes = hits.map((h) => ({
            id: h.noteId,
            // 附件命中：title 展示为"笔记名 › 附件名"，便于用户定位
            title:
              h.entityType === "attachment" && h.attachmentFilename
                ? `${h.title || "(未命名笔记)"} › ${h.attachmentFilename}`
                : h.title,
            snippet: (h.chunkText || "").slice(0, 600),
            kind: h.entityType,
            attachmentId: h.attachmentId || null,
            attachmentFilename: h.attachmentFilename || null,
          }));
          retrieval = "vector";
        }
      }
    } catch (e) {
      console.warn("[/ask] vector retrieval failed, falling back:", e);
    }
  }

  const keywords = extractKeywords(question);

  // ---- 路径 B：FTS5（仅当 vec 未命中时走）----
  //
  // 隔离规则：
  //   - 个人空间：notes_fts 路径 + WHERE userId = ? AND workspaceId IS NULL
  //   - 工作区  ：WHERE workspaceId = ?  （不限 userId，工作区共享）
  // notes_fts 没有 workspaceId 列，所以隔离在外层 notes JOIN 时做。
  if (relatedNotes.length === 0 && keywords.length > 0) {
    // FTS5 查询：每个关键词加前缀通配符 *，用 OR 连接，提高命中率
    // 例如：「"前端"* OR "性能"* OR "优化"*」
    const ftsQuery = keywords
      .map(k => `"${k.replace(/"/g, "")}"*`)
      .join(" OR ");
    try {
      const ftsResults = db.prepare(`
        SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?
      `).all(ftsQuery) as { rowid: number }[];

      if (ftsResults.length > 0) {
        const rowids = ftsResults.map(r => r.rowid).slice(0, 30);
        const placeholders = rowids.map(() => "?").join(",");
        const userClause = workspaceId === null ? "userId = ? AND " : "";
        const userParams = workspaceId === null ? [userId] : [];
        const notes = db.prepare(`
          SELECT id, title, contentText FROM notes
          WHERE rowid IN (${placeholders}) AND ${userClause}${wsClause} AND isTrashed = 0 ${nbClause ? `AND ${nbClause}` : ``}
          ORDER BY updatedAt DESC
          LIMIT 5
        `).all(...rowids, ...userParams, ...wsParams, ...nbParams) as { id: string; title: string; contentText: string }[];

        relatedNotes = notes.map(n => ({
          id: n.id,
          title: n.title,
          snippet: (n.contentText || "").slice(0, 500),
        }));
        retrieval = "fts";
      }
    } catch {
      // FTS query failed, continue without context
    }
  }

  // 如果 FTS 没结果，尝试 LIKE 模糊匹配（同时匹配 title 与 contentText，提高召回）
  if (relatedNotes.length === 0 && keywords.length > 0) {
    try {
      const topKeywords = keywords.slice(0, 5);
      const likeClauses = topKeywords
        .map(() => "(contentText LIKE ? OR title LIKE ?)")
        .join(" OR ");
      const likeParams: string[] = [];
      for (const k of topKeywords) {
        likeParams.push(`%${k}%`, `%${k}%`);
      }
      const userClause = workspaceId === null ? "userId = ? AND " : "";
      const userParams = workspaceId === null ? [userId] : [];
      const notes = db.prepare(`
        SELECT id, title, contentText FROM notes
        WHERE ${userClause}${wsClause} AND isTrashed = 0 ${nbClause ? `AND ${nbClause}` : ``} AND (${likeClauses})
        ORDER BY updatedAt DESC
        LIMIT 5
      `).all(...userParams, ...wsParams, ...nbParams, ...likeParams) as { id: string; title: string; contentText: string }[];

      relatedNotes = notes.map(n => ({
        id: n.id,
        title: n.title,
        snippet: (n.contentText || "").slice(0, 500),
      }));
      if (relatedNotes.length > 0) retrieval = "like";
    } catch {
      // fallback failed
    }
  }

  // 最终兜底：关键词完全没命中（比如用户问"总结我最近的笔记"这种不含具体
  // 内容词的问题），或所有检索路径都失败时，取最近更新的若干篇笔记作为上下文。
  // 没有这档兜底时，AI 只会回答"你的知识库中没有相关内容"——给人"AI 读不到
  // 笔记"的错觉。
  if (relatedNotes.length === 0) {
    try {
      const userClause = workspaceId === null ? "userId = ? AND " : "";
      const userParams = workspaceId === null ? [userId] : [];
      const notes = db.prepare(`
        SELECT id, title, contentText FROM notes
        WHERE ${userClause}${wsClause} AND isTrashed = 0 ${nbClause ? `AND ${nbClause}` : ``}
        ORDER BY updatedAt DESC
        LIMIT 5
      `).all(...userParams, ...wsParams, ...nbParams) as { id: string; title: string; contentText: string }[];

      relatedNotes = notes.map(n => ({
        id: n.id,
        title: n.title,
        snippet: (n.contentText || "").slice(0, 500),
      }));
      if (relatedNotes.length > 0) retrieval = "recent";
    } catch {
      // nothing to do
    }
  }

  // 2. 构建 RAG prompt
  //
  // 附件命中会带 kind='attachment'，给 LLM 看的 contextBlock 用 📎 前缀标注
  // 来源类型，这样它回答时能自然说出"根据你上传的 XXX.pdf..."而不是把附件
  // 误当成笔记正文。
  let contextBlock = "";
  if (relatedNotes.length > 0) {
    contextBlock = relatedNotes.map((n, i) => {
      const tag =
        n.kind === "attachment" ? `【附件 ${i + 1}】📎 ` : `【笔记 ${i + 1}】`;
      return `${tag}${n.title}\n${n.snippet}`;
    }).join("\n\n---\n\n");
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

  // 规范化 URL：去除末尾斜杠，避免拼接出双斜杠
  // 使用 ai-client 统一入口，兼容多种 AI Provider
  try {
    return streamSSE(c, async (stream) => {
      // 先发送参考笔记信息
      if (relatedNotes.length > 0) {
        await stream.writeSSE({
          data: JSON.stringify(relatedNotes.map(n => ({
            id: n.id,
            title: n.title,
            kind: n.kind || "note",
            attachmentId: n.attachmentId || undefined,
            attachmentFilename: n.attachmentFilename || undefined,
          }))),
          event: "references",
        });
        await stream.writeSSE({
          data: JSON.stringify({ mode: retrieval }),
          event: "retrieval",
        });
      }

      // 先尝试流式
      let gotContent = false;
      try {
        const gen = callAIChatStream(settings, messages, { temperature: 0.7, max_tokens: 2000 });
        for await (const chunk of gen) {
          gotContent = true;
          await stream.writeSSE({ data: JSON.stringify({ t: chunk }), event: "message" });
        }
      } catch {
        // stream failed, fallback to non-stream
      }

      // 如果流式没有内容，fallback 到 non-stream
      if (!gotContent) {
        try {
          const text = await callAIChat(settings, messages, { temperature: 0.7, max_tokens: 2000 });
          if (text) {
            await stream.writeSSE({ data: JSON.stringify({ t: text }), event: "message" });
          }
        } catch (e: any) {
          await stream.writeSSE({ data: sanitizeError(e), event: "error" });
        }
      }

      await stream.writeSSE({ data: "[DONE]", event: "done" });
    });
  } catch (err: any) {
    return c.json({ error: sanitizeError(err) || "AI 请求失败" }, 500);
  }
});

// ===== ③ 文档智能解析 =====
ai.post("/parse-document", async (c) => {
  const settings = getAISettings(c);
  if (!settings.ai_api_url) {
    return c.json({ error: "未配置 AI 服务" }, 400);
  }
  if (!NO_KEY_PROVIDERS.includes(settings.ai_provider) && !settings.ai_api_key) {
    return c.json({ error: "未配置 API Key" }, 400);
  }

  const userId = c.req.header("X-User-Id") || "demo";

  try {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    const notebookId = formData.get("notebookId") as string | null;
    const formatMode = (formData.get("formatMode") as string) || "markdown"; // markdown | note

    if (!file) {
      return c.json({ error: "请上传文件" }, 400);
    }

    const fileName = file.name.toLowerCase();
    const buffer = Buffer.from(await file.arrayBuffer());
    let rawText = "";

    // 根据文件类型解析内容
    if (fileName.endsWith(".docx")) {
      const mammoth = await import("mammoth");
      const result = await mammoth.default.convertToHtml({ buffer });
      // 将 HTML 转为纯文本/简易 Markdown
      rawText = result.value
        .replace(/<h([1-6])>(.*?)<\/h[1-6]>/gi, (_: string, level: string, text: string) => '#'.repeat(Number(level)) + ' ' + text + '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?p>/gi, '\n')
        .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
        .replace(/<em>(.*?)<\/em>/gi, '*$1*')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    } else if (fileName.endsWith(".doc")) {
      const WordExtractor = (await import("word-extractor")).default;
      const extractor = new WordExtractor();
      const doc = await extractor.extract(buffer as any);
      rawText = doc.getBody();
    } else if (fileName.endsWith(".csv") || fileName.endsWith(".tsv")) {
      const text = buffer.toString("utf-8");
      const separator = fileName.endsWith(".tsv") ? "\t" : ",";
      const lines = text.split("\n").filter(l => l.trim());
      if (lines.length > 0) {
        const headers = lines[0].split(separator).map(h => h.trim().replace(/^"|"$/g, ""));
        const divider = headers.map(() => "---");
        const rows = lines.slice(1).map(line =>
          line.split(separator).map(cell => cell.trim().replace(/^"|"$/g, ""))
        );
        rawText = `| ${headers.join(" | ")} |\n| ${divider.join(" | ")} |\n`;
        rawText += rows.map(row => `| ${row.join(" | ")} |`).join("\n");
      }
    } else if (fileName.endsWith(".txt") || fileName.endsWith(".md")) {
      rawText = buffer.toString("utf-8");
    } else if (fileName.endsWith(".html") || fileName.endsWith(".htm")) {
      // 简单提取 HTML 文本内容
      const html = buffer.toString("utf-8");
      rawText = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, "\n")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    } else {
      return c.json({ error: `不支持的文件格式: ${fileName.split(".").pop()}` }, 400);
    }

    if (!rawText.trim()) {
      return c.json({ error: "文件内容为空或无法解析" }, 400);
    }

    // 使用 AI 将内容转换为规范的 Markdown 格式
    const aiPrompt = formatMode === "note"
      ? "请将以下文档内容整理为结构化的笔记格式（Markdown），合理使用标题层级、列表、表格、代码块等元素，保留原始信息不丢失，使内容清晰易读："
      : "请将以下文档内容转换为规范的 Markdown 格式，保持原始结构和内容不变，合理使用标题、列表、表格、代码块、引用等格式元素：";

    const messages = [
      { role: "system", content: "你是一个专业的文档格式化助手。请直接输出格式化后的 Markdown 内容，不要添加额外的解释、前缀或总结。" },
      { role: "user", content: `${aiPrompt}\n\n${rawText.slice(0, 8000)}` },
    ];

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (settings.ai_api_key) {
      headers["Authorization"] = `Bearer ${settings.ai_api_key}`;
    }

    const baseUrl = settings.ai_api_url.replace(/\/+$/, "");
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: settings.ai_model,
        messages,
        stream: false,
        temperature: 0.3,
        max_tokens: 4000,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return c.json({ error: `AI 服务错误: ${res.status} ${err.slice(0, 200)}` }, 502);
    }

    const data = await res.json();
    const markdownContent = data.choices?.[0]?.message?.content || rawText;

    // 如果指定了 notebookId，直接创建笔记
    if (notebookId) {
      const db = getDb();
      const { v4: uuidv4 } = await import("uuid");
      const noteId = uuidv4();
      const title = file.name.replace(/\.[^.]+$/, "");
      const contentText = markdownContent.replace(/[#*`>\-|_\[\]()]/g, "").replace(/\n{2,}/g, "\n").trim();

      db.prepare(`
        INSERT INTO notes (id, title, content, contentText, notebookId, userId, isFavorite, isPinned, isTrashed, isLocked, version, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 1, datetime('now'), datetime('now'))
      `).run(noteId, title, JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: markdownContent }] }] }), contentText, notebookId, userId);

      return c.json({
        success: true,
        noteId,
        title,
        markdown: markdownContent,
        saved: true,
      });
    }

    return c.json({
      success: true,
      markdown: markdownContent,
      fileName: file.name,
      originalLength: rawText.length,
      saved: false,
    });
  } catch (err: any) {
    return c.json({ error: err.message || "文档解析失败" }, 500);
  }
});

// ============================================================
// 剪藏增强（nowen-clipper 专用）
// ------------------------------------------------------------
//
// POST /api/ai/clip-enhance
//
// 用途：浏览器扩展剪藏页面后，先把正文过一遍 LLM，产出
//        {title?, summary?, outline?, tags?, highlight?, translation?}
//        然后让客户端按 mode 决定怎么拼回笔记（默认追加在原文上面，
//        保留原文为"事实"，AI 产物为"加工"）。
//
// 设计要点：
//   - 非流式（剪藏场景不需要打字动画；MV3 service worker 30s 易回收，流式不靠谱）
//   - 单次调用多任务（让 LLM 用 JSON 模式一次返回所有字段，省 token 省往返）
//   - 失败不抛错：返回 {ok:false, error}，由客户端决定是否降级保存原文
//   - 输入截断：默认 6000 字，超长取头 4000 + 尾 2000（标题党文章头部最关键，
//     结尾常有总结，中间噪声多）
//
// 入参：
//   {
//     title: string,             // 页面标题（用于上下文）
//     url?: string,              // 来源 URL（用于上下文）
//     siteName?: string,         // 站点名
//     contentText: string,       // 正文纯文本（不含 HTML 标签）
//     tasks: {                   // 哪些任务要做（多选）
//       summary?: boolean,       //   TL;DR 摘要
//       outline?: boolean,       //   结构化大纲
//       tags?: boolean,          //   自动标签 3-5 个
//       title?: boolean,         //   重写标题（针对标题党页面）
//       highlight?: boolean,     //   重点高亮（提取 3-5 个关键句）
//       translation?: boolean,   //   翻译为中文（外文剪藏）
//     },
//     language?: string,         // 输出语言，默认 "zh-CN"
//     customInstruction?: string,// 用户自定义补充指令（拼到 system prompt 末尾）
//     maxInputChars?: number,    // 输入截断长度，默认 6000
//   }
//
// 返回：
//   {
//     ok: true,
//     enhanced: {
//       title?: string,          // tasks.title 才返回
//       summary?: string,        // 一段或几句话
//       outline?: string,        // Markdown 多级列表
//       tags?: string[],         // 字符串数组
//       highlights?: string[],   // 关键句数组
//       translation?: string,    // 中文译文（Markdown）
//     },
//     model: string,
//     truncated: boolean,        // 输入是否被截断
//   }
//   或：{ ok: false, error: string }
ai.post("/clip-enhance", async (c) => {
  const settings = getAISettings(c);
  if (!settings.ai_api_url) {
    return c.json({ ok: false, error: "未配置 AI 服务" }, 400);
  }
  if (!NO_KEY_PROVIDERS.includes(settings.ai_provider) && !settings.ai_api_key) {
    return c.json({ ok: false, error: "未配置 API Key" }, 400);
  }

  type Tasks = {
    summary?: boolean;
    outline?: boolean;
    tags?: boolean;
    title?: boolean;
    highlight?: boolean;
    translation?: boolean;
  };

  let body: {
    title?: string;
    url?: string;
    siteName?: string;
    contentText?: string;
    tasks?: Tasks;
    language?: string;
    customInstruction?: string;
    maxInputChars?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "请求体不是合法 JSON" }, 400);
  }

  const contentText = (body.contentText || "").trim();
  if (!contentText || contentText.length < 20) {
    return c.json({ ok: false, error: "正文过短，跳过 AI 优化" }, 400);
  }

  const tasks: Tasks = body.tasks || { summary: true, tags: true };
  // 至少选一项任务
  const anyTask =
    tasks.summary || tasks.outline || tasks.tags || tasks.title || tasks.highlight || tasks.translation;
  if (!anyTask) {
    return c.json({ ok: false, error: "未指定任何优化任务" }, 400);
  }

  const language = (body.language || "zh-CN").toLowerCase();
  const isChinese = language.startsWith("zh");

  // 输入截断：默认 6000 字，超长取头 4000 + 尾 2000
  const MAX_INPUT = Math.min(Math.max(body.maxInputChars ?? 6000, 1000), 12000);
  let inputText = contentText;
  let truncated = false;
  if (inputText.length > MAX_INPUT) {
    const head = Math.floor(MAX_INPUT * 0.66);
    const tail = MAX_INPUT - head - 32; // 留空给省略号
    inputText =
      inputText.slice(0, head) +
      "\n\n...[中间内容已省略]...\n\n" +
      inputText.slice(inputText.length - tail);
    truncated = true;
  }

  // 构造 schema 描述（让 LLM 知道返回哪些字段）
  const schemaFields: string[] = [];
  if (tasks.title) {
    schemaFields.push(
      isChinese
        ? `  "title": "改写后的简洁标题（≤30字，去除"震惊体"等标题党用语）"`
        : `  "title": "rewritten concise title (<=30 chars)"`,
    );
  }
  if (tasks.summary) {
    schemaFields.push(
      isChinese
        ? `  "summary": "用 1-3 句话概括文章核心观点（≤120字），客观陈述，不要议论"`
        : `  "summary": "1-3 sentences TL;DR (<=120 chars), neutral tone"`,
    );
  }
  if (tasks.outline) {
    schemaFields.push(
      isChinese
        ? `  "outline": "用 Markdown 多级列表给出文章结构大纲（- 一级要点\\n  - 二级要点），3-7 个一级要点"`
        : `  "outline": "Markdown bulleted outline (3-7 top-level items)"`,
    );
  }
  if (tasks.tags) {
    schemaFields.push(
      isChinese
        ? `  "tags": ["3-5 个分类标签，每个 2-6 字的名词或短语，不要带#号"]`
        : `  "tags": ["3-5 short noun tags"]`,
    );
  }
  if (tasks.highlight) {
    schemaFields.push(
      isChinese
        ? `  "highlights": ["3-5 句从原文中精选的关键句（保留原文表述，不要改写）"]`
        : `  "highlights": ["3-5 verbatim key sentences from source"]`,
    );
  }
  if (tasks.translation) {
    schemaFields.push(
      isChinese
        ? `  "translation": "将正文完整翻译为流畅中文（保留段落和列表结构，用 Markdown 格式）"`
        : `  "translation": "full translation to target language in Markdown"`,
    );
  }

  const systemPrompt = isChinese
    ? `你是一位资深的网页剪藏助手，专门帮用户把杂乱的网页正文整理成可读、可检索、可归档的笔记素材。

请严格按用户要求的字段输出**纯 JSON**（不要包裹在 markdown 代码块里，不要任何前后缀解释）。

输出 JSON 的字段要求：
{
${schemaFields.join(",\n")}
}

通用规则：
1. 字段值用简体中文。
2. 摘要保持客观，不复制原文连续大段，不臆造信息。
3. 标签用名词短语（如"前端工程"、"产品设计"），不要用句子，不要带 # 号。
4. 大纲要反映原文真实结构，不是凭空想象的目录。
5. 如果原文质量太低（广告/导航文本/乱码）以致无法完成任务，对应字段输出空字符串或空数组，但 JSON 结构保持完整。
6. 不要输出 JSON 之外的任何字符。${body.customInstruction ? `\n\n补充指令：${body.customInstruction}` : ""}`
    : `You are a web clipper assistant. Output strict JSON (no markdown code fences, no explanation) with the following fields:

{
${schemaFields.join(",\n")}
}

Rules: be concise, neutral, faithful to source. If source is unusable, return empty string/array for that field but keep JSON structure intact.${body.customInstruction ? `\n\nAdditional: ${body.customInstruction}` : ""}`;

  const ctxLines: string[] = [];
  if (body.title) ctxLines.push(`标题：${body.title}`);
  if (body.siteName) ctxLines.push(`站点：${body.siteName}`);
  if (body.url) ctxLines.push(`URL：${body.url}`);
  const userPrompt =
    (ctxLines.length ? ctxLines.join("\n") + "\n\n" : "") +
    (isChinese ? "正文：\n" : "Content:\n") +
    inputText;

  const aiHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.ai_api_key) {
    aiHeaders["Authorization"] = `Bearer ${settings.ai_api_key}`;
  }

  const baseUrl = settings.ai_api_url.replace(/\/+$/, "");

  try {
    // 优先用 OpenAI 风格的 response_format: { type: "json_object" }
    // 某些 provider（Ollama 老版本、自建 vLLM 等）不支持，失败后会自动回退到普通模式。
    const reqBody: any = {
      model: settings.ai_model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      stream: false,
      temperature: 0.3,
      max_tokens: 2000,
    };
    // 尝试启用 JSON mode（OpenAI / DeepSeek / Qwen / Gemini OpenAI-compat 都支持）
    if (
      settings.ai_provider === "openai" ||
      settings.ai_provider === "deepseek" ||
      settings.ai_provider === "qwen" ||
      settings.ai_provider === "doubao" ||
      settings.ai_provider === "custom"
    ) {
      reqBody.response_format = { type: "json_object" };
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: aiHeaders,
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return c.json(
        { ok: false, error: `AI 服务返回 ${res.status}：${errText.slice(0, 200) || res.statusText}` },
        200, // 200 + ok:false：客户端根据 ok 字段判断是否降级，不要触发 fetch 异常路径
      );
    }

    const data = await res.json();
    let raw = data?.choices?.[0]?.message?.content;
    if (!raw || typeof raw !== "string") {
      return c.json({ ok: false, error: "AI 返回内容为空" }, 200);
    }

    // 兜底：去掉可能的 ```json 代码块包裹
    raw = raw.trim();
    const fenceMatch = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenceMatch) raw = fenceMatch[1].trim();

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 二次兜底：从文本里抽第一个 { ... } 块
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          return c.json(
            { ok: false, error: "AI 返回的不是合法 JSON：" + raw.slice(0, 200) },
            200,
          );
        }
      } else {
        return c.json(
          { ok: false, error: "AI 返回的不是合法 JSON：" + raw.slice(0, 200) },
          200,
        );
      }
    }

    // 规整字段（防止 LLM 给出奇怪类型）
    const enhanced: Record<string, any> = {};
    if (tasks.title && typeof parsed.title === "string" && parsed.title.trim()) {
      enhanced.title = parsed.title.trim().slice(0, 200);
    }
    if (tasks.summary && typeof parsed.summary === "string" && parsed.summary.trim()) {
      enhanced.summary = parsed.summary.trim();
    }
    if (tasks.outline && typeof parsed.outline === "string" && parsed.outline.trim()) {
      enhanced.outline = parsed.outline.trim();
    }
    if (tasks.tags) {
      let tagArr: string[] = [];
      if (Array.isArray(parsed.tags)) {
        tagArr = parsed.tags
          .filter((t: any) => typeof t === "string")
          .map((t: string) => t.trim().replace(/^#+/, ""))
          .filter((t: string) => t.length > 0 && t.length <= 20)
          .slice(0, 8);
      } else if (typeof parsed.tags === "string") {
        tagArr = parsed.tags
          .split(/[,，、\s]+/)
          .map((t: string) => t.trim().replace(/^#+/, ""))
          .filter((t: string) => t.length > 0 && t.length <= 20)
          .slice(0, 8);
      }
      if (tagArr.length) enhanced.tags = tagArr;
    }
    if (tasks.highlight) {
      let hs: string[] = [];
      if (Array.isArray(parsed.highlights)) {
        hs = parsed.highlights
          .filter((s: any) => typeof s === "string")
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0)
          .slice(0, 8);
      }
      if (hs.length) enhanced.highlights = hs;
    }
    if (
      tasks.translation &&
      typeof parsed.translation === "string" &&
      parsed.translation.trim()
    ) {
      enhanced.translation = parsed.translation.trim();
    }

    return c.json({
      ok: true,
      enhanced,
      model: settings.ai_model,
      truncated,
    });
  } catch (err: any) {
    const msg = err?.name === "TimeoutError" ? "AI 请求超时（45 秒）" : err?.message || String(err);
    return c.json({ ok: false, error: msg }, 200);
  }
});

// ===== ⑤ 批量 Markdown 格式化 =====
ai.post("/batch-format", async (c) => {
  const settings = getAISettings(c);
  if (!settings.ai_api_url) {
    return c.json({ error: "未配置 AI 服务" }, 400);
  }
  if (!NO_KEY_PROVIDERS.includes(settings.ai_provider) && !settings.ai_api_key) {
    return c.json({ error: "未配置 API Key" }, 400);
  }

  const userId = c.req.header("X-User-Id") || "demo";
  const { noteIds } = await c.req.json() as { noteIds: string[] };

  if (!noteIds || noteIds.length === 0) {
    return c.json({ error: "请选择要格式化的笔记" }, 400);
  }

  if (noteIds.length > 20) {
    return c.json({ error: "单次最多格式化 20 篇笔记" }, 400);
  }

  const db = getDb();
  const results: { id: string; title: string; success: boolean; error?: string }[] = [];

  const aiHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.ai_api_key) {
    aiHeaders["Authorization"] = `Bearer ${settings.ai_api_key}`;
  }

  for (const noteId of noteIds) {
    try {
      const note = db.prepare(
        "SELECT id, title, contentText, isLocked FROM notes WHERE id = ? AND userId = ? AND isTrashed = 0"
      ).get(noteId) as { id: string; title: string; contentText: string; isLocked: number } | undefined;

      if (!note) {
        results.push({ id: noteId, title: "未找到", success: false, error: "笔记不存在" });
        continue;
      }

      if (note.isLocked) {
        results.push({ id: noteId, title: note.title, success: false, error: "笔记已锁定" });
        continue;
      }

      if (!note.contentText || note.contentText.trim().length < 10) {
        results.push({ id: noteId, title: note.title, success: false, error: "内容过短" });
        continue;
      }

      const batchBaseUrl = settings.ai_api_url.replace(/\/+$/, "");
      const res = await fetch(`${batchBaseUrl}/chat/completions`, {
        method: "POST",
        headers: aiHeaders,
        body: JSON.stringify({
          model: settings.ai_model,
          messages: [
            { role: "system", content: "你是一个专业的文档格式化助手。请将内容转换为规范的 Markdown 格式，合理使用标题层级、列表、表格、代码块、引用等元素。保持原始图片链接（![...](...)）不变。保持代码块的语言标记正确。保持内嵌表格格式完整。直接输出结果，不要添加额外解释。" },
            { role: "user", content: `请将以下笔记内容格式化为规范的 Markdown：\n\n${note.contentText.slice(0, 6000)}` },
          ],
          stream: false,
          temperature: 0.2,
          max_tokens: 4000,
        }),
      });

      if (!res.ok) {
        results.push({ id: noteId, title: note.title, success: false, error: `AI 返回 ${res.status}` });
        continue;
      }

      const data = await res.json();
      const formatted = data.choices?.[0]?.message?.content;

      if (formatted) {
        const contentText = formatted.replace(/[#*`>\-|_\[\]()]/g, "").replace(/\n{2,}/g, "\n").trim();
        db.prepare(
          "UPDATE notes SET contentText = ?, updatedAt = datetime('now'), version = version + 1 WHERE id = ?"
        ).run(contentText, noteId);
        results.push({ id: noteId, title: note.title, success: true });
      } else {
        results.push({ id: noteId, title: note.title, success: false, error: "AI 返回为空" });
      }
    } catch (err: any) {
      results.push({ id: noteId, title: "未知", success: false, error: err.message });
    }
  }

  const successCount = results.filter(r => r.success).length;
  return c.json({
    total: noteIds.length,
    success: successCount,
    failed: noteIds.length - successCount,
    results,
  });
});

// ===== ⑥ 知识库文档导入 =====
//
// scope 行为（与 /ai/knowledge-stats 保持一致）：
//   - 个人空间（workspaceId=null）：按 (userId, workspaceId IS NULL) 维度复用/创建
//     "知识库文档"笔记本，写入 notes 时 workspaceId=NULL；
//   - 工作区（workspaceId=<uuid>）：按 workspaceId 维度共享一个"知识库文档"笔记本，
//     不限作者（与 stats 的"工作区不限 userId"语义一致），创建时 owner 记当前用户。
ai.post("/import-to-knowledge", async (c) => {
  const settings = getAISettings(c);
  const scope = resolveScope(c);
  if ("error" in scope) return scope.error;
  const { userId, workspaceId } = scope;

  try {
    const formData = await c.req.formData();
    const files = formData.getAll("files") as File[];
    const notebookId = formData.get("notebookId") as string | null;

    if (!files || files.length === 0) {
      return c.json({ error: "请上传文件" }, 400);
    }

    if (files.length > 50) {
      return c.json({ error: "单次最多导入 50 个文件" }, 400);
    }

    const db = getDb();
    const { v4: uuidv4 } = (await import("uuid"));

    // 如果没有指定 notebookId，自动查找/创建一个"知识库文档"笔记本（按 scope 隔离）
    let targetNotebookId = notebookId;
    if (!targetNotebookId) {
      let existing: { id: string } | undefined;
      if (workspaceId === null) {
        // 个人空间：按 (userId, workspaceId IS NULL) 匹配
        existing = db.prepare(
          "SELECT id FROM notebooks WHERE name = '知识库文档' AND userId = ? AND workspaceId IS NULL",
        ).get(userId) as { id: string } | undefined;
      } else {
        // 工作区：按 workspaceId 共享，不限 userId
        existing = db.prepare(
          "SELECT id FROM notebooks WHERE name = '知识库文档' AND workspaceId = ? ORDER BY createdAt ASC LIMIT 1",
        ).get(workspaceId) as { id: string } | undefined;
      }

      if (existing) {
        targetNotebookId = existing.id;
      } else {
        targetNotebookId = uuidv4();
        db.prepare(
          "INSERT INTO notebooks (id, name, icon, userId, workspaceId, parentId, createdAt, updatedAt) VALUES (?, '知识库文档', '📚', ?, ?, NULL, datetime('now'), datetime('now'))",
        ).run(targetNotebookId, userId, workspaceId);
      }
    } else {
      // 用户显式传了 notebookId：必须确保它在当前 scope 内，避免把工作区文档塞到
      // 个人空间笔记本（或反之），同时阻断越权写入。
      const nb = db.prepare(
        "SELECT id, userId, workspaceId FROM notebooks WHERE id = ?",
      ).get(targetNotebookId) as { id: string; userId: string; workspaceId: string | null } | undefined;
      if (!nb) {
        return c.json({ error: "笔记本不存在" }, 404);
      }
      const nbWs = nb.workspaceId || null;
      if (nbWs !== workspaceId) {
        return c.json({ error: "笔记本不属于当前工作区" }, 403);
      }
      // 个人空间下还要确保是当前用户自己的笔记本
      if (workspaceId === null && nb.userId !== userId) {
        return c.json({ error: "无权写入该笔记本" }, 403);
      }
    }

    const results: { fileName: string; success: boolean; noteId?: string; error?: string }[] = [];
    const aiHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (settings.ai_api_key) {
      aiHeaders["Authorization"] = `Bearer ${settings.ai_api_key}`;
    }

    for (const file of files) {
      try {
        const fileName = file.name.toLowerCase();
        const buffer = Buffer.from(await file.arrayBuffer());
        let rawText = "";

        // 解析文件内容
        if (fileName.endsWith(".docx")) {
          const mammoth = await import("mammoth");
          const result = await mammoth.default.convertToHtml({ buffer });
          // 将 HTML 转为纯文本/简易 Markdown
          rawText = result.value
            .replace(/<h([1-6])>(.*?)<\/h[1-6]>/gi, (_: string, level: string, text: string) => '#'.repeat(Number(level)) + ' ' + text + '\n')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/?p>/gi, '\n')
            .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
            .replace(/<em>(.*?)<\/em>/gi, '*$1*')
            .replace(/<[^>]+>/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        } else if (fileName.endsWith(".doc")) {
          const WordExtractor = (await import("word-extractor")).default;
          const extractor = new WordExtractor();
          const doc = await extractor.extract(buffer as any);
          rawText = doc.getBody();
        } else if (fileName.endsWith(".csv") || fileName.endsWith(".tsv")) {
          const text = buffer.toString("utf-8");
          const sep = fileName.endsWith(".tsv") ? "\t" : ",";
          const lines = text.split("\n").filter(l => l.trim());
          if (lines.length > 0) {
            const headers = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, ""));
            rawText = `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n`;
            rawText += lines.slice(1).map(line =>
              `| ${line.split(sep).map(c => c.trim().replace(/^"|"$/g, "")).join(" | ")} |`
            ).join("\n");
          }
        } else if (fileName.endsWith(".txt") || fileName.endsWith(".md")) {
          rawText = buffer.toString("utf-8");
        } else if (fileName.endsWith(".html") || fileName.endsWith(".htm")) {
          const html = buffer.toString("utf-8");
          rawText = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, "\n")
            .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
            .replace(/\n{3,}/g, "\n\n").trim();
        } else if (fileName.endsWith(".json")) {
          const json = buffer.toString("utf-8");
          rawText = "```json\n" + json + "\n```";
        } else {
          results.push({ fileName: file.name, success: false, error: "不支持的格式" });
          continue;
        }

        if (!rawText.trim()) {
          results.push({ fileName: file.name, success: false, error: "内容为空" });
          continue;
        }

        // 如果配置了 AI，使用 AI 优化格式；否则直接存储原始内容
        let finalContent = rawText;
        if (settings.ai_api_url && (NO_KEY_PROVIDERS.includes(settings.ai_provider) || settings.ai_api_key)) {
          try {
            const importBaseUrl = settings.ai_api_url.replace(/\/+$/, "");
            const res = await fetch(`${importBaseUrl}/chat/completions`, {
              method: "POST",
              headers: aiHeaders,
              body: JSON.stringify({
                model: settings.ai_model,
                messages: [
                  { role: "system", content: "你是一个文档格式化助手。请将文档内容整理为结构清晰的 Markdown 笔记格式，保留原始信息。直接输出结果。" },
                  { role: "user", content: `请格式化以下文档内容：\n\n${rawText.slice(0, 6000)}` },
                ],
                stream: false,
                temperature: 0.2,
                max_tokens: 4000,
              }),
              signal: AbortSignal.timeout(30000),
            });
            if (res.ok) {
              const data = await res.json();
              const aiContent = data.choices?.[0]?.message?.content;
              if (aiContent) finalContent = aiContent;
            }
          } catch {
            // AI 失败则使用原始内容
          }
        }

        const noteId = uuidv4();
        const title = file.name.replace(/\.[^.]+$/, "");
        const contentText = finalContent.replace(/[#*`>\-|_\[\]()]/g, "").replace(/\n{2,}/g, "\n").trim();

        db.prepare(`
          INSERT INTO notes (id, title, content, contentText, notebookId, userId, workspaceId, isFavorite, isPinned, isTrashed, isLocked, version, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 1, datetime('now'), datetime('now'))
        `).run(noteId, title, JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: finalContent }] }] }), contentText, targetNotebookId, userId, workspaceId);

        results.push({ fileName: file.name, success: true, noteId });
      } catch (err: any) {
        results.push({ fileName: file.name, success: false, error: err.message });
      }
    }

    const successCount = results.filter(r => r.success).length;
    return c.json({
      total: files.length,
      success: successCount,
      failed: files.length - successCount,
      notebookId: targetNotebookId,
      results,
    });
  } catch (err: any) {
    return c.json({ error: err.message || "导入失败" }, 500);
  }
});

// ===== 知识库统计 =====
//
// 按当前 scope（个人空间 / 工作区）返回笔记/笔记本/标签数。注意：
//   - notes_fts 是全库共享的虚表，没有 userId/workspaceId 列；这里改为
//     "scope 内已有 contentText 非空的笔记数" 替代旧的 ftsCount，更贴近
//     用户感知（"有多少笔记被 FTS 索引过"在多用户共享 fts 表的语义下意义不大）。
ai.get("/knowledge-stats", (c) => {
  const db = getDb();
  const scope = resolveScope(c);
  if ("error" in scope) return scope.error;
  const { userId, workspaceId } = scope;

  // 个人空间需要叠加 userId 过滤；工作区只用 workspaceId（不限作者）
  const userClause = workspaceId === null ? "userId = ? AND " : "";
  const userParams: any[] = workspaceId === null ? [userId] : [];
  const wsClause = workspaceId === null ? "workspaceId IS NULL" : "workspaceId = ?";
  const wsParams: any[] = workspaceId === null ? [] : [workspaceId];

  const noteCount = (db.prepare(
    `SELECT COUNT(*) as count FROM notes WHERE ${userClause}${wsClause} AND isTrashed = 0`,
  ).get(...userParams, ...wsParams) as { count: number }).count;

  // "已被 FTS 索引"在共享 fts 表语境下没有 scope 维度，改为 "scope 内有正文的笔记数"
  const ftsCount = (db.prepare(
    `SELECT COUNT(*) as count FROM notes
       WHERE ${userClause}${wsClause} AND isTrashed = 0
         AND contentText IS NOT NULL AND contentText != ''`,
  ).get(...userParams, ...wsParams) as { count: number }).count;

  const notebookCount = (db.prepare(
    `SELECT COUNT(*) as count FROM notebooks WHERE ${userClause}${wsClause}`,
  ).get(...userParams, ...wsParams) as { count: number }).count;

  const tagCount = (db.prepare(
    `SELECT COUNT(*) as count FROM tags WHERE ${userClause}${wsClause}`,
  ).get(...userParams, ...wsParams) as { count: number }).count;

  const recentNotes = db.prepare(
    `SELECT title FROM notes
       WHERE ${userClause}${wsClause} AND isTrashed = 0
       ORDER BY updatedAt DESC LIMIT 5`,
  ).all(...userParams, ...wsParams) as { title: string }[];

  return c.json({
    noteCount,
    ftsCount,
    notebookCount,
    tagCount,
    recentTopics: recentNotes.map(n => n.title).filter(Boolean),
    indexed: ftsCount > 0,
  });
});

// ==============================================================
// RAG Phase 1：向量索引管理
// ==============================================================
//
// 这里只暴露"看进度"和"重建"两个端点，真正的算向量逻辑都在
// services/embedding-worker.ts 里后台跑，请求链路完全异步。
//
// 端点：
//   GET  /api/ai/embeddings/stats     —— 当前用户的向量索引统计 + 队列状态
//   POST /api/ai/embeddings/rebuild   —— 把当前用户全部笔记重新入队（可选清空老向量）
//
// 没有删除单条向量的端点：当笔记被删/移入回收站时，FK CASCADE + worker 自身的
// "笔记已删则 DELETE 队列项"逻辑已经能自洽清理。

// GET /api/ai/embeddings/stats?workspaceId=xxx
//
// scope 解析见 resolveScope。统计仅展示当前 scope 下的进度，避免"在工作区
// 视图里看到自己个人笔记的 indexed 数"造成误解。
ai.get("/embeddings/stats", (c) => {
  const scope = resolveScope(c);
  if ("error" in scope) return scope.error;
  const { userId, workspaceId } = scope;
  const stats = getEmbeddingStats({
    userId,
    workspaceId,
  });
  return c.json(stats);
});

// POST /api/ai/embeddings/rebuild?workspaceId=xxx
// body: { clearExisting?: boolean }  默认 true（切模型场景下老向量必须清，否则
// note_embeddings 里会同时存在多种维度的向量，后续检索会乱）
//
// scope 与 stats 同：
//   - 个人空间：仅清/重建当前用户在 workspaceId IS NULL 下的索引
//   - 工作区  ：仅清/重建该工作区的索引（不限作者，工作区共享）
ai.post("/embeddings/rebuild", async (c) => {
  let body: { clearExisting?: boolean } = {};
  try { body = await c.req.json(); } catch { /* 允许空 body */ }
  const clearExisting = body.clearExisting !== false; // 默认 true
  const scope = resolveScope(c);
  if ("error" in scope) return scope.error;
  const { userId, workspaceId } = scope;
  const result = rebuildAllEmbeddings({
    clearExisting,
    userId: workspaceId === null ? userId : undefined,
    workspaceId,
  });
  return c.json({ ok: true, ...result, clearedExisting: clearExisting });
});

// POST /api/ai/embeddings/reindex-vec
// 仅重建 vec0 虚表（从 note_embeddings.vectorJson 全量灌入），不重新调 embedding API。
// 用途：
//   - 用户从老版本升级（有 note_embeddings 但还没 vec_note_chunks）
//   - vec 表损坏 / 维度漂移后修复
//   - 重启发现 sqlite-vec 加载成功但 KNN 查不到东西时手动救场
// 不消耗 AI provider 配额，秒级完成。
ai.post("/embeddings/reindex-vec", (c) => {
  if (!isVecAvailable()) {
    // 即使 sqlite-vec 没加载，也允许调用 reindex（会在内部 noop），返回明确状态
    return c.json({ ok: false, error: "sqlite-vec 不可用（扩展未加载或维度未初始化）" }, 400);
  }
  const result = reindexAllVectors();
  return c.json({ ok: true, ...result });
});

// ==============================================================
// AI 聊天记录持久化（多会话）
// ==============================================================
//
// 设计（v10 起）：
//   每条消息挂到 ai_chat_conversations 的一条会话下，一个用户可以创建
//   多条会话（类似 ChatGPT 左侧对话列表），前端默认打开"最近一条会话"。
//
//   前端职责：
//     - 打开面板时 GET /conversations 拉列表、GET /chat-history?conversationId=...
//       拉当前会话的消息
//     - 点"新建对话"调 POST /conversations 拿 id
//     - 用户发送时：POST /chat-history 必须带 conversationId；AI 流式结束后
//       再 POST assistant 消息（同一个 conversationId）
//     - 点"删除会话"调 DELETE /conversations/:id（级联删除该会话下所有消息）
//     - 点"重命名"调 PATCH /conversations/:id
//
//   兼容旧前端：POST /chat-history 未传 conversationId 时，会自动挂到"最近一次
//   活跃的会话"（没有任何会话时现场建一条）——这样旧前端升级前后都能写入，
//   但多会话语义只有新前端才能真正用起来。

// 最多保留的历史条数；超过时按时间最老的裁掉（每次 POST 后兜底修剪）
// 注意：v10 起裁剪范围从"用户"收紧到"会话"，避免一条活跃会话挤掉其它会话
// 的历史——多会话的本意就是把各个话题隔开保存。
const CHAT_HISTORY_KEEP = 200;

/** 获取或现场创建一个"最近活跃"的会话 id，用于兼容未传 conversationId 的旧前端调用 */
function ensureDefaultConversation(db: ReturnType<typeof getDb>, userId: string): string {
  const row = db.prepare(`
    SELECT id FROM ai_chat_conversations
    WHERE userId = ? AND archived = 0
    ORDER BY updatedAt DESC, createdAt DESC
    LIMIT 1
  `).get(userId) as { id: string } | undefined;
  if (row) return row.id;
  const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(`
    INSERT INTO ai_chat_conversations (id, userId, title, archived, createdAt, updatedAt)
    VALUES (?, ?, '', 0, datetime('now'), datetime('now'))
  `).run(id, userId);
  return id;
}

/** 校验会话归属；不存在或跨用户返回 null */
function getConversation(
  db: ReturnType<typeof getDb>,
  userId: string,
  conversationId: string,
): { id: string; title: string } | null {
  const row = db.prepare(`
    SELECT id, title FROM ai_chat_conversations
    WHERE id = ? AND userId = ?
  `).get(conversationId, userId) as { id: string; title: string } | undefined;
  return row ?? null;
}

// ---------- 会话列表 ----------
// GET /api/ai/conversations
// 返回当前用户的会话（按 updatedAt 倒序），每条附最近一条消息做 preview
ai.get("/conversations", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";

  const rows = db.prepare(`
    SELECT
      conv.id,
      conv.title,
      conv.archived,
      conv.createdAt,
      conv.updatedAt,
      (SELECT COUNT(*) FROM ai_chat_messages m WHERE m.conversationId = conv.id) AS messageCount,
      (SELECT content FROM ai_chat_messages m WHERE m.conversationId = conv.id
        ORDER BY createdAt DESC, id DESC LIMIT 1) AS lastMessage,
      (SELECT role FROM ai_chat_messages m WHERE m.conversationId = conv.id
        ORDER BY createdAt DESC, id DESC LIMIT 1) AS lastRole
    FROM ai_chat_conversations conv
    WHERE conv.userId = ?
    ORDER BY conv.updatedAt DESC, conv.createdAt DESC
  `).all(userId) as {
    id: string;
    title: string;
    archived: number;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
    lastMessage: string | null;
    lastRole: string | null;
  }[];

  return c.json({
    conversations: rows.map(r => ({
      id: r.id,
      title: r.title || "",
      archived: r.archived === 1,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      messageCount: r.messageCount,
      lastMessage: r.lastMessage ? r.lastMessage.slice(0, 80) : null,
      lastRole: r.lastRole,
    })),
  });
});

// POST /api/ai/conversations
// body: { title? }  创建新会话并返回其 id
ai.post("/conversations", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  let body: { title?: string } = {};
  try { body = await c.req.json(); } catch { /* 允许空 body */ }
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 100) : "";

  const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(`
    INSERT INTO ai_chat_conversations (id, userId, title, archived, createdAt, updatedAt)
    VALUES (?, ?, ?, 0, datetime('now'), datetime('now'))
  `).run(id, userId, title);

  const row = db.prepare(
    "SELECT id, title, archived, createdAt, updatedAt FROM ai_chat_conversations WHERE id = ?"
  ).get(id) as {
    id: string; title: string; archived: number; createdAt: string; updatedAt: string;
  };

  return c.json({
    conversation: {
      id: row.id,
      title: row.title || "",
      archived: row.archived === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      messageCount: 0,
      lastMessage: null,
      lastRole: null,
    },
  });
});

// PATCH /api/ai/conversations/:id   body: { title?, archived? }
ai.patch("/conversations/:id", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  const id = c.req.param("id");

  let body: { title?: string; archived?: boolean } = {};
  try { body = await c.req.json(); } catch { /* ignore */ }

  const conv = getConversation(db, userId, id);
  if (!conv) return c.json({ error: "conversation not found" }, 404);

  const sets: string[] = [];
  const args: (string | number)[] = [];
  if (typeof body.title === "string") {
    sets.push("title = ?");
    args.push(body.title.trim().slice(0, 100));
  }
  if (typeof body.archived === "boolean") {
    sets.push("archived = ?");
    args.push(body.archived ? 1 : 0);
  }
  if (sets.length === 0) return c.json({ ok: true, noop: true });

  sets.push("updatedAt = datetime('now')");
  args.push(id);
  db.prepare(`UPDATE ai_chat_conversations SET ${sets.join(", ")} WHERE id = ?`).run(...args);

  return c.json({ ok: true });
});

// DELETE /api/ai/conversations/:id
// 连带删除会话下的所有消息（SQLite ALTER 加列拿不到 FK CASCADE，这里显式删）
ai.delete("/conversations/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  const id = c.req.param("id");

  const conv = getConversation(db, userId, id);
  if (!conv) return c.json({ error: "conversation not found" }, 404);

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM ai_chat_messages WHERE conversationId = ? AND userId = ?").run(id, userId);
    db.prepare("DELETE FROM ai_chat_conversations WHERE id = ? AND userId = ?").run(id, userId);
  });
  tx();

  return c.json({ ok: true });
});

// GET /api/ai/chat-history?conversationId=xxx&limit=100
// conversationId 可选：
//   - 传了：返回该会话的消息（校验归属）
//   - 未传：返回"最近活跃会话"的消息（兼容旧前端）；若该用户没任何消息/会话则返回 []
ai.get("/chat-history", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  const limitParam = Number(c.req.query("limit") || "100");
  const limit = Math.min(500, Math.max(1, Number.isFinite(limitParam) ? limitParam : 100));
  const convIdParam = c.req.query("conversationId") || "";

  let convId = "";
  if (convIdParam) {
    const conv = getConversation(db, userId, convIdParam);
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    convId = conv.id;
  } else {
    // 未传：挑最近活跃会话；没任何会话就直接返回空（不创建，避免 GET 产生副作用）
    const row = db.prepare(`
      SELECT id FROM ai_chat_conversations
      WHERE userId = ? AND archived = 0
      ORDER BY updatedAt DESC, createdAt DESC
      LIMIT 1
    `).get(userId) as { id: string } | undefined;
    if (!row) return c.json({ messages: [], conversationId: null });
    convId = row.id;
  }

  // 按时间倒序取最近 N 条，再在内存里反转成升序；SQL 里直接 ORDER BY ASC LIMIT 无法拿"最近 N 条"
  const rows = db.prepare(`
    SELECT id, role, content, referencesJson, createdAt
    FROM ai_chat_messages
    WHERE userId = ? AND conversationId = ?
    ORDER BY createdAt DESC, id DESC
    LIMIT ?
  `).all(userId, convId, limit) as {
    id: string;
    role: string;
    content: string;
    referencesJson: string | null;
    createdAt: string;
  }[];

  const messages = rows.reverse().map(r => ({
    id: r.id,
    role: r.role,
    content: r.content,
    references: r.referencesJson ? safeParseRefs(r.referencesJson) : undefined,
    createdAt: r.createdAt,
  }));

  return c.json({ messages, conversationId: convId });
});

function safeParseRefs(s: string): { id: string; title: string }[] | undefined {
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v;
  } catch { /* ignore */ }
  return undefined;
}

// POST /api/ai/chat-history
// body: { id?, conversationId?, role: 'user'|'assistant', content: string, references?: [{id,title}] }
// 返回：入库的 { id, createdAt, conversationId }
ai.post("/chat-history", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";

  let body: {
    id?: string;
    conversationId?: string;
    role?: string;
    content?: string;
    references?: { id: string; title: string }[];
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const role = body.role;
  if (role !== "user" && role !== "assistant") {
    return c.json({ error: "role must be 'user' or 'assistant'" }, 400);
  }
  const content = typeof body.content === "string" ? body.content : "";
  // assistant 流式可能结束时 content 为空字符串（比如用户中断），此时不入库以免脏数据
  if (role === "assistant" && content.trim().length === 0) {
    return c.json({ ok: true, skipped: true });
  }

  // 解析 conversationId：
  //   - 传了且校验通过：挂到它上面
  //   - 传了但不存在/跨用户：400，避免静默落到"默认会话"掩盖 bug
  //   - 未传：回退到"最近活跃会话"；无则现场建一条（兼容旧前端）
  let conversationId: string;
  if (body.conversationId) {
    const conv = getConversation(db, userId, body.conversationId);
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    conversationId = conv.id;
  } else {
    conversationId = ensureDefaultConversation(db, userId);
  }

  // id：优先用前端传入（前端在渲染时已生成；保持一致便于幂等），否则后端生成
  const id = body.id && typeof body.id === "string"
    ? body.id
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const referencesJson = Array.isArray(body.references) && body.references.length > 0
    ? JSON.stringify(body.references.map(r => ({ id: String(r.id), title: String(r.title) })))
    : null;

  // INSERT OR REPLACE：若前端重试用相同 id 再发一次，覆盖而不是重复
  db.prepare(`
    INSERT OR REPLACE INTO ai_chat_messages (id, userId, conversationId, role, content, referencesJson, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(id, userId, conversationId, role, content, referencesJson);

  // 顺手把会话的 updatedAt 推到最新——会话列表就能按"最近活动"排序
  db.prepare(`
    UPDATE ai_chat_conversations SET updatedAt = datetime('now') WHERE id = ?
  `).run(conversationId);

  // 会话内消息上限：超过时裁掉本会话最老的（按 createdAt 升序删除多余部分）
  const count = (db.prepare(
    "SELECT COUNT(*) as c FROM ai_chat_messages WHERE conversationId = ?"
  ).get(conversationId) as { c: number }).c;
  if (count > CHAT_HISTORY_KEEP) {
    const excess = count - CHAT_HISTORY_KEEP;
    db.prepare(`
      DELETE FROM ai_chat_messages
      WHERE id IN (
        SELECT id FROM ai_chat_messages
        WHERE conversationId = ?
        ORDER BY createdAt ASC, id ASC
        LIMIT ?
      )
    `).run(conversationId, excess);
  }

  const row = db.prepare(
    "SELECT createdAt FROM ai_chat_messages WHERE id = ?"
  ).get(id) as { createdAt: string } | undefined;

  return c.json({ ok: true, id, createdAt: row?.createdAt, conversationId });
});

// DELETE /api/ai/chat-history?conversationId=xxx
// - 传 conversationId：只清该会话的消息（会话本身保留，便于保留标题和创建时间）
// - 未传：兜底行为——清空"最近活跃会话"的消息（兼容旧前端的"清空聊天"按钮）
ai.delete("/chat-history", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "demo";
  const convIdParam = c.req.query("conversationId") || "";

  let convId = "";
  if (convIdParam) {
    const conv = getConversation(db, userId, convIdParam);
    if (!conv) return c.json({ error: "conversation not found" }, 404);
    convId = conv.id;
  } else {
    const row = db.prepare(`
      SELECT id FROM ai_chat_conversations
      WHERE userId = ? AND archived = 0
      ORDER BY updatedAt DESC, createdAt DESC
      LIMIT 1
    `).get(userId) as { id: string } | undefined;
    if (!row) return c.json({ ok: true, deleted: 0 });
    convId = row.id;
  }

  const info = db.prepare(
    "DELETE FROM ai_chat_messages WHERE userId = ? AND conversationId = ?"
  ).run(userId, convId);
  return c.json({ ok: true, deleted: info.changes });
});

// ============================================================
// AI 自定义指令模板（P2）
// ------------------------------------------------------------
// 给写作助手的"自定义指令"提供可持久化、可命名、可复用的模板仓库。
//
// 约定：
//   - 作用域：按 userId 隔离（不按工作区；写作风格属于个人属性）；
//   - 唯一性：同一用户下 name 唯一——UNIQUE(userId,name) 兜底，写路径
//     去重时把重名当成 400 而非 500，给前端更明确的错误语义；
//   - 排序：GET 默认按 usageCount DESC, updatedAt DESC，让"常用 + 最近编辑"
//     的模板自然置顶；
//   - 点击计数：专门的 POST /:id/touch 端点，避免把"使用一次"污染成写操作
//     导致 updatedAt 被扰动；usageCount 用它自增，lastUsedAt 独立更新。
// ============================================================

interface AiCustomPromptRow {
  id: string;
  userId: string;
  name: string;
  prompt: string;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toPromptDto(r: { id: string; name: string; prompt: string; usageCount: number; lastUsedAt: string | null; createdAt: string; updatedAt: string }) {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    usageCount: r.usageCount,
    lastUsedAt: r.lastUsedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** 标准化输入字符串：trim 并做基础长度校验 */
function normalizePromptInput(body: { name?: unknown; prompt?: unknown }):
  | { ok: true; name: string; prompt: string }
  | { ok: false; error: string } {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!name) return { ok: false, error: "名称不能为空" };
  if (name.length > 80) return { ok: false, error: "名称长度不能超过 80 个字符" };
  if (!prompt) return { ok: false, error: "指令内容不能为空" };
  if (prompt.length > 4000) return { ok: false, error: "指令内容长度不能超过 4000 个字符" };
  return { ok: true, name, prompt };
}

// GET /api/ai/prompts — 列出当前用户所有自定义指令
ai.get("/prompts", (c) => {
  const userId = c.req.header("X-User-Id") || "demo";
  const rows = aiCustomPromptsRepository.listByUser(userId);
  return c.json({ items: rows.map(toPromptDto) });
});

// POST /api/ai/prompts — 新建
ai.post("/prompts", async (c) => {
  const userId = c.req.header("X-User-Id") || "demo";
  const body = await c.req.json().catch(() => ({})) as { name?: unknown; prompt?: unknown };
  const norm = normalizePromptInput(body);
  if (!norm.ok) return c.json({ error: norm.error }, 400);

  const id = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    aiCustomPromptsRepository.create({ id, userId, name: norm.name, prompt: norm.prompt });
  } catch (e: any) {
    // UNIQUE(userId,name) 冲突 → 400 给前端明确信号
    if (String(e?.message || "").includes("UNIQUE")) {
      return c.json({ error: "已存在同名指令，请换一个名称" }, 400);
    }
    throw e;
  }
  const row = aiCustomPromptsRepository.getByIdAndUser(id, userId);
  if (!row) return c.json({ error: "指令不存在" }, 404);
  return c.json(toPromptDto(row));
});

// PUT /api/ai/prompts/:id — 更新（可改名、可改内容）
ai.put("/prompts/:id", async (c) => {
  const userId = c.req.header("X-User-Id") || "demo";
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({})) as { name?: unknown; prompt?: unknown };
  const norm = normalizePromptInput(body);
  if (!norm.ok) return c.json({ error: norm.error }, 400);

  // 先确认归属——防止跨用户篡改
  const own = aiCustomPromptsRepository.getByIdAndUser(id, userId);
  if (!own) return c.json({ error: "指令不存在" }, 404);

  try {
    aiCustomPromptsRepository.updateByIdAndUser(id, userId, { name: norm.name, prompt: norm.prompt });
  } catch (e: any) {
    if (String(e?.message || "").includes("UNIQUE")) {
      return c.json({ error: "已存在同名指令，请换一个名称" }, 400);
    }
    throw e;
  }
  const row = aiCustomPromptsRepository.getByIdAndUser(id, userId);
  if (!row) return c.json({ error: "指令不存在" }, 404);
  return c.json(toPromptDto(row));
});

// DELETE /api/ai/prompts/:id
ai.delete("/prompts/:id", (c) => {
  const userId = c.req.header("X-User-Id") || "demo";
  const id = c.req.param("id");
  const deleted = aiCustomPromptsRepository.deleteByIdAndUser(id, userId);
  if (!deleted) return c.json({ error: "指令不存在" }, 404);
  return c.json({ ok: true });
});

// POST /api/ai/prompts/:id/touch — 上报"被使用一次"
// 仅更新 usageCount/lastUsedAt，不动 updatedAt，避免"使用一次"扰动排序语义
// 里的"最近编辑"维度。
ai.post("/prompts/:id/touch", (c) => {
  const userId = c.req.header("X-User-Id") || "demo";
  const id = c.req.param("id");
  const touched = aiCustomPromptsRepository.touchUsage(id, userId);
  if (!touched) return c.json({ error: "指令不存在" }, 404);
  return c.json({ ok: true });
});

// ============================================================
// AI 自动目录归类（P3）
// ------------------------------------------------------------
// 让 AI 根据笔记标题 + 内容片段，从 scope 内的候选笔记本里推荐最匹配的
// 2-3 个归类目标。前端负责确认与执行移动（复用 updateNote({notebookId})）。
//
// 设计要点：
//   - scope：沿用 resolveScope(c) — 个人空间时 workspaceId=null，工作区时
//     强制成员校验；避免跨 scope 泄漏笔记本结构。
//   - 候选集：同 scope 下所有 notebooks，按 parentId 构建完整 path（"父/子/孙"）
//     塞进 prompt；笔记本数量超过 100 时只取 sortOrder 排序前 100 — 既保证
//     LLM 上下文不爆，也覆盖常用笔记本。
//   - LLM 输出：要求严格 JSON
//       { "suggestions": [{ "notebookId": "...", "reason": "...", "confidence": 0.8 }, ...] }
//     后端解析时加"JSON 提取"兜底（去掉 ``` 围栏、找 {…} 子串），LLM 偶尔
//     不守规也不全挂；解析失败直接 502 返回原文。
//   - confidence 容错：LLM 可能返回 0-1 小数或 0-100 整数；统一归一到 [0,1]。
//   - 只读：本端点不修改笔记；前端点"移动到此"才走 /notes/:id PUT。
// ============================================================

interface NotebookRow {
  id: string;
  parentId: string | null;
  name: string;
  description: string | null;
  sortOrder: number;
}

/** 把扁平 notebooks 列表构建成 "父/子/孙" 形态的路径文本，便于喂给 LLM */
function buildNotebookPaths(rows: NotebookRow[]): Map<string, string> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const cache = new Map<string, string>();
  const build = (id: string, visited = new Set<string>()): string => {
    if (cache.has(id)) return cache.get(id)!;
    if (visited.has(id)) return byId.get(id)?.name || id; // 防环（正常数据不该发生）
    visited.add(id);
    const node = byId.get(id);
    if (!node) return id;
    const path = node.parentId
      ? `${build(node.parentId, visited)} / ${node.name}`
      : node.name;
    cache.set(id, path);
    return path;
  };
  for (const r of rows) build(r.id);
  return cache;
}

/** 提取 JSON：先按 markdown code fence 剥，再贪心找 {...} */
function extractJsonObject(raw: string): any | null {
  if (!raw) return null;
  let t = raw.trim();
  // ```json ... ``` 或 ``` ... ```
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch { /* fallthrough */ }
  // 贪心取第一个 { 到最后一个 }
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(t.slice(first, last + 1));
    } catch { /* ignore */ }
  }
  return null;
}

// POST /api/ai/classify
// 请求体：{ noteId?: string; title?: string; content?: string; workspaceId?: string }
//   - 传 noteId → 后端读当前笔记的 title/contentText，安全起见校验归属
//   - 传 title + content → 用于"新笔记建议归类"场景（无 noteId 时走此路径）
// 响应：
//   { suggestions: [{ notebookId, notebookName, path, confidence, reason }] }
ai.post("/classify", async (c) => {
  const scope = resolveScope(c);
  if ("error" in scope) return scope.error;
  const { userId, workspaceId } = scope;

  const settings = getAISettings(c);
  if (!settings.ai_api_url) {
    return c.json({ error: "未配置 AI 服务" }, 400);
  }
  if (!NO_KEY_PROVIDERS.includes(settings.ai_provider) && !settings.ai_api_key) {
    return c.json({ error: "未配置 API Key" }, 400);
  }

  const body = await c.req.json().catch(() => ({})) as {
    noteId?: string;
    title?: string;
    content?: string;
  };
  const db = getDb();

  // ---- 1. 取当前笔记内容 ----
  let noteTitle = "";
  let noteText = "";
  let currentNotebookId: string | null = null;

  if (body.noteId) {
    const row = db.prepare(
      `SELECT id, userId, notebookId, title, contentText
         FROM notes
        WHERE id = ?`,
    ).get(body.noteId) as { id: string; userId: string; notebookId: string; title: string; contentText: string } | undefined;
    if (!row) return c.json({ error: "笔记不存在" }, 404);
    if (row.userId !== userId) return c.json({ error: "无权访问该笔记" }, 403);
    noteTitle = row.title || "";
    noteText = row.contentText || "";
    currentNotebookId = row.notebookId;
  } else {
    noteTitle = (body.title || "").trim();
    noteText = (body.content || "").trim();
    if (!noteTitle && !noteText) {
      return c.json({ error: "请提供 noteId 或 title/content" }, 400);
    }
  }

  // ---- 2. 取候选 notebooks（同 scope 内）----
  // workspaceId = null 代表个人空间；DB 层 notebooks 没有 workspaceId 列，
  // 目前按 userId 隔离即是个人空间；工作区笔记本走 workspaces 体系（与笔记
  // 的 notebookId 约束一致），这里用 notes 反推每个 notebook 所属 workspaceId：
  //   - 个人 scope：notebook 下所有 note.workspaceId IS NULL 视作个人 notebook；
  //     或者该 notebook 完全为空（从未被用过）时也归入个人候选；
  //   - 工作区 scope：至少有一条 note 挂在该工作区 → 候选。
  // 这样无需改 schema 就能复用现有隔离规则。若后续要把"空 notebook 归属"
  // 精确化，可在 notebooks 表加 workspaceId 列。
  let notebookRows: NotebookRow[];
  if (workspaceId === null) {
    notebookRows = db.prepare(`
      SELECT nb.id, nb.parentId, nb.name, nb.description, nb.sortOrder
        FROM notebooks nb
       WHERE nb.userId = ?
         AND NOT EXISTS (
           SELECT 1 FROM notes n
            WHERE n.notebookId = nb.id AND n.workspaceId IS NOT NULL
         )
       ORDER BY nb.sortOrder ASC, nb.name ASC
       LIMIT 100
    `).all(userId) as NotebookRow[];
  } else {
    notebookRows = db.prepare(`
      SELECT DISTINCT nb.id, nb.parentId, nb.name, nb.description, nb.sortOrder
        FROM notebooks nb
        JOIN notes n ON n.notebookId = nb.id
       WHERE nb.userId = ?
         AND n.workspaceId = ?
       ORDER BY nb.sortOrder ASC, nb.name ASC
       LIMIT 100
    `).all(userId, workspaceId) as NotebookRow[];
  }

  if (notebookRows.length === 0) {
    return c.json({ suggestions: [] });
  }

  const pathMap = buildNotebookPaths(notebookRows);

  // ---- 3. 构造 prompt ----
  // notebookLines 形如：
  //   [id_xxx] 技术 / 数据库 — MySQL/PG 相关的研究与调优记录
  // LLM 只需要返回我们给的 id；description 可选但有助于判断。
  const notebookLines = notebookRows.map((r) => {
    const p = pathMap.get(r.id) || r.name;
    const desc = r.description ? ` — ${r.description.slice(0, 80)}` : "";
    return `[${r.id}] ${p}${desc}`;
  }).join("\n");

  // 正文截断 2000 字符足够 LLM 判断主题；大文本喂太多反而稀释信号。
  const noteSnippet = noteText.slice(0, 2000);

  const systemPrompt =
    "你是一个专业的笔记归类助手。用户会提供一条笔记的标题与摘要，以及可选的目标笔记本列表。\n" +
    "请你从笔记本列表中挑选 1-3 个最合适的笔记本作为归类建议。\n" +
    "必须严格按下面的 JSON 格式返回，不要任何其他解释文字：\n" +
    `{"suggestions":[{"notebookId":"<id>","confidence":0.0-1.0,"reason":"20字以内的原因"}]}\n` +
    "要求：\n" +
    "1) notebookId 必须来自给定列表，不可编造；\n" +
    "2) confidence 是你对该归类的把握程度，0 到 1 之间的小数；\n" +
    "3) 按 confidence 从高到低排序；\n" +
    "4) 如果没有任何合适的笔记本，返回 {\"suggestions\":[]}。";

  const userMessage =
    `候选笔记本列表：\n${notebookLines}\n\n` +
    `笔记标题：${noteTitle || "（无标题）"}\n` +
    (currentNotebookId
      ? `当前所在笔记本ID：${currentNotebookId}（仅供参考，可选同类或其他更合适的）\n`
      : "") +
    `笔记摘要：\n${noteSnippet || "（无内容）"}`;

  const baseUrl = settings.ai_api_url.replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.ai_api_key) {
    headers["Authorization"] = `Bearer ${settings.ai_api_key}`;
  }

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: settings.ai_model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        stream: false,
        temperature: 0.1,
        max_tokens: 600,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return c.json({ error: `AI 服务返回错误：${res.status} ${errText.slice(0, 200)}` }, 502);
    }

    const data = await res.json() as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = data.choices?.[0]?.message?.content || "";

    const parsed = extractJsonObject(raw);
    if (!parsed || !Array.isArray(parsed.suggestions)) {
      return c.json({
        error: "AI 返回格式无法解析",
        raw: raw.slice(0, 500),
      }, 502);
    }

    // ---- 4. 校验 + 归一 ----
    // 只保留 notebookId 存在于候选集的项；confidence 可能是 0-1 / 0-100 / 字符串。
    const idSet = new Set(notebookRows.map((r) => r.id));
    const clean = (parsed.suggestions as any[])
      .map((s) => {
        const id = typeof s?.notebookId === "string" ? s.notebookId : "";
        if (!idSet.has(id)) return null;
        const nb = notebookRows.find((r) => r.id === id)!;
        let conf = Number(s?.confidence ?? 0);
        if (!Number.isFinite(conf)) conf = 0;
        if (conf > 1 && conf <= 100) conf = conf / 100;
        conf = Math.max(0, Math.min(1, conf));
        const reason = typeof s?.reason === "string" ? s.reason.slice(0, 100) : "";
        return {
          notebookId: id,
          notebookName: nb.name,
          path: pathMap.get(id) || nb.name,
          confidence: Number(conf.toFixed(3)),
          reason,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      // LLM 排序可能不可靠，后端再排一遍
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);

    return c.json({
      suggestions: clean,
      currentNotebookId,
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (msg.includes("timeout") || msg.includes("Timeout")) {
      return c.json({ error: "AI 请求超时，请稍后重试" }, 504);
    }
    return c.json({ error: `AI 请求失败：${msg.slice(0, 200)}` }, 502);
  }
});


// ===== 笔记本级 AI 总结 / Mermaid 生成 =====

/**
 * 从指定笔记本（可含子笔记本）收集笔记摘要文本。
 * 超过 maxNotes 篇时只取标题 + 前 200 字。
 */
function collectNotebookTexts(
  db: any,
  userId: string,
  workspaceId: string | null,
  notebookIds: string[],
  maxNotes = 50,
): { title: string; snippet: string }[] {
  const wsClause = workspaceId === null ? "workspaceId IS NULL" : "workspaceId = ?";
  const wsParams = workspaceId === null ? [] : [workspaceId];
  const userClause = workspaceId === null ? "userId = ? AND " : "";
  const userParams = workspaceId === null ? [userId] : [];
  const nbPh = notebookIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT title, contentText FROM notes
    WHERE ${userClause}${wsClause} AND isTrashed = 0 AND notebookId IN (${nbPh})
    ORDER BY updatedAt DESC
    LIMIT ?
  `).all(...userParams, ...wsParams, ...notebookIds, maxNotes) as { title: string; contentText: string }[];
  return rows.map(r => ({
    title: r.title || "(未命名)",
    snippet: (r.contentText || "").slice(0, 200),
  }));
}

ai.post("/notebook-summary", async (c) => {
  const body = await c.req.json() as { notebookId: string; includeChildren?: boolean };
  if (!body.notebookId) return c.json({ error: "请指定笔记本" }, 400);

  const scope = resolveKnowledgeScope(c, body);
  if ("error" in scope) return scope.error;
  const { userId, workspaceId, notebookIds } = scope;
  if (!notebookIds) return c.json({ error: "请指定笔记本" }, 400);

  const db = getDb();
  const notes = collectNotebookTexts(db, userId, workspaceId, notebookIds);
  if (notes.length === 0) return c.json({ error: "该笔记本没有笔记" }, 400);

  const noteBlock = notes.map((n, i) => `${i + 1}. ${n.title}\n${n.snippet}`).join("\n\n");
  const prompt = "请总结以下笔记本中的笔记内容，要求：\n1. 先给出笔记本整体主题\n2. 列出 5-10 条核心要点\n3. 给出一段简洁总结\n4. 不要编造原文没有的信息\n5. 用中文输出\n\n笔记列表：\n" + noteBlock;

  try {
    const settings = getAISettings(c);
    const text = await callAIChat(settings, [
      { role: "system", content: "你是一个知识库分析助手。" },
      { role: "user", content: prompt },
    ], { max_tokens: 1500 });
    return c.json({ summary: text, noteCount: notes.length });
  } catch (err: any) {
    return c.json({ error: err.message || "AI 请求失败" }, 500);
  }
});

ai.post("/notebook-mermaid", async (c) => {
  const body = await c.req.json() as { notebookId: string; includeChildren?: boolean; diagramType?: "mindmap" | "flowchart" };
  if (!body.notebookId) return c.json({ error: "请指定笔记本" }, 400);

  const scope = resolveKnowledgeScope(c, body);
  if ("error" in scope) return scope.error;
  const { userId, workspaceId, notebookIds } = scope;
  if (!notebookIds) return c.json({ error: "请指定笔记本" }, 400);

  const db = getDb();
  const notes = collectNotebookTexts(db, userId, workspaceId, notebookIds);
  if (notes.length === 0) return c.json({ error: "该笔记本没有笔记" }, 400);

  const diagramType = body.diagramType || "mindmap";
  const noteBlock = notes.map((n, i) => `${i + 1}. ${n.title}\n${n.snippet}`).join("\n\n");
  const prompt = diagramType === "mindmap"
    ? "请根据以下笔记列表生成一个 Mermaid mindmap 思维导图，展示笔记本的知识结构。要求：只输出 Mermaid 源码，不要代码围栏，不要解释，第一行必须是 mindmap，节点不超过 50 个，层级不超过 4 层。\n\n笔记列表：\n" + noteBlock
    : "请根据以下笔记列表生成一个 Mermaid flowchart 流程图，展示笔记本的知识结构和笔记间关系。要求：只输出 Mermaid 源码，不要代码围栏，不要解释，第一行必须是 flowchart TD，节点不超过 50 个。\n\n笔记列表：\n" + noteBlock;

  try {
    const settings = getAISettings(c);
    let mermaid = await callAIChat(settings, [
      { role: "system", content: "你是一个知识库可视化助手。只输出合法的 Mermaid 源码。" },
      { role: "user", content: prompt },
    ], { max_tokens: 2000 });

    // 清洗：去掉围栏、多余空白
    mermaid = mermaid.replace(/^```mermaid\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```\s*$/, "").trim();
    // 校验开头
    if (diagramType === "mindmap" && !mermaid.startsWith("mindmap")) {
      return c.json({ error: "AI 未返回合法的 mindmap 源码", raw: mermaid.slice(0, 300) }, 502);
    }
    if (diagramType === "flowchart" && !mermaid.startsWith("flowchart") && !mermaid.startsWith("graph")) {
      return c.json({ error: "AI 未返回合法的 flowchart 源码", raw: mermaid.slice(0, 300) }, 502);
    }

    return c.json({ mermaid, diagramType, noteCount: notes.length });
  } catch (err: any) {
    return c.json({ error: err.message || "AI 请求失败" }, 500);
  }
});
export default ai;

