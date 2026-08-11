import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import type Database from "better-sqlite3";
import { syncNoteBlocks } from "./noteBlocks.js";

interface IndexedBlockRow {
  blockId: string;
  blockType: string;
  parentBlockId: string | null;
  blockOrder: number;
  plainText: string;
  contentHash: string;
  path: string;
  startOffset: number | null;
  endOffset: number | null;
}

interface PreviousRecord {
  blockId: string;
  version: number;
  payloadHash: string;
}

interface StoredBlockRecord {
  blockId: string;
  parentBlockId: string | null;
  blockType: string;
  blockOrder: number;
  path: string;
  payload: string;
  payloadHash: string;
}

interface StoredBlockDocument {
  contentFormat: string;
  snapshotContent: string;
  snapshotHash: string;
  materializedHash: string;
  rootOrderJson: string;
  status: string;
}

export interface RebuildBlockAuthorityOptions {
  noteVersion: number;
  operationId?: string;
  operationType?: string;
  operationJson?: unknown;
}

export interface BlockAuthorityDocumentState {
  status: "healthy" | "mismatch";
  blockVersion: number;
  structureVersion: number;
  snapshotHash: string;
}

export interface ExpectedBlockAuthorityVersions {
  expectedStructureVersion?: number;
  expectedBlockVersions?: Record<string, number>;
}

export interface BlockAuthorityHistoryItem {
  noteVersion: number;
  blockVersion: number;
  structureVersion: number;
  type: string;
  time: string;
  operationId: string | null;
  operation: unknown;
}

