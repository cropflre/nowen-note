/**
 * Embedding Worker — RAG Phase 1
 *
 * 职责：定时从 embedding_queue 拉取 pending 任务，调用配置的 AI provider 的
 *      `/embeddings` 接口算向量，写入 note_embeddings；失败重试到上限后标 failed。
 *
 * 设计要点：
 *   - 完全异步、与请求链路解耦：不阻塞笔记保存。
 *   - 配置缺失（未配 embedding URL/key）时优雅降级：把任务标 failed 并跳过；
 *     用户配好以后可以手动 /api/ai/embeddings/rebuild 重新入队。
 *   - 单进程串行处理（同时间只跑一个 fetch），避免对 OpenAI 类账号触发 RPM 限流；
 *     批量场景下吞吐由 BATCH_SIZE × 单次延迟决定，已经够 1000+ 篇笔记/小时。
 *   - 文本太短（<10 字符）直接跳过，节约 API 配额。
 *   - 大文本简单按 ~1500 字符切段；当前 Phase 1 暂不做语义切分，整篇笔记作为
 *     1~3 个 chunk 已能满足绝大多数笔记应用场景。Phase 2 可考虑按 Markdown 标题切。
 *
 * 与 schema.ts 中 embedding_queue 表的契约：
 *   status: pending | processing | done | failed
 *   retries: 失败累计次数；超过 MAX_RETRIES 的任务不再被 pickPending 选中
 *
 * 与 sqlite-vec 的关系：
 *   Phase 1 不依赖 sqlite-vec；向量以 JSON 字符串落 note_embeddings.vectorJson。
 *   Phase 2 接入 sqlite-vec 时新建虚表 vec_note_chunks 并把现有 vectorJson 灌进去。
 */
import { getDb } from "../db/schema";
import type Database from "better-sqlite3";
import {
  isVecAvailable,
  upsertVectors,
  deleteVectorsByRowids,
  resetVecTable,
  getVecDim,
  clearAllVectors,
} from "./vec-store";
import { extractAttachmentText, chunkAttachmentText } from "./attachment-indexer";
import { attachmentChunksRepository, embeddingQueueRepository } from "../repositories";
import { resolveEmbeddingConfig, type EmbeddingConfig } from "./embedding-config";

// ====== 调参 ======
const POLL_INTERVAL_MS = 5_000;          // 轮询间隔（无任务时）
const BATCH_SIZE = 5;                    // 单轮处理多少条
const MAX_RETRIES = 3;                   // 单任务最大重试次数
const MIN_CONTENT_LENGTH = 10;           // 文本短于此长度直接 skip
const CHUNK_SIZE = 1500;                 // 单 chunk 字符数（粗略，按字符切）
const MAX_CHUNKS_PER_NOTE = 8;           // 防止超长笔记把队列卡死
const HTTP_TIMEOUT_MS = 30_000;          // 单次 embedding 请求超时
const DEFAULT_DIM = 1536;                // 仅作元数据，实际维度由 provider 返回为准

// ====== 内部状态 ======
let timer: NodeJS.Timeout | null = null;
let running = false;            // 是否有 tick 正在执行
let stopped = false;            // 是否已 stop（防止 tick 在 stop 后再排下一次）

// ============================================================
// 配置读取
// ============================================================
//
// 每次按任务或请求的 userId 读取配置，禁止后台任务借用其他用户的 Key。
// 三个 embedding key：
//   ai_embedding_url    — embedding 接口 base url（不含 /embeddings 后缀，去尾斜杠）
//                         留空时回退到 ai_api_url
//   ai_embedding_model  — embedding 模型名，例如 "text-embedding-3-small"、"bge-m3"
//                         留空 worker 直接 noop
//   ai_embedding_key    — 单独 key，留空时回退到 ai_api_key

// ============================================================
// 文本切分（粗略版）
// ============================================================
//
// 当前策略：按 CHUNK_SIZE 字符硬切，最多 MAX_CHUNKS_PER_NOTE 段。
// 不做句子边界识别（中文不容易），笔记应用场景下重叠 0、按字符切已经够用。
// 标题作为第 0 段单独算一次 embedding，让短查询命中标题的概率显著上升。
function chunkText(title: string, body: string): { idx: number; text: string }[] {
  const chunks: { idx: number; text: string }[] = [];
  const t = (title || "").trim();
  const b = (body || "").trim();

  // chunk 0：标题（哪怕正文为空，也至少要有标题向量）
  if (t) {
    chunks.push({ idx: 0, text: t });
  }

  if (!b) return chunks;

  // chunk 1..N：正文
  let i = 0;
  let chunkIdx = 1;
  while (i < b.length && chunkIdx <= MAX_CHUNKS_PER_NOTE) {
    const piece = b.slice(i, i + CHUNK_SIZE);
    chunks.push({ idx: chunkIdx, text: piece });
    i += CHUNK_SIZE;
    chunkIdx++;
  }
  return chunks;
}

