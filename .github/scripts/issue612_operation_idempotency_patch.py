from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    Path(path).write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    write(path, text.replace(old, new, 1))


write(
    "backend/src/db/yjsOperationReceiptsMigration.ts",
    '''import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";

export function ensureYjsOperationReceiptsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS yjs_operation_receipts (
      noteId TEXT NOT NULL,
      operationId TEXT NOT NULL,
      updateId INTEGER NOT NULL,
      userId TEXT,
      updateHash TEXT NOT NULL,
      persistedAt TEXT NOT NULL,
      PRIMARY KEY (noteId, operationId),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_yjs_operation_receipts_persisted
      ON yjs_operation_receipts(persistedAt);
  `);
}

export const yjsOperationReceiptsMigration: Migration = {
  version: 71,
  name: "yjs-operation-receipts",
  up: ensureYjsOperationReceiptsSchema,
};
''',
)

replace_once(
    "backend/src/db/migrations.ts",
    'import { taskDayPlansMigration } from "./taskDayPlansMigration.js";\n',
    'import { taskDayPlansMigration } from "./taskDayPlansMigration.js";\nimport { yjsOperationReceiptsMigration } from "./yjsOperationReceiptsMigration.js";\n',
)
replace_once(
    "backend/src/db/migrations.ts",
    '''  blockSchemaRepairMigration,
  taskDayPlansMigration,
].sort((a, b) => a.version - b.version);
''',
    '''  blockSchemaRepairMigration,
  taskDayPlansMigration,
  yjsOperationReceiptsMigration,
].sort((a, b) => a.version - b.version);
''',
)

replace_once(
    "backend/src/db/schema.ts",
    '''    CREATE TABLE IF NOT EXISTS note_yupdates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      noteId TEXT NOT NULL,
      userId TEXT,
      update_blob BLOB NOT NULL,
      clock INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );

    -- Y 文档快照（每 N 条 update 或定时生成一次；合并后可清理旧 updates）
''',
    '''    CREATE TABLE IF NOT EXISTS note_yupdates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      noteId TEXT NOT NULL,
      userId TEXT,
      update_blob BLOB NOT NULL,
      clock INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );

    -- 客户端持久化操作回执。与 note_yupdates 分表，避免 update GC 后失去重试幂等性。
    CREATE TABLE IF NOT EXISTS yjs_operation_receipts (
      noteId TEXT NOT NULL,
      operationId TEXT NOT NULL,
      updateId INTEGER NOT NULL,
      userId TEXT,
      updateHash TEXT NOT NULL,
      persistedAt TEXT NOT NULL,
      PRIMARY KEY (noteId, operationId),
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_yjs_operation_receipts_persisted
      ON yjs_operation_receipts(persistedAt);

    -- Y 文档快照（每 N 条 update 或定时生成一次；合并后可清理旧 updates）
''',
)

replace_once(
    "backend/src/db/postgres/schema.base.sql",
    '''CREATE INDEX IF NOT EXISTS idx_note_yupdates_note ON note_yupdates("noteId", id);

-- ============================================================
-- Embeddings
''',
    '''CREATE INDEX IF NOT EXISTS idx_note_yupdates_note ON note_yupdates("noteId", id);

CREATE TABLE IF NOT EXISTS yjs_operation_receipts (
    "noteId" TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    "operationId" TEXT NOT NULL,
    "updateId" BIGINT NOT NULL,
    "userId" TEXT,
    "updateHash" TEXT NOT NULL,
    "persistedAt" TIMESTAMPTZ NOT NULL,
    PRIMARY KEY ("noteId", "operationId")
);

CREATE INDEX IF NOT EXISTS idx_yjs_operation_receipts_persisted
    ON yjs_operation_receipts("persistedAt");

-- ============================================================
-- Embeddings
''',
)

