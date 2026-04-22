/**
 * Phase 3: Y.js CRDT 服务端
 * --------------------------------------------------------------------
 * 核心职责：
 *   1. 按 noteId 维护一个内存中的 Y.Doc（懒加载、引用计数）
 *   2. 启动时从 SQLite 的 note_ysnapshots + note_yupdates 回放恢复文档
 *   3. 接收客户端 update：applyUpdate 到内存 Doc + 追加写入 note_yupdates
 *   4. 向同房间其他客户端广播该 update
 *   5. 周期性 / 阈值触发快照合并（snapshot = encodeStateAsUpdate）
 *   6. 房间无人时 debounce 清理内存 Doc（N 秒后 flush + 释放）
 *   7. 与 Phase 1/2 的 `notes.content` 双写：每次更新把 Y.Text 序列化回 markdown 写入 notes 表
 *      —— 保证 FTS5 搜索、REST API、版本历史继续工作
 *
 * 协议（复用 Phase 2 WebSocket JSON 通道）：
 *   客户端 → 服务端
 *     { type: "y:join",   noteId }                        订阅 CRDT 房间；立即回 sync
 *     { type: "y:leave",  noteId }                        退订
 *     { type: "y:update", noteId, update: <base64> }      提交 Y update
 *     { type: "y:awareness", noteId, update: <base64> }   提交 awareness update
 *   服务端 → 客户端
 *     { type: "y:sync",   noteId, state: <base64> }       初次同步：整个 Y doc 的 state
 *     { type: "y:update", noteId, update: <base64>, actorConnectionId }
 *     { type: "y:awareness", noteId, update: <base64>, actorConnectionId }
 *
 * 取舍：
 *   - 使用 JSON + base64 而非 y-protocols 二进制协议（ArrayBuffer）——牺牲几十字节/包的
 *     带宽，换来复用 Phase 2 的 WebSocketServer 与鉴权/路由，逻辑简化很多。20 人规模够用。
 *   - Awareness 走转发模式（服务端不维护状态）；Presence 仍由 Phase 2 管理。
 */

import * as Y from "yjs";
import { getDb } from "../db/schema";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 超过多少条 update 触发一次 snapshot 合并（减少启动恢复耗时） */
const SNAPSHOT_EVERY_N_UPDATES = 100;
/** 房间空闲多久后回收内存 Doc（仍保留 SQLite 持久化） */
const ROOM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** 单条 y:update 二进制大小上限（解码后字节数）——防止恶意 / 误操作塞巨型 patch */
export const MAX_UPDATE_BYTES = 1 * 1024 * 1024; // 1 MiB
/** 兜底：定期对所有内存 Doc 写一次 snapshot（哪怕没到 N 条），避免长期编辑迟迟不归并 */
const PERIODIC_SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000; // 1h

// ---------------------------------------------------------------------------
// 内存状态
// ---------------------------------------------------------------------------

interface RoomState {
  noteId: string;
  doc: Y.Doc;
  /** 活跃连接数；降到 0 时开始空闲计时 */
  refCount: number;
  /** 自上次 snapshot 起累积的 update 数 */
  updatesSinceSnapshot: number;
  /** 空闲清理定时器 */
  idleTimer: NodeJS.Timeout | null;
  /** 是否已把最新 markdown 回写到 notes.content（debounce） */
  persistTimer: NodeJS.Timeout | null;
  /** 最后一位编辑者（用于回写 notes 表时记录 actor） */
  lastActorUserId: string | null;
  /** 最近一次 version++ 的时间戳（毫秒）——用于 P2-#8 版本粒度控制 */
  lastVersionBumpAt: number;
  /** 最近一次 snapshot 兜底检查的时间戳 */
  lastPeriodicSnapshotAt: number;
}

const rooms = new Map<string, RoomState>();

// ---------------------------------------------------------------------------
// 持久化：从 SQLite 恢复 / 写入
// ---------------------------------------------------------------------------