export interface BlockAuthorityHistoryPage {
  items: BlockAuthorityHistoryItem[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export class BlockAuthorityConflictError extends Error {
  constructor(
    readonly code: "BLOCK_VERSION_CONFLICT" | "STRUCTURE_VERSION_CONFLICT",
    readonly details: Record<string, unknown>,
  ) {
    super(code);
  }
}

export function hashBlockAuthorityContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * 已完成建表的连接。
 *
 * 这些 DDL 全是 IF NOT EXISTS，重复执行逻辑上无害，但并非免费：内存库约
 * 0.02ms，而真实部署的文件库（Docker volume / NAS）实测约 5ms —— 每次
 * GET /api/notes/:id 都会白付一次。用 WeakSet 按连接记忆，连接被回收时自动
 * 释放；换新连接（重连、测试重建库）会重新建表，不影响正确性。
 */
const schemaReadyConnections = new WeakSet<Database.Database>();

export function ensureBlockAuthorityTables(db: Database.Database): void {
  if (schemaReadyConnections.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_block_documents (
      noteId TEXT PRIMARY KEY,
      contentFormat TEXT NOT NULL,
      noteVersion INTEGER NOT NULL DEFAULT 1,
      blockVersion INTEGER NOT NULL DEFAULT 1,
      structureVersion INTEGER NOT NULL DEFAULT 1,
      snapshotHash TEXT NOT NULL,
      materializedHash TEXT NOT NULL,
      snapshotContent TEXT NOT NULL,
      rootOrderJson TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'healthy',
      mismatchReason TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS note_block_records (
      noteId TEXT NOT NULL,
      blockId TEXT NOT NULL,
      parentBlockId TEXT,
      blockType TEXT NOT NULL,
      blockOrder INTEGER NOT NULL,
      path TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      payload TEXT NOT NULL,
      payloadHash TEXT NOT NULL,
      plainText TEXT NOT NULL DEFAULT '',
      contentHash TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (noteId, blockId),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_note_block_records_order ON note_block_records(noteId, blockOrder);
    CREATE INDEX IF NOT EXISTS idx_note_block_records_parent ON note_block_records(noteId, parentBlockId);
    CREATE TABLE IF NOT EXISTS note_block_operations (
      id TEXT PRIMARY KEY,
      noteId TEXT NOT NULL,
      operationId TEXT,
      operationType TEXT NOT NULL,
      noteVersion INTEGER NOT NULL,
      blockVersion INTEGER NOT NULL,
      structureVersion INTEGER NOT NULL,
      operationJson TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_note_block_operations_note ON note_block_operations(noteId, createdAt DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_note_block_operations_idempotency
      ON note_block_operations(noteId, operationId) WHERE operationId IS NOT NULL;
    CREATE TABLE IF NOT EXISTS note_block_attachment_refs (
      noteId TEXT NOT NULL,
      blockId TEXT NOT NULL,
      attachmentId TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (noteId, blockId, attachmentId),
      FOREIGN KEY (noteId, blockId) REFERENCES note_block_records(noteId, blockId) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_note_block_attachment_refs_attachment
      ON note_block_attachment_refs(attachmentId, noteId);
    CREATE TRIGGER IF NOT EXISTS trg_note_block_authority_stale_after_content_update
    AFTER UPDATE OF content ON notes
    WHEN OLD.content IS NOT NEW.content
    BEGIN
      UPDATE note_block_documents
      SET status = 'mismatch',
          mismatchReason = 'notes_content_changed_without_shadow_rebuild',
          updatedAt = datetime('now')
      WHERE noteId = NEW.id;
    END;
  `);
  schemaReadyConnections.add(db);
}

function readIndexedBlocks(db: Database.Database, noteId: string): IndexedBlockRow[] {
  return db.prepare(`
    SELECT blockId, blockType, parentBlockId, blockOrder, plainText, contentHash,
           path, startOffset, endOffset
    FROM note_blocks_index WHERE noteId = ? ORDER BY blockOrder
  `).all(noteId) as IndexedBlockRow[];
}

/**
 * 在已解析的文档对象上按 path 定位节点。
 *
 * 只接受解析后的对象（而非 content 字符串），因为调用方都需要在遍历多条记录时
 * 复用同一份解析结果 —— 每条记录各自 JSON.parse 整篇文档会退化成 O(n²)。
 */
function tiptapNodeAtPathInDoc(doc: unknown, path: string): unknown {
  let nodes = Array.isArray((doc as any)?.content) ? (doc as any).content : [];
  let node: unknown = null;
  for (const part of path.split(".")) {
    const index = Number(part);
    if (!Number.isInteger(index) || !Array.isArray(nodes) || index < 0 || index >= nodes.length) return null;
    node = nodes[index];
    nodes = Array.isArray((node as any)?.content) ? (node as any).content : [];
  }
  return node;
}

/** 从已解析的文档对象中取出指定 Block 的 payload。 */
function tiptapBlockPayloadFromDoc(doc: unknown, row: IndexedBlockRow): string {
  const node = tiptapNodeAtPathInDoc(doc, row.path);
  if (!node) throw new Error(`无法从 path ${row.path} 读取 Block ${row.blockId}`);
  return JSON.stringify(node);
}

const AUTHORITY_ROOT_PREFIX = "__authority_root__";

function compareBlockPaths(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    if (leftParts[index] === undefined) return -1;
    if (rightParts[index] === undefined) return 1;
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

/**
 * note_blocks_index 只索引可寻址业务 Block，bulletList 等结构包装节点没有 Block ID。
 * 权威存储必须保留这些包装节点，因此只在 shadow 内补合成根记录；客户端版本协议仍只使用真实 Block ID。
 */
function buildAuthorityRows(content: string, contentFormat: string, indexedRows: IndexedBlockRow[]): IndexedBlockRow[] {
  if (contentFormat !== "tiptap-json") return indexedRows;
  const doc = JSON.parse(content || "{}");
  if (doc?.type !== "doc" || !Array.isArray(doc.content)) throw new Error("Tiptap 权威源不是合法 doc");
  const rows = indexedRows.map((row) => ({ ...row }));
  for (let index = 0; index < doc.content.length; index += 1) {
    const rootPath = String(index);
    if (rows.some((row) => row.path === rootPath)) continue;
    const descendant = rows
      .filter((row) => row.path.startsWith(`${rootPath}.`))
      .sort((left, right) => compareBlockPaths(left.path, right.path))[0];
    const identity = descendant?.blockId
      || `${index}_${hashBlockAuthorityContent(JSON.stringify({
        type: doc.content[index]?.type,
        attrs: doc.content[index]?.attrs ?? null,
      })).slice(0, 12)}`;
    rows.push({
      blockId: `${AUTHORITY_ROOT_PREFIX}${identity}`,
      blockType: String(doc.content[index]?.type || "unknown"),
      parentBlockId: null,
      blockOrder: 0,
      plainText: "",
      contentHash: hashBlockAuthorityContent(JSON.stringify(doc.content[index])),
      path: rootPath,
      startOffset: null,
      endOffset: null,
    });
  }

  rows.sort((left, right) => compareBlockPaths(left.path, right.path));
  const byPath = new Map(rows.map((row) => [row.path, row]));
  return rows.map((row, blockOrder) => {
    const parts = row.path.split(".");
    let parentBlockId: string | null = null;
    for (let length = parts.length - 1; length > 0; length -= 1) {
      const parent = byPath.get(parts.slice(0, length).join("."));
      if (parent) {
        parentBlockId = parent.blockId;
        break;
      }
    }
    return { ...row, parentBlockId, blockOrder };
  });
}

function markdownBlockPayload(
  content: string,
  row: IndexedBlockRow,
  index: number,
  rows: IndexedBlockRow[],
): string {
  if (row.startOffset == null || row.endOffset == null || row.startOffset < 0 || row.endOffset < row.startOffset) {
    throw new Error(`Markdown Block ${row.blockId} 缺少合法范围`);
  }
  const nextStart = rows[index + 1]?.startOffset ?? content.length;
  if (nextStart == null || row.endOffset > nextStart || nextStart > content.length) {
    throw new Error(`Markdown Block ${row.blockId} 的范围顺序不合法`);
  }
  const start = index === 0 ? 0 : row.startOffset;
  return content.slice(start, nextStart);
}

function buildIndexedPayloads(
  content: string,
  contentFormat: string,
  rows: IndexedBlockRow[],
): Array<{ row: IndexedBlockRow; payload: string; payloadHash: string }> {
  if (contentFormat === "markdown" && rows.length === 0 && content.length > 0) {
    throw new Error("非空 Markdown 缺少可物化的 Block 记录");
  }
  // tiptap 场景整篇只解析一次后复用：tiptapBlockPayload 内部会 JSON.parse 全文，
  // 逐行调用会退化成 O(n²)（5000 段/776KB 实测 rebuild 21.6s）。
  const parsedDoc = contentFormat === "tiptap-json" ? JSON.parse(content || "{}") : null;
  return rows.map((row, index) => {
    const payload = contentFormat === "tiptap-json"
      ? tiptapBlockPayloadFromDoc(parsedDoc, row)
      : markdownBlockPayload(content, row, index, rows);
    return { row, payload, payloadHash: hashBlockAuthorityContent(payload) };
  });
}

function structureSignature(rows: IndexedBlockRow[]): string {
  return hashBlockAuthorityContent(JSON.stringify(rows.map((row) => ({
    blockId: row.blockId,
    parentBlockId: row.parentBlockId,
    blockOrder: row.blockOrder,
    path: row.path,
  }))));
}

function readPreviousStructureSignature(db: Database.Database, noteId: string): string | null {
  const rows = db.prepare(`
    SELECT blockId, parentBlockId, blockOrder, path
    FROM note_block_records WHERE noteId = ? ORDER BY blockOrder
  `).all(noteId) as Array<{ blockId: string; parentBlockId: string | null; blockOrder: number; path: string }>;
  if (rows.length === 0) return null;
  return hashBlockAuthorityContent(JSON.stringify(rows));
}

function attachmentIdsFromPayload(payload: string): string[] {
  const ids = new Set<string>();
  for (const match of payload.matchAll(/\/api\/attachments\/([A-Za-z0-9_-]{6,128})/g)) ids.add(match[1]);
  for (const match of payload.matchAll(/"attachmentId"\s*:\s*"([A-Za-z0-9_-]{6,128})"/g)) ids.add(match[1]);
  return [...ids];
}

function readStoredBlockRecords(db: Database.Database, noteId: string): StoredBlockRecord[] {
  return db.prepare(`
    SELECT blockId, parentBlockId, blockType, blockOrder, path, payload, payloadHash
    FROM note_block_records WHERE noteId = ? ORDER BY blockOrder
  `).all(noteId) as StoredBlockRecord[];
}

function parseRootOrder(rootOrderJson: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(rootOrderJson);
  } catch {
    throw new Error("rootOrderJson 不是合法 JSON");
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("rootOrderJson 必须是 Block ID 数组");
  }
  const rootOrder = value as string[];
  if (new Set(rootOrder).size !== rootOrder.length) throw new Error("rootOrderJson 包含重复 Block");
  return rootOrder;
}

function validateRecordGraph(records: StoredBlockRecord[], rootOrder: string[]): Map<string, StoredBlockRecord> {
  const byId = new Map<string, StoredBlockRecord>();
  const blockOrders = new Set<number>();
  const paths = new Set<string>();
  for (const record of records) {
    if (byId.has(record.blockId)) throw new Error(`Block ${record.blockId} 重复`);
    if (blockOrders.has(record.blockOrder)) throw new Error(`Block 顺序 ${record.blockOrder} 重复`);
    if (paths.has(record.path)) throw new Error(`Block path ${record.path} 重复`);
    if (hashBlockAuthorityContent(record.payload) !== record.payloadHash) {
      throw new Error(`Block ${record.blockId} 的 payloadHash 不匹配`);
    }
    byId.set(record.blockId, record);
    blockOrders.add(record.blockOrder);
    paths.add(record.path);
  }

  const roots = records.filter((record) => record.parentBlockId == null).sort((a, b) => a.blockOrder - b.blockOrder);
  if (roots.length !== rootOrder.length || roots.some((record, index) => record.blockId !== rootOrder[index])) {
    throw new Error("rootOrderJson 与顶层 Block 记录不一致");
  }

  for (const record of records) {
    if (record.parentBlockId != null && !byId.has(record.parentBlockId)) {
      throw new Error(`Block ${record.blockId} 引用了缺失父级 ${record.parentBlockId}`);
    }
    const visited = new Set<string>();
    let current: StoredBlockRecord | undefined = record;
    while (current?.parentBlockId != null) {
      if (visited.has(current.blockId)) throw new Error(`Block ${record.blockId} 的父级引用形成循环`);
      visited.add(current.blockId);
      current = byId.get(current.parentBlockId);
    }
  }
  return byId;
}

function expectedParentFromPath(
  record: StoredBlockRecord,
  recordsByPath: Map<string, StoredBlockRecord>,
): string | null {
  const parts = record.path.split(".");
  for (let length = parts.length - 1; length > 0; length--) {
    const parentPath = parts.slice(0, length).join(".");
    const parent = recordsByPath.get(parentPath);
    if (parent) return parent.blockId;
  }
  return null;
}

function materializeTiptapRecords(
  records: StoredBlockRecord[],
  rootOrder: string[],
  byId: Map<string, StoredBlockRecord>,
): string {
  const roots = rootOrder.map((blockId) => {
    const record = byId.get(blockId);
    if (!record) throw new Error(`缺少根 Block ${blockId}`);
    try {
      return JSON.parse(record.payload);
    } catch {
      throw new Error(`根 Block ${blockId} 的 payload 不是合法 JSON`);
    }
  });
  const content = JSON.stringify({ type: "doc", content: roots });
  const recordsByPath = new Map(records.map((record) => [record.path, record]));

  // 校验用的文档树只解析一次后复用。
  //   之前每条 record 都调用 tiptapNodeAtPath(content, ...)，而该函数内部会
  //   JSON.parse 整篇文档 —— 记录数 × 全文解析 = O(n²)。5000 段 / 776KB 的笔记
  //   实测单次物化 10.6s，且 GET /api/notes/:id 每次读取都会走到这里。
  //   这里改为复用 roots（已是解析后的对象），校验逻辑与语义保持完全一致。
  const materializedDoc = { type: "doc", content: roots };

  // 顶层 payload 负责组装文档；嵌套记录用于逐 Block 校验，不能成为未验证的旁路副本。
  for (const record of records) {
    const node = tiptapNodeAtPathInDoc(materializedDoc, record.path);
    if (!node || JSON.stringify(node) !== record.payload) {
      throw new Error(`Block ${record.blockId} 与物化文档的 path 不一致`);
    }
    if (
      !record.blockId.startsWith(AUTHORITY_ROOT_PREFIX)
      && (node as any)?.attrs?.blockId !== record.blockId
    ) {
      throw new Error(`Block ${record.blockId} 与 payload 中的 Block ID 不一致`);
    }
    if (expectedParentFromPath(record, recordsByPath) !== record.parentBlockId) {
      throw new Error(`Block ${record.blockId} 的父级引用与 path 不一致`);
    }
  }
  return content;
}

function materializeStoredRecords(
  contentFormat: string,
  rootOrderJson: string,
  records: StoredBlockRecord[],
): string {
  if (contentFormat !== "tiptap-json" && contentFormat !== "markdown") {
    throw new Error(`不支持物化 contentFormat=${contentFormat}`);
  }
  const rootOrder = parseRootOrder(rootOrderJson);
  const byId = validateRecordGraph(records, rootOrder);
  if (contentFormat === "markdown") {
    if (records.some((record) => record.parentBlockId != null)) {
      throw new Error("Markdown Block 记录不允许父级引用");
    }
    return rootOrder.map((blockId) => byId.get(blockId)?.payload ?? "").join("");
  }
  return materializeTiptapRecords(records, rootOrder, byId);
}

export function materializeBlockAuthorityContent(db: Database.Database, noteId: string): string {
  ensureBlockAuthorityTables(db);
  const document = db.prepare(`
    SELECT contentFormat, rootOrderJson FROM note_block_documents WHERE noteId = ?
  `).get(noteId) as Pick<StoredBlockDocument, "contentFormat" | "rootOrderJson"> | undefined;
  if (!document) throw new Error(`笔记 ${noteId} 缺少 Block 权威文档`);
  return materializeStoredRecords(document.contentFormat, document.rootOrderJson, readStoredBlockRecords(db, noteId));
}

export function rebuildBlockAuthorityStore(
  db: Database.Database,
  noteId: string,
  content: string,
  contentFormat: string,
  options: RebuildBlockAuthorityOptions,
): BlockAuthorityDocumentState {
  ensureBlockAuthorityTables(db);
  const rows = buildAuthorityRows(content, contentFormat, readIndexedBlocks(db, noteId));
  const previousDocument = db.prepare(`
    SELECT blockVersion, structureVersion FROM note_block_documents WHERE noteId = ?
  `).get(noteId) as { blockVersion: number; structureVersion: number } | undefined;
  const previousRecords = new Map((db.prepare(`
    SELECT blockId, version, payloadHash FROM note_block_records WHERE noteId = ?
  `).all(noteId) as PreviousRecord[]).map((row) => [row.blockId, row]));
  const previousStructure = readPreviousStructureSignature(db, noteId);
  const nextStructure = structureSignature(rows);
  const materialized = buildIndexedPayloads(content, contentFormat, rows);
  const removed = [...previousRecords.keys()].some((blockId) => !rows.some((row) => row.blockId === blockId));
  const blockChanged = removed || materialized.some(({ row, payloadHash }) => previousRecords.get(row.blockId)?.payloadHash !== payloadHash);
  const structureChanged = previousStructure == null || previousStructure !== nextStructure;
  const blockVersion = previousDocument ? previousDocument.blockVersion + (blockChanged ? 1 : 0) : 1;
  const structureVersion = previousDocument ? previousDocument.structureVersion + (structureChanged ? 1 : 0) : 1;
  const snapshotHash = hashBlockAuthorityContent(content);
  const rootOrderJson = JSON.stringify(rows
    .filter((row) => row.path.split(".").length === 1)
    .map((row) => row.blockId));

  const write = db.transaction(() => {
    db.prepare("DELETE FROM note_block_attachment_refs WHERE noteId = ?").run(noteId);
    db.prepare("DELETE FROM note_block_records WHERE noteId = ?").run(noteId);
    const insertRecord = db.prepare(`
      INSERT INTO note_block_records (
        noteId, blockId, parentBlockId, blockType, blockOrder, path, version,
        payload, payloadHash, plainText, contentHash, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);
    const insertRef = db.prepare(`
      INSERT OR IGNORE INTO note_block_attachment_refs (noteId, blockId, attachmentId)
      VALUES (?, ?, ?)
    `);
    for (const { row, payload, payloadHash } of materialized) {
      const previous = previousRecords.get(row.blockId);
      const version = previous ? previous.version + (previous.payloadHash === payloadHash ? 0 : 1) : 1;
      insertRecord.run(
        noteId, row.blockId, row.parentBlockId, row.blockType, row.blockOrder, row.path,
        version, payload, payloadHash, row.plainText, row.contentHash,
      );
      for (const attachmentId of attachmentIdsFromPayload(payload)) insertRef.run(noteId, row.blockId, attachmentId);
    }
    const materializedContent = materializeStoredRecords(
      contentFormat,
      rootOrderJson,
      readStoredBlockRecords(db, noteId),
    );
    const materializedHash = hashBlockAuthorityContent(materializedContent);
    if (materializedHash !== snapshotHash) {
      throw new Error("Block 记录物化内容与 notes.content 不一致");
    }
    db.prepare(`
      INSERT INTO note_block_documents (
        noteId, contentFormat, noteVersion, blockVersion, structureVersion,
        snapshotHash, materializedHash, snapshotContent, rootOrderJson,
        status, mismatchReason, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'healthy', NULL, datetime('now'), datetime('now'))
      ON CONFLICT(noteId) DO UPDATE SET
        contentFormat = excluded.contentFormat,
        noteVersion = excluded.noteVersion,
        blockVersion = excluded.blockVersion,
        structureVersion = excluded.structureVersion,
        snapshotHash = excluded.snapshotHash,
        materializedHash = excluded.materializedHash,
        snapshotContent = excluded.snapshotContent,
        rootOrderJson = excluded.rootOrderJson,
        status = 'healthy', mismatchReason = NULL, updatedAt = datetime('now')
    `).run(
      noteId, contentFormat, options.noteVersion, blockVersion, structureVersion,
      snapshotHash, materializedHash, content, rootOrderJson,
    );
    if (options.operationType !== undefined || options.operationId || options.operationJson !== undefined) {
      db.prepare(`
        INSERT OR IGNORE INTO note_block_operations (
          id, noteId, operationId, operationType, noteVersion,
          blockVersion, structureVersion, operationJson
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuid(), noteId, options.operationId || null, options.operationType || "snapshot",
        options.noteVersion, blockVersion, structureVersion, JSON.stringify(options.operationJson ?? {}),
      );
    }
  });
  write();
  return { status: "healthy", blockVersion, structureVersion, snapshotHash };
}

/** 按新到旧读取 Block 写入历史；任一损坏 JSON 都拒绝返回部分历史。 */
export function readBlockAuthorityHistory(
  db: Database.Database,
  noteId: string,
  options: { limit?: number; offset?: number } = {},
): BlockAuthorityHistoryPage {
  ensureBlockAuthorityTables(db);
  const requestedLimit = Number.isFinite(options.limit) ? Math.trunc(options.limit as number) : 20;
  const requestedOffset = Number.isFinite(options.offset) ? Math.trunc(options.offset as number) : 0;
  const limit = Math.max(1, Math.min(100, requestedLimit));
  const offset = Math.max(0, requestedOffset);
  const rows = db.prepare(`
    SELECT operationId, operationType, noteVersion, blockVersion, structureVersion,
           operationJson, createdAt
    FROM note_block_operations
    WHERE noteId = ?
    ORDER BY createdAt DESC, rowid DESC
    LIMIT ? OFFSET ?
  `).all(noteId, limit + 1, offset) as Array<{
    operationId: string | null;
    operationType: string;
    noteVersion: number;
    blockVersion: number;
    structureVersion: number;
    operationJson: string;
    createdAt: string;
  }>;
  const items = rows.slice(0, limit).map((row) => {
    let operation: unknown;
    try {
      operation = JSON.parse(row.operationJson);
    } catch {
      throw new Error(`operationJson 不是合法 JSON: ${row.operationId || "anonymous"}`);
    }
    return {
      noteVersion: row.noteVersion,
      blockVersion: row.blockVersion,
      structureVersion: row.structureVersion,
      type: row.operationType,
      time: row.createdAt,
      operationId: row.operationId,
      operation,
    };
  });
  return { items, limit, offset, hasMore: rows.length > limit };
}

/**
 * healthy 判定结果缓存（按连接隔离）。
 *
 * 物化 + 3 次全文哈希只为回答"这份 Block 权威数据是否仍然健康"。同一笔记在
 * 内容未变时反复读取（A→B→A、乐观锁重试、多端轮询）会重复得出同一结论，
 * 而 1MB 文档的一次判定实测约 30ms。
 *
 * 缓存键覆盖全部影响判定的输入：
 *   - snapshotHash / materializedHash / status 来自 note_block_documents，
 *     任何重建都会更新它们；
 *   - note_block_records 的改动必然经由 rebuildBlockAuthorityStore，从而刷新
 *     上面两个 hash，因此无需单独纳入；
 *   - notesContent 的哈希参与 notesHash !== snapshotHash 判定，必须纳入。
 * 键不同即重新校验，所以不会返回过期结论。只缓存 healthy —— 劣化状态需要
 * 落库并保留现场，不能走缓存。
 *
 * 已知边界：绕过所有写路径直接 UPDATE note_block_records 且不刷新任何 hash，
 * 缓存命中期内无法发现（换连接或键变化后仍会被立刻检出）。正常写入都经由
 * rebuildBlockAuthorityStore，因此不影响真实场景。
 */
const healthyVerdictCache = new WeakMap<Database.Database, Map<string, string>>();
const MAX_HEALTHY_VERDICT_ENTRIES = 256;

function healthyVerdictKey(row: StoredBlockDocument, notesContentHash: string): string {
  return [row.status, row.snapshotHash, row.materializedHash, notesContentHash].join("|");
}

function readCachedHealthyVerdict(
  db: Database.Database,
  noteId: string,
  key: string,
): boolean {
  return healthyVerdictCache.get(db)?.get(noteId) === key;
}

function rememberHealthyVerdict(db: Database.Database, noteId: string, key: string): void {
  let perConnection = healthyVerdictCache.get(db);
  if (!perConnection) {
    perConnection = new Map();
    healthyVerdictCache.set(db, perConnection);
  }
  perConnection.delete(noteId);
  perConnection.set(noteId, key);
  while (perConnection.size > MAX_HEALTHY_VERDICT_ENTRIES) {
    const oldest = perConnection.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    perConnection.delete(oldest);
  }
}

export function readAuthoritativeNoteContent(
  db: Database.Database,
  noteId: string,
  notesContent: string,
): { content: string; source: "blocks" | "notes"; status: "healthy" | "missing" | "mismatch" } {
  ensureBlockAuthorityTables(db);
  const row = db.prepare(`
    SELECT contentFormat, snapshotContent, snapshotHash, materializedHash, rootOrderJson, status
    FROM note_block_documents WHERE noteId = ?
  `).get(noteId) as StoredBlockDocument | undefined;
  if (!row) return { content: notesContent, source: "notes", status: "missing" };

  // 已知处于 mismatch 的文档无需再次物化校验。
  //   物化 + 3 次全文哈希只用于"从 healthy 判定是否劣化"，对已经 mismatch 的
  //   文档得不出新结论：本函数不会自愈（mismatch 必须保留现场），所以每次读取
  //   重跑一遍纯属浪费，而且会把触发器写入的具体原因覆盖成通用的
  //   authority_hash_mismatch，反而丢掉诊断信息。
  //   直接返回 notes.content —— 与下方 mismatch 分支的返回值完全一致。
  if (row.status === "mismatch") {
    return { content: notesContent, source: "notes", status: "mismatch" };
  }

  const notesHash = hashBlockAuthorityContent(notesContent);
  const verdictKey = healthyVerdictKey(row, notesHash);

  // 命中缓存说明这套输入上次已判定 healthy，可跳过物化与另外两次全文哈希。
  //   返回 notesContent 是等价的：healthy 要求 notesHash === row.snapshotHash
  //   且 liveMaterializedHash === row.materializedHash === row.snapshotHash，
  //   即物化结果与 notesContent 的哈希相同 —— 同一份内容。
  if (readCachedHealthyVerdict(db, noteId, verdictKey)) {
    return { content: notesContent, source: "blocks", status: "healthy" };
  }

  let materializedContent: string;
  let mismatchReason: string | null = null;
  try {
    materializedContent = materializeStoredRecords(
      row.contentFormat,
      row.rootOrderJson,
      readStoredBlockRecords(db, noteId),
    );
  } catch (error) {
    materializedContent = "";
    mismatchReason = `record_materialization_failed:${error instanceof Error ? error.message : String(error)}`;
  }
  const snapshotContentHash = hashBlockAuthorityContent(row.snapshotContent);
  const liveMaterializedHash = hashBlockAuthorityContent(materializedContent);
  if (
    row.status !== "healthy"
    || mismatchReason != null
    || snapshotContentHash !== row.snapshotHash
    || liveMaterializedHash !== row.materializedHash
    || row.materializedHash !== row.snapshotHash
    || notesHash !== row.snapshotHash
  ) {
    db.prepare(`
      UPDATE note_block_documents
      SET status = 'mismatch', mismatchReason = ?, updatedAt = datetime('now')
      WHERE noteId = ?
    `).run((mismatchReason || "authority_hash_mismatch").slice(0, 512), noteId);
    healthyVerdictCache.get(db)?.delete(noteId);
    return { content: notesContent, source: "notes", status: "mismatch" };
  }
  rememberHealthyVerdict(db, noteId, verdictKey);
  return { content: materializedContent, source: "blocks", status: "healthy" };
}

export function assertBlockAuthorityVersions(
  db: Database.Database,
  noteId: string,
  expected: ExpectedBlockAuthorityVersions,
): BlockAuthorityDocumentState | null {
  ensureBlockAuthorityTables(db);
  const document = db.prepare(`
    SELECT status, blockVersion, structureVersion, snapshotHash
    FROM note_block_documents WHERE noteId = ?
  `).get(noteId) as BlockAuthorityDocumentState | undefined;
  if (!document || document.status !== "healthy") return null;
  if (
    expected.expectedStructureVersion !== undefined
    && expected.expectedStructureVersion !== document.structureVersion
  ) {
    throw new BlockAuthorityConflictError("STRUCTURE_VERSION_CONFLICT", {
      currentStructureVersion: document.structureVersion,
    });
  }
  const entries = Object.entries(expected.expectedBlockVersions || {});
  if (entries.length > 0) {
    const readVersion = db.prepare(`
      SELECT version FROM note_block_records WHERE noteId = ? AND blockId = ?
    `);
    const conflicts = entries.flatMap(([blockId, expectedVersion]) => {
      const row = readVersion.get(noteId, blockId) as { version: number } | undefined;
      return row?.version === expectedVersion
        ? []
        : [{ blockId, expectedVersion, currentVersion: row?.version ?? null }];
    });
    if (conflicts.length > 0) {
      throw new BlockAuthorityConflictError("BLOCK_VERSION_CONFLICT", { conflicts });
    }
  }
  return document;
}

export function backfillBlockAuthorityStore(
  db: Database.Database,
  options: { limit?: number; afterId?: string } = {},
): { scanned: number; rebuilt: number; failed: Array<{ noteId: string; error: string }>; nextCursor: string | null } {
  ensureBlockAuthorityTables(db);
  const limit = Math.max(1, Math.min(1000, options.limit ?? 100));
  const rows = db.prepare(`
    SELECT id, content, contentFormat, version
    FROM notes
    WHERE id > ? AND contentFormat IN ('tiptap-json', 'markdown')
    ORDER BY id LIMIT ?
  `).all(options.afterId || "", limit) as Array<{
    id: string;
    content: string;
    contentFormat: string;
    version: number;
  }>;
  const failed: Array<{ noteId: string; error: string }> = [];
  let rebuilt = 0;
  for (const row of rows) {
    try {
      db.transaction(() => {
        const synced = syncNoteBlocks(db, row.id, row.content, row.contentFormat);
        if (synced.content !== row.content) {
          db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
            .run(synced.content, synced.contentText, row.id);
        }
        rebuildBlockAuthorityStore(db, row.id, synced.content, row.contentFormat, {
          noteVersion: row.version,
          operationType: "backfill",
        });
      })();
      rebuilt += 1;
    } catch (error) {
      markBlockAuthorityMismatch(db, row.id, `backfill:${error instanceof Error ? error.message : String(error)}`);
      failed.push({ noteId: row.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    scanned: rows.length,
    rebuilt,
    failed,
    nextCursor: rows.length === limit ? rows[rows.length - 1]?.id || null : null,
  };
}

export function markBlockAuthorityMismatch(db: Database.Database, noteId: string, reason: string): void {
  ensureBlockAuthorityTables(db);
  db.prepare(`
    UPDATE note_block_documents SET status = 'mismatch', mismatchReason = ?, updatedAt = datetime('now')
    WHERE noteId = ?
  `).run(reason.slice(0, 512), noteId);
}
