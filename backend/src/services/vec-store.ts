/**
 * Vector Store — RAG Phase 2
 *
 * 在 better-sqlite3 上加载 sqlite-vec 扩展，维护一个 vec0 虚表
 *   vec_note_chunks(embedding float[D])
 * 用 rowid 与 note_embeddings.id 一一对应（同步写入/删除）。
 *
 * 为什么不直接 JOIN：
 *   sqlite-vec 的 vec0 虚表不支持 JOIN（rowid + KNN match 是它的快路径）。
 *   常规做法是：先 KNN 拿 rowid+distance，再回 note_embeddings 用 rowid 取
 *   noteId/chunkText，最后回 notes 取标题。
 *
 * 维度策略：
 *   sqlite-vec 的列在 CREATE 时必须固定维度。我们没法在 schema.ts 一开始就
 *   写死维度（用户可能换模型）。所以：
 *     - 第一次拿到一个非空向量时根据其维度建表
 *     - 维度不一致时拒绝写入，要求用户走 /embeddings/rebuild 清掉重来
 *     - 把当前维度写入 system_settings 'vec_dim' 持久化，重启可读
 *
 * 失败容忍：
 *   sqlite-vec 没成功加载（比如平台不兼容、二进制缺失），整个模块降级为 noop
 *   stub：所有写入吞掉，isAvailable() 返回 false。/ask 检测到不可用时回退到
 *   BM25 检索路径，用户体验仍然能用，只是没有"语义"召回。
 */
import * as sqliteVec from "sqlite-vec";
import type Database from "better-sqlite3";
import { getDb } from "../db/schema";
import { systemSettingsRepository } from "../repositories";

// ====== 内部状态 ======
let loaded = false;          // sqlite-vec 是否成功加载到当前 db 连接
let loadAttempted = false;   // 是否已尝试加载（避免每次调用都试，noisy log）
let currentDim: number | null = null; // 当前 vec0 表使用的维度；未建表时为 null

// ====== 配置 ======
const SETTINGS_KEY_DIM = "vec_dim";

// ============================================================
// 加载扩展 + 建表
// ============================================================

/**
 * 幂等加载 sqlite-vec 扩展并恢复维度元数据。
 * 启动时调一次；之后每次 getDb 拿到的都是同一个连接（schema.ts 单例），
 * 不需要在每个查询前再 load。
 */
export function initVecStore(): { loaded: boolean; dim: number | null; error?: string } {
  if (loadAttempted) {
    return { loaded, dim: currentDim };
  }
  loadAttempted = true;

  try {
    const db = getDb();
    // sqlite-vec 通过 db.loadExtension 加载；package 里直接暴露了 load(db) 帮助函数
    sqliteVec.load(db);
    loaded = true;

    // 读持久化的维度；如果之前建过 vec0 表，这里恢复 currentDim
    try {
      const row = systemSettingsRepository.get(SETTINGS_KEY_DIM);
      if (row?.value) {
        const d = parseInt(row.value, 10);
        if (Number.isFinite(d) && d > 0) {
          currentDim = d;
          // 确认表确实存在；不存在则按 currentDim 重建（覆盖重启场景）
          ensureVecTable(db, currentDim);
        }
      }
    } catch (e) {
      console.warn("[vec-store] restore dim failed:", e);
    }

    console.log(`[vec-store] sqlite-vec loaded (dim=${currentDim ?? "uninitialized"})`);
    return { loaded: true, dim: currentDim };
  } catch (e: any) {
    loaded = false;
    const msg = e?.message || String(e);
    console.warn("[vec-store] sqlite-vec load failed, falling back to BM25-only:", msg);
    return { loaded: false, dim: null, error: msg };
  }
}

/**
 * 检测 sqlite-vec 是否就绪（已加载且至少建过一次 vec0 表）。
 * /ask 决定走向量检索还是回退 BM25 时调用。
 */
export function isVecAvailable(): boolean {
  return loaded && currentDim !== null;
}

export function getVecDim(): number | null {
  return currentDim;
}

// ============================================================
// 内部：建表
// ============================================================