/**
 * 初始化 Y.Doc：
 *   1. 若有 snapshot，先 applyUpdate(snapshot)
 *   2. 再按 clock 顺序 applyUpdate(update)
 *   3. 若都没有，但 notes.content 存在 markdown 文本，则作为"种子"导入 Y.Text
 */
function loadDocFromDb(noteId: string): Y.Doc {
  const db = getDb();
  const doc = new Y.Doc();

  const snap = db
    .prepare("SELECT snapshot_blob, updatesMergedTo FROM note_ysnapshots WHERE noteId = ?")
    .get(noteId) as { snapshot_blob: Buffer; updatesMergedTo: number } | undefined;

  let appliedAny = false;
  let lastAppliedId = 0;

  if (snap) {
    try {
      Y.applyUpdate(doc, new Uint8Array(snap.snapshot_blob));
      appliedAny = true;
      lastAppliedId = snap.updatesMergedTo || 0;
    } catch (e) {
      console.warn(`[yjs] applySnapshot failed for ${noteId}:`, e);
    }
  }

  const updates = db
    .prepare("SELECT id, update_blob FROM note_yupdates WHERE noteId = ? AND id > ? ORDER BY id ASC")
    .all(noteId, lastAppliedId) as Array<{ id: number; update_blob: Buffer }>;

  for (const row of updates) {
    try {
      Y.applyUpdate(doc, new Uint8Array(row.update_blob));
      appliedAny = true;
    } catch (e) {
      console.warn(`[yjs] applyUpdate failed for ${noteId} (updateId=${row.id}):`, e);
    }
  }

  // 冷启动：Y 数据库还没任何 update，但 notes 表里有 markdown → 作为种子导入
  if (!appliedAny) {
    const note = db.prepare("SELECT content, contentText FROM notes WHERE id = ?").get(noteId) as
      | { content: string; contentText: string }
      | undefined;
    if (note) {
      // 只对 markdown 文本笔记做种子导入（Tiptap JSON 的情况由前端判断是否启用协同）
      const seed = inferMarkdownSeed(note.content, note.contentText);
      if (seed) {
        const ytext = doc.getText("content");
        ytext.insert(0, seed);
      }
    }
  } else {
    // 修复遗留空 yText：历史版本存在一个 bug ——MD 编辑器在 yDoc 未 synced 时
    // 用空串初始化 CM，挂载 yCollab 后把"空 CM doc"作为 update 持久化到
    // note_yupdates，导致后续加载 appliedAny=true 但 yText 实际为空。此时若
    // notes.content 里还保留着原始内容，直接回种给 yText，避免前端 MD 编辑器空白。
    //
    // 注意：这里的 insert 是就地操作当前 Y.Doc（不走 persistUpdate），由后续
    // 客户端正常编辑产生的 update 自然持久化；下次 idle 卸载后 loadDocFromDb
    // 会重新进入本分支再 seed 一次，保持幂等。
    const ytext = doc.getText("content");
    if (ytext.length === 0) {
      const note = db.prepare("SELECT content, contentText FROM notes WHERE id = ?").get(noteId) as
        | { content: string; contentText: string }
        | undefined;
      if (note) {
        const seed = inferMarkdownSeed(note.content, note.contentText);
        if (seed) {
          ytext.insert(0, seed);
          console.log(`[yjs] fallback-seeded empty yText for note ${noteId} (len=${seed.length})`);
        }
      }
    }
  }

  return doc;
}

/** 粗略判断 content 是否为 markdown 字符串（而非 Tiptap JSON） */
function inferMarkdownSeed(content: string | null | undefined, contentText: string | null | undefined): string {
  if (!content) return contentText || "";
  const trimmed = content.trim();
  if (!trimmed) return contentText || "";
  // JSON 风格（Tiptap）：以 { 开头并包含 "type" 字段
  if (trimmed.startsWith("{") && /"type"\s*:/.test(trimmed)) {
    // 无法无损反序列化，回退到纯文本作为只读种子（用户编辑后会覆盖）
    return contentText || "";
  }
  return content;
}

