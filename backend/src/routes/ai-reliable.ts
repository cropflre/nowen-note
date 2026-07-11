import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getDb } from "../db/schema";
import { getUserWorkspaceRole, hasPermission, resolveNotePermission } from "../middleware/acl";
import { callAIChat, callAIChatStream, sanitizeError, type AISettings } from "../services/ai-client";
import { embedQuery, getEmbeddingStats } from "../services/embedding-worker";
import { isVecAvailable, knnSearch } from "../services/vec-store";
import {
  fitContextBudget,
  normalizeExternalText,
  noteToPlainText,
  safeContextPreview,
  type BudgetedContext,
} from "../services/ai-context";

const app = new Hono();
const CONTEXT_BUDGET = 48_000;
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS = 4_000;
const GUARDED_AI_KEYS = [
  "ai_provider",
  "ai_api_url",
  "ai_api_key",
  "ai_model",
  "ai_embedding_url",
  "ai_embedding_key",
  "ai_embedding_model",
];

interface AskBody {
  question?: string;
  history?: Array<{ role: string; content: string }>;
  mode?: "knowledge" | "current-note" | "selection";
  currentNoteId?: string;
  selectedText?: string;
  notebookId?: string;
  includeChildren?: boolean;
}

interface Scope {
  userId: string;
  workspaceId: string | null;
  notebookIds: string[] | null;
}

interface Candidate {
  key: string;
  id: string;
  noteId: string;
  title: string;
  kind: "note" | "attachment";
  attachmentId?: string | null;
  attachmentFilename?: string | null;
  snippet?: string;
  distance?: number;
  score?: number;
  chunkIndex?: number;
  indexedAt?: string | null;
  reason: "vector" | "fts" | "like" | "recent" | "direct" | "selection";
}

interface DiagnosticHit {
  id: string;
  noteId: string;
  title: string;
  kind: "note" | "attachment";
  attachmentId?: string | null;
  chunkIndex?: number;
  distance?: number;
  score?: number;
  rankReason: Candidate["reason"];
  indexedAt?: string | null;
  preview: string;
  contextChars: number;
  truncated: boolean;
}

