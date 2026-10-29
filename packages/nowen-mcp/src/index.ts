#!/usr/bin/env node
/**
 * Nowen Note MCP Server
 * 
 * 让 Codex CLI / Claude Desktop / Cursor 等 AI 工具直接操作 Nowen Note 笔记系统。
 * 
 * 环境变量：
 *   NOWEN_URL      — Nowen Note 后端地址（默认 http://localhost:3001）
 *   NOWEN_API_TOKEN — 推荐：个人 API Token
 *   NOWEN_USERNAME — 可选：显式指定的用户名（不使用默认管理员账号）
 *   NOWEN_PASSWORD — 可选：显式指定的登录密码
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NowenApiClient } from "./api-client.js";
import { stringifyTimedResult } from "./result-time.js";
import { registerP1Tools } from "./p1-tools.js";
import { registerP2Tools } from "./p2-tools.js";
import { registerMigrationTools } from "./migration-tools.js";
import { treeMutationRevision, treeMutationPreconditions, type TreeMutationNode } from "./tree-mutation.js";
import {
  CONTENT_FORMAT_VALUES,
  buildCreateNotePayload,
  buildReadNoteResult,
  buildUpdateNotePayloadWithCurrentVersion,
} from "./note-format.js";

// ===== 从环境变量读取配置 =====
const config = {
  baseUrl: process.env.NOWEN_URL || "http://localhost:3001",
  username: process.env.NOWEN_USERNAME || "",
  password: process.env.NOWEN_PASSWORD || "",
};

const api = new NowenApiClient(config);

/** Plugin execution, webhooks and automation can have external side effects. */
function requireDangerousToolOptIn(toolName: string): void {
  if (process.env.MCP_ENABLE_DANGEROUS_TOOLS?.trim().toLowerCase() === "true") return;
  throw new Error(`${toolName} 已默认关闭；请在确认宿主客户端授权策略后设置 MCP_ENABLE_DANGEROUS_TOOLS=true`);
}