/** 追加持久化一条 update */
function persistUpdate(noteId: string, update: Uint8Array, userId: string | null): number {
  const db = getDb();
  const info = db
    .prepare("INSERT INTO note_yupdates (noteId, userId, update_blob, clock) VALUES (?, ?, ?, ?)")
    .run(noteId, userId, Buffer.from(update), Date.now());
  return Number(info.lastInsertRowid);
}

/** 把当前 Y.Doc 合并成一次 snapshot。
 *
 * 原子性策略（修复 P0-#3）：
 *   - 整个写入包在事务里
 *   - **不立即删除已合并的老 update**，只推进水位线 `updatesMergedTo`
 *     → 即使 snapshot 写入中途崩溃，启动时仍能用"snapshot 或老 updates"二选一恢复
 *   - 老 updates 的真正清理由独立的 GC 步骤做（有 safety margin）
 */
function writeSnapshot(noteId: string, doc: Y.Doc) {
  const db = getDb();
  const state = Y.encodeStateAsUpdate(doc);
  // 取当前最大 updateId 作为水位线（在事务内做，避免并发 insert 造成 off-by-one）
  const tx = db.transaction(() => {
    const maxRow = db
      .prepare("SELECT MAX(id) as maxId FROM note_yupdates WHERE noteId = ?")
      .get(noteId) as { maxId: number | null } | undefined;
    const mergedTo = maxRow?.maxId || 0;
    db.prepare(
      `INSERT INTO note_ysnapshots (noteId, snapshot_blob, updatesMergedTo, updatedAt)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(noteId) DO UPDATE SET
         snapshot_blob = excluded.snapshot_blob,
         updatesMergedTo = excluded.updatesMergedTo,
         updatedAt = excluded.updatedAt`,
    ).run(noteId, Buffer.from(state), mergedTo);
  });
  tx();
}

/**
 * 独立的 GC：删除已合并进某个 snapshot 的老 updates。
 * 保留 margin（mergedTo - GC_SAFETY_MARGIN）条，避免 snapshot 刚写完就把依赖删光。
 */
const GC_SAFETY_MARGIN = 50;
function gcMergedUpdates(noteId: string) {
  const db = getDb();
  const snap = db
    .prepare("SELECT updatesMergedTo FROM note_ysnapshots WHERE noteId = ?")
    .get(noteId) as { updatesMergedTo: number } | undefined;
  if (!snap) return;
  const safeDeleteBelow = snap.updatesMergedTo - GC_SAFETY_MARGIN;
  if (safeDeleteBelow <= 0) return;
  db.prepare("DELETE FROM note_yupdates WHERE noteId = ? AND id <= ?").run(
    noteId,
    safeDeleteBelow,
  );
}

// ---------------------------------------------------------------------------
// 回写 notes.content / contentText（FTS & REST 兼容）
// ---------------------------------------------------------------------------

/**
 * 把 Y.Text 序列化成 markdown 写回 notes 表。debounce 1.5s，
 * 避免频繁输入时大量 write。
 */
function schedulePersistToNotesTable(room: RoomState) {
  if (room.persistTimer) clearTimeout(room.persistTimer);
  room.persistTimer = setTimeout(() => {
    room.persistTimer = null;
    try {
      persistToNotesTable(room);
    } catch (e) {
      console.warn(`[yjs] persistToNotesTable failed for ${room.noteId}:`, e);
    }
  }, 1500);
}