write(
    "backend/src/repositories/noteYupdatesRepository.ts",
    '''/**
 * Note Y-updates Repository
 *
 * 职责：
 * - 封装 note_yupdates 与 yjs_operation_receipts 的数据库操作
 * - 提供类型安全的接口
 * - 保持现有 SQLite 行为不变
 */

import { createHash } from "node:crypto";
import { getDb } from "../db/schema";
import { SqliteAdapter } from "../db/adapters";

export interface YjsOperationReceipt {
  noteId: string;
  operationId: string;
  updateId: number;
  userId: string | null;
  updateHash: string;
  persistedAt: string;
}

function getAdapter() {
  return new SqliteAdapter(getDb());
}

function hashUpdate(update: Buffer): string {
  return createHash("sha256").update(update).digest("hex");
}

export const noteYupdatesRepository = {
  /** 获取笔记的 Y.js updates（指定 ID 之后的）。 */
  listAfterId(noteId: string, afterId: number): Array<{ id: number; update_blob: Buffer }> {
    const db = getDb();
    return db
      .prepare("SELECT id, update_blob FROM note_yupdates WHERE noteId = ? AND id > ? ORDER BY id ASC")
      .all(noteId, afterId) as Array<{ id: number; update_blob: Buffer }>;
  },

  /** 创建不带 ACK operationId 的旧协议 Y.js update。 */
  create(noteId: string, userId: string, update: Buffer): number {
    const db = getDb();
    const info = db
      .prepare("INSERT INTO note_yupdates (noteId, userId, update_blob, clock) VALUES (?, ?, ?, ?)")
      .run(noteId, userId, update, Date.now());
    return Number(info.lastInsertRowid);
  },

  /**
   * 原子写入 Y.js update 与 operation receipt。
   * receipt 唯一约束失败时整个事务回滚，禁止留下没有幂等回执的更新日志。
   */
  createWithOperation(
    noteId: string,
    userId: string,
    update: Buffer,
    operationId: string,
  ): number {
    const db = getDb();
    const persistedAt = new Date().toISOString();
    const updateHash = hashUpdate(update);
    const transaction = db.transaction(() => {
      const info = db
        .prepare("INSERT INTO note_yupdates (noteId, userId, update_blob, clock) VALUES (?, ?, ?, ?)")
        .run(noteId, userId, update, Date.now());
      const updateId = Number(info.lastInsertRowid);
      db.prepare(
        `INSERT INTO yjs_operation_receipts
           (noteId, operationId, updateId, userId, updateHash, persistedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(noteId, operationId, updateId, userId || null, updateHash, persistedAt);
      return updateId;
    });
    return transaction();
  },

  findOperationReceipt(noteId: string, operationId: string): YjsOperationReceipt | undefined {
    return getDb().prepare(
      `SELECT noteId, operationId, updateId, userId, updateHash, persistedAt
       FROM yjs_operation_receipts
       WHERE noteId = ? AND operationId = ?`,
    ).get(noteId, operationId) as YjsOperationReceipt | undefined;
  },

  deleteOperationReceiptsBefore(persistedBefore: string): number {
    const result = getDb()
      .prepare("DELETE FROM yjs_operation_receipts WHERE persistedAt < ?")
      .run(persistedBefore);
    return result.changes;
  },

  /** 获取笔记的最大 update ID。 */
  getMaxId(noteId: string): { maxId: number | null } | undefined {
    const db = getDb();
    return db
      .prepare("SELECT MAX(id) as maxId FROM note_yupdates WHERE noteId = ?")
      .get(noteId) as { maxId: number | null } | undefined;
  },

  /** 删除指定 ID 以下的 updates。回执按独立保留期清理，不跟随 update GC。 */
  deleteUpTo(noteId: string, maxId: number): void {
    const db = getDb();
    db.prepare("DELETE FROM note_yupdates WHERE noteId = ? AND id <= ?").run(noteId, maxId);
  },

  /** 删除笔记的所有旧协议 Yjs 数据。 */
  deleteByNoteId(noteId: string): void {
    const db = getDb();
    db.transaction(() => {
      db.prepare("DELETE FROM note_yupdates WHERE noteId = ?").run(noteId);
      db.prepare("DELETE FROM yjs_operation_receipts WHERE noteId = ?").run(noteId);
    })();
  },

  /** 转移用户（用户迁移时使用）。返回值保持为更新的 update 行数。 */
  transferOwnership(fromUserId: string, toUserId: string): number {
    const db = getDb();
    return db.transaction(() => {
      const result = db.prepare("UPDATE note_yupdates SET userId = ? WHERE userId = ?").run(toUserId, fromUserId);
      db.prepare("UPDATE yjs_operation_receipts SET userId = ? WHERE userId = ?").run(toUserId, fromUserId);
      return result.changes;
    })();
  },

  async listAfterIdAsync(noteId: string, afterId: number): Promise<Array<{ id: number; update_blob: Buffer }>> {
    return getAdapter().queryMany<{ id: number; update_blob: Buffer }>(
      "SELECT id, update_blob FROM note_yupdates WHERE noteId = ? AND id > ? ORDER BY id ASC",
      [noteId, afterId],
    );
  },

  async createAsync(noteId: string, userId: string, update: Buffer): Promise<number> {
    const result = await getAdapter().execute(
      "INSERT INTO note_yupdates (noteId, userId, update_blob, clock) VALUES (?, ?, ?, ?)",
      [noteId, userId, update, Date.now()],
    );
    return Number(result.lastInsertRowid);
  },

  async getMaxIdAsync(noteId: string): Promise<{ maxId: number | null } | undefined> {
    return getAdapter().queryOne<{ maxId: number | null }>(
      "SELECT MAX(id) as maxId FROM note_yupdates WHERE noteId = ?",
      [noteId],
    );
  },

  async deleteUpToAsync(noteId: string, maxId: number): Promise<void> {
    await getAdapter().execute(
      "DELETE FROM note_yupdates WHERE noteId = ? AND id <= ?",
      [noteId, maxId],
    );
  },

  async deleteByNoteIdAsync(noteId: string): Promise<void> {
    await getAdapter().transaction(async (tx) => {
      await tx.execute("DELETE FROM note_yupdates WHERE noteId = ?", [noteId]);
      await tx.execute("DELETE FROM yjs_operation_receipts WHERE noteId = ?", [noteId]);
    });
  },

  async transferOwnershipAsync(fromUserId: string, toUserId: string): Promise<number> {
    return getAdapter().transaction(async (tx) => {
      const result = await tx.execute(
        "UPDATE note_yupdates SET userId = ? WHERE userId = ?",
        [toUserId, fromUserId],
      );
      await tx.execute(
        "UPDATE yjs_operation_receipts SET userId = ? WHERE userId = ?",
        [toUserId, fromUserId],
      );
      return result.changes;
    });
  },
};
''',
)