function ensureVecTable(db: Database.Database, dim: number): void {
  // vec0 虚表语法：CREATE VIRTUAL TABLE name USING vec0(embedding float[D])
  // 不带 IF NOT EXISTS：vec0 模块会自己处理"已存在"，但保险起见 try/catch
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_note_chunks USING vec0(
      embedding float[${dim}]
    )`);
  } catch (e: any) {
    // 极端情况下：维度不一致会报错（之前以另一个 dim 建过表）
    // 抛上去，由调用方决定是否要 reset
    throw new Error(`ensureVecTable failed: ${e?.message || e}`);
  }
}

/**
 * 用指定维度（重新）初始化 vec0 表。
 * - 如果已有相同维度：no-op
 * - 如果已有不同维度：DROP 重建（数据全清；调用方自己负责把 note_embeddings 也清掉再灌）
 * - 如果还没建过：直接建
 *
 * 在 worker 第一次写向量、用户切模型走 /embeddings/rebuild 时被调用。
 */
export function resetVecTable(dim: number): void {
  if (!loaded) return;
  if (!Number.isFinite(dim) || dim <= 0) {
    throw new Error(`resetVecTable: invalid dim ${dim}`);
  }
  const db = getDb();

  if (currentDim === dim) {
    // 维度未变；只要表存在就没事
    ensureVecTable(db, dim);
    return;
  }

  const tx = db.transaction(() => {
    // 必须先 DROP 旧的，CREATE 时维度才能换
    try { db.exec("DROP TABLE IF EXISTS vec_note_chunks"); } catch { /* 不存在也不要紧 */ }
    ensureVecTable(db, dim);
    systemSettingsRepository.set(SETTINGS_KEY_DIM, String(dim));
  });
  tx();

  currentDim = dim;
  console.log(`[vec-store] vec_note_chunks (re)initialized with dim=${dim}`);
}

// ============================================================
// 写入 / 删除
// ============================================================

/**
 * 把一组（note_embeddings.id, vector）灌进 vec0 表。
 * - rowid = note_embeddings.id（保证一一对应，后续 KNN 命中后能反查回原表）
 * - 维度不匹配会抛错；调用方 try/catch 后决定是否走 reset
 *
 * 之所以不在 worker 里直接 INSERT vec_note_chunks 而要走这层封装：
 *   1. sqlite-vec 不一定加载成功；这里有 isAvailable 的统一短路
 *   2. 维度自检 + 必要时 reset
 *   3. 把 vec0 的存储格式（Float32Array buffer）的细节封死在一个文件里
 */
export function upsertVectors(
  rows: { rowid: number; vector: number[] }[],
): { written: number; skipped: number } {
  if (!loaded || rows.length === 0) {
    return { written: 0, skipped: rows.length };
  }
  const dim = rows[0].vector.length;
  if (!dim) return { written: 0, skipped: rows.length };

  // 首次写入：按维度建表
  if (currentDim === null) {
    resetVecTable(dim);
  } else if (currentDim !== dim) {
    // 维度变了 → 不擅自 reset（会清空全表），让调用方决定
    throw new Error(
      `vec dim mismatch: table=${currentDim}, incoming=${dim}. ` +
      `调用 resetVecTable + 重灌 note_embeddings 来切换模型。`,
    );
  }

  const db = getDb();
  // sqlite-vec 接受多种向量输入；最稳的方式是传 Float32Array 的 Buffer
  // 也可以传 JSON 字符串 '[0.1,0.2,...]'，但大 batch 时 Buffer 性能更好
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO vec_note_chunks(rowid, embedding) VALUES (?, ?)",
  );
  let written = 0;
  let skipped = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (r.vector.length !== dim) {
        skipped++;
        continue;
      }
      const buf = Buffer.from(new Float32Array(r.vector).buffer);
      stmt.run(r.rowid, buf);
      written++;
    }
  });
  tx();
  return { written, skipped };
}

/**
 * 删除一组 rowid（通常对应某 noteId 的全部 chunk）。
 * sqlite-vec vec0 支持普通 DELETE WHERE rowid IN (...)，无需特殊语法。
 */
export function deleteVectorsByRowids(rowids: number[]): number {
  if (!loaded || !isVecAvailable() || rowids.length === 0) return 0;
  const db = getDb();
  const placeholders = rowids.map(() => "?").join(",");
  const info = db.prepare(
    `DELETE FROM vec_note_chunks WHERE rowid IN (${placeholders})`,
  ).run(...rowids);
  return info.changes;
}

/** 清空 vec0 表（不删表本身）。用于 /embeddings/rebuild?clearExisting=true */
export function clearAllVectors(): void {
  if (!loaded || !isVecAvailable()) return;
  const db = getDb();
  try {
    db.exec("DELETE FROM vec_note_chunks");
  } catch (e) {
    console.warn("[vec-store] clearAllVectors failed:", e);
  }
}

// ============================================================
// 查询：KNN
// ============================================================

export interface VecHit {
  rowid: number;     // = note_embeddings.id
  distance: number;  // 越小越相似（cosine/L2 视 sqlite-vec 默认而定，当前为 L2）
  // v8 扩展：区分 note / attachment
  //   - entityType='note'       → noteId 是笔记 id，attachmentId = null
  //   - entityType='attachment' → noteId 是附件所属笔记 id（便于引用回跳），
  //                               attachmentId 是附件 id，filename 是附件原始文件名
  entityType: "note" | "attachment";
  noteId: string;
  userId: string;
  workspaceId: string | null;
  chunkText: string;
  chunkIndex: number;
  title: string;              // note: 笔记标题；attachment: 附件所属笔记标题
  attachmentId?: string | null;
  attachmentFilename?: string | null;
}

/**
 * 取查询向量的 K 近邻，自动反查 note_embeddings + notes，按 noteId 去重
 * 取每个 note 最相似的 chunk。
 *
 * 参数：
 *   queryVec    查询向量（必须维度匹配；不匹配返回 []）
 *   userId      调用方用户 id（个人空间下作为额外的 owner 过滤；工作区下用于
 *               业务层之外的兜底审计——本函数本身不替代权限校验）
 *   workspaceId 当前 scope：null = 个人空间（仅命中 userId 自己 + workspaceId IS NULL
 *               的笔记），string = 指定工作区（命中所有 workspaceId 匹配的笔记，
 *               不再以"作者"过滤，让同一个工作区成员能搜到彼此的笔记）
 *   k           取多少个 chunk（去重前；建议 20，去重后通常剩 5~10 篇）
 *   maxNotes    去重后最多返回多少篇
 *
 * 注意：调用方必须在路由层先校验"当前用户对该 workspaceId 有读权限"，本函数
 *      只负责把检索范围严格收敛到给定的 (userId, workspaceId) scope。
 */
export function knnSearch(
  queryVec: number[],
  userId: string,
  workspaceId: string | null,
  k = 20,
  maxNotes = 5,
  notebookIds?: string[] | null,
): VecHit[] {

  const db = getDb();
  const buf = Buffer.from(new Float32Array(queryVec).buffer);

  // 有 notebookId 过滤时提高 k，避免小范围笔记本被全库稀释
  const effectiveK = notebookIds && notebookIds.length > 0 ? Math.max(k, 300) : k;
  // sqlite-vec KNN 语法：MATCH 给查询向量，k=? 控制返回数
  // 注意：vec0 的 MATCH 只支持单一查询向量；不支持 WHERE 复合条件
  // 所以我们多取一些（k 个），再在外层用 note_embeddings.userId/workspaceId 过滤
  let vecRows: { rowid: number; distance: number }[] = [];
  try {
    vecRows = db.prepare(`
      SELECT rowid, distance
      FROM vec_note_chunks
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(buf, effectiveK) as { rowid: number; distance: number }[];
  } catch (e: any) {
    console.warn("[vec-store] knnSearch failed:", e?.message || e);
    return [];
  }

  if (vecRows.length === 0) return [];

  // 反查 note_embeddings + notes（一次 IN 查询）
  // v8：也带上 entityType / attachmentId，并 LEFT JOIN attachments 拿附件文件名
  const ids = vecRows.map((r) => r.rowid);
  const placeholders = ids.map(() => "?").join(",");
  const meta = db.prepare(`
    SELECT
      e.id         AS rowid,
      e.noteId     AS noteId,
      e.userId     AS userId,
      e.workspaceId AS workspaceId,
      e.chunkText  AS chunkText,
      e.chunkIndex AS chunkIndex,
      e.entityType AS entityType,
      e.attachmentId AS attachmentId,
      n.notebookId AS notebookId,
      n.title      AS title,
      n.isTrashed  AS isTrashed,
      a.filename   AS attachmentFilename
    FROM note_embeddings e
    JOIN notes n ON n.id = e.noteId
    LEFT JOIN attachments a ON a.id = e.attachmentId
    WHERE e.id IN (${placeholders})
  `).all(...ids) as {
    rowid: number;
    noteId: string;
    userId: string;
    workspaceId: string | null;
    chunkText: string;
    chunkIndex: number;
    entityType: string;
    attachmentId: string | null;
    notebookId: string;
    title: string;
    isTrashed: number;
    attachmentFilename: string | null;
  }[];

  const metaMap = new Map(meta.map((m) => [m.rowid, m]));

  // scope 归一：'' 也按 null 处理；后端 query 解析层已经在传入前做过转换，
  // 这里再加一道防御。
  const wantWs: string | null = workspaceId || null;

  // 按 vecRows 顺序（已按 distance asc）merge + 过滤 scope/trash + 按实体去重
  //
  // 隔离规则：
  //   - 个人空间 (wantWs === null)：仅命中 userId === 当前用户 且
  //     workspaceId IS NULL 的向量。这同时阻止了"工作区笔记泄漏到个人空间"
  //     和"别人的个人空间笔记泄漏给我"两种情况。
  //   - 工作区 (wantWs !== null)：仅命中 workspaceId === wantWs 的向量；
  //     不再按 userId 过滤——同一个工作区的成员应该能互相搜索到彼此的笔记，
  //     这是协作场景的核心需求。访问权限由调用方（路由层）通过 workspace
  //     成员校验保证：能拿到 wantWs 的人都已经具备该工作区读权限。
  //
  // 去重：
  //   - note：按 noteId 去重（同笔记多 chunk 只留最相似的一个，保证 hits 里
  //           每篇笔记最多一行，避免 /ask 上下文里同一篇笔记被列两次）
  //   - attachment：按 attachmentId 去重（同附件多 chunk 同理）
  //   note 与 attachment 不去重——同一篇笔记命中 note 行 + 它的附件命中
  //   attachment 行，两者都应该出现（承载的是不同信息）。
  const seenNotes = new Set<string>();
  const seenAttachments = new Set<string>();
  const hits: VecHit[] = [];
  for (const v of vecRows) {
    const m = metaMap.get(v.rowid);
    if (!m) continue;             // 元数据缺失：可能 note 已删但 vec 没及时清；跳过
    const mWs: string | null = m.workspaceId || null;
    if (wantWs === null) {
      // 个人空间：必须 owner 是自己 + 笔记本身在个人空间
      if (m.userId !== userId) continue;
      if (mWs !== null) continue;
    } else {
      // 工作区：仅按 workspaceId 匹配，不限 owner
      if (mWs !== wantWs) continue;
    }
    if (m.isTrashed) continue;
    if (notebookIds && !notebookIds.includes(m.notebookId)) continue;

    const entityType = (m.entityType === "attachment" ? "attachment" : "note") as
      | "note"
      | "attachment";
    if (entityType === "attachment") {
      const aid = m.attachmentId || "";
      if (!aid || seenAttachments.has(aid)) continue;
      seenAttachments.add(aid);
    } else {
      if (seenNotes.has(m.noteId)) continue;
      seenNotes.add(m.noteId);
    }

    hits.push({
      rowid: v.rowid,
      distance: v.distance,
      entityType,
      noteId: m.noteId,
      userId: m.userId,
      workspaceId: mWs,
      chunkText: m.chunkText,
      chunkIndex: m.chunkIndex,
      title: m.title,
      attachmentId: m.attachmentId,
      attachmentFilename: m.attachmentFilename,
    });
    if (hits.length >= maxNotes) break;
  }
  return hits;
}