function persistToNotesTable(room: RoomState) {
  const db = getDb();
  const ytext = room.doc.getText("content");
  const markdown = ytext.toString();
  // 生成纯文本（给 FTS 用）—— 用最朴素的剥离，复杂的由前端 contentFormat 负责
  const contentText = markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#>*_`~\-]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const existing = db.prepare("SELECT version FROM notes WHERE id = ?").get(room.noteId) as
    | { version: number }
    | undefined;
  if (!existing) return;

  // P2-#8：version 粒度控制——5 分钟内连续编辑合并为同一个 version，
  // 避免 CRDT 下每 1.5s 就 ++ 把版本历史稀释成噪音
  const VERSION_BUMP_INTERVAL_MS = 5 * 60 * 1000;
  const now = Date.now();
  const shouldBump = now - room.lastVersionBumpAt >= VERSION_BUMP_INTERVAL_MS;

  if (shouldBump) {
    db.prepare(
      `UPDATE notes
         SET content = ?,
             contentText = ?,
             version = version + 1,
             updatedAt = datetime('now')
       WHERE id = ?`,
    ).run(markdown, contentText, room.noteId);
    room.lastVersionBumpAt = now;
  } else {
    // 不动 version，仅更新 content / contentText / updatedAt
    db.prepare(
      `UPDATE notes
         SET content = ?,
             contentText = ?,
             updatedAt = datetime('now')
       WHERE id = ?`,
    ).run(markdown, contentText, room.noteId);
  }
}

// ---------------------------------------------------------------------------
// 房间生命周期
// ---------------------------------------------------------------------------

function getOrCreateRoom(noteId: string): RoomState {
  let room = rooms.get(noteId);
  if (!room) {
    const doc = loadDocFromDb(noteId);
    room = {
      noteId,
      doc,
      refCount: 0,
      updatesSinceSnapshot: 0,
      idleTimer: null,
      persistTimer: null,
      lastActorUserId: null,
      lastVersionBumpAt: 0,
      lastPeriodicSnapshotAt: Date.now(),
    };
    rooms.set(noteId, room);
  }
  if (room.idleTimer) {
    clearTimeout(room.idleTimer);
    room.idleTimer = null;
  }
  return room;
}

function releaseRoom(noteId: string) {
  const room = rooms.get(noteId);
  if (!room) return;
  room.refCount = Math.max(0, room.refCount - 1);
  if (room.refCount === 0) {
    // 空闲计时：N 分钟后销毁内存 Doc
    room.idleTimer = setTimeout(() => {
      // 最后一次 flush
      if (room.persistTimer) {
        clearTimeout(room.persistTimer);
        room.persistTimer = null;
        try { persistToNotesTable(room); } catch {}
      }
      // 保险：再写一次 snapshot
      try { writeSnapshot(noteId, room.doc); } catch {}
      room.doc.destroy();
      rooms.delete(noteId);
    }, ROOM_IDLE_TIMEOUT_MS);
  }
}

// ---------------------------------------------------------------------------
// 对外 API（供 realtime.ts 的消息处理器调用）
// ---------------------------------------------------------------------------

export interface YJoinResult {
  /** Base64 编码的 sync update；客户端 applyUpdate 即可拿到完整 Y state */
  stateBase64: string;
}

/** 客户端订阅某笔记的 CRDT 房间。返回当前的全量 state 供初次同步。 */
export function yJoin(noteId: string, userId: string | null): YJoinResult {
  const room = getOrCreateRoom(noteId);
  room.refCount++;
  if (userId) room.lastActorUserId = userId;
  const state = Y.encodeStateAsUpdate(room.doc);
  return { stateBase64: bufferToBase64(state) };
}

/** 客户端取消订阅 */
export function yLeave(noteId: string) {
  releaseRoom(noteId);
}

/**
 * 应用客户端 update 到服务端 Doc。
 * @returns 应用结果：'ok' | 'too_large' | 'invalid' | 'no_room'
 */
export type YApplyResult = "ok" | "too_large" | "invalid" | "no_room";

