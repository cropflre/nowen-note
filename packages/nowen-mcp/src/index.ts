#!/usr/bin/env node
/**
 * Nowen Note MCP Server
 * 
 * 让 Codex CLI / Claude Desktop / Cursor 等 AI 工具直接操作 Nowen Note 笔记系统。
 * 
 * 环境变量：
 *   NOWEN_URL      — Nowen Note 后端地址（默认 http://localhost:3001）
 *   NOWEN_USERNAME — 登录用户名（默认 admin）
 *   NOWEN_PASSWORD — 登录密码（默认 admin123）
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NowenApiClient } from "./api-client.js";

// ===== 从环境变量读取配置 =====
const config = {
  baseUrl: process.env.NOWEN_URL || "http://localhost:3001",
  username: process.env.NOWEN_USERNAME || "admin",
  password: process.env.NOWEN_PASSWORD || "admin123",
};

const api = new NowenApiClient(config);

// ===== 创建 MCP Server =====
const server = new McpServer({
  name: "nowen-note",
  version: "1.0.0",
});

// ==================== 笔记本工具 ====================

server.tool(
  "nowen_list_notebooks",
  "获取 Nowen Note 中的所有笔记本列表（支持树形结构），返回每个笔记本的 id、名称、图标、颜色和笔记数量",
  {},
  async () => {
    try {
      const notebooks = await api.listNotebooks();
      const summary = notebooks.map((nb: any) => ({
        id: nb.id,
        name: nb.name,
        icon: nb.icon,
        color: nb.color,
        parentId: nb.parentId,
        noteCount: nb.noteCount,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "nowen_create_notebook",
  "在 Nowen Note 中创建一个新笔记本",
  {
    name: z.string().describe("笔记本名称"),
    parentId: z.string().optional().describe("父笔记本 ID（可选，创建子笔记本时使用）"),
    icon: z.string().optional().describe("笔记本图标 emoji（默认 📒）"),
  },
  async ({ name, parentId, icon }) => {
    try {
      const notebook = await api.createNotebook({ name, parentId, icon });
      return {
        content: [{ type: "text" as const, text: `笔记本创建成功:\n${JSON.stringify(notebook, null, 2)}` }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== 笔记工具 ====================

server.tool(
  "nowen_list_notes",
  "获取 Nowen Note 中的笔记列表。可按笔记本、标签、收藏状态、日期范围等筛选。返回笔记概要（不含完整内容）",
  {
    notebookId: z.string().optional().describe("按笔记本 ID 筛选"),
    tagId: z.string().optional().describe("按标签 ID 筛选"),
    isFavorite: z.boolean().optional().describe("是否只返回收藏笔记"),
    isTrashed: z.boolean().optional().describe("是否只返回回收站笔记"),
    search: z.string().optional().describe("全文搜索关键词"),
    dateFrom: z.string().optional().describe("开始日期 YYYY-MM-DD"),
    dateTo: z.string().optional().describe("结束日期 YYYY-MM-DD"),
  },
  async ({ notebookId, tagId, isFavorite, isTrashed, search, dateFrom, dateTo }) => {
    try {
      const query: Record<string, string> = {};
      if (notebookId) query.notebookId = notebookId;
      if (tagId) query.tagId = tagId;
      if (isFavorite) query.isFavorite = "1";
      if (isTrashed) query.isTrashed = "1";
      if (search) query.search = search;
      if (dateFrom) query.dateFrom = dateFrom;
      if (dateTo) query.dateTo = dateTo;

      const notes = await api.listNotes(query);
      const summary = notes.map((n: any) => ({
        id: n.id,
        title: n.title,
        notebookId: n.notebookId,
        isPinned: n.isPinned,
        isFavorite: n.isFavorite,
        isLocked: n.isLocked,
        updatedAt: n.updatedAt,
        contentPreview: n.contentText?.slice(0, 100),
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "nowen_read_note",
  "读取 Nowen Note 中指定笔记的完整内容（包括标题、正文、标签等全部信息）",
  {
    noteId: z.string().describe("笔记 ID"),
  },
  async ({ noteId }) => {
    try {
      const note = await api.getNote(noteId);
      // 提取纯文本内容供 AI 阅读
      const result = {
        id: note.id,
        title: note.title,
        notebookId: note.notebookId,
        contentText: note.contentText,
        isPinned: note.isPinned,
        isFavorite: note.isFavorite,
        isLocked: note.isLocked,
        version: note.version,
        tags: note.tags?.map((t: any) => ({ id: t.id, name: t.name })),
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "nowen_create_note",
  "在 Nowen Note 中创建一篇新笔记。需要指定目标笔记本 ID",
  {
    notebookId: z.string().describe("目标笔记本 ID"),
    title: z.string().optional().describe("笔记标题(默认为'无标题笔记')"),
    content: z.string().optional().describe("笔记内容（Markdown 纯文本）"),
  },
  async ({ notebookId, title, content }) => {
    try {
      const body: any = { notebookId };
      if (title) body.title = title;
      if (content) {
        // 将纯文本包装为 TipTap JSON 格式
        body.content = JSON.stringify({
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: content }] }],
        });
        body.contentText = content;
      }
      const note = await api.createNote(body);
      return {
        content: [{ type: "text" as const, text: `笔记创建成功:\n${JSON.stringify({ id: note.id, title: note.title }, null, 2)}` }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "nowen_update_note",
  "更新 Nowen Note 中已有笔记的标题或内容",
  {
    noteId: z.string().describe("笔记 ID"),
    title: z.string().optional().describe("新标题"),
    content: z.string().optional().describe("新内容（Markdown 纯文本）"),
  },
  async ({ noteId, title, content }) => {
    try {
      const body: any = {};
      if (title) body.title = title;
      if (content) {
        body.content = JSON.stringify({
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: content }] }],
        });
        body.contentText = content;
      }
      const note = await api.updateNote(noteId, body);
      return {
        content: [{ type: "text" as const, text: `笔记更新成功:\n${JSON.stringify({ id: note.id, title: note.title, version: note.version }, null, 2)}` }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "nowen_delete_note",
  "将 Nowen Note 中指定笔记移入回收站（软删除），或从回收站永久删除",
  {
    noteId: z.string().describe("笔记 ID"),
    permanent: z.boolean().optional().describe("是否永久删除（默认 false，仅移入回收站）"),
  },
  async ({ noteId, permanent }) => {
    try {
      if (permanent) {
        await api.deleteNote(noteId);
        return { content: [{ type: "text" as const, text: `笔记已永久删除: ${noteId}` }] };
      } else {
        await api.updateNote(noteId, { isTrashed: 1 });
        return { content: [{ type: "text" as const, text: `笔记已移入回收站: ${noteId}` }] };
      }
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== 搜索工具 ====================

server.tool(
  "nowen_search",
  "在 Nowen Note 中全文搜索笔记。使用 FTS5 全文索引，支持模糊匹配，返回匹配的笔记摘要和高亮片段",
  {
    query: z.string().describe("搜索关键词"),
  },
  async ({ query }) => {
    try {
      const results = await api.search(query);
      const summary = results.map((r: any) => ({
        id: r.id,
        title: r.title,
        snippet: r.snippet,
        notebookId: r.notebookId,
        updatedAt: r.updatedAt,
      }));
      return {
        content: [{ type: "text" as const, text: `找到 ${results.length} 条结果:\n${JSON.stringify(summary, null, 2)}` }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== 标签工具 ====================

server.tool(
  "nowen_list_tags",
  "获取 Nowen Note 中的所有标签列表，包含每个标签的颜色和关联笔记数",
  {},
  async () => {
    try {
      const tags = await api.listTags();
      const summary = tags.map((t: any) => ({
        id: t.id,
        name: t.name,
        color: t.color,
        noteCount: t.noteCount,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "nowen_manage_tags",
  "管理 Nowen Note 中笔记的标签：创建标签、给笔记添加标签、或移除笔记标签",
  {
    action: z.enum(["create", "add_to_note", "remove_from_note"]).describe("操作类型: create=创建标签, add_to_note=给笔记添加标签, remove_from_note=移除笔记标签"),
    tagName: z.string().optional().describe("标签名称（创建时必填）"),
    tagColor: z.string().optional().describe("标签颜色（创建时可选，默认蓝色）"),
    tagId: z.string().optional().describe("标签 ID（添加/移除时必填）"),
    noteId: z.string().optional().describe("笔记 ID（添加/移除时必填）"),
  },
  async ({ action, tagName, tagColor, tagId, noteId }) => {
    try {
      switch (action) {
        case "create": {
          if (!tagName) throw new Error("创建标签时 tagName 必填");
          const tag = await api.createTag({ name: tagName, color: tagColor });
          return { content: [{ type: "text" as const, text: `标签创建成功:\n${JSON.stringify(tag, null, 2)}` }] };
        }
        case "add_to_note": {
          if (!noteId || !tagId) throw new Error("添加标签时 noteId 和 tagId 必填");
          await api.addTagToNote(noteId, tagId);
          return { content: [{ type: "text" as const, text: `已为笔记 ${noteId} 添加标签 ${tagId}` }] };
        }
        case "remove_from_note": {
          if (!noteId || !tagId) throw new Error("移除标签时 noteId 和 tagId 必填");
          await api.removeTagFromNote(noteId, tagId);
          return { content: [{ type: "text" as const, text: `已移除笔记 ${noteId} 的标签 ${tagId}` }] };
        }
      }
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== AI 工具 ====================

server.tool(
  "nowen_ai_ask",
  "向 Nowen Note 知识库提问。系统会自动检索相关笔记内容，结合 AI 生成回答，并标注信息来源",
  {
    question: z.string().describe("要提问的问题"),
  },
  async ({ question }) => {
    try {
      const { answer, references } = await api.askKnowledge(question);
      let text = answer;
      if (references.length > 0) {
        text += "\n\n📌 参考笔记:\n";
        text += references.map((r, i) => `  ${i + 1}. [${r.title}] (id: ${r.id})`).join("\n");
      }
      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "nowen_ai_process",
  "使用 AI 处理笔记文本。支持续写、改写、润色、精简、扩展、翻译、摘要、解释、纠错、格式化等操作",
  {
    action: z.enum([
      "continue", "rewrite", "polish", "shorten", "expand",
      "translate_en", "translate_zh", "summarize", "explain",
      "fix_grammar", "format_markdown", "format_code", "custom",
    ]).describe("处理类型"),
    text: z.string().describe("要处理的文本内容"),
    customPrompt: z.string().optional().describe("自定义指令（action 为 custom 时必填）"),
  },
  async ({ action, text, customPrompt }) => {
    try {
      const result = await api.aiChat({ action, text, customPrompt });
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "nowen_knowledge_stats",
  "获取 Nowen Note 知识库的统计信息，包括笔记数、笔记本数、标签数、FTS 索引状态等",
  {},
  async () => {
    try {
      const stats = await api.knowledgeStats();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== 插件工具 ====================

server.tool(
  "nowen_list_plugins",
  "获取 Nowen Note 中已加载的插件列表，每个插件声明了它支持的能力（action）",
  {},
  async () => {
    try {
      const plugins = await api.listPlugins();
      return { content: [{ type: "text" as const, text: JSON.stringify(plugins, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "nowen_execute_plugin",
  "执行 Nowen Note 中指定名称的插件，传入参数并获取处理结果",
  {
    pluginName: z.string().describe("插件名称"),
    params: z.record(z.any()).describe("传给插件的参数对象"),
  },
  async ({ pluginName, params }) => {
    try {
      const result = await api.executePlugin(pluginName, params);
      if (result.text) {
        return { content: [{ type: "text" as const, text: result.text }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== Webhook 工具 ====================

server.tool(
  "nowen_list_webhooks",
  "获取 Nowen Note 中已配置的 Webhook 列表",
  {},
  async () => {
    try {
      const webhooks = await api.listWebhooks();
      return { content: [{ type: "text" as const, text: JSON.stringify(webhooks, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "nowen_create_webhook",
  "在 Nowen Note 中创建新的 Webhook，当指定事件发生时自动推送 HTTP 通知",
  {
    url: z.string().describe("Webhook 回调 URL"),
    events: z.array(z.string()).optional().describe("监听的事件列表，如 ['note.created', 'note.updated']，默认为 ['*'] 接收所有"),
    description: z.string().optional().describe("描述"),
  },
  async ({ url, events, description }) => {
    try {
      const webhook = await api.createWebhook({ url, events, description });
      return { content: [{ type: "text" as const, text: `Webhook 创建成功!\nID: ${webhook.id}\nSecret: ${webhook.secret}\n\n请妥善保存 Secret，后续不会再显示。` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== 审计日志工具 ====================

server.tool(
  "nowen_audit_stats",
  "获取 Nowen Note 的操作审计统计（按分类、级别统计，以及最近操作记录）",
  {},
  async () => {
    try {
      const stats = await api.getAuditStats();
      let text = `📊 审计统计\n总记录: ${stats.total} | 今日: ${stats.todayCount}\n\n`;
      text += `按分类:\n`;
      for (const c of stats.byCategory || []) {
        text += `  ${c.category}: ${c.count}\n`;
      }
      text += `\n最近操作:\n`;
      for (const r of (stats.recent || []).slice(0, 5)) {
        text += `  [${r.level}] ${r.category}.${r.action} — ${r.createdAt}\n`;
      }
      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== 备份工具 ====================

server.tool(
  "nowen_list_backups",
  "获取 Nowen Note 的数据备份列表",
  {},
  async () => {
    try {
      const backups = await api.listBackups();
      if (backups.length === 0) {
        return { content: [{ type: "text" as const, text: "暂无备份" }] };
      }
      const text = backups.map(b =>
        `📦 ${b.filename}\n   大小: ${(b.size / 1024).toFixed(1)}KB | 类型: ${b.type} | 笔记: ${b.noteCount} | 时间: ${b.createdAt}`
      ).join("\n\n");
      return { content: [{ type: "text" as const, text }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "nowen_create_backup",
  "创建 Nowen Note 数据备份。db-only 仅备份数据库，full 备份所有数据",
  {
    type: z.enum(["db-only", "full"]).optional().describe("备份类型，默认 db-only"),
  },
  async ({ type }) => {
    try {
      const backup = await api.createBackup(type || "db-only");
      return { content: [{ type: "text" as const, text: `✅ 备份创建成功!\n文件: ${backup.filename}\n大小: ${(backup.size / 1024).toFixed(1)}KB\n笔记: ${backup.noteCount} 篇\n校验: ${backup.checksum}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== 资源：笔记本列表 ====================

server.resource(
  "notebooks",
  "nowen://notebooks",
  async (uri) => {
    const notebooks = await api.listNotebooks();
    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(notebooks, null, 2),
      }],
    };
  }
);

// ==================== 启动 ====================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`🚀 Nowen Note MCP Server 已启动`);
  console.error(`   连接目标: ${config.baseUrl}`);
  console.error(`   用户: ${config.username}`);
}

main().catch((err) => {
  console.error("MCP Server 启动失败:", err);
  process.exit(1);
});