// ============================================================
// HTTP 调用：兼容 OpenAI /embeddings 协议
// ============================================================
//
// 请求体：{ model, input: string | string[] }
// 响应体：{ data: [{ embedding: number[], index }], model, usage }
// 通义/智谱/DeepSeek/Ollama(/v1) 都遵循这个协议；少数 provider 需要单独适配再说。
async function callEmbeddings(
  cfg: EmbeddingConfig,
  inputs: string[],
): Promise<number[][]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

  const res = await fetch(`${cfg.url}/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: cfg.model, input: inputs }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    data?: { embedding: number[]; index?: number }[];
  };
  if (!data.data || !Array.isArray(data.data)) {
    throw new Error("响应缺少 data 数组");
  }
  // 按 index 排序；很多 provider 已经按顺序返回，这里防御一下
  const sorted = [...data.data].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  const vectors = sorted.map((d) => d.embedding);
  if (vectors.length !== inputs.length) {
    throw new Error(`返回向量数量 ${vectors.length} 与请求数 ${inputs.length} 不匹配`);
  }
  return vectors;
}

// ============================================================
// 单条任务处理
// ============================================================
async function processOne(
  db: Database.Database,
  cfg: EmbeddingConfig,
  task: { noteId: string; userId: string; retries: number },
): Promise<void> {
  // 取笔记内容（含 workspaceId，写入 note_embeddings 时同步落表）
  const note = db
    .prepare(
      "SELECT id, userId, workspaceId, title, contentText, isTrashed FROM notes WHERE id = ?",
    )
    .get(task.noteId) as
    | {
        id: string;
        userId: string;
        workspaceId: string | null;
        title: string;
        contentText: string;
        isTrashed: number;
      }
    | undefined;

  if (!note || note.isTrashed) {
    // 笔记已不存在或被丢进回收站 → 直接清队列项
    embeddingQueueRepository.deleteByNoteId(task.noteId);
    return;
  }

  const chunks = chunkText(note.title || "", note.contentText || "");
  if (chunks.length === 0 || chunks.every((c) => c.text.length < MIN_CONTENT_LENGTH)) {
    // 内容过短：标 done 不算 embedding，避免反复重试
    embeddingQueueRepository.markSkipped(task.noteId);
    return;
  }

  // 过滤掉过短的 chunk（比如标题很短但正文很长，标题保留靠下面 length>=2 的兜底）
  const valid = chunks.filter((c) => c.text.length >= 2);
  const inputs = valid.map((c) => c.text);

  // 调 provider
  const vectors = await callEmbeddings(cfg, inputs);
  const dim = vectors[0]?.length || DEFAULT_DIM;

  // 事务写入：先删旧的，再插新的；同步收集新插入的 rowid 用于灌 vec 表
  const newRowIds: number[] = [];
  const tx = db.transaction(() => {
    // 先把旧 rowid 抓出来，事务结束后从 vec 表里删干净（避免脏数据）
    const oldRows = db
      .prepare("SELECT id FROM note_embeddings WHERE noteId = ?")
      .all(task.noteId) as { id: number }[];
    if (oldRows.length > 0) {
      try { deleteVectorsByRowids(oldRows.map((r) => r.id)); } catch { /* vec 不可用时忽略 */ }
    }
    db.prepare("DELETE FROM note_embeddings WHERE noteId = ?").run(task.noteId);

    // workspaceId 直接从 notes 行取——这是唯一真相源；笔记跨空间移动时
    // notes_embed_au 触发器会让本笔记重新入队，processOne 这里读到的就是
    // 最新的 workspaceId，旧的 embedding 行已经被本事务前面的 DELETE 清掉，
    // 不会留下"旧空间残影"。
    const ins = db.prepare(`
      INSERT INTO note_embeddings (noteId, userId, workspaceId, model, dim, chunkIndex, chunkText, vectorJson, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    for (let i = 0; i < valid.length; i++) {
      const info = ins.run(
        note.id,
        note.userId,
        note.workspaceId, // null = 个人空间
        cfg.model,
        dim,
        valid[i].idx,
        valid[i].text,
        JSON.stringify(vectors[i]),
      );
      // better-sqlite3 同步 API：lastInsertRowid 直接可用
      newRowIds.push(Number(info.lastInsertRowid));
    }
    embeddingQueueRepository.markDone(task.noteId);
  });
  tx();

  // 灌 vec0 表：放在事务外，避免 vec 维度不匹配抛错把整笔 note_embeddings 写入也回滚
  // （note_embeddings.vectorJson 是真相源；vec0 表只是加速结构，缺失了可重建）
  if (isVecAvailable() || getVecDim() === null /* 还没建表，第一条会建 */) {
    try {
      // 维度变了：先 reset vec 表（会清空，由调用 /embeddings/rebuild 时已经 clear 过 note_embeddings）
      // 这里仅在 vec 表已经存在且维度不一致时才 reset；否则会反复清表
      const vecDim = getVecDim();
      if (vecDim !== null && vecDim !== dim) {
        // 安全做法：用户应通过 /embeddings/rebuild + reindex-vec 主动切；
        // 但如果这里直接 reset 也只是丢了 vec 表里的"上一个模型"残余向量，
        // note_embeddings 已经被本笔记 DELETE+INSERT 覆盖了，整体仍一致。
        resetVecTable(dim);
      }
      const pairs = newRowIds.map((rowid, i) => ({ rowid, vector: vectors[i] }));
      upsertVectors(pairs);
    } catch (e) {
      // vec 写入失败不影响主流程；下次 reindex-vec 能修
      console.warn("[embedding-worker] vec upsert failed:", e);
    }
  }
}