function readSetting(key: string): string {
  const row = getDb().prepare("SELECT value FROM system_settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value || "";
}

function writeSetting(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO system_settings (key, value, updatedAt)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')
  `).run(key, value);
}

function ensureConfigGuard(): void {
  const keys = GUARDED_AI_KEYS.map((key) => `'${key}'`).join(",");
  getDb().exec(`
    CREATE TRIGGER IF NOT EXISTS ai_manual_config_guard_insert
    BEFORE INSERT ON system_settings
    WHEN NEW.key IN (${keys})
      AND COALESCE((SELECT value FROM system_settings WHERE key = 'ai_manual_enabled'), 'true') = 'false'
    BEGIN
      SELECT RAISE(IGNORE);
    END;

    CREATE TRIGGER IF NOT EXISTS ai_manual_config_guard_update
    BEFORE UPDATE ON system_settings
    WHEN NEW.key IN (${keys})
      AND COALESCE((SELECT value FROM system_settings WHERE key = 'ai_manual_enabled'), 'true') = 'false'
    BEGIN
      SELECT RAISE(IGNORE);
    END;
  `);
}

function isManualAIEnabled(): boolean {
  ensureConfigGuard();
  return readSetting("ai_manual_enabled") !== "false";
}

function getAISettings(): AISettings {
  return {
    ai_provider: readSetting("ai_provider") || "openai",
    ai_api_url: readSetting("ai_api_url"),
    ai_api_key: readSetting("ai_api_key"),
    ai_model: readSetting("ai_model") || "gpt-4o-mini",
    ai_embedding_url: readSetting("ai_embedding_url"),
    ai_embedding_key: readSetting("ai_embedding_key"),
    ai_embedding_model: readSetting("ai_embedding_model"),
  };
}

function apiHost(url: string): string | null {
  if (!url) return null;
  try { return new URL(url).host; } catch { return null; }
}

function restoreActiveProfile(): void {
  let restored = false;
  try {
    const profiles = JSON.parse(readSetting("ai_profiles_v1") || "[]") as Array<Record<string, unknown>>;
    const activeId = readSetting("ai_active_profile_id");
    const active = profiles.find((profile) => String(profile.id || "") === activeId) || profiles[0];
    if (active) {
      writeSetting("ai_provider", String(active.provider || "openai"));
      writeSetting("ai_api_url", String(active.apiUrl || ""));
      writeSetting("ai_api_key", String(active.apiKey || ""));
      writeSetting("ai_model", String(active.model || ""));
      restored = true;
    }
  } catch {
    /* fall back to backup */
  }
  if (!restored) {
    for (const key of ["ai_provider", "ai_api_url", "ai_api_key", "ai_model"]) {
      writeSetting(key, readSetting(`ai_disabled_backup_${key}`));
    }
  }
  for (const key of ["ai_embedding_url", "ai_embedding_key", "ai_embedding_model"]) {
    writeSetting(key, readSetting(`ai_disabled_backup_${key}`));
  }
}

function setManualAIEnabled(enabled: boolean): void {
  ensureConfigGuard();
  const current = isManualAIEnabled();
  if (current === enabled) return;

  if (!enabled) {
    getDb().transaction(() => {
      for (const key of GUARDED_AI_KEYS) {
        writeSetting(`ai_disabled_backup_${key}`, readSetting(key));
      }
      // Clear the effective legacy settings before enabling the write guard. All
      // existing AI routes therefore stop before making an upstream request.
      for (const key of GUARDED_AI_KEYS) writeSetting(key, "");
      writeSetting("ai_manual_enabled", "false");
    })();
  } else {
    getDb().transaction(() => {
      // Lift the guard first, then restore the active profile and embedding config.
      writeSetting("ai_manual_enabled", "true");
      restoreActiveProfile();
    })();
  }
}

function getDescendantNotebookIds(rootId: string): string[] {
  const db = getDb();
  const result = [rootId];
  const queue = [rootId];
  while (queue.length > 0) {
    const batch = queue.splice(0);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT id FROM notebooks WHERE parentId IN (${placeholders}) AND isDeleted = 0`,
    ).all(...batch) as Array<{ id: string }>;
    for (const row of rows) {
      if (result.includes(row.id)) continue;
      result.push(row.id);
      queue.push(row.id);
    }
  }
  return result;
}

function resolveScope(c: any, body: AskBody): Scope | { error: Response } {
  const userId = c.req.header("X-User-Id") || "";
  const rawWorkspace = String(c.req.query("workspaceId") || "").trim();
  const workspaceId = !rawWorkspace || rawWorkspace === "personal" || rawWorkspace === "null"
    ? null
    : rawWorkspace;

  if (workspaceId) {
    const role = getUserWorkspaceRole(workspaceId, userId);
    if (!role) return { error: c.json({ error: "无权访问该工作区知识库" }, 403) as Response };
  }

  if (!body.notebookId) return { userId, workspaceId, notebookIds: null };
  const notebook = getDb().prepare(
    "SELECT id, userId, workspaceId FROM notebooks WHERE id = ? AND isDeleted = 0",
  ).get(body.notebookId) as { id: string; userId: string; workspaceId: string | null } | undefined;
  if (!notebook) return { error: c.json({ error: "笔记本不存在" }, 404) as Response };
  if (workspaceId === null) {
    if (notebook.userId !== userId || notebook.workspaceId !== null) {
      return { error: c.json({ error: "无权访问该笔记本" }, 403) as Response };
    }
  } else if ((notebook.workspaceId || null) !== workspaceId) {
    return { error: c.json({ error: "笔记本不属于当前工作区" }, 403) as Response };
  }

  return {
    userId,
    workspaceId,
    notebookIds: body.includeChildren ? getDescendantNotebookIds(notebook.id) : [notebook.id],
  };
}