// ===== 创建 MCP Server =====
export function createNowenMcpServer(options: { transport?: "stdio" | "streamable-http" } = {}): McpServer {
const allowLocalFiles = options.transport !== "streamable-http";
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
        content: [{ type: "text" as const, text: stringifyTimedResult(summary) }],
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
        content: [{ type: "text" as const, text: stringifyTimedResult(summary) }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "nowen_read_note",
  "读取指定笔记，可返回纯文本、Markdown/原始正文或结构化块树",
  {
    noteId: z.string().describe("笔记 ID"),
    mode: z.enum(["text", "markdown", "blocks"]).optional().describe("返回模式，默认 text"),
    includeBlockIds: z.boolean().optional().describe("text/markdown 模式是否同时附带块 ID 列表"),
    maxBlocks: z.number().int().positive().max(2000).optional().describe("blocks 模式最大块数量，默认 500"),
  },
  async ({ noteId, mode, includeBlockIds, maxBlocks }) => {
    try {
      const note = await api.getNote(noteId);
      const selectedMode = mode || "text";
      if (selectedMode === "blocks") {
        const blocks = await api.listNoteBlocks(noteId, maxBlocks || 500);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            id: note.id,
            title: note.title,
            notebookId: note.notebookId,
            version: note.version,
            contentFormat: note.contentFormat,
            blocks,
          }, null, 2) }],
        };
      }
      const result: any = selectedMode === "markdown"
        ? {
            id: note.id,
            title: note.title,
            notebookId: note.notebookId,
            version: note.version,
            contentFormat: note.contentFormat,
            content: note.content,
          }
        : buildReadNoteResult(note);
      if (includeBlockIds) result.blocks = await api.listNoteBlocks(noteId, maxBlocks || 500);
      return {
        content: [{ type: "text" as const, text: stringifyTimedResult(result) }],
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
    contentFormat: z.enum(CONTENT_FORMAT_VALUES).optional().describe("内容格式，默认 markdown"),
  },
  async ({ notebookId, title, content, contentFormat }) => {
    try {
      const body = buildCreateNotePayload({ notebookId, title, content, contentFormat });
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
    contentFormat: z.enum(CONTENT_FORMAT_VALUES).optional().describe("内容格式，默认 markdown"),
  },
  async ({ noteId, title, content, contentFormat }) => {
    try {
      const body = await buildUpdateNotePayloadWithCurrentVersion(api, { noteId, title, content, contentFormat });
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
  "安全地将笔记移到回收站；默认只预览。MCP 禁止永久删除，执行需提供预览版本和确认文本",
  {
    noteId: z.string().min(1).describe("笔记 ID"),
    permanent: z.boolean().optional().describe("永久删除已禁用；传 true 将拒绝请求"),
    dryRun: z.boolean().optional().describe("默认 true：先预览笔记，不进行删除"),
    expectedVersion: z.number().int().positive().optional().describe("执行时必须与预览的 version 完全一致"),
    confirmation: z.string().optional().describe("执行时填写 MOVE_TO_TRASH；应先征得用户确认"),
  },
  async ({ noteId, permanent, dryRun, expectedVersion, confirmation }) => {
    try {
      if (permanent) throw new Error("MCP 永久删除已禁用；请在 Nowen Note 回收站界面手动执行");
      const note = await api.getNote(noteId);
      if (!note || note.id !== noteId) throw new Error("无法读取当前笔记");
      const preview = {
        noteId, title: note.title, notebookId: note.notebookId,
        version: note.version, alreadyTrashed: Boolean(note.isTrashed),
      };
      if (dryRun !== false) {
        return { content: [{ type: "text" as const, text: `移入回收站预览（未执行）：\n${JSON.stringify(preview, null, 2)}\n请确认后传 dryRun=false、expectedVersion、confirmation=MOVE_TO_TRASH。` }] };
      }
      if (confirmation !== "MOVE_TO_TRASH") throw new Error("缺少明确确认：confirmation 必须是 MOVE_TO_TRASH");
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== note.version) {
        throw new Error(`笔记版本已变化或未确认，当前版本 ${note.version}，请重新预览`);
      }
      if (note.isTrashed) throw new Error("笔记已在回收站，无须重复删除");
      const result = await api.updateNote(noteId, { isTrashed: 1, version: expectedVersion, writeSource: "mcp" });
      return { content: [{ type: "text" as const, text: `已移入回收站（可恢复）：${JSON.stringify({ id: noteId, version: result?.version })}` }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== 双链与块工具 ====================

const noteBlockTypeSchema = z.enum(["heading", "paragraph", "listItem", "taskItem", "blockquote", "codeBlock"]);

server.tool(
  "nowen_resolve_link",
  "解析 note: 内部链接，返回目标笔记和可选目标块",
  { link: z.string().describe("note:<noteId> 或 note:<noteId>#blk:<blockId>") },
  async ({ link }) => {
    try {
      const result = await api.resolveInternalLink(link);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "nowen_get_backlinks",
  "获取引用指定笔记的来源笔记和来源块",
  {
    noteId: z.string().describe("目标笔记 ID"),
    limit: z.number().int().positive().max(200).optional().describe("最大结果数，默认 100"),
  },
  async ({ noteId, limit }) => {
    try {
      const backlinks = await api.getBacklinks(noteId, limit || 100);
      return { content: [{ type: "text" as const, text: JSON.stringify(backlinks, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "nowen_get_block",
  "按 noteId + blockId 读取单个结构化块",
  {
    noteId: z.string().describe("笔记 ID"),
    blockId: z.string().describe("块 ID"),
  },
  async ({ noteId, blockId }) => {
    try {
      const block = await api.getBlock(noteId, blockId);
      return { content: [{ type: "text" as const, text: JSON.stringify(block, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "nowen_search_blocks",
  "全文搜索块，返回 noteId、blockId、块类型、文本和路径",
  {
    query: z.string().describe("搜索关键词"),
    notebookId: z.string().optional().describe("限定笔记本 ID"),
    limit: z.number().int().positive().max(200).optional().describe("最大结果数，默认 50"),
  },
  async ({ query, notebookId, limit }) => {
    try {
      const blocks = await api.searchBlocks(query, { notebookId, limit: limit || 50 });
      return { content: [{ type: "text" as const, text: JSON.stringify(blocks, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "nowen_get_block_backlinks",
  "获取指向指定块的来源笔记和来源块",
  {
    noteId: z.string().describe("目标笔记 ID"),
    blockId: z.string().describe("目标块 ID"),
  },
  async ({ noteId, blockId }) => {
    try {
      const backlinks = await api.getBlockBacklinks(noteId, blockId);
      return { content: [{ type: "text" as const, text: JSON.stringify(backlinks, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "nowen_create_block",
  "在笔记中创建块；通过 expectedNoteVersion 防并发覆盖，operationId 保证重试幂等",
  {
    noteId: z.string().describe("笔记 ID"),
    blockType: noteBlockTypeSchema.optional().describe("块类型，默认 paragraph"),
    text: z.string().optional().describe("块文本"),
    afterBlockId: z.string().optional().describe("插入到该块之后；不传则追加"),
    expectedNoteVersion: z.number().int().positive().describe("当前笔记版本"),
    operationId: z.string().min(8).max(128).describe("调用方生成的幂等操作 ID"),
  },
  async ({ noteId, blockType, text, afterBlockId, expectedNoteVersion, operationId }) => {
    try {
      const result = await api.createBlock(noteId, { blockType, text, afterBlockId, expectedNoteVersion, operationId });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "nowen_update_block",
  "更新块文本，要求笔记版本和幂等操作 ID",
  {
    noteId: z.string().describe("笔记 ID"),
    blockId: z.string().describe("块 ID"),
    text: z.string().describe("新文本"),
    expectedNoteVersion: z.number().int().positive().describe("当前笔记版本"),
    operationId: z.string().min(8).max(128).describe("幂等操作 ID"),
  },
  async ({ noteId, blockId, text, expectedNoteVersion, operationId }) => {
    try {
      const result = await api.updateBlock(noteId, blockId, { text, expectedNoteVersion, operationId });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "nowen_delete_block",
  "删除块，要求笔记版本和幂等操作 ID",
  {
    noteId: z.string().describe("笔记 ID"),
    blockId: z.string().describe("块 ID"),
    expectedNoteVersion: z.number().int().positive().describe("当前笔记版本"),
    operationId: z.string().min(8).max(128).describe("幂等操作 ID"),
  },
  async ({ noteId, blockId, expectedNoteVersion, operationId }) => {
    try {
      const result = await api.deleteBlock(noteId, blockId, { expectedNoteVersion, operationId });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "nowen_move_block",
  "在同一父块内移动块，要求笔记版本和幂等操作 ID",
  {
    noteId: z.string().describe("笔记 ID"),
    blockId: z.string().describe("要移动的块 ID"),
    targetBlockId: z.string().describe("目标块 ID"),
    position: z.enum(["before", "after"]).optional().describe("放在目标之前或之后，默认 after"),
    expectedNoteVersion: z.number().int().positive().describe("当前笔记版本"),
    operationId: z.string().min(8).max(128).describe("幂等操作 ID"),
  },
  async ({ noteId, blockId, targetBlockId, position, expectedNoteVersion, operationId }) => {
    try {
      const result = await api.moveBlock(noteId, blockId, { targetBlockId, position, expectedNoteVersion, operationId });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  },
);

// ==================== 附件工具 ====================

server.tool(
  "nowen_upload_attachment",
  "上传本地文件到 Nowen Note。传 noteId 时绑定指定笔记；不传 noteId 时上传到文件管理。返回的 url 可直接写入 Markdown 图片或链接",
  {
    filePath: z.string().describe("本地文件路径"),
    noteId: z.string().optional().describe("目标笔记 ID（可选；传入后走 /api/attachments）"),
    filename: z.string().optional().describe("上传时使用的文件名（可选）"),
    mimeType: z.string().optional().describe("MIME 类型（可选；未传会按扩展名做基础推断）"),
    workspaceId: z.string().optional().describe("工作区 ID（可选；仅未绑定上传时使用）"),
    folderId: z.string().optional().describe("附件文件夹 ID（可选；仅未绑定上传时使用）"),
  },
  async ({ filePath, noteId, filename, mimeType, workspaceId, folderId }) => {
    try {
      if (!allowLocalFiles) throw new Error("HTTP MCP 不允许读取服务器本地路径，请使用 REST 文件上传");
      const result = await api.uploadAttachment({ filePath, noteId, filename, mimeType, workspaceId, folderId });
      return {
        content: [{
          type: "text" as const,
          text: `附件上传成功:\n${JSON.stringify({
            id: result.id,
            url: result.url,
            mimeType: result.mimeType,
            size: result.size,
            filename: result.filename,
            category: result.category,
            markdown: result.category === "image"
              ? `![${result.filename}](${result.url})`
              : `[${result.filename}](${result.url}?download=1)`,
          }, null, 2)}`,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "nowen_list_attachments",
  "列出 Nowen Note 文件管理中的附件，可按类型、笔记、笔记本、文件夹、关键词和引用状态筛选",
  {
    category: z.enum(["all", "image", "file"]).optional().describe("附件类型，默认 all"),
    filter: z.enum(["unreferenced", "myUploads"]).optional().describe("筛选视图：无引用或我的上传"),
    myUploadsRef: z.enum(["referenced", "unreferenced"]).optional().describe("我的上传子筛选"),
    noteId: z.string().optional().describe("只列出被该笔记引用过的附件"),
    notebookId: z.string().optional().describe("按笔记本筛选"),
    folderId: z.string().optional().describe("按附件文件夹筛选；__unarchived 表示未归档"),
    q: z.string().optional().describe("文件名关键词"),
    page: z.number().int().positive().optional().describe("页码，默认 1"),
    pageSize: z.number().int().positive().max(200).optional().describe("每页数量，默认 50，最大 200"),
    workspaceId: z.string().optional().describe("工作区 ID（可选）"),
  },
  async (params) => {
    try {
      const result = await api.listAttachments(params);
      const summary = (result.items || []).map((file: any) => ({
        id: file.id,
        filename: file.filename,
        url: file.url,
        mimeType: file.mimeType,
        size: file.size,
        category: file.category,
        primaryNote: file.primaryNote,
      }));
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ items: summary, total: result.total, page: result.page, pageSize: result.pageSize }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "nowen_attach_to_note",
  "把已上传附件插入指定 Markdown 笔记正文。图片生成 ![alt](url)，其它文件生成下载链接，并携带当前 version 更新笔记",
  {
    noteId: z.string().describe("目标笔记 ID"),
    attachmentId: z.string().describe("附件 ID"),
    alt: z.string().optional().describe("图片 alt 文本或文件链接标题"),
    mode: z.enum(["append", "prepend", "replace_marker"]).optional().describe("插入模式，默认 append"),
    marker: z.string().optional().describe("replace_marker 模式要替换的占位文本"),
  },
  async ({ noteId, attachmentId, alt, mode, marker }) => {
    try {
      const note = await api.attachToNote({ noteId, attachmentId, alt, mode, marker });
      return {
        content: [{
          type: "text" as const,
          text: `附件已插入笔记:\n${JSON.stringify({ id: note.id, title: note.title, version: note.version }, null, 2)}`,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// ==================== 搜索工具 ====================

server.tool(
  "nowen_search",
  "搜索笔记或块；块级搜索会返回稳定 blockId",
  {
    query: z.string().describe("搜索关键词"),
    level: z.enum(["note", "block"]).optional().describe("搜索层级，默认 note"),
    notebookId: z.string().optional().describe("块级搜索时限定笔记本"),
    limit: z.number().int().positive().max(200).optional().describe("块级结果上限"),
  },
  async ({ query, level, notebookId, limit }) => {
    try {
      if (level === "block") {
        const blocks = await api.searchBlocks(query, { notebookId, limit: limit || 50 });
        return { content: [{ type: "text" as const, text: `找到 ${blocks.length} 个块:\n${JSON.stringify(blocks, null, 2)}` }] };
      }
      const results = await api.search(query);
      const summary = results.map((r: any) => ({
        id: r.id,
        title: r.title,
        snippet: r.snippet,
        notebookId: r.notebookId,
        updatedAt: r.updatedAt,
      }));
      return {
        content: [{ type: "text" as const, text: `找到 ${results.length} 条结果:\n${stringifyTimedResult(summary)}` }],
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
        content: [{ type: "text" as const, text: stringifyTimedResult(summary) }],
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
  "nowen_list_plugin_actions",
  "发现 Nowen Note 中已启用的插件 Action 及其输入结构",
  {},
  async () => {
    try {
      const actions = await api.listPluginActions();
      return { content: [{ type: "text" as const, text: JSON.stringify(actions, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "nowen_execute_plugin_action",
  "按 pluginId 和 actionId 执行已授权的 Nowen 插件 Action",
  {
    pluginId: z.string().describe("Manifest 中稳定的插件 ID"),
    actionId: z.string().describe("Manifest 中稳定的 Action ID"),
    input: z.record(z.any()).describe("符合 Action input schema 的参数对象"),
  },
  async ({ pluginId, actionId, input }) => {
    try {
      requireDangerousToolOptIn("nowen_execute_plugin_action");
      const result = await api.executePluginAction(pluginId, actionId, input);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "nowen_get_plugin_execution",
  "查询一次插件 Action 的执行状态、错误和截断日志",
  { executionId: z.string().describe("执行 ID") },
  async ({ executionId }) => {
    try {
      const result = await api.getPluginExecution(executionId);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true };
    }
  }
);

// Personal task tools
server.tool("nowen_list_tasks", "List personal tasks", {
  filter: z.enum(["all","today","week","overdue","completed"]).optional()
}, async ({ filter }) => {
  try {
    const result = await api.listTasks(filter);
    return { content: [{ type: "text" as const, text: stringifyTimedResult(result) }] };
  } catch (error: any) {
    return { content: [{ type: "text" as const, text: String(error.message) }], isError: true };
  }
});
server.tool("nowen_get_task", "Read personal task", { taskId: z.string() }, async ({ taskId }) => {
  try { return { content: [{ type: "text" as const, text: stringifyTimedResult(await api.getTask(taskId)) }] }; }
  catch (error: any) { return { content: [{ type: "text" as const, text: String(error.message) }], isError: true }; }
});
const dueAtSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/)
  .describe("本地截止时间 YYYY-MM-DDTHH:mm，不带时区；与 dueDate 日期一致。提醒时区由 timezoneOffsetMinutes 指定");
server.tool("nowen_create_task", "Create personal task with user approval; use nowen_create_task_reminder afterwards to set a reminder", {
  title: z.string().min(1), dueDate: z.string().optional(), dueAt: dueAtSchema.optional(), priority: z.number().int().min(1).max(3).optional()
}, async ({ title, dueDate, dueAt, priority }) => {
  try { return { content: [{ type: "text" as const, text: stringifyTimedResult(await api.createTask({ title, dueDate, dueAt, priority })) }] }; }
  catch (error: any) { return { content: [{ type: "text" as const, text: String(error.message) }], isError: true }; }
});
server.tool("nowen_complete_task", "Complete personal task with user approval", { taskId: z.string() }, async ({ taskId }) => {
  try { return { content: [{ type: "text" as const, text: stringifyTimedResult(await api.updateTask(taskId, { isCompleted: true })) }] }; }
  catch (error: any) { return { content: [{ type: "text" as const, text: String(error.message) }], isError: true }; }
});
server.tool("nowen_get_task_summary", "Read personal task counts", {}, async () => {
  try { return { content: [{ type: "text" as const, text: JSON.stringify(await api.taskSummary()) }] }; }
  catch (error: any) { return { content: [{ type: "text" as const, text: String(error.message) }], isError: true }; }
});
// ==================== 任务项目与安全元数据工具 ====================

server.tool(
  "nowen_update_task",
  "更新本人个人任务的标题、描述、到期日期/具体时间、优先级或状态；不会修改空间、项目或父子关系",
  {
    taskId: z.string().min(1),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    dueDate: z.string().nullable().optional(),
    dueAt: dueAtSchema.nullable().optional(),
    priority: z.number().int().min(1).max(3).optional(),
    status: z.enum(["todo", "doing", "blocked", "done"]).optional(),
  },
  async ({ taskId, title, description, dueDate, dueAt, priority, status }) => {
    try {
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (description !== undefined) body.description = description;
      if (dueDate !== undefined) body.dueDate = dueDate;
      if (dueAt !== undefined) body.dueAt = dueAt;
      if (priority !== undefined) body.priority = priority;
      if (status !== undefined) body.status = status;
      if (!Object.keys(body).length) throw new Error("至少指定一个待更新字段");
      const task = await api.updateTask(taskId, body);
      return { content: [{ type: "text" as const, text: stringifyTimedResult(task) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `错误: ${error.message}` }], isError: true };
    }
  },
);

server.tool(
  "nowen_create_subtask",
  "为本人个人任务创建子任务；父任务必须属于同一用户个人空间",
  {
    parentTaskId: z.string().min(1),
    title: z.string().min(1),
    priority: z.number().int().min(1).max(3).optional(),
    dueDate: z.string().optional(),
    dueAt: dueAtSchema.optional(),
  },
  async ({ parentTaskId, title, priority, dueDate, dueAt }) => {
    try {
      const task = await api.createTask({ parentId: parentTaskId, title, priority, dueDate, dueAt });
      return { content: [{ type: "text" as const, text: stringifyTimedResult(task) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `错误: ${error.message}` }], isError: true };
    }
  },
);

server.tool("nowen_list_task_reminders", "读取本人个人任务的提醒，需要 tasks:read", {
  taskId: z.string().min(1),
}, async ({ taskId }) => {
  try { return { content: [{ type: "text" as const, text: stringifyTimedResult(await api.listTaskReminders(taskId)) }] }; }
  catch (error: any) { return { content: [{ type: "text" as const, text: String(error.message) }], isError: true }; }
});

server.tool("nowen_create_task_reminder", "经用户批准为已有个人任务设置提醒，需要 tasks:write。先创建含 dueDate/dueAt 的任务，再设置提醒；不代表已获设备通知权限", {
  taskId: z.string().min(1),
  offsetMinutes: z.number().int().min(0).max(525600).describe("提前分钟数，0 为到期时；全天任务按用户时区次日零点倒推"),
  timezoneOffsetMinutes: z.number().int().min(-840).max(840).describe("用户在截止日期的 UTC 偏移分钟，采用 JS getTimezoneOffset 符号：UTC+8 为 -480，UTC-5 为 300；不要使用服务器时区"),
}, async ({ taskId, offsetMinutes, timezoneOffsetMinutes }) => {
  try { return { content: [{ type: "text" as const, text: stringifyTimedResult(await api.createTaskReminder(taskId, { offsetMinutes, timezoneOffsetMinutes })) }] }; }
  catch (error: any) { return { content: [{ type: "text" as const, text: String(error.message) }], isError: true }; }
});

server.tool(
  "nowen_assign_task_project",
  "将个人任务分配至个人项目或从项目中移除；不允许跨用户或工作区关联",
  {
    taskId: z.string().min(1),
    projectId: z.string().nullable().describe("个人项目 ID，null 表示取消关联"),
  },
  async ({ taskId, projectId }) => {
    try {
      const result = await api.updateTask(taskId, { projectId });
      return { content: [{ type: "text" as const, text: stringifyTimedResult(result) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `错误: ${error.message}` }], isError: true };
    }
  },
);

server.tool(
  "nowen_archive_task",
  "归档或恢复已完成的个人顶层任务及其子任务；归档前需获得用户批准",
  {
    taskId: z.string().min(1),
    archived: z.boolean().describe("true=归档，false=恢复"),
  },
  async ({ taskId, archived }) => {
    try {
      const result = await api.archiveTask(taskId, archived);
      return { content: [{ type: "text" as const, text: stringifyTimedResult(result) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `错误: ${error.message}` }], isError: true };
    }
  },
);

server.tool("nowen_list_task_projects", "列出本人个人空间的任务项目", {}, async () => {
  try {
    const items = await api.listTaskProjects();
    return { content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }] };
  } catch (error: any) {
    return { content: [{ type: "text" as const, text: `错误: ${error.message}` }], isError: true };
  }
});

server.tool(
  "nowen_create_task_project",
  "在本人个人空间中创建任务项目，不会创建团队项目",
  {
    name: z.string().min(1).max(120),
    icon: z.string().max(32).optional(),
    color: z.string().max(32).optional(),
  },
  async ({ name, icon, color }) => {
    try {
      const result = await api.createTaskProject({ name, icon, color });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `错误: ${error.message}` }], isError: true };
    }
  },
);

server.tool(
  "nowen_update_task_project",
  "修改本人个人项目的名称、图标或颜色；不允许跨空间移动项目",
  {
    projectId: z.string().min(1),
    name: z.string().min(1).max(120).optional(),
    icon: z.string().max(32).optional(),
    color: z.string().max(32).optional(),
  },
  async ({ projectId, name, icon, color }) => {
    try {
      if (name === undefined && icon === undefined && color === undefined) throw new Error("至少提供一个修改字段");
      const result = await api.updateTaskProject(projectId, { name, icon, color });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `错误: ${error.message}` }], isError: true };
    }
  },
);

// Note metadata uses the same version precondition as the existing MCP note updater.
server.tool(
  "nowen_set_note_flags",
  "更新笔记收藏或置顶状态，保留笔记正文和内容格式",
  {
    noteId: z.string().min(1),
    favorite: z.boolean().optional(),
    pinned: z.boolean().optional(),
  },
  async ({ noteId, favorite, pinned }) => {
    try {
      if (favorite === undefined && pinned === undefined) throw new Error("必须设置 favorite 或 pinned");
      const current = await api.getNote(noteId);
      const update = await api.updateNote(noteId, {
        version: current.version || 1,
        writeSource: "mcp",
        ...(favorite !== undefined ? { isFavorite: favorite ? 1 : 0 } : {}),
        ...(pinned !== undefined ? { isPinned: pinned ? 1 : 0 } : {}),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ id: update.id, version: update.version, isPinned: update.isPinned, isFavorite: update.isFavorite }, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `错误: ${error.message}` }], isError: true };
    }
  },
);

server.tool(
  "nowen_get_knowledge_tree",
  "读取某个空间的统一知识树，包含文件夹、笔记和文件节点；服务端及 Token 会按权限过滤",
  {
    workspaceId: z.string().optional().describe("personal 或团队工作区 ID，默认 personal"),
  },
  async ({ workspaceId }) => {
    try {
      const result = await api.getKnowledgeTree(workspaceId);
      const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
      const summary = nodes.map((node: any) => ({
        id: node.id,
        parentId: node.parentId,
        resourceType: node.resourceType,
        resourceId: node.resourceId,
        title: node.title,
        childCount: node.childCount,
        isDeleted: node.isDeleted,
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify({ nodes: summary }, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `错误: ${error.message}` }], isError: true };
    }
  },
);

server.tool(
  "nowen_move_note",
  "预览或执行笔记移动，默认只预览；执行时必须提供预览得到的预期版本，并确认目标笔记本有权限",
  {
    noteId: z.string().min(1),
    targetNotebookId: z.string().min(1),
    dryRun: z.boolean().optional().describe("默认 true：仅预览，不更改数据"),
    expectedVersion: z.number().int().positive().optional().describe("执行移动时必填：预览返回的 version"),
  },
  async ({ noteId, targetNotebookId, dryRun, expectedVersion }) => {
    try {
      const note = await api.getNote(noteId);
      const version = note.version || 1;
      const preview = { noteId, title: note.title, sourceNotebookId: note.notebookId, targetNotebookId, version };
      if (dryRun !== false) {
        return { content: [{ type: "text" as const, text: `移动预览（未写入）:\n${JSON.stringify(preview, null, 2)}` }] };
      }
      if (expectedVersion === undefined || expectedVersion !== version) {
        throw new Error(`笔记已变化或缺少版本确认，当前版本为 ${version}；请重新预览`);
      }
      if (note.notebookId === targetNotebookId) {
        return { content: [{ type: "text" as const, text: "目标笔记本与当前位置相同，无需移动" }] };
      }
      const moved = await api.updateNote(noteId, { notebookId: targetNotebookId, version, writeSource: "mcp" });
      return { content: [{ type: "text" as const, text: JSON.stringify({ id: moved.id, notebookId: moved.notebookId, version: moved.version }, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `错误: ${error.message}` }], isError: true };
    }
  },
);

// ==================== P0: 知识树安全变更 ====================

const treeOperationShape = {
  operation: z.enum(["create", "rename", "move", "trash", "restore"]),
  nodeId: z.string().min(1).optional().describe("要修改的知识树节点 ID；create 时可省略"),
  parentId: z.string().min(1).optional().describe("create/move 需要目标文件夹节点 ID"),
  title: z.string().trim().min(1).max(120).optional().describe("create/rename 使用的新名称"),
  nodeType: z.enum(["folder", "markdown"]).optional().describe("create 使用，默认 folder"),
};

async function prepareTreeOperation(params: {
  operation: "create" | "rename" | "move" | "trash" | "restore";
  nodeId?: string;
  parentId?: string;
  title?: string;
  nodeType?: "folder" | "markdown";
}) {
  const catalog = await api.getKnowledgeTree("personal", true);
  const nodes = (Array.isArray(catalog?.nodes) ? catalog.nodes : []) as TreeMutationNode[];
  const { operation, nodeId, parentId, title } = params;
  if ((operation === "create" || operation === "rename") && !title?.trim()) {
    throw new Error("创建或重命名时必须填写非空 title");
  }
  if ((operation === "create" || operation === "move") && !parentId) {
    throw new Error("创建或移动必须指定目标文件夹 parentId");
  }
  if (operation !== "create" && !nodeId) throw new Error("必须指定 nodeId");
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const source = operation === "create" ? byId.get(parentId!) : byId.get(nodeId!);
  if (!source) throw new Error("源节点或创建位置不存在，或者当前 Token 没有访问权限");
  if (source.workspaceId != null) throw new Error("MCP P0 仅支持个人知识树操作");
  if (operation === "create" && (source.isDeleted || source.resourceType !== "notebook")) {
    throw new Error("只允许在有效文件夹下创建笔记或文件夹");
  }
  if (operation !== "create" && !["note", "notebook"].includes(source.resourceType)) {
    throw new Error("只允许修改普通笔记或文件夹，其他资源类型暂不开放");
  }
  const target = parentId ? byId.get(parentId) : null;
  if (parentId && (!target || target.workspaceId != null || target.isDeleted || target.resourceType !== "notebook")) {
    throw new Error("目标文件夹不存在或不属于个人空间");
  }
  const isSubtree = ["move", "trash", "restore"].includes(operation);
  const previewId = operation === "create" ? parentId! : nodeId!;
  const revision = treeMutationRevision(nodes, previewId);
  const subtreeRevision = isSubtree ? treeMutationRevision(nodes, previewId, true) : undefined;
  const affectedNodeIds = isSubtree ? nodes.filter((node) => {
    let current: TreeMutationNode | undefined = node;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      if (current.id === previewId) return true;
      visited.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return false;
  }).map((node) => node.id) : [previewId];
  if (affectedNodeIds.length > 10000) throw new Error("受影响节点过多，请拆分操作");
  if (isSubtree && affectedNodeIds.some((id) => {
    const descendant = byId.get(id);
    return !descendant || descendant.workspaceId != null
      || !["note", "notebook"].includes(descendant.resourceType);
  })) {
    throw new Error("目录包含文件、思维导图或其他尚未验收的资源类型；MCP P0 禁止修改这种混合子树");
  }
  return {
    nodes, source, target, revision, subtreeRevision,
    preconditions: treeMutationPreconditions(source, subtreeRevision),
    affectedNodeIds,
  };
}

server.tool(
  "nowen_preview_knowledge_tree_change",
  "预览创建、重命名、移动、回收站或恢复操作；不修改任何数据。返回修订指纹，实际操作前必须向用户确认",
  treeOperationShape,
  async (params) => {
    try {
      const plan = await prepareTreeOperation(params);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            dryRun: true, operation: params.operation, nodeId: params.nodeId,
            parentId: params.parentId, title: params.title, nodeType: params.nodeType || "folder",
            source: {
              id: plan.source.id, title: plan.source.title,
              parentId: plan.source.parentId, isDeleted: Boolean(plan.source.isDeleted),
            },
            target: plan.target ? { id: plan.target.id, title: plan.target.title } : null,
            affectedCount: plan.affectedNodeIds.length,
            affectedNodeIds: plan.affectedNodeIds.slice(0, 30),
            revision: plan.revision, subtreeRevision: plan.subtreeRevision,
            nextStep: "征得用户确认后，在 nowen_apply_knowledge_tree_change 中填写相同参数、revision 和 confirmation。",
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `错误: ${error.message}` }], isError: true };
    }
  },
);

server.tool(
  "nowen_apply_knowledge_tree_change",
  "在用户确认后执行知识树变更；必须先调用预览并提交匹配的 revision。删除仅移动至可恢复的回收站，绝不永久删除",
  {
    ...treeOperationShape,
    expectedRevision: z.string().regex(/^[0-9a-f]{64}$/).describe("必须填写上次预览得到的 revision"),
    expectedSubtreeRevision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    confirmation: z.enum(["APPLY_TREE_CHANGE", "MOVE_TREE_TO_TRASH", "RESTORE_TREE"])
      .describe("删除必须 MOVE_TREE_TO_TRASH；恢复必须 RESTORE_TREE；其余操作 APPLY_TREE_CHANGE"),
  },
  async (params) => {
    try {
      const { operation, nodeId, parentId, title, nodeType, expectedRevision, expectedSubtreeRevision, confirmation } = params;
      const requiredConfirmation = operation === "trash" ? "MOVE_TREE_TO_TRASH"
        : operation === "restore" ? "RESTORE_TREE" : "APPLY_TREE_CHANGE";
      if (confirmation !== requiredConfirmation) throw new Error("未提供本次操作要求的明确确认");
      const plan = await prepareTreeOperation(params);
      if (plan.revision !== expectedRevision) throw new Error("目录在预览后发生变化，请重新预览");
      if (plan.subtreeRevision !== expectedSubtreeRevision) {
        throw new Error("子目录内容在预览后发生变化，请重新预览，防止误操作");
      }
      const preconditions = plan.preconditions;
      let result: any;
      if (operation === "create") {
        result = await api.createKnowledgeNode({
          parentId: parentId!, title: title!.trim(), nodeType: nodeType || "folder",
          ...preconditions,
        });
      } else if (operation === "rename") {
        result = await api.renameKnowledgeNode(nodeId!, { title: title!.trim(), ...preconditions });
      } else if (operation === "move") {
        result = await api.moveKnowledgeNode(nodeId!, { parentId: parentId!, ...preconditions });
      } else if (operation === "trash") {
        result = await api.trashKnowledgeNode(nodeId!, preconditions);
      } else {
        result = await api.restoreKnowledgeNode(nodeId!, { includeSubtree: true, ...preconditions });
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ applied: true, operation, result }, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text" as const, text: `错误: ${error.message}` }], isError: true };
    }
  },
);

// ==================== 自动化工具 ====================

server.tool(
  "nowen_list_workflows",
  "列出当前用户可管理的 Nowen 自动化工作流及其启用状态",
  {},
  async () => {
    try {
      const workflows = await api.listWorkflows();
      return { content: [{ type: "text" as const, text: JSON.stringify(workflows.map((item) => ({ id: item.id, name: item.name, enabled: item.enabled, trigger: item.trigger })), null, 2) }] };
    } catch (err: any) { return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true }; }
  },
);

server.tool(
  "nowen_run_workflow",
  "手动运行一个已存在的 Nowen 工作流；不会创建或长期启用工作流",
  { workflowId: z.string().describe("工作流 ID") },
  async ({ workflowId }) => {
    try {
      requireDangerousToolOptIn("nowen_run_workflow");
      const run = await api.runWorkflow(workflowId);
      return { content: [{ type: "text" as const, text: JSON.stringify(run, null, 2) }] };
    } catch (err: any) { return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true }; }
  },
);

server.tool(
  "nowen_get_workflow_run",
  "查询 Nowen 工作流运行状态和每一步的持久化记录",
  { runId: z.string().describe("工作流运行 ID") },
  async ({ runId }) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(await api.getWorkflowRun(runId), null, 2) }] };
    } catch (err: any) { return { content: [{ type: "text" as const, text: `错误: ${err.message}` }], isError: true }; }
  },
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
      requireDangerousToolOptIn("nowen_create_webhook");
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
      requireDangerousToolOptIn("nowen_create_backup");
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

// 注册 P1 安全网盘和任务成果转存工具。
registerP1Tools(server, api);
registerP2Tools(server, api);
registerMigrationTools(server, api, { allowLocalFiles });
return server;
}

// ==================== 启动 ====================

export async function main() {
  const server = createNowenMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`🚀 Nowen Note MCP Server 已启动`);
  console.error(`   连接目标: ${config.baseUrl}`);
  console.error(`   用户: ${config.username}`);
}