// ============================================================
// 附件任务处理
// ============================================================
//
// 与 processOne（笔记）对称：从 attachment_embedding_queue 取一条任务，
// 读 attachments 行，从磁盘提取文本，切段，调 embedding，写 note_embeddings
// （entityType='attachment'）+ attachment_chunks + vec_note_chunks。
//
// 为什么复用 note_embeddings 而不是单开一张 attachment_embeddings？
//   - vec_note_chunks 虚表只有一张（维度必须一致），复用其 rowid 空间最省事；
//   - KNN 召回时只做一次查询，按 entityType 分流；
//   - /ask 拼 prompt 的代码也只需要处理一张"命中结果"表。
//
// 失败策略：
//   - 附件不存在 / 格式不支持 / 过大 / 空：标 done + lastError='skipped:...'，
//     不算失败（重试也救不了），等下次重建或 MIME 变了手动再试；
//   - 解析器抛错 / embedding HTTP 失败：计入 retries，超过 MAX_RETRIES 标 failed。
async function processAttachmentOne(
  db: Database.Database,
  cfg: EmbeddingConfig,
  task: { attachmentId: string; retries: number },
): Promise<void> {
  const att = db
    .prepare(
      `SELECT a.id, a.noteId, a.userId, a.workspaceId, a.filename, a.mimeType, a.size, a.path,
              n.isTrashed AS noteTrashed
         FROM attachments a
         JOIN notes n ON n.id = a.noteId
        WHERE a.id = ?`,
    )
    .get(task.attachmentId) as
    | {
        id: string;
        noteId: string;
        userId: string;
        workspaceId: string | null;
        filename: string;
        mimeType: string;
        size: number;
        path: string;
        noteTrashed: number;
      }
    | undefined;

  if (!att || att.noteTrashed) {
    db.prepare(
      "DELETE FROM attachment_embedding_queue WHERE attachmentId = ?",
    ).run(task.attachmentId);
    return;
  }

  // 1. 提取文本
  const extracted = await extractAttachmentText({
    id: att.id,
    path: att.path,
    mimeType: att.mimeType,
    filename: att.filename,
    size: att.size,
  });

  if (extracted.skipReason) {
    // 跳过：标 done 但带原因，前端"诊断"时能看见
    db.prepare(
      `UPDATE attachment_embedding_queue
          SET status = 'done', updatedAt = datetime('now'),
              lastError = ?
        WHERE attachmentId = ?`,
    ).run(`skipped: ${extracted.skipReason}`, task.attachmentId);
    return;
  }

  const chunks = chunkAttachmentText(att.filename, extracted.text);
  const valid = chunks.filter((c) => c.text.length >= 2);
  if (valid.length === 0) {
    db.prepare(
      `UPDATE attachment_embedding_queue
          SET status = 'done', updatedAt = datetime('now'),
              lastError = 'skipped: empty after chunking'
        WHERE attachmentId = ?`,
    ).run(task.attachmentId);
    return;
  }

  // 2. 调 embedding（可能抛错 → 外层 catch 按 retries 处理）
  const vectors = await callEmbeddings(cfg, valid.map((c) => c.text));
  const dim = vectors[0]?.length || DEFAULT_DIM;

  // 3. 事务写入：删旧 → 插新 note_embeddings + attachment_chunks
  const newRowIds: number[] = [];
  const tx = db.transaction(() => {
    // 旧 note_embeddings rowid（attachment 行）收集用于事务外清 vec 表
    const oldRows = db
      .prepare(
        "SELECT id FROM note_embeddings WHERE entityType = 'attachment' AND attachmentId = ?",
      )
      .all(att.id) as { id: number }[];
    if (oldRows.length > 0) {
      try { deleteVectorsByRowids(oldRows.map((r) => r.id)); } catch { /* ignore */ }
    }
    db.prepare(
      "DELETE FROM note_embeddings WHERE entityType = 'attachment' AND attachmentId = ?",
    ).run(att.id);
    attachmentChunksRepository.deleteByAttachmentId(att.id);

    const insE = db.prepare(`
      INSERT INTO note_embeddings
        (noteId, userId, workspaceId, model, dim, chunkIndex, chunkText, vectorJson,
         entityType, attachmentId, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'attachment', ?, datetime('now'))
    `);

    for (let i = 0; i < valid.length; i++) {
      const info = insE.run(
        att.noteId,
        att.userId,
        att.workspaceId,
        cfg.model,
        dim,
        valid[i].idx,
        valid[i].text,
        JSON.stringify(vectors[i]),
        att.id,
      );
      newRowIds.push(Number(info.lastInsertRowid));
      attachmentChunksRepository.create(att.id, valid[i].idx, valid[i].text);
    }

    db.prepare(
      `UPDATE attachment_embedding_queue
          SET status = 'done', lastError = NULL, updatedAt = datetime('now')
        WHERE attachmentId = ?`,
    ).run(att.id);
  });
  tx();

  // 4. 灌 vec0 表（事务外）
  if (isVecAvailable() || getVecDim() === null) {
    try {
      const vecDim = getVecDim();
      if (vecDim !== null && vecDim !== dim) {
        resetVecTable(dim);
      }
      upsertVectors(newRowIds.map((rowid, i) => ({ rowid, vector: vectors[i] })));
    } catch (e) {
      console.warn("[embedding-worker] attachment vec upsert failed:", e);
    }
  }
}