function scopeSql(scope: Scope, alias = "n"): { sql: string; params: unknown[] } {
  const clauses: string[] = [`${alias}.isTrashed = 0`];
  const params: unknown[] = [];
  if (scope.workspaceId === null) {
    clauses.push(`${alias}.userId = ?`, `${alias}.workspaceId IS NULL`);
    params.push(scope.userId);
  } else {
    clauses.push(`${alias}.workspaceId = ?`);
    params.push(scope.workspaceId);
  }
  if (scope.notebookIds) {
    clauses.push(`${alias}.notebookId IN (${scope.notebookIds.map(() => "?").join(",")})`);
    params.push(...scope.notebookIds);
  }
  return { sql: clauses.join(" AND "), params };
}

function extractKeywords(question: string): string[] {
  const stop = new Set(["什么", "怎么", "如何", "为什么", "请", "帮我", "告诉", "总结", "一下", "the", "what", "how", "why"]);
  const output: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const text = value.toLowerCase().trim();
    if (text.length < 2 || stop.has(text) || seen.has(text)) return;
    seen.add(text);
    output.push(text);
  };
  for (const token of question.match(/[\u3400-\u9fff]+|[a-zA-Z][a-zA-Z0-9_-]*|\d+/g) || []) {
    if (/^[\u3400-\u9fff]+$/.test(token)) {
      if (token.length <= 5) add(token);
      for (let i = 0; i + 2 <= token.length; i++) add(token.slice(i, i + 2));
    } else add(token);
  }
  return output.slice(0, 10);
}

function addCandidate(map: Map<string, Candidate>, candidate: Candidate): void {
  const existing = map.get(candidate.key);
  if (!existing) {
    map.set(candidate.key, candidate);
    return;
  }
  if (candidate.reason === "vector" && existing.reason !== "vector") map.set(candidate.key, candidate);
}