replace_once(
    "backend/src/services/yjs.ts",
    '''/** 追加持久化一条 update */
function persistUpdate(noteId: string, update: Uint8Array, userId: string | null): number {
  return noteYupdatesRepository.create(noteId, userId || "", Buffer.from(update));
}
''',
    '''/** 追加持久化一条 update；新协议同时原子写入 operation receipt。 */
function persistUpdate(
  noteId: string,
  update: Uint8Array,
  userId: string | null,
  operationId: string | null = null,
): number {
  const buffer = Buffer.from(update);
  if (operationId) {
    return noteYupdatesRepository.createWithOperation(noteId, userId || "", buffer, operationId);
  }
  return noteYupdatesRepository.create(noteId, userId || "", buffer);
}
''',
)
replace_once(
    "backend/src/services/yjs.ts",
    '''export function yApplyUpdate(
  noteId: string,
  updateBase64: string,
  userId: string | null,
): YApplyResult {
''',
    '''export function yApplyUpdate(
  noteId: string,
  updateBase64: string,
  userId: string | null,
  operationId: string | null = null,
): YApplyResult {
''',
)
replace_once(
    "backend/src/services/yjs.ts",
    '    persistUpdate(noteId, update, userId);\n',
    '    persistUpdate(noteId, update, userId, operationId);\n',
)

current_durability = read("backend/src/services/yjsDurability.ts")
checkpoint_marker = "/**\n * Creates a recoverable Markdown snapshot at most once per five minutes."
marker_index = current_durability.find(checkpoint_marker)
if marker_index < 0:
    raise SystemExit("backend/src/services/yjsDurability.ts: checkpoint marker missing")