// ============================================================
// 主循环
// ============================================================
async function tick(): Promise<void> {
  if (running || stopped) return;
  running = true;
  try {
    const db = getDb();

    // Keep the previous URL pre-filter so invalid chat/custom configurations cannot occupy an
    // entire batch. A fixed Profile ID is an additional eligible source and is validated below.
    const tasks = db.prepare(`
      SELECT q.noteId, q.userId, q.retries
      FROM embedding_queue q
      WHERE q.status = 'pending' AND q.retries < ?
        AND EXISTS (
          SELECT 1 FROM user_ai_settings model
          WHERE model.userId = q.userId
            AND model.key = 'ai_embedding_model'
            AND trim(model.value) <> ''
        )
        AND (
          EXISTS (
            SELECT 1 FROM user_ai_settings embedding_profile
            WHERE embedding_profile.userId = q.userId
              AND embedding_profile.key = 'ai_embedding_profile_id'
              AND trim(embedding_profile.value) <> ''
          )
          OR EXISTS (
            SELECT 1 FROM user_ai_settings embedding_url
            WHERE embedding_url.userId = q.userId
              AND embedding_url.key = 'ai_embedding_url'
              AND trim(embedding_url.value) <> ''
          )
          OR EXISTS (
            SELECT 1 FROM user_ai_settings api_url
            WHERE api_url.userId = q.userId
              AND api_url.key = 'ai_api_url'
              AND trim(api_url.value) <> ''
          )
          OR NOT EXISTS (
            SELECT 1 FROM user_ai_settings explicit_api_url
            WHERE explicit_api_url.userId = q.userId
              AND explicit_api_url.key = 'ai_api_url'
          )
        )
      ORDER BY q.enqueuedAt ASC
      LIMIT ?
    `).all(MAX_RETRIES, BATCH_SIZE) as Array<{ noteId: string; userId: string; retries: number }>;

    if (tasks.length === 0) return;

    for (const task of tasks) {
      const resolution = resolveEmbeddingConfig(task.userId);
      if (!resolution.config) {
        embeddingQueueRepository.updateStatus(
          task.noteId,
          "failed",
          MAX_RETRIES,
          (resolution.error || "Embedding 配置不可用").slice(0, 500),
        );
        continue;
      }
      const cfg = resolution.config;
      embeddingQueueRepository.markProcessing(task.noteId);
      try {
        await processOne(db, cfg, task);
      } catch (e: any) {
        const msg = (e?.message || String(e)).slice(0, 500);
        const newRetries = task.retries + 1;
        const newStatus = newRetries >= MAX_RETRIES ? "failed" : "pending";
        embeddingQueueRepository.updateStatus(task.noteId, newStatus, newRetries, msg);
        // 出错后稍微歇一下再继续下一条，避免对 provider 接口连击
        await sleep(500);
      }
    }
  } catch (e) {
    console.warn("[embedding-worker] tick error:", e);
  } finally {
    running = false;
  }

  // ---- 附件任务：与笔记任务同一个 tick，共享 BATCH_SIZE 的"大轮询"节奏 ----
  // 放在 finally 之外的独立 try/catch：笔记分支出错不影响附件分支，反之亦然。
  await tickAttachments();
}