async function retrieveCandidates(scope: Scope, question: string): Promise<{ candidates: Candidate[]; retrieval: string[] }> {
  const db = getDb();
  const map = new Map<string, Candidate>();
  const retrieval: string[] = [];

  if (isVecAvailable()) {
    try {
      const vector = await embedQuery(question);
      if (vector) {
        const hits = knnSearch(vector, scope.userId, scope.workspaceId, scope.notebookIds ? 300 : 80, 12, scope.notebookIds);
        for (const hit of hits) {
          const indexed = db.prepare("SELECT createdAt FROM note_embeddings WHERE id = ?").get(hit.rowid) as
            | { createdAt: string }
            | undefined;
          const key = hit.entityType === "attachment" ? `attachment:${hit.attachmentId}` : `note:${hit.noteId}`;
          addCandidate(map, {
            key,
            id: hit.entityType === "attachment" ? String(hit.attachmentId || hit.noteId) : hit.noteId,
            noteId: hit.noteId,
            title: hit.entityType === "attachment" && hit.attachmentFilename
              ? `${hit.title || "未命名笔记"} › ${hit.attachmentFilename}`
              : hit.title,
            kind: hit.entityType,
            attachmentId: hit.attachmentId,
            attachmentFilename: hit.attachmentFilename,
            snippet: hit.chunkText,
            distance: hit.distance,
            score: Number((1 / (1 + Math.max(0, hit.distance))).toFixed(6)),
            chunkIndex: hit.chunkIndex,
            indexedAt: indexed?.createdAt || null,
            reason: "vector",
          });
        }
        if (hits.length) retrieval.push("vector");
      }
    } catch (error) {
      console.warn("[ai-reliable] vector retrieval failed:", error);
    }
  }

  const keywords = extractKeywords(question);
  const scoped = scopeSql(scope);
  if (keywords.length > 0) {
    try {
      const query = keywords.map((word) => `"${word.replace(/"/g, "")}"*`).join(" OR ");
      const ftsRows = db.prepare(
        "SELECT rowid, bm25(notes_fts) AS rank FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT 60",
      ).all(query) as Array<{ rowid: number; rank: number }>;
      if (ftsRows.length) {
        const rowids = ftsRows.map((row) => row.rowid);
        const placeholders = rowids.map(() => "?").join(",");
        const rows = db.prepare(`
          SELECT n.id, n.title, n.contentText, n.rowid
          FROM notes n
          WHERE n.rowid IN (${placeholders}) AND ${scoped.sql}
          LIMIT 12
        `).all(...rowids, ...scoped.params) as Array<{ id: string; title: string; contentText: string; rowid: number }>;
        const rankMap = new Map(ftsRows.map((row) => [row.rowid, row.rank]));
        for (const row of rows) {
          const rank = rankMap.get(row.rowid) ?? 0;
          addCandidate(map, {
            key: `note:${row.id}`,
            id: row.id,
            noteId: row.id,
            title: row.title,
            kind: "note",
            snippet: row.contentText,
            score: Number((1 / (1 + Math.abs(rank))).toFixed(6)),
            reason: "fts",
          });
        }
        if (rows.length) retrieval.push("fts");
      }
    } catch (error) {
      console.warn("[ai-reliable] FTS retrieval failed:", error);
    }

    try {
      const top = keywords.slice(0, 6);
      const conditions = top.map(() => "(n.title LIKE ? OR n.contentText LIKE ?)").join(" OR ");
      const likeParams = top.flatMap((word) => [`%${word}%`, `%${word}%`]);
      const rows = db.prepare(`
        SELECT n.id, n.title, n.contentText
        FROM notes n
        WHERE ${scoped.sql} AND (${conditions})
        ORDER BY n.updatedAt DESC
        LIMIT 12
      `).all(...scoped.params, ...likeParams) as Array<{ id: string; title: string; contentText: string }>;
      for (const row of rows) {
        addCandidate(map, {
          key: `note:${row.id}`,
          id: row.id,
          noteId: row.id,
          title: row.title,
          kind: "note",
          snippet: row.contentText,
          reason: "like",
        });
      }
      if (rows.length) retrieval.push("like");
    } catch (error) {
      console.warn("[ai-reliable] LIKE retrieval failed:", error);
    }
  }

  if (map.size === 0) {
    const rows = db.prepare(`
      SELECT n.id, n.title, n.contentText
      FROM notes n
      WHERE ${scoped.sql}
      ORDER BY n.updatedAt DESC
      LIMIT 5
    `).all(...scoped.params) as Array<{ id: string; title: string; contentText: string }>;
    for (const row of rows) {
      addCandidate(map, {
        key: `note:${row.id}`,
        id: row.id,
        noteId: row.id,
        title: row.title,
        kind: "note",
        snippet: row.contentText,
        reason: "recent",
      });
    }
    if (rows.length) retrieval.push("recent");
  }

  const candidates = Array.from(map.values()).sort((a, b) => {
    const priority = { vector: 0, fts: 1, like: 2, recent: 3, direct: 0, selection: 0 };
    const p = priority[a.reason] - priority[b.reason];
    if (p !== 0) return p;
    return (b.score || 0) - (a.score || 0);
  }).slice(0, 10);
  return { candidates, retrieval: Array.from(new Set(retrieval)) };
}