checkpoint_suffix = current_durability[marker_index:]
write(
    "backend/src/services/yjsDurability.ts",
    '''import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import { noteVersionsRepository, noteYupdatesRepository } from "../repositories";
import { yApplyUpdate, yDestroyDoc, yFlush, type YApplyResult } from "./yjs";

export type DurableYApplyFailureCode =
  | Exclude<YApplyResult, "ok">
  | "persist_failed"
  | "invalid_operation"
  | "operation_conflict";

export type DurableYApplyResult =
  | {
      ok: true;
      updateId: number;
      persistedAt: string;
      duplicate: boolean;
    }
  | {
      ok: false;
      code: DurableYApplyFailureCode;
    };

const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
const CHECKPOINT_DELAY_MS = 2_000;
const OPERATION_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const OPERATION_RECEIPT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_OPERATION_ID_LENGTH = 128;
const checkpointTimers = new Map<string, NodeJS.Timeout>();
let lastReceiptPruneAt = 0;

function hashUpdateBase64(updateBase64: string): string {
  return createHash("sha256").update(Buffer.from(updateBase64, "base64")).digest("hex");
}

function maybePruneOperationReceipts(now = Date.now()): void {
  if (now - lastReceiptPruneAt < OPERATION_RECEIPT_PRUNE_INTERVAL_MS) return;
  lastReceiptPruneAt = now;
  try {
    noteYupdatesRepository.deleteOperationReceiptsBefore(
      new Date(now - OPERATION_RECEIPT_RETENTION_MS).toISOString(),
    );
  } catch (error) {
    console.warn("[yjs-durability] operation receipt prune failed:", error);
  }
}

function failClosed(noteId: string, code: DurableYApplyFailureCode): DurableYApplyResult {
  try { yDestroyDoc(noteId); } catch {}
  return { ok: false, code };
}

/**
 * Applies an update and proves that both the append-only recovery log and the
 * operation receipt are durable before ACK. A repeated operationId returns the
 * original receipt without appending another update. Reusing an operationId for
 * different bytes is rejected fail-closed so content can never be silently dropped.
 */
export function yApplyUpdateDurably(
  noteId: string,
  updateBase64: string,
  userId: string | null,
  operationId: string | null = null,
): DurableYApplyResult {
  const normalizedOperationId = operationId?.trim() || null;
  if (normalizedOperationId && normalizedOperationId.length > MAX_OPERATION_ID_LENGTH) {
    return { ok: false, code: "invalid_operation" };
  }

  const incomingHash = normalizedOperationId ? hashUpdateBase64(updateBase64) : null;
  if (normalizedOperationId && incomingHash) {
    const existing = noteYupdatesRepository.findOperationReceipt(noteId, normalizedOperationId);
    if (existing) {
      if (existing.updateHash !== incomingHash) {
        return { ok: false, code: "operation_conflict" };
      }
      scheduleYjsRecoveryCheckpoint(noteId, userId);
      maybePruneOperationReceipts();
      return {
        ok: true,
        updateId: existing.updateId,
        persistedAt: existing.persistedAt,
        duplicate: true,
      };
    }
  }

  const before = noteYupdatesRepository.getMaxId(noteId)?.maxId || 0;
  const result = yApplyUpdate(noteId, updateBase64, userId, normalizedOperationId);
  if (result !== "ok") return { ok: false, code: result };

  const after = noteYupdatesRepository.getMaxId(noteId)?.maxId || 0;
  if (normalizedOperationId && incomingHash) {
    const receipt = noteYupdatesRepository.findOperationReceipt(noteId, normalizedOperationId);
    if (!receipt) {
      console.error(`[yjs-durability] operation receipt missing for ${noteId}/${normalizedOperationId}`);
      return failClosed(noteId, "persist_failed");
    }
    if (receipt.updateHash !== incomingHash) {
      console.error(`[yjs-durability] operation hash conflict for ${noteId}/${normalizedOperationId}`);
      return failClosed(noteId, "operation_conflict");
    }

    scheduleYjsRecoveryCheckpoint(noteId, userId);
    maybePruneOperationReceipts();
    return {
      ok: true,
      updateId: receipt.updateId,
      persistedAt: receipt.persistedAt,
      duplicate: receipt.updateId <= before,
    };
  }

  if (after <= before) {
    console.error(`[yjs-durability] update log did not advance for ${noteId}`);
    return failClosed(noteId, "persist_failed");
  }

  scheduleYjsRecoveryCheckpoint(noteId, userId);
  maybePruneOperationReceipts();
  return {
    ok: true,
    updateId: after,
    persistedAt: new Date().toISOString(),
    duplicate: false,
  };
}

''' + checkpoint_suffix,
)