async function tickAttachments(): Promise<void> {
  if (stopped) return;
  try {
    const db = getDb();

    const tasks = db
      .prepare(
        `SELECT q.attachmentId, q.userId, q.retries
           FROM attachment_embedding_queue q
          WHERE q.status = 'pending' AND q.retries < ?
            AND EXISTS (
              SELECT 1 FROM user_ai_settings model
              WHERE model.userId = q.userId
                AND model.key = 'ai_embedding_model'
                AND trim(model.value) <> ''
            )
            AND (
              EXISTS (
                SELECT 1 FROM user_ai_settings embedding_profile
                WHERE embedding_profile.userId = q.userId
                  AND embedding_profile.key = 'ai_embedding_profile_id'
                  AND trim(embedding_profile.value) <> ''
              )
              OR EXISTS (
                SELECT 1 FROM user_ai_settings embedding_url
                WHERE embedding_url.userId = q.userId
                  AND embedding_url.key = 'ai_embedding_url'
                  AND trim(embedding_url.value) <> ''
              )
              OR EXISTS (
                SELECT 1 FROM user_ai_settings api_url
                WHERE api_url.userId = q.userId
                  AND api_url.key = 'ai_api_url'
                  AND trim(api_url.value) <> ''
              )
              OR NOT EXISTS (
                SELECT 1 FROM user_ai_settings explicit_api_url
                WHERE explicit_api_url.userId = q.userId
                  AND explicit_api_url.key = 'ai_api_url'
              )
            )
          ORDER BY q.enqueuedAt ASC
          LIMIT ?`,
      )
      .all(MAX_RETRIES, BATCH_SIZE) as {
      attachmentId: string;
      userId: string;
      retries: number;
    }[];

    if (tasks.length === 0) return;

    const markProcessing = db.prepare(
      "UPDATE attachment_embedding_queue SET status = 'processing', updatedAt = datetime('now') WHERE attachmentId = ?",
    );
    for (const task of tasks) {
      const resolution = resolveEmbeddingConfig(task.userId);
      if (!resolution.config) {
        db.prepare(
          `UPDATE attachment_embedding_queue
              SET status = 'failed', retries = ?, lastError = ?, updatedAt = datetime('now')
            WHERE attachmentId = ?`,
        ).run(MAX_RETRIES, (resolution.error || "Embedding 配置不可用").slice(0, 500), task.attachmentId);
        continue;
      }
      const cfg = resolution.config;
      markProcessing.run(task.attachmentId);
      try {
        await processAttachmentOne(db, cfg, task);
      } catch (e: any) {
        const msg = (e?.message || String(e)).slice(0, 500);
        const newRetries = task.retries + 1;
        const newStatus = newRetries >= MAX_RETRIES ? "failed" : "pending";
        db.prepare(
          `UPDATE attachment_embedding_queue
              SET status = ?, retries = ?, lastError = ?, updatedAt = datetime('now')
            WHERE attachmentId = ?`,
        ).run(newStatus, newRetries, msg, task.attachmentId);
        await sleep(500);
      }
    }
  } catch (e) {
    console.warn("[embedding-worker] tickAttachments error:", e);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// 对外 API
// ============================================================

/** 启动 worker（幂等）。在 index.ts 启动时调用一次即可。 */
export function startEmbeddingWorker(): void {
  if (timer) return;
  stopped = false;
  // 启动后立即跑一轮，再进入定时循环（首次跑能加速冷启动回填）
  setImmediate(() => { void tick(); });
  timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  // 让 timer 不阻塞进程退出
  if (typeof timer.unref === "function") timer.unref();
  console.log("[embedding-worker] started");
}

/** 停止 worker（用于优雅关停 / 单测） */
export function stopEmbeddingWorker(): void {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * 把"未被回收"的笔记重新入队。
 * 用途：
 *   - 用户切换 embedding 模型后，老向量需要全部重算
 *   - 用户手动点"重建索引"
 *
 * scope 控制：
 *   - 不传 userId / workspaceId 即"全库重建"（仅运维场景使用，不应暴露给前端）
 *   - 传 userId（不传 workspaceId）：把该用户名下"个人空间 + 所有他作为成员
 *     的工作区里他自己写的笔记"全部重建。这是个人空间页面"重建索引"的语义。
 *   - 传 workspaceId（不传 userId）：把该工作区里**所有成员的**笔记全部重建。
 *     这是工作区视图"重建索引"的语义——工作区的成员应共享一份完整索引。
 *   - userId + workspaceId 同传：仅当前用户在该工作区里的笔记。一般不用。
 *
 * clearExisting：
 *   true 时**只清 scope 内**的 note_embeddings 行，不会动其它 scope 的索引；
 *   false 时不清理（仅追加入队，可能与已有 done 状态共存——靠 ON CONFLICT 覆盖）。
 *
 * vec 表：vec_note_chunks 是按 rowid 关联 note_embeddings 的副本；scope 局部清理
 *   时，对应 rowid 通过 deleteVectorsByRowids 同步从 vec 表删除——避免出现
 *   "note_embeddings 已经空了但 vec 表还有旧 rowid"的悬挂索引。
 */
export function rebuildAllEmbeddings(opts: {
  clearExisting?: boolean;
  userId?: string;
  workspaceId?: string | null;
} = {}): {
  enqueued: number;
} {
  const db = getDb();
  const { clearExisting, userId, workspaceId } = opts;
  // workspaceId 归一：undefined = 不限制；'' / null 视为"个人空间"
  const wsRaw = workspaceId === undefined ? undefined
    : (workspaceId === null || workspaceId === "" ? null : workspaceId);

  // 把 scope 拼成 WHERE 子句 + 参数（同时用于 note_embeddings 删除 与 notes 入队）
  // 设计：notes 表与 note_embeddings 表的 scope 列同名（userId / workspaceId），
  //      因此可以共享同一段 WHERE。
  const conds: string[] = [];
  const params: any[] = [];
  if (userId !== undefined) {
    conds.push(`userId = ?`);
    params.push(userId);
  }
  if (wsRaw !== undefined) {
    if (wsRaw === null) {
      conds.push(`workspaceId IS NULL`);
    } else {
      conds.push(`workspaceId = ?`);
      params.push(wsRaw);
    }
  }

  // 待清理的 vec rowid（事务内收集，事务外清；vec0 抛错不能让主表事务回滚）
  let oldRowids: number[] = [];

  const tx = db.transaction(() => {
    if (clearExisting) {
      // 1) 找出 scope 内现有的 rowid，事务后从 vec 表删干净
      const rowidWhere = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
      const oldIds = db
        .prepare(`SELECT id FROM note_embeddings ${rowidWhere}`)
        .all(...params) as { id: number }[];
      // 2) DELETE note_embeddings
      db.prepare(`DELETE FROM note_embeddings ${rowidWhere}`).run(...params);
      // 3) 收集到闭包，事务外清 vec 表
      oldRowids = oldIds.map((r) => r.id);
    }

    // 入队：用 notes 表的 scope 选择需要重建的笔记
    const notesWhere = ["isTrashed = 0", ...conds].join(" AND ");
    embeddingQueueRepository.enqueueByWhere(notesWhere, params);
  });
  tx();

  // 同步清 vec 表（事务外做：vec0 是虚表，与主表事务回滚保护无关）
  if (clearExisting) {
    if (oldRowids.length > 0) {
      try { deleteVectorsByRowids(oldRowids); } catch { /* vec 不可用时忽略 */ }
    } else if (userId === undefined && wsRaw === undefined) {
      // 全库 + clearExisting 的兜底：直接清空 vec 表（保留与历史行为一致）
      try { clearAllVectors(); } catch { /* 忽略 */ }
    }
  }

  // 返回 scope 内当前 pending 数（不是全局，避免 UI 上"清了别的 scope 但显示 0"）
  const countWhere = ["status = 'pending'", ...conds].join(" AND ");
  const enqueued = embeddingQueueRepository.countByWhere(countWhere, params);

  // ---- 附件索引：同 scope 下的附件也一起重建 ----
  // 与笔记索引同步：切换 embedding 模型或点"重建索引"时，附件向量也需要
  // 重算——否则两种向量维度不一致会在 vec0 表里打架。attachment_embedding_queue
  // 按 (userId, workspaceId) 维护自己的 scope 列（v8 迁移创建时已冗余），
  // 条件 WHERE 复用 conds。
  let attEnqueued = 0;
  try {
    attEnqueued = rebuildAttachmentEmbeddingsInternal(db, conds, params, clearExisting);
  } catch (e) {
    console.warn("[embedding-worker] attachment rebuild failed:", e);
  }

  return { enqueued: enqueued + attEnqueued };
}

/**
 * 附件重建内部实现：与 note 走同一套 scope。
 * 不导出：外部一律走 rebuildAllEmbeddings 触发；需要单独重建的场景也可
 * 加 scope=... 的 opts，worker 会自动处理两类队列。
 */
function rebuildAttachmentEmbeddingsInternal(
  db: Database.Database,
  conds: string[],
  params: any[],
  clearExisting?: boolean,
): number {
  // scope 过滤 SQL：conds 是 "userId = ?" / "workspaceId IS NULL" / "workspaceId = ?"
  // 之类的片段，attachments 表同样有这些列，直接复用。
  const rowidWhere = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";

  let oldRowids: number[] = [];
  const tx = db.transaction(() => {
    if (clearExisting) {
      const oldIds = db
        .prepare(
          `SELECT id FROM note_embeddings WHERE entityType = 'attachment'${
            conds.length > 0 ? " AND " + conds.join(" AND ") : ""
          }`,
        )
        .all(...params) as { id: number }[];
      db.prepare(
        `DELETE FROM note_embeddings WHERE entityType = 'attachment'${
          conds.length > 0 ? " AND " + conds.join(" AND ") : ""
        }`,
      ).run(...params);
      // attachment_chunks 同步清理：按 attachmentId IN (scope 内的附件 id)
      attachmentChunksRepository.deleteByAttachmentWhere(rowidWhere, params);
      oldRowids = oldIds.map((r) => r.id);
    }

    // 入队：只入"所属笔记未回收"的附件
    const attachWhere = conds.length > 0 ? conds.join(" AND ") + " AND " : "";
    db.prepare(
      `INSERT INTO attachment_embedding_queue
         (attachmentId, userId, workspaceId, noteId, status, retries, enqueuedAt, updatedAt)
       SELECT a.id, a.userId, a.workspaceId, a.noteId, 'pending', 0, datetime('now'), datetime('now')
         FROM attachments a
         JOIN notes n ON n.id = a.noteId
        WHERE ${attachWhere}n.isTrashed = 0
       ON CONFLICT(attachmentId) DO UPDATE SET
         workspaceId = excluded.workspaceId,
         status = 'pending',
         retries = 0,
         lastError = NULL,
         updatedAt = datetime('now')`,
    ).run(...params);
  });
  tx();

  if (clearExisting && oldRowids.length > 0) {
    try { deleteVectorsByRowids(oldRowids); } catch { /* ignore */ }
  }

  const countWhere = ["status = 'pending'", ...conds].join(" AND ");
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM attachment_embedding_queue WHERE ${countWhere}`,
    )
    .get(...params) as { c: number };
  return row.c;
}

/**
 * 给前端展示用的统计信息。
 *
 * scope 语义同 rebuildAllEmbeddings：
 *   - userId + workspaceId === null   →  个人空间（仅该用户的 NULL 工作区笔记）
 *   - workspaceId === string (uuid)   →  指定工作区（不限作者，全工作区成员共享）
 *   - 都不传                            →  全库（运维 / 管理员视角）
 */
export function getEmbeddingStats(opts: {
  userId: string;
  workspaceId?: string | null;
}): {
  totalNotes: number;
  indexedNotes: number;
  pending: number;
  processing: number;
  failed: number;
  // 附件维度（v8）
  totalAttachments: number;
  indexedAttachments: number;
  attachmentPending: number;
  attachmentProcessing: number;
  attachmentFailed: number;
  configured: boolean;
  model: string | null;
  vecAvailable: boolean;
  vecDim: number | null;
} {
  const db = getDb();
  const resolution = resolveEmbeddingConfig(opts.userId);
  const cfg = resolution.config;

  const conds: string[] = [];
  const params: any[] = [];
  if (opts.userId !== undefined) {
    conds.push(`userId = ?`);
    params.push(opts.userId);
  }
  if (opts.workspaceId !== undefined) {
    if (opts.workspaceId === null || opts.workspaceId === "") {
      conds.push(`workspaceId IS NULL`);
    } else {
      conds.push(`workspaceId = ?`);
      params.push(opts.workspaceId);
    }
  }
  const whereTail = conds.length > 0 ? ` AND ${conds.join(" AND ")}` : "";
  const whereOnly = conds.length > 0 ? ` WHERE ${conds.join(" AND ")}` : "";

  const totalNotes = (db
    .prepare(`SELECT COUNT(*) as c FROM notes WHERE isTrashed = 0${whereTail}`)
    .get(...params) as { c: number }).c;

  // 只统计 note 类实体；attachment 行在 v8 后混入 note_embeddings，
  // 统计 note 已索引数量必须加 entityType='note' 过滤，否则会把附件计进来。
  const indexedNotes = (db
    .prepare(
      `SELECT COUNT(DISTINCT noteId) as c FROM note_embeddings WHERE entityType = 'note'${whereTail}`,
    )
    .get(...params) as { c: number }).c;

  const queueRows = embeddingQueueRepository.countByStatus(whereOnly ? whereOnly.replace("WHERE ", "") : "", params);
  const counts: Record<string, number> = {};
  for (const r of queueRows) counts[r.status] = r.c;

  // ---- 附件统计（与 note 同 scope）----
  // attachments 表需要 JOIN notes 过滤 isTrashed；scope 列本身在 attachments
  // 上已经有（v5 backfill 已完成）。
  const attachConds: string[] = [];
  const attachParams: any[] = [];
  if (opts.userId !== undefined) {
    attachConds.push(`a.userId = ?`);
    attachParams.push(opts.userId);
  }
  if (opts.workspaceId !== undefined) {
    if (opts.workspaceId === null || opts.workspaceId === "") {
      attachConds.push(`a.workspaceId IS NULL`);
    } else {
      attachConds.push(`a.workspaceId = ?`);
      attachParams.push(opts.workspaceId);
    }
  }
  const attachWhere = attachConds.length > 0 ? ` AND ${attachConds.join(" AND ")}` : "";
  const totalAttachments = (db
    .prepare(
      `SELECT COUNT(*) as c FROM attachments a JOIN notes n ON n.id = a.noteId
        WHERE n.isTrashed = 0${attachWhere}`,
    )
    .get(...attachParams) as { c: number }).c;

  const indexedAttachments = (db
    .prepare(
      `SELECT COUNT(DISTINCT attachmentId) as c FROM note_embeddings
        WHERE entityType = 'attachment'${whereTail}`,
    )
    .get(...params) as { c: number }).c;

  const attachQueueRows = db
    .prepare(
      `SELECT status, COUNT(*) as c FROM attachment_embedding_queue${whereOnly} GROUP BY status`,
    )
    .all(...params) as { status: string; c: number }[];
  const attachCounts: Record<string, number> = {};
  for (const r of attachQueueRows) attachCounts[r.status] = r.c;

  return {
    totalNotes,
    indexedNotes,
    pending: counts.pending || 0,
    processing: counts.processing || 0,
    failed: counts.failed || 0,
    totalAttachments,
    indexedAttachments,
    attachmentPending: attachCounts.pending || 0,
    attachmentProcessing: attachCounts.processing || 0,
    attachmentFailed: attachCounts.failed || 0,
    configured: !!cfg,
    model: cfg?.model || null,
    vecAvailable: isVecAvailable(),
    vecDim: getVecDim(),
  };
}

// ============================================================
// 查询向量化（给 /ask 用）
// ============================================================
//
// 把用户的问题文本转成向量，用于 vec_note_chunks KNN 检索。
// - 复用 readEmbeddingConfig：保证查询和入库用同一个 model/url，维度一致
// - 配置缺失返回 null，调用方降级走 BM25
// - 失败也返回 null（吞错）：用户已经在等回复，不能因为 embedding 接口抖动导致 /ask 整个挂掉

/**
 * 附件上传成功后由 routes/attachments.ts 调用：立即入队一次 embedding 任务。
 *
 * 幂等：对同一 attachmentId 二次调用会通过 ON CONFLICT 覆盖为 pending，
 * 重置 retries/lastError，worker 下一轮处理。
 *
 * 不抛错：任何 DB 错误都被吞掉 + 打 warn——上传本身已经成功，索引失败不该
 * 把上传接口的 201 响应也带错成 500。
 */
export function enqueueAttachment(att: {
  attachmentId: string;
  userId: string;
  workspaceId: string | null;
  noteId: string;
}): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO attachment_embedding_queue
         (attachmentId, userId, workspaceId, noteId, status, retries, enqueuedAt, updatedAt)
       VALUES (?, ?, ?, ?, 'pending', 0, datetime('now'), datetime('now'))
       ON CONFLICT(attachmentId) DO UPDATE SET
         userId = excluded.userId,
         workspaceId = excluded.workspaceId,
         noteId = excluded.noteId,
         status = 'pending',
         retries = 0,
         lastError = NULL,
         updatedAt = datetime('now')`,
    ).run(att.attachmentId, att.userId, att.workspaceId, att.noteId);
  } catch (e) {
    console.warn("[embedding-worker] enqueueAttachment failed:", e);
  }
}

export async function embedQuery(userId: string, text: string): Promise<number[] | null> {
  const t = (text || "").trim();
  if (t.length < 2) return null;

  const cfg = resolveEmbeddingConfig(userId).config;
  if (!cfg) return null;

  try {
    const vectors = await callEmbeddings(cfg, [t.slice(0, 4000)]);
    return vectors[0] || null;
  } catch (e) {
    console.warn("[embedding-worker] embedQuery failed:", e);
    return null;
  }
}