export function yApplyUpdate(
  noteId: string,
  updateBase64: string,
  userId: string | null,
): YApplyResult {
  const room = rooms.get(noteId);
  if (!room) return "no_room";
  let update: Uint8Array;
  try {
    update = base64ToUint8(updateBase64);
  } catch {
    return "invalid";
  }
  // P0-#10：大小限制，防止恶意塞巨型 patch
  if (update.byteLength > MAX_UPDATE_BYTES) {
    console.warn(
      `[yjs] reject oversize update for ${noteId}: ${update.byteLength} bytes (limit=${MAX_UPDATE_BYTES})`,
    );
    return "too_large";
  }
  try {
    Y.applyUpdate(room.doc, update);
  } catch (e) {
    console.warn(`[yjs] applyUpdate rejected for ${noteId}:`, e);
    return "invalid";
  }
  try {
    persistUpdate(noteId, update, userId);
  } catch (e) {
    console.warn(`[yjs] persistUpdate failed for ${noteId}:`, e);
  }
  room.updatesSinceSnapshot++;
  room.lastActorUserId = userId;

  // 阈值触发快照
  if (room.updatesSinceSnapshot >= SNAPSHOT_EVERY_N_UPDATES) {
    try {
      writeSnapshot(noteId, room.doc);
      room.updatesSinceSnapshot = 0;
      room.lastPeriodicSnapshotAt = Date.now();
      // snapshot 之后做一次 GC（带 safety margin）
      try { gcMergedUpdates(noteId); } catch {}
    } catch (e) {
      console.warn(`[yjs] writeSnapshot failed for ${noteId}:`, e);
    }
  } else if (Date.now() - room.lastPeriodicSnapshotAt >= PERIODIC_SNAPSHOT_INTERVAL_MS) {
    // 兜底：长期编辑哪怕没到 N 条，也每小时合并一次
    try {
      writeSnapshot(noteId, room.doc);
      room.updatesSinceSnapshot = 0;
      room.lastPeriodicSnapshotAt = Date.now();
      try { gcMergedUpdates(noteId); } catch {}
    } catch {}
  }

  // debounce 回写 notes.content（供 FTS / REST）
  schedulePersistToNotesTable(room);

  return "ok";
}

/**
 * P2-#6：双向 sync 第一步。
 * 客户端发来自己的 stateVector，服务端返回 diff（服务端有、客户端没有的部分）。
 * 用于接入 IndexedDB 后：客户端本地可能已有服务端尚未见过的 update，
 * 只需在本端持续 doc.on("update") → yUpdate 即可自动补发；
 * 但服务端侧这条路只是"把服务端已有的 diff 告诉客户端"。
 */
export function yEncodeDiffSinceStateVector(
  noteId: string,
  stateVectorBase64: string,
): string | null {
  const room = rooms.get(noteId);
  if (!room) return null;
  try {
    const sv = base64ToUint8(stateVectorBase64);
    const diff = Y.encodeStateAsUpdate(room.doc, sv);
    return bufferToBase64(diff);
  } catch (e) {
    console.warn(`[yjs] encodeDiff failed for ${noteId}:`, e);
    return null;
  }
}

/**
 * 强制立即 flush 一篇笔记到 notes.content 和 snapshot。
 * 用于 REST 端点需要最新内容时（例如 GET /notes/:id）。
 */
export function yFlush(noteId: string) {
  const room = rooms.get(noteId);
  if (!room) return;
  if (room.persistTimer) {
    clearTimeout(room.persistTimer);
    room.persistTimer = null;
  }
  try { persistToNotesTable(room); } catch {}
  try {
    writeSnapshot(noteId, room.doc);
    room.updatesSinceSnapshot = 0;
    room.lastPeriodicSnapshotAt = Date.now();
    try { gcMergedUpdates(noteId); } catch {}
  } catch {}
}

/** 进程退出时调用：把所有房间 flush 到磁盘。返回 Promise，便于 caller await。 */
export function yFlushAll(): Promise<void> {
  const ids = Array.from(rooms.keys());
  for (const id of ids) {
    try { yFlush(id); } catch (e) { console.warn("[yjs] flush failed:", id, e); }
  }
  return Promise.resolve();
}