replace_once(
    "backend/src/services/realtime.ts",
    '      const result = yApplyUpdateDurably(noteId, msg.update, info.userId);\n',
    '      const result = yApplyUpdateDurably(noteId, msg.update, info.userId, operationId);\n',
)
replace_once(
    "backend/src/services/realtime.ts",
    '''          no_room: "Not joined",
          persist_failed: "Update persistence failed",
''',
    '''          no_room: "Not joined",
          persist_failed: "Update persistence failed",
          invalid_operation: "Invalid operation id",
          operation_conflict: "Operation id was reused for different content",
''',
)
replace_once(
    "backend/src/services/realtime.ts",
    '''          updateId: result.updateId,
          persistedAt: result.persistedAt,
''',
    '''          updateId: result.updateId,
          persistedAt: result.persistedAt,
          duplicate: result.duplicate,
''',
)

replace_once(
    "backend/tests/yjs-durability.test.ts",
    '  db.prepare("DELETE FROM note_versions").run();\n',
    '  db.prepare("DELETE FROM note_versions").run();\n  db.prepare("DELETE FROM yjs_operation_receipts").run();\n',
)

with open("backend/tests/yjs-durability.test.ts", "a", encoding="utf-8") as test_file:
    test_file.write('''

test("operationId retry is idempotent across room reload", () => {
  resetDb();
  const update = buildClientUpdate("durable operation receipt body");
  const operationId = "op-idempotent-retry-1";

  const first = yApplyUpdateDurably(NOTE_ID, update, USER_ID, operationId);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.duplicate, false);
  assert.equal(noteYupdatesRepository.listAfterId(NOTE_ID, 0).length, 1);

  yDestroyDoc(NOTE_ID);
  yJoin(NOTE_ID, USER_ID);
  const retry = yApplyUpdateDurably(NOTE_ID, update, USER_ID, operationId);
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  assert.equal(retry.duplicate, true);
  assert.equal(retry.updateId, first.updateId);
  assert.equal(retry.persistedAt, first.persistedAt);
  assert.equal(noteYupdatesRepository.listAfterId(NOTE_ID, 0).length, 1);

  const receipt = getDb().prepare(
    `SELECT updateId, updateHash, persistedAt
     FROM yjs_operation_receipts WHERE noteId = ? AND operationId = ?`,
  ).get(NOTE_ID, operationId) as
    | { updateId: number; updateHash: string; persistedAt: string }
    | undefined;
  assert.ok(receipt);
  assert.equal(receipt?.updateId, first.updateId);
  assert.match(receipt?.updateHash || "", /^[a-f0-9]{64}$/);
  assert.equal(readServerText(), "durable operation receipt body");

  yDestroyDoc(NOTE_ID);
});

test("reusing an operationId for different content is rejected fail-closed", () => {
  resetDb();
  const operationId = "op-conflict-1";
  const firstUpdate = buildClientUpdate("first durable body");
  const first = yApplyUpdateDurably(NOTE_ID, firstUpdate, USER_ID, operationId);
  assert.equal(first.ok, true);

  const conflictingUpdate = buildClientUpdate("different body must not be dropped");
  const conflict = yApplyUpdateDurably(NOTE_ID, conflictingUpdate, USER_ID, operationId);
  assert.deepEqual(conflict, { ok: false, code: "operation_conflict" });
  assert.equal(noteYupdatesRepository.listAfterId(NOTE_ID, 0).length, 1);
  assert.equal(readServerText(), "first durable body");

  yDestroyDoc(NOTE_ID);
});

test("operation receipt failure rolls back the update and destroys dirty memory", () => {
  resetDb("durable receipt baseline");
  const update = buildClientUpdate("must not survive without receipt");
  const originalCreateWithOperation = noteYupdatesRepository.createWithOperation;
  (noteYupdatesRepository as any).createWithOperation = () => {
    throw new Error("simulated receipt disk failure");
  };

  try {
    const result = yApplyUpdateDurably(NOTE_ID, update, USER_ID, "op-receipt-failure-1");
    assert.deepEqual(result, { ok: false, code: "persist_failed" });
  } finally {
    (noteYupdatesRepository as any).createWithOperation = originalCreateWithOperation;
  }

  assert.equal(noteYupdatesRepository.listAfterId(NOTE_ID, 0).length, 0);
  const receipts = getDb().prepare(
    "SELECT COUNT(*) AS count FROM yjs_operation_receipts WHERE noteId = ?",
  ).get(NOTE_ID) as { count: number };
  assert.equal(receipts.count, 0);
  assert.equal(readServerText(), "durable receipt baseline");

  yDestroyDoc(NOTE_ID);
});
''')