// ============================================================
// 全量重建：把 note_embeddings 全表灌进 vec0
// ============================================================

/**
 * 从 note_embeddings 全表重建 vec_note_chunks。
 * 用途：
 *   1. 启动时发现 sqlite-vec 刚加载、note_embeddings 已有数据但 vec 表为空 → 自动重建
 *   2. 用户主动触发 POST /embeddings/reindex-vec
 *
 * 实现：分批 SELECT，避免大库一次性加载到内存。
 */
export function reindexAllVectors(opts: { batchSize?: number } = {}): {
  total: number;
  written: number;
  skipped: number;
  dim: number | null;
} {
  if (!loaded) return { total: 0, written: 0, skipped: 0, dim: null };

  const db = getDb();
  const batchSize = Math.max(50, opts.batchSize || 500);

  // 先看第一行决定维度
  const firstRow = db
    .prepare("SELECT vectorJson FROM note_embeddings WHERE vectorJson != '[]' LIMIT 1")
    .get() as { vectorJson: string } | undefined;
  if (!firstRow) {
    return { total: 0, written: 0, skipped: 0, dim: currentDim };
  }

  let dim = 0;
  try {
    const v = JSON.parse(firstRow.vectorJson);
    if (Array.isArray(v) && v.length > 0) dim = v.length;
  } catch { /* invalid */ }
  if (!dim) return { total: 0, written: 0, skipped: 0, dim: currentDim };

  // 重建表（维度变了会清空旧的；维度相同则保留）
  resetVecTable(dim);
  // 但即便维度未变，也可能存在历史脏数据：清一遍再灌更稳
  clearAllVectors();

  let total = 0;
  let written = 0;
  let skipped = 0;
  let lastId = 0;

  // 用 id > lastId 做游标分页，比 OFFSET 在大表上快得多
  const stmt = db.prepare(
    "SELECT id, vectorJson FROM note_embeddings WHERE id > ? ORDER BY id ASC LIMIT ?",
  );

  while (true) {
    const rows = stmt.all(lastId, batchSize) as { id: number; vectorJson: string }[];
    if (rows.length === 0) break;
    total += rows.length;
    lastId = rows[rows.length - 1].id;

    const batch: { rowid: number; vector: number[] }[] = [];
    for (const r of rows) {
      try {
        const vec = JSON.parse(r.vectorJson);
        if (!Array.isArray(vec) || vec.length !== dim) {
          skipped++;
          continue;
        }
        batch.push({ rowid: r.id, vector: vec });
      } catch {
        skipped++;
      }
    }
    if (batch.length > 0) {
      const res = upsertVectors(batch);
      written += res.written;
      skipped += res.skipped;
    }
  }

  return { total, written, skipped, dim };
}