/**
 * P3-#18：笔记被硬删除时调用，立刻销毁内存 Doc 并清理 SQLite 记录。
 * 外键 CASCADE 会自动删 note_yupdates / note_ysnapshots，这里重点是
 * 把内存 Doc 立即释放，避免悬挂引用。
 */
export function yDestroyDoc(noteId: string) {
  const room = rooms.get(noteId);
  if (!room) return;
  if (room.idleTimer) { clearTimeout(room.idleTimer); room.idleTimer = null; }
  if (room.persistTimer) { clearTimeout(room.persistTimer); room.persistTimer = null; }
  try { room.doc.destroy(); } catch {}
  rooms.delete(noteId);
}

/** 调试：当前房间状态 */
export function getYjsStats() {
  return {
    rooms: rooms.size,
    details: Array.from(rooms.values()).map((r) => ({
      noteId: r.noteId,
      refCount: r.refCount,
      updatesSinceSnapshot: r.updatesSinceSnapshot,
      idle: r.refCount === 0,
    })),
  };
}

/**
 * 强制把 yText "content" 替换为给定 markdown，产生一个合法 Y update 并持久化。
 *
 * 使用场景（EditorPane RTE→MD 切换）：
 *   RTE 模式下笔记内容以 Tiptap JSON 存在 notes.content，**y room 里的 yDoc 与它完全脱钩**
 *   （RTE 的 debounce PUT 是普通 REST，不经过 y 房间）。切到 MD 时只改 notes.content 不够，
 *   因为客户端一旦订阅 y:join，拿到的是服务端内存里那份仍然残留着"上次 MD 会话"旧内容
 *   的 yDoc；即便 idleTimer 销毁了 room，重启后 loadDocFromDb 也会 applyUpdate 历史 update
 *   还原成旧 yText（注意此时 appliedAny=true 不会走 seed 分支）。
 *
 *   所以必须在服务端"代写"一次：把 yText 清空并重新插入规范化后的 markdown。
 *   产生的 update 走常规持久化通道（note_yupdates + 阈值 snapshot），并由调用方广播给
 *   正在订阅此 room 的其他客户端（比如同一用户的其他 tab / 其他协作者）。
 *
 * 实现注意：
 *   - 只有当现有 yText 内容与目标 markdown 不同时才执行修改，避免产生无意义的 update。
 *   - 使用 doc.transact 把 delete + insert 合并为一个原子 update（客户端应用时是一次性替换，
 *     不会出现中间空状态的抖动）。
 *   - 返回 update 的 base64 以便 realtime 层广播；若没有产生 update 返回 null。
 *
 * @returns { update: base64, version }  实际产生了 update 时返回；no-op 时返回 null。
 */
