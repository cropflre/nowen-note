/**
 * Block 权威存储 Repository。
 *
 * 保持现有同步 store 不变，为 SQLite/PostgreSQL 共用查询和原子替换提供 async 边界。
 */
import { getDb } from "../db/schema";
import { SqliteAdapter } from "../db/adapters";
import type { DatabaseAdapter } from "../db/adapters/types";
import { randomUUID } from "node:crypto";

export interface BlockAuthorityDocumentRow {
  noteId: string;
  contentFormat: string;
  noteVersion: number;
  blockVersion: number;
  structureVersion: number;
  snapshotHash: string;
  materializedHash: string;
  snapshotContent: string;
  rootOrderJson: string;
  status: string;
  mismatchReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlockAuthorityRecordRow {
  noteId: string;
  blockId: string;
  parentBlockId: string | null;
  blockType: string;
  blockOrder: number;
  path: string;
  version: number;
  payload: string;
  payloadHash: string;
  plainText: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface BlockAuthorityOperationRow {
  id: string;
  noteId: string;
  operationId: string | null;
  operationType: string;
  noteVersion: number;
  blockVersion: number;
  structureVersion: number;
  operationJson: string;
  createdAt: string;
}

export interface BlockAuthorityAttachmentRefRow {
  noteId: string;
  blockId: string;
  attachmentId: string;
  createdAt: string;
}

export interface BlockAuthorityWriteState {
  document: BlockAuthorityDocumentRow;
  records: BlockAuthorityRecordRow[];
  attachmentRefs: BlockAuthorityAttachmentRefRow[];
  operation?: BlockAuthorityOperationRow;
}

function getAdapter(): DatabaseAdapter {
  return new SqliteAdapter(getDb());
}

export function createBlockAuthorityRepository(adapter?: DatabaseAdapter) {
  const resolveAdapter = (): DatabaseAdapter => {
    adapter ??= getAdapter();
    return adapter;
  };

  return {
    async getDocument(noteId: string): Promise<BlockAuthorityDocumentRow | undefined> {
      return resolveAdapter().queryOne<BlockAuthorityDocumentRow>(`
        SELECT "noteId", "contentFormat", "noteVersion", "blockVersion", "structureVersion",
               "snapshotHash", "materializedHash", "snapshotContent", "rootOrderJson",
               status, "mismatchReason", "createdAt", "updatedAt"
        FROM note_block_documents WHERE "noteId" = ?
      `, [noteId]);
    },

    async listRecords(noteId: string): Promise<BlockAuthorityRecordRow[]> {
      return resolveAdapter().queryMany<BlockAuthorityRecordRow>(`
        SELECT "noteId", "blockId", "parentBlockId", "blockType", "blockOrder", path, version,
               payload, "payloadHash", "plainText", "contentHash", "createdAt", "updatedAt"
        FROM note_block_records WHERE "noteId" = ? ORDER BY "blockOrder"
      `, [noteId]);
    },

    async listOperations(
      noteId: string,
      options: { limit?: number; offset?: number } = {},
    ): Promise<BlockAuthorityOperationRow[]> {
      const requestedLimit = Number.isFinite(options.limit) ? Math.trunc(options.limit as number) : 20;
      const requestedOffset = Number.isFinite(options.offset) ? Math.trunc(options.offset as number) : 0;
      const limit = Math.max(1, Math.min(100, requestedLimit));
      const offset = Math.max(0, requestedOffset);
      return resolveAdapter().queryMany<BlockAuthorityOperationRow>(`
        SELECT id, "noteId", "operationId", "operationType", "noteVersion", "blockVersion",
               "structureVersion", "operationJson", "createdAt"
        FROM note_block_operations
        WHERE "noteId" = ?
        ORDER BY "createdAt" DESC, id DESC
        LIMIT ? OFFSET ?
      `, [noteId, limit, offset]);
    },

    async replaceAuthorityState(state: BlockAuthorityWriteState): Promise<{ changes: number }> {
      const guardedOperation = state.operation?.operationId
        ? { operation: state.operation, claimId: randomUUID() }
        : null;
      const guardSql = guardedOperation
        ? ` AND EXISTS (
            SELECT 1 FROM note_block_operations
            WHERE "noteId" = ? AND "operationId" = ? AND id = ?
          )`
        : "";
      const guardParams = guardedOperation
        ? [state.document.noteId, guardedOperation.operation.operationId, guardedOperation.claimId]
        : [];
      const insertGuardSql = guardedOperation
        ? ` WHERE EXISTS (
            SELECT 1 FROM note_block_operations
            WHERE "noteId" = ? AND "operationId" = ? AND id = ?
          )`
        : "";
      const statements: Array<{ sql: string; params?: unknown[] }> = [];

      if (guardedOperation) {
        const { operation, claimId } = guardedOperation;
        // 每次调用使用独立 claimId；只有首次插入 operationId 的调用能命中后续写入守卫。
        statements.push({
          sql: `
            INSERT INTO note_block_operations (
              id, "noteId", "operationId", "operationType", "noteVersion", "blockVersion",
              "structureVersion", "operationJson", "createdAt"
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT ("noteId", "operationId") WHERE "operationId" IS NOT NULL DO NOTHING
          `,
          params: [
            claimId, operation.noteId, operation.operationId, operation.operationType,
            operation.noteVersion, operation.blockVersion, operation.structureVersion,
            operation.operationJson, operation.createdAt,
          ],
        });
      }

      statements.push(
        {
          sql: `DELETE FROM note_block_attachment_refs WHERE "noteId" = ?${guardSql}`,
          params: [state.document.noteId, ...guardParams],
        },
        {
          sql: `DELETE FROM note_block_records WHERE "noteId" = ?${guardSql}`,
          params: [state.document.noteId, ...guardParams],
        },
      );

      for (const record of state.records) {
        statements.push({
          sql: `
            INSERT INTO note_block_records (
              "noteId", "blockId", "parentBlockId", "blockType", "blockOrder", path, version,
              payload, "payloadHash", "plainText", "contentHash", "createdAt", "updatedAt"
            ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${insertGuardSql}
          `,
          params: [
            record.noteId, record.blockId, record.parentBlockId, record.blockType,
            record.blockOrder, record.path, record.version, record.payload, record.payloadHash,
            record.plainText, record.contentHash, record.createdAt, record.updatedAt,
            ...guardParams,
          ],
        });
      }

      for (const ref of state.attachmentRefs) {
        statements.push({
          sql: `
            INSERT INTO note_block_attachment_refs (
              "noteId", "blockId", "attachmentId", "createdAt"
            ) SELECT ?, ?, ?, ?${insertGuardSql}
          `,
          params: [ref.noteId, ref.blockId, ref.attachmentId, ref.createdAt, ...guardParams],
        });
      }

      const document = state.document;
      statements.push({
        sql: `
          INSERT INTO note_block_documents (
            "noteId", "contentFormat", "noteVersion", "blockVersion", "structureVersion",
            "snapshotHash", "materializedHash", "snapshotContent", "rootOrderJson", status,
            "mismatchReason", "createdAt", "updatedAt"
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${insertGuardSql}
          ON CONFLICT ("noteId") DO UPDATE SET
            "contentFormat" = excluded."contentFormat",
            "noteVersion" = excluded."noteVersion",
            "blockVersion" = excluded."blockVersion",
            "structureVersion" = excluded."structureVersion",
            "snapshotHash" = excluded."snapshotHash",
            "materializedHash" = excluded."materializedHash",
            "snapshotContent" = excluded."snapshotContent",
            "rootOrderJson" = excluded."rootOrderJson",
            status = excluded.status,
            "mismatchReason" = excluded."mismatchReason",
            "updatedAt" = excluded."updatedAt"
        `,
        params: [
          document.noteId, document.contentFormat, document.noteVersion, document.blockVersion,
          document.structureVersion, document.snapshotHash, document.materializedHash,
          document.snapshotContent, document.rootOrderJson, document.status,
          document.mismatchReason, document.createdAt, document.updatedAt,
          ...guardParams,
        ],
      });

      if (state.operation && !guardedOperation) {
        const operation = state.operation;
        statements.push({
          sql: `
            INSERT INTO note_block_operations (
              id, "noteId", "operationId", "operationType", "noteVersion", "blockVersion",
              "structureVersion", "operationJson", "createdAt"
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT ("noteId", "operationId") WHERE "operationId" IS NOT NULL DO NOTHING
          `,
          params: [
            operation.id, operation.noteId, operation.operationId, operation.operationType,
            operation.noteVersion, operation.blockVersion, operation.structureVersion,
            operation.operationJson, operation.createdAt,
          ],
        });
      }

      return resolveAdapter().executeStatements(statements);
    },
  };
}

export const blockAuthorityRepository = createBlockAuthorityRepository();
