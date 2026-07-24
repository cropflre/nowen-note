/**
 * Block 权威存储只读 Repository。
 *
 * 保持现有同步 store 不变，仅为 SQLite/PostgreSQL 共用查询提供 async 边界。
 */
import { getDb } from "../db/schema";
import { SqliteAdapter } from "../db/adapters";
import type { DatabaseAdapter } from "../db/adapters/types";

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
        SELECT noteId, contentFormat, noteVersion, blockVersion, structureVersion,
               snapshotHash, materializedHash, snapshotContent, rootOrderJson,
               status, mismatchReason, createdAt, updatedAt
        FROM note_block_documents WHERE noteId = ?
      `, [noteId]);
    },

    async listRecords(noteId: string): Promise<BlockAuthorityRecordRow[]> {
      return resolveAdapter().queryMany<BlockAuthorityRecordRow>(`
        SELECT noteId, blockId, parentBlockId, blockType, blockOrder, path, version,
               payload, payloadHash, plainText, contentHash, createdAt, updatedAt
        FROM note_block_records WHERE noteId = ? ORDER BY blockOrder
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
        SELECT id, noteId, operationId, operationType, noteVersion, blockVersion,
               structureVersion, operationJson, createdAt
        FROM note_block_operations
        WHERE noteId = ?
        ORDER BY createdAt DESC, id DESC
        LIMIT ? OFFSET ?
      `, [noteId, limit, offset]);
    },
  };
}

export const blockAuthorityRepository = createBlockAuthorityRepository();