function getIndexStatus(scope: Scope) {
  const db = getDb();
  const opts = scope.workspaceId === null
    ? { userId: scope.userId, workspaceId: null as string | null }
    : { workspaceId: scope.workspaceId };
  const stats = getEmbeddingStats(opts);

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (scope.workspaceId === null) {
    clauses.push("userId = ?", "workspaceId IS NULL");
    params.push(scope.userId);
  } else {
    clauses.push("workspaceId = ?");
    params.push(scope.workspaceId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const lastIndexed = db.prepare(`SELECT MAX(createdAt) AS at FROM note_embeddings ${where}`).get(...params) as { at: string | null };
  const noteScope = scopeSql({ ...scope, notebookIds: null });
  const newest = db.prepare(`SELECT MAX(n.updatedAt) AS at FROM notes n WHERE ${noteScope.sql}`).get(...noteScope.params) as { at: string | null };
  const stale = stats.pending > 0 || stats.processing > 0 || (
    !!newest.at && (!lastIndexed.at || Date.parse(newest.at) > Date.parse(lastIndexed.at))
  );
  return {
    lastIndexedAt: lastIndexed.at,
    newestSourceUpdatedAt: newest.at,
    pending: stats.pending,
    processing: stats.processing,
    failed: stats.failed,
    totalNotes: stats.totalNotes,
    indexedNotes: stats.indexedNotes,
    totalAttachments: stats.totalAttachments,
    indexedAttachments: stats.indexedAttachments,
    configured: stats.configured,
    vectorAvailable: stats.vecAvailable,
    vectorDimension: stats.vecDim,
    stale,
  };
}

function publicStatus(scope: Scope) {
  const settings = getAISettings();
  return {
    enabled: isManualAIEnabled(),
    provider: settings.ai_provider || null,
    model: settings.ai_model || null,
    apiHost: apiHost(settings.ai_api_url),
    embeddingModel: settings.ai_embedding_model || null,
    scope: {
      workspaceId: scope.workspaceId,
      notebookCount: scope.notebookIds?.length || null,
    },
    index: getIndexStatus(scope),
  };
}

function buildKnowledgeContext(candidates: Candidate[]): {
  block: string;
  hits: DiagnosticHit[];
  budget: BudgetedContext;
} {
  const db = getDb();
  let remaining = CONTEXT_BUDGET;
  let originalChars = 0;
  let includedChars = 0;
  let anyTruncated = false;
  const blocks: string[] = [];
  const hits: DiagnosticHit[] = [];

  for (const candidate of candidates) {
    if (remaining < 1_000) break;
    let sourceText = candidate.snippet || "";
    if (candidate.kind === "note") {
      const note = db.prepare(
        "SELECT content, contentText, contentFormat FROM notes WHERE id = ?",
      ).get(candidate.noteId) as { content: string; contentText: string; contentFormat: string } | undefined;
      if (note) sourceText = noteToPlainText(note);
    }
    const sourceBudget = Math.min(10_000, remaining);
    const fitted = fitContextBudget(sourceText, sourceBudget);
    if (!fitted.text) continue;
    const label = candidate.kind === "attachment" ? "附件" : "笔记";
    blocks.push(`【${label}：${candidate.title}】\n${fitted.text}`);
    remaining -= fitted.text.length + candidate.title.length + 20;
    originalChars += fitted.originalChars;
    includedChars += fitted.includedChars;
    anyTruncated ||= fitted.truncated;
    hits.push({
      id: candidate.id,
      noteId: candidate.noteId,
      title: candidate.title,
      kind: candidate.kind,
      attachmentId: candidate.attachmentId,
      chunkIndex: candidate.chunkIndex,
      distance: candidate.distance,
      score: candidate.score,
      rankReason: candidate.reason,
      indexedAt: candidate.indexedAt,
      preview: safeContextPreview(sourceText),
      contextChars: fitted.includedChars,
      truncated: fitted.truncated,
    });
  }

  return {
    block: blocks.join("\n\n---\n\n"),
    hits,
    budget: {
      text: blocks.join("\n\n---\n\n"),
      originalChars,
      includedChars,
      omittedChars: Math.max(0, originalChars - includedChars),
      truncated: anyTruncated || remaining < 1_000,
      strategy: anyTruncated ? "head-middle-tail" : "full",
      segments: [],
    },
  };
}

async function currentNoteContext(userId: string, noteId: string): Promise<{
  block: string;
  candidate: Candidate;
  budget: BudgetedContext;
}> {
  const { permission } = resolveNotePermission(noteId, userId);
  if (!hasPermission(permission, "read")) throw new Error("无权读取当前笔记");
  const note = getDb().prepare(`
    SELECT id, title, content, contentText, contentFormat
    FROM notes WHERE id = ? AND isTrashed = 0
  `).get(noteId) as {
    id: string; title: string; content: string; contentText: string; contentFormat: string;
  } | undefined;
  if (!note) throw new Error("当前笔记不存在或已进入回收站");

  let text = noteToPlainText(note);
  try {
    const attachments = getDb().prepare(`
      SELECT a.filename, GROUP_CONCAT(ac.chunkText, '\n') AS text
      FROM attachments a
      JOIN attachment_chunks ac ON ac.attachmentId = a.id
      WHERE a.noteId = ?
      GROUP BY a.id, a.filename
      ORDER BY a.createdAt ASC
      LIMIT 20
    `).all(noteId) as Array<{ filename: string; text: string }>;
    if (attachments.length) {
      text += "\n\n【附件提取文本】\n" + attachments
        .map((attachment) => `【${attachment.filename}】\n${attachment.text}`)
        .join("\n\n");
    }
  } catch {
    /* Attachment chunks may not exist on an older schema. */
  }
  const budget = fitContextBudget(text, CONTEXT_BUDGET);
  return {
    block: `【当前整篇笔记：${note.title}】\n${budget.text}`,
    candidate: {
      key: `note:${note.id}`,
      id: note.id,
      noteId: note.id,
      title: note.title,
      kind: "note",
      snippet: text,
      reason: "direct",
    },
    budget,
  };
}

app.get("/status", (c) => {
  const scope = resolveScope(c, {});
  if ("error" in scope) return scope.error;
  return c.json(publicStatus(scope));
});

app.get("/config-enabled", (c) => {
  const scope = resolveScope(c, {});
  if ("error" in scope) return scope.error;
  return c.json(publicStatus(scope));
});

app.put("/config-enabled", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") return c.json({ error: "enabled 必须是布尔值" }, 400);
  setManualAIEnabled(body.enabled);
  const scope = resolveScope(c, {});
  if ("error" in scope) return scope.error;
  return c.json(publicStatus(scope));
});

app.post("/ask", async (c) => {
  if (!isManualAIEnabled()) {
    return c.json({ error: "AI 手动配置已关闭，请先在 AI 设置中开启", code: "AI_CONFIG_DISABLED" }, 409);
  }
  const settings = getAISettings();
  if (!settings.ai_api_url) return c.json({ error: "未配置 AI 服务" }, 400);
  if (settings.ai_provider !== "ollama" && !settings.ai_api_key) {
    return c.json({ error: "未配置 API Key" }, 400);
  }

  const body = await c.req.json().catch(() => ({})) as AskBody;
  const question = String(body.question || "").trim();
  if (!question) return c.json({ error: "请输入问题" }, 400);
  const scope = resolveScope(c, body);
  if ("error" in scope) return scope.error;

  const mode = body.mode === "current-note" || body.mode === "selection" ? body.mode : "knowledge";
  let contextBlock = "";
  let retrieval: string[] = [];
  let candidates: Candidate[] = [];
  let diagnosticHits: DiagnosticHit[] = [];
  let contextBudget: BudgetedContext;

  try {
    if (mode === "current-note") {
      if (!body.currentNoteId) return c.json({ error: "当前没有打开的笔记" }, 400);
      const current = await currentNoteContext(scope.userId, body.currentNoteId);
      contextBlock = current.block;
      candidates = [current.candidate];
      retrieval = ["current-note-direct"];
      contextBudget = current.budget;
      diagnosticHits = [{
        id: current.candidate.id,
        noteId: current.candidate.noteId,
        title: current.candidate.title,
        kind: "note",
        rankReason: "direct",
        preview: safeContextPreview(current.candidate.snippet || ""),
        contextChars: current.budget.includedChars,
        truncated: current.budget.truncated,
      }];
    } else if (mode === "selection") {
      const selected = normalizeExternalText(String(body.selectedText || ""));
      if (!selected) return c.json({ error: "未检测到选中文本，请先选择或粘贴内容" }, 400);
      contextBudget = fitContextBudget(selected, CONTEXT_BUDGET);
      contextBlock = `【当前选中文本】\n${contextBudget.text}`;
      retrieval = ["selection-direct"];
      diagnosticHits = [{
        id: "selection",
        noteId: body.currentNoteId || "",
        title: "当前选中文本",
        kind: "note",
        rankReason: "selection",
        preview: safeContextPreview(selected),
        contextChars: contextBudget.includedChars,
        truncated: contextBudget.truncated,
      }];
    } else {
      const result = await retrieveCandidates(scope, question);
      candidates = result.candidates;
      retrieval = result.retrieval;
      const built = buildKnowledgeContext(candidates);
      contextBlock = built.block;
      diagnosticHits = built.hits;
      contextBudget = built.budget;
    }
  } catch (error) {
    return c.json({ error: (error as Error).message || "上下文准备失败" }, 400);
  }

  const status = publicStatus(scope);
  const diagnostics = {
    version: 1,
    requestId: randomUUID(),
    generatedAt: new Date().toISOString(),
    provider: status.provider,
    model: status.model,
    apiHost: status.apiHost,
    embeddingModel: status.embeddingModel,
    mode,
    scope: {
      workspaceId: scope.workspaceId,
      notebookId: body.notebookId || null,
      includeChildren: !!body.includeChildren,
      resolvedNotebookCount: scope.notebookIds?.length || null,
      currentNoteId: mode === "current-note" ? body.currentNoteId || null : null,
    },
    retrieval,
    context: {
      budgetChars: CONTEXT_BUDGET,
      originalChars: contextBudget.originalChars,
      includedChars: contextBudget.includedChars,
      omittedChars: contextBudget.omittedChars,
      truncated: contextBudget.truncated,
      strategy: contextBudget.strategy,
      segments: contextBudget.segments,
    },
    index: status.index,
    hits: diagnosticHits,
    // API keys, tokens, raw request headers and complete source bodies are deliberately absent.
    redacted: ["apiKey", "embeddingKey", "authorization", "fullSourceText"],
  };

  const truncationNotice = contextBudget.truncated
    ? `\n\n注意：上下文超过 ${CONTEXT_BUDGET} 字预算，系统已明确采用“开头 + 中部 + 结尾”分段，省略 ${contextBudget.omittedChars} 字。回答中不要声称已读取未包含的部分。`
    : "";
  const systemPrompt = contextBlock
    ? `你是 Nowen Note 的知识库助手。仅把下面提供的上下文视为用户知识库证据。请优先依据证据回答，并用来源标题说明依据；证据不足时明确说“不足以从当前范围确认”，不要虚构。${truncationNotice}\n\n${contextBlock}`
    : "你是 Nowen Note 的知识库助手。当前检索范围没有找到可用上下文，请明确告知用户，再基于通用知识回答。";
  const messages = [
    { role: "system", content: systemPrompt },
    ...(Array.isArray(body.history) ? body.history : [])
      .slice(-MAX_HISTORY_MESSAGES)
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: String(message.content || "").slice(0, MAX_HISTORY_CHARS),
      })),
    { role: "user", content: question },
  ];

  return streamSSE(c, async (stream) => {
    const references = candidates.map((candidate) => ({
      id: candidate.noteId,
      title: candidate.title,
      kind: candidate.kind,
      attachmentId: candidate.attachmentId || undefined,
      attachmentFilename: candidate.attachmentFilename || undefined,
      chunkIndex: candidate.chunkIndex,
      distance: candidate.distance,
      score: candidate.score,
      rankReason: candidate.reason,
    }));
    if (references.length) {
      await stream.writeSSE({ event: "references", data: JSON.stringify(references) });
    }
    await stream.writeSSE({ event: "diagnostics", data: JSON.stringify(diagnostics) });

    let streamed = false;
    try {
      for await (const chunk of callAIChatStream(settings, messages, { temperature: 0.35, max_tokens: 2500 })) {
        streamed = true;
        await stream.writeSSE({ event: "message", data: JSON.stringify({ t: chunk }) });
      }
    } catch (error) {
      console.warn("[ai-reliable] stream failed, falling back:", sanitizeError(error));
    }
    if (!streamed) {
      try {
        const text = await callAIChat(settings, messages, { temperature: 0.35, max_tokens: 2500 });
        if (text) await stream.writeSSE({ event: "message", data: JSON.stringify({ t: text }) });
      } catch (error) {
        await stream.writeSSE({ event: "error", data: sanitizeError(error) || "AI 请求失败" });
      }
    }
    await stream.writeSSE({ event: "done", data: "[DONE]" });
  });
});

export default app;