export function yReplaceContentAsUpdate(
  noteId: string,
  markdown: string,
  userId: string | null,
): { updateBase64: string } | null {
  // 手动管理 room：调用方其实没有"持有"一个 ws 连接，不能走 getOrCreateRoom + releaseRoom
  // 这对 refCount 的配对（++ / --）——releaseRoom 会把 refCount 减到负再被 Math.max 钳到 0，
  // 并顺便把原本有人在房间里的 room 误标成 idle，结果是活跃协作者还在但 room 启动了 idleTimer。
  //
  // 这里只借用 room 里的 doc 做一次 yText 替换，不应影响 refCount：
  //   - 若 room 已存在：保留其 refCount 和 idleTimer 语义。如果当前 refCount==0（idle 中），
  //     我们的写入结束后也让它继续 idle；idleTimer 就保持原状（不需要额外处理）。
  //   - 若 room 不存在：临时加载一次到内存，写完保留——因为 syncToYjs 紧接着会被
  //     发起切换的那个 tab 通过 y:join 订阅，等一下就会挂上 refCount；此时再进 idleTimer
  //     也没关系，下一步 y:join 进来会 clearTimeout 把它取消。
  //
  // 所以整体上：只要 getOrCreateRoom 不 ++，releaseRoom 不 --，语义就是干净的"偷看一眼 + 写一下"。
  let room = rooms.get(noteId);
  let createdHere = false;
  if (!room) {
    const doc = loadDocFromDb(noteId);
    room = {
      noteId,
      doc,
      refCount: 0,
      updatesSinceSnapshot: 0,
      idleTimer: null,
      persistTimer: null,
      lastActorUserId: null,
      lastVersionBumpAt: 0,
      lastPeriodicSnapshotAt: Date.now(),
    };
    rooms.set(noteId, room);
    createdHere = true;
  }

  let produced: Uint8Array | null = null;
  try {
    const ytext = room.doc.getText("content");
    const current = ytext.toString();
    if (current === markdown) {
      return null;
    }

    // 捕获产生的增量 update：在 transact 前抓 stateVector，transact 后 encode diff
    const preSv = Y.encodeStateVector(room.doc);
    room.doc.transact(() => {
      if (ytext.length > 0) ytext.delete(0, ytext.length);
      if (markdown && markdown.length > 0) ytext.insert(0, markdown);
    }, "server-replace");
    produced = Y.encodeStateAsUpdate(room.doc, preSv);

    // 持久化到 note_yupdates，并记一次 snapshot 阈值计数
    try {
      persistUpdate(noteId, produced, userId);
    } catch (e) {
      console.warn(`[yjs] persistUpdate (replace) failed for ${noteId}:`, e);
    }
    room.updatesSinceSnapshot++;
    if (userId) room.lastActorUserId = userId;

    // 到达阈值顺手合并一次 snapshot，行为与 yApplyUpdate 对齐
    if (room.updatesSinceSnapshot >= SNAPSHOT_EVERY_N_UPDATES) {
      try {
        writeSnapshot(noteId, room.doc);
        room.updatesSinceSnapshot = 0;
        room.lastPeriodicSnapshotAt = Date.now();
        try { gcMergedUpdates(noteId); } catch {}
      } catch (e) {
        console.warn(`[yjs] writeSnapshot (after replace) failed for ${noteId}:`, e);
      }
    }

    return { updateBase64: bufferToBase64(produced) };
  } finally {
    // 本函数临时创建且无人订阅的 room：启动 idleTimer，保持与 releaseRoom(refCount→0) 一致的
    // 生命周期。已有 room 不做任何处理，避免影响其现有 refCount / idleTimer。
    if (createdHere && room.refCount === 0 && !room.idleTimer) {
      room.idleTimer = setTimeout(() => {
        if (room!.persistTimer) {
          clearTimeout(room!.persistTimer);
          room!.persistTimer = null;
          try { persistToNotesTable(room!); } catch {}
        }
        try { writeSnapshot(noteId, room!.doc); } catch {}
        room!.doc.destroy();
        rooms.delete(noteId);
      }, ROOM_IDLE_TIMEOUT_MS);
    }
  }
}

/**
 * 手动把 markdown 种子导入 Y.Doc（供测试/迁移脚本）。
 * 注意：只在 Y.Doc 为空时生效；如果已有内容会 no-op。
 */
export function ySeedIfEmpty(noteId: string, markdown: string) {
  const room = getOrCreateRoom(noteId);
  const ytext = room.doc.getText("content");
  if (ytext.length > 0) {
    releaseRoom(noteId);
    return;
  }
  ytext.insert(0, markdown || "");
  // 导入事务会产生一个 update，通过 observer 机制不会自动持久化这里，手动写一次 snapshot
  try { writeSnapshot(noteId, room.doc); } catch {}
  releaseRoom(noteId);
}

// ---------------------------------------------------------------------------
// 工具：Base64 <-> Uint8Array
// ---------------------------------------------------------------------------

function bufferToBase64(u8: Uint8Array): string {
  return Buffer.from(u8).toString("base64");
}

function base64ToUint8(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
