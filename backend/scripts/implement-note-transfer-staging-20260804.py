#!/usr/bin/env python3
"""One-shot implementation for PostgreSQL Note Transfer prepared -> staging."""

from __future__ import annotations

from pathlib import Path


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    source = path.read_text(encoding="utf-8")
    if old not in source:
        if new in source:
            return
        raise SystemExit(f"{label} anchor changed in {path}")
    path.write_text(source.replace(old, new, 1), encoding="utf-8")


def write_migration() -> None:
    Path("backend/src/db/postgres/migrations/0017_note_transfer_staging_manifest.sql").write_text(
        '''CREATE TABLE IF NOT EXISTS note_transfer_staged_attachments (
  "operationId" TEXT NOT NULL REFERENCES note_transfer_operations(id) ON DELETE CASCADE,
  "sourceAttachmentId" TEXT NOT NULL,
  "sourceNoteId" TEXT NOT NULL,
  "targetAttachmentId" TEXT NOT NULL,
  "targetNoteId" TEXT NOT NULL,
  "sourcePath" TEXT NOT NULL,
  "stagedPath" TEXT NOT NULL,
  filename TEXT NOT NULL,
  "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
  size BIGINT NOT NULL CHECK (size >= 0),
  hash TEXT,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'copying', 'staged', 'committed', 'failed', 'cleaned')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("operationId", "sourceAttachmentId"),
  UNIQUE ("operationId", "targetAttachmentId"),
  UNIQUE ("operationId", "stagedPath")
);

CREATE INDEX IF NOT EXISTS idx_note_transfer_staged_attachments_operation_status
  ON note_transfer_staged_attachments("operationId", status, "sourceAttachmentId");

CREATE INDEX IF NOT EXISTS idx_note_transfer_staged_attachments_source_note
  ON note_transfer_staged_attachments("sourceNoteId", "operationId");
''',
        encoding="utf-8",
    )


def patch_repository() -> None:
    path = Path("backend/src/repositories/noteTransferOperationRepository.ts")

    replace_once(
        path,
        '''export type NoteTransferOperationItem = {
  sourceNoteId: string;
  targetNoteId: string;
  sourceVersion: number;
  itemOrder: number;
  status: "planned" | "staged" | "committed" | "failed" | "cancelled";
};
''',
        '''export type NoteTransferOperationItem = {
  sourceNoteId: string;
  targetNoteId: string;
  sourceVersion: number;
  itemOrder: number;
  status: "planned" | "staged" | "committed" | "failed" | "cancelled";
};

export type NoteTransferStagedAttachment = {
  sourceAttachmentId: string;
  sourceNoteId: string;
  targetAttachmentId: string;
  targetNoteId: string;
  sourcePath: string;
  stagedPath: string;
  filename: string;
  mimeType: string;
  size: number;
  hash: string | null;
  status: "planned" | "copying" | "staged" | "committed" | "failed" | "cleaned";
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};
''',
        "staged attachment public type",
    )

    replace_once(
        path,
        '''  items: NoteTransferOperationItem[];
  reused: boolean;
};
''',
        '''  items: NoteTransferOperationItem[];
  stagedAttachments: NoteTransferStagedAttachment[];
  reused: boolean;
};
''',
        "operation manifest field",
    )

    replace_once(
        path,
        '''type ItemRow = {
  sourceNoteId: string;
  targetNoteId: string;
  sourceVersion: number | string;
  itemOrder: number | string;
  status: NoteTransferOperationItem["status"];
};
''',
        '''type ItemRow = {
  sourceNoteId: string;
  targetNoteId: string;
  sourceVersion: number | string;
  itemOrder: number | string;
  status: NoteTransferOperationItem["status"];
};

type StagedAttachmentRow = Omit<NoteTransferStagedAttachment, "size" | "attempts" | "createdAt" | "updatedAt"> & {
  size: number | string;
  attempts: number | string;
  createdAt: string | Date;
  updatedAt: string | Date;
};

type SourceAttachmentRow = {
  id: string;
  noteId: string;
  path: string;
  filename: string;
  mimeType: string | null;
  size: number | string;
  hash: string | null;
};
''',
        "staged attachment row types",
    )

    replace_once(
        path,
        '''function parseJson<T>(value: T | string, fallback: T): T {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
''',
        '''function parseJson<T>(value: T | string, fallback: T): T {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
''',
        "placeholder helper",
    )

    replace_once(
        path,
        '''    const items = await db.queryMany<ItemRow>(
      `SELECT sourceNoteId, targetNoteId, sourceVersion, itemOrder, status
         FROM note_transfer_operation_items
        WHERE operationId = ?
        ORDER BY itemOrder, sourceNoteId`,
      [row.id],
    );
    return {
''',
        '''    const items = await db.queryMany<ItemRow>(
      `SELECT sourceNoteId, targetNoteId, sourceVersion, itemOrder, status
         FROM note_transfer_operation_items
        WHERE operationId = ?
        ORDER BY itemOrder, sourceNoteId`,
      [row.id],
    );
    const stagedAttachments = await db.queryMany<StagedAttachmentRow>(
      `SELECT sourceAttachmentId, sourceNoteId, targetAttachmentId, targetNoteId,
              sourcePath, stagedPath, filename, mimeType, size, hash,
              status, attempts, lastError, createdAt, updatedAt
         FROM note_transfer_staged_attachments
        WHERE operationId = ?
        ORDER BY sourceNoteId, sourceAttachmentId`,
      [row.id],
    );
    return {
''',
        "load manifest rows",
    )

    replace_once(
        path,
        '''      items: items.map((item) => ({
        sourceNoteId: item.sourceNoteId,
        targetNoteId: item.targetNoteId,
        sourceVersion: toNumber(item.sourceVersion),
        itemOrder: toNumber(item.itemOrder),
        status: item.status,
      })),
      reused: false,
''',
        '''      items: items.map((item) => ({
        sourceNoteId: item.sourceNoteId,
        targetNoteId: item.targetNoteId,
        sourceVersion: toNumber(item.sourceVersion),
        itemOrder: toNumber(item.itemOrder),
        status: item.status,
      })),
      stagedAttachments: stagedAttachments.map((attachment) => ({
        sourceAttachmentId: attachment.sourceAttachmentId,
        sourceNoteId: attachment.sourceNoteId,
        targetAttachmentId: attachment.targetAttachmentId,
        targetNoteId: attachment.targetNoteId,
        sourcePath: attachment.sourcePath,
        stagedPath: attachment.stagedPath,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: toNumber(attachment.size),
        hash: attachment.hash,
        status: attachment.status,
        attempts: toNumber(attachment.attempts),
        lastError: attachment.lastError,
        createdAt: toTimestamp(attachment.createdAt),
        updatedAt: toTimestamp(attachment.updatedAt),
      })),
      reused: false,
''',
        "map manifest rows",
    )

    load_helper = '''

  async function loadSourceAttachments(
    operation: PreparedNoteTransferOperation,
  ): Promise<SourceAttachmentRow[]> {
    if (!operation.includeAttachments || operation.plan.sourceNoteIds.length === 0) return [];
    return db.queryMany<SourceAttachmentRow>(
      `SELECT id, noteId, path, filename, mimeType, size, hash
         FROM attachments
        WHERE noteId IN (${placeholders(operation.plan.sourceNoteIds.length)})
        ORDER BY createdAt, id`,
      operation.plan.sourceNoteIds,
    );
  }
'''
    replace_once(
        path,
        '''  }

  return {
    async getPrepared(input: {
''',
        '''  }
''' + load_helper + '''
  return {
    async getPrepared(input: {
''',
        "source attachment loader",
    )

    staging_method = '''    async beginStaging(input: {
      actorUserId: string;
      idempotencyKey: string;
    }): Promise<PreparedNoteTransferOperation> {
      const key = normalizeIdempotencyKey(input.idempotencyKey);
      const operation = await loadOperation(input.actorUserId, key);
      if (!operation) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_PLAN_NOT_FOUND",
          "转移计划不存在",
          404,
        );
      }
      assertNotExpired(operation);
      if (operation.status === "staging") return { ...operation, reused: true };
      if (operation.status !== "prepared") {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_STATE_CONFLICT",
          `当前状态 ${operation.status} 无法进入 staging`,
          409,
          { operationId: operation.id, status: operation.status },
        );
      }

      const sourceAttachments = await loadSourceAttachments(operation);
      const attachmentBytes = sourceAttachments.reduce(
        (total, attachment) => total + toNumber(attachment.size),
        0,
      );
      if (
        sourceAttachments.length !== operation.plan.attachmentCount
        || attachmentBytes !== operation.plan.attachmentBytes
      ) {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_ATTACHMENT_SNAPSHOT_STALE",
          "附件数量或大小已变化，请重新预检",
          409,
          {
            operationId: operation.id,
            expectedCount: operation.plan.attachmentCount,
            actualCount: sourceAttachments.length,
            expectedBytes: operation.plan.attachmentBytes,
            actualBytes: attachmentBytes,
          },
        );
      }

      const stagedAttachments = sourceAttachments.map((attachment) => {
        const targetNoteId = operation.plan.targetNoteIds[attachment.noteId];
        if (!targetNoteId) {
          throw new NoteTransferOperationError(
            "NOTE_TRANSFER_PLAN_STALE",
            "附件对应的目标笔记映射不存在，请重新预检",
            409,
            { sourceAttachmentId: attachment.id, sourceNoteId: attachment.noteId },
          );
        }
        const targetAttachmentId = randomUUID();
        return {
          source: attachment,
          targetAttachmentId,
          targetNoteId,
          stagedPath: `note-transfer-staging/${operation.id}/${targetAttachmentId}`,
          mimeType: attachment.mimeType || "application/octet-stream",
        };
      });

      const statements: DbStatement[] = [
        targetGuard({
          actorUserId: input.actorUserId,
          targetNotebookId: operation.targetNotebookId,
          targetWorkspaceId: operation.targetWorkspaceId,
        }),
        ...operation.plan.sourceNoteIds.map((sourceNoteId) => sourceGuard({
          actorUserId: input.actorUserId,
          sourceWorkspaceId: operation.sourceWorkspaceId,
          sourceNoteId,
          sourceVersion: operation.sourceVersions[sourceNoteId],
        })),
      ];

      if (operation.includeAttachments) {
        const notePlaceholders = placeholders(operation.plan.sourceNoteIds.length);
        statements.push({
          sql: `SELECT 1
                  WHERE (SELECT COUNT(*) FROM attachments WHERE noteId IN (${notePlaceholders})) = ?
                    AND (SELECT COALESCE(SUM(size), 0) FROM attachments WHERE noteId IN (${notePlaceholders})) = ?`,
          params: [
            ...operation.plan.sourceNoteIds,
            operation.plan.attachmentCount,
            ...operation.plan.sourceNoteIds,
            operation.plan.attachmentBytes,
          ],
          requireChanges: 1,
        });
      }

      statements.push({
        sql: `UPDATE note_transfer_operations
                 SET status = 'staging', updatedAt = CURRENT_TIMESTAMP
               WHERE id = ? AND userId = ? AND idempotencyKey = ?
                 AND status = 'prepared' AND expiresAt > CURRENT_TIMESTAMP`,
        params: [operation.id, input.actorUserId, key],
        requireChanges: 1,
      });

      for (const attachment of stagedAttachments) {
        statements.push({
          sql: `INSERT INTO note_transfer_staged_attachments (
                  operationId, sourceAttachmentId, sourceNoteId,
                  targetAttachmentId, targetNoteId, sourcePath, stagedPath,
                  filename, mimeType, size, hash, status
                )
                SELECT ?, source.id, source.noteId, ?, ?, source.path, ?,
                       source.filename, COALESCE(source.mimeType, 'application/octet-stream'),
                       source.size, source.hash, 'planned'
                  FROM attachments source
                 WHERE source.id = ? AND source.noteId = ? AND source.path = ?
                   AND source.filename = ?
                   AND COALESCE(source.mimeType, 'application/octet-stream') = ?
                   AND source.size = ?
                   AND COALESCE(source.hash, '') = COALESCE(?, '')`,
          params: [
            operation.id,
            attachment.targetAttachmentId,
            attachment.targetNoteId,
            attachment.stagedPath,
            attachment.source.id,
            attachment.source.noteId,
            attachment.source.path,
            attachment.source.filename,
            attachment.mimeType,
            toNumber(attachment.source.size),
            attachment.source.hash,
          ],
          requireChanges: 1,
        });
      }

      try {
        await db.executeStatements(statements);
      } catch (error) {
        const raced = await loadOperation(input.actorUserId, key).catch(() => null);
        if (raced?.status === "staging") return { ...raced, reused: true };
        if (error instanceof DbStatementChangeError) mapTransactionError(error);
        throw error;
      }

      const staged = await loadOperation(input.actorUserId, key);
      if (!staged || staged.status !== "staging") {
        throw new NoteTransferOperationError(
          "NOTE_TRANSFER_STAGING_PERSIST_FAILED",
          "转移 staging 状态保存失败",
          409,
        );
      }
      return staged;
    },

'''
    replace_once(
        path,
        '''    async prepareOperation(input: {
''',
        staging_method + '''    async prepareOperation(input: {
''',
        "begin staging method",
    )


def patch_route() -> None:
    path = Path("backend/src/routes/note-transfers-runtime.ts")
    route = '''
  app.post("/operations/:idempotencyKey/staging", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const credentialError = rejectNonInteractiveCredential(c);
    if (credentialError) return credentialError;

    try {
      const operation = await operations.beginStaging({
        actorUserId: c.req.header("X-User-Id") || "",
        idempotencyKey: c.req.param("idempotencyKey"),
      });
      return c.json(operation, operation.reused ? 200 : 202);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

'''
    replace_once(
        path,
        '''  app.get("/operations/:idempotencyKey", async (c) => {
''',
        route + '''  app.get("/operations/:idempotencyKey", async (c) => {
''',
        "staging route",
    )
    replace_once(
        path,
        '''        error: "PostgreSQL 笔记转移执行事务尚未迁移，请先使用预检和 prepare 接口",
''',
        '''        error: "PostgreSQL 笔记转移最终提交尚未迁移，请先使用预检、prepare 和 staging 接口",
''',
        "pending execution message",
    )


def patch_migration_test() -> None:
    path = Path("backend/tests/postgres-migrations.test.ts")
    replace_once(
        path,
        '''    "0016_note_transfer_operations",
  ]);
''',
        '''    "0016_note_transfer_operations",
    "0017_note_transfer_staging_manifest",
  ]);
''',
        "migration version list",
    )
    replace_once(
        path,
        '''    "note_transfer_operation_items",
    "note_transfer_operations",
''',
        '''    "note_transfer_operation_items",
    "note_transfer_operations",
    "note_transfer_staged_attachments",
''',
        "migration parity table",
    )
    replace_once(
        path,
        '''    `SELECT to_regclass('public.idx_note_transfer_operations_user_time') AS user_time,
            to_regclass('public.idx_note_transfer_operations_status_expiry') AS status_expiry,
            to_regclass('public.idx_note_transfer_items_source') AS item_source`,
''',
        '''    `SELECT to_regclass('public.idx_note_transfer_operations_user_time') AS user_time,
            to_regclass('public.idx_note_transfer_operations_status_expiry') AS status_expiry,
            to_regclass('public.idx_note_transfer_items_source') AS item_source,
            to_regclass('public.idx_note_transfer_staged_attachments_operation_status') AS staged_status,
            to_regclass('public.idx_note_transfer_staged_attachments_source_note') AS staged_source`,
''',
        "migration transfer index query",
    )
    replace_once(
        path,
        '''  assert.equal(
    transferIndexes.rows[0].item_source,
    "idx_note_transfer_items_source",
  );
''',
        '''  assert.equal(
    transferIndexes.rows[0].item_source,
    "idx_note_transfer_items_source",
  );
  assert.equal(
    transferIndexes.rows[0].staged_status,
    "idx_note_transfer_staged_attachments_operation_status",
  );
  assert.equal(
    transferIndexes.rows[0].staged_source,
    "idx_note_transfer_staged_attachments_source_note",
  );
''',
        "migration transfer index assertions",
    )


def patch_runtime_test() -> None:
    path = Path("backend/tests/note-transfer-preview-runtime-pg.test.ts")
    replace_once(
        path,
        '''    const adapter = new PostgresAdapter(pool);
    const app = new Hono();
''',
        '''    const adapter = new PostgresAdapter(pool);
    const operations = createNoteTransferOperationRepository(adapter);
    const app = new Hono();
''',
        "runtime test operation repository",
    )

    staging_tests = '''

    const staged = await request(
      `/operations/${encodeURIComponent(IDEMPOTENCY_KEY)}/staging`,
      ACTOR,
      {},
      202,
    );
    assert.equal(staged.id, prepared.id);
    assert.equal(staged.status, "staging");
    assert.equal(staged.reused, false);
    assert.equal(staged.stagedAttachments.length, 1);
    assert.equal(staged.stagedAttachments[0].sourceAttachmentId, ATTACHMENT);
    assert.equal(staged.stagedAttachments[0].sourceNoteId, SOURCE_NOTE_A);
    assert.equal(
      staged.stagedAttachments[0].targetNoteId,
      prepared.plan.targetNoteIds[SOURCE_NOTE_A],
    );
    assert.equal(staged.stagedAttachments[0].status, "planned");
    assert.equal(staged.stagedAttachments[0].size, 24);
    assert.match(
      staged.stagedAttachments[0].stagedPath,
      new RegExp(`^note-transfer-staging/${prepared.id}/`),
    );

    const stagedRetry = await request(
      `/operations/${encodeURIComponent(IDEMPOTENCY_KEY)}/staging`,
      ACTOR,
      {},
      200,
    );
    assert.equal(stagedRetry.reused, true);
    assert.equal(
      stagedRetry.stagedAttachments[0].targetAttachmentId,
      staged.stagedAttachments[0].targetAttachmentId,
    );
    assert.equal(
      stagedRetry.stagedAttachments[0].stagedPath,
      staged.stagedAttachments[0].stagedPath,
    );

    const raceKey = "transfer-preview-staging-race";
    await operations.prepareOperation({
      actorUserId: ACTOR,
      idempotencyKey: raceKey,
      mode: "copy",
      sourceWorkspaceId: null,
      targetWorkspaceId: ACTOR_WORKSPACE,
      targetNotebookId: ACTOR_TARGET,
      includeAttachments: true,
      includeTags: false,
      sourceNoteIds: [SOURCE_NOTE_A],
      sourceVersions: { [SOURCE_NOTE_A]: 4 },
      attachmentCount: 1,
      attachmentBytes: 24,
      tagCount: 0,
      internalNoteLinkCount: 0,
      externalNoteLinkCount: 0,
    });
    const raceResults = await Promise.all([
      operations.beginStaging({ actorUserId: ACTOR, idempotencyKey: raceKey }),
      operations.beginStaging({ actorUserId: ACTOR, idempotencyKey: raceKey }),
    ]);
    assert.deepEqual(raceResults.map((result) => result.status), ["staging", "staging"]);
    assert.equal(raceResults.filter((result) => result.reused === false).length, 1);
    assert.equal(raceResults.filter((result) => result.reused === true).length, 1);
    assert.equal(
      raceResults[0].stagedAttachments[0].targetAttachmentId,
      raceResults[1].stagedAttachments[0].targetAttachmentId,
    );
    const raceManifestCount = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM note_transfer_staged_attachments
        WHERE "operationId" = $1`,
      [raceResults[0].id],
    );
    assert.equal(raceManifestCount.rows[0].count, 1);

    const staleStageKey = "transfer-preview-staging-stale";
    const staleStagePrepared = await operations.prepareOperation({
      actorUserId: ACTOR,
      idempotencyKey: staleStageKey,
      mode: "copy",
      sourceWorkspaceId: null,
      targetWorkspaceId: ACTOR_WORKSPACE,
      targetNotebookId: ACTOR_TARGET,
      includeAttachments: false,
      includeTags: false,
      sourceNoteIds: [SOURCE_NOTE_B],
      sourceVersions: { [SOURCE_NOTE_B]: 7 },
      attachmentCount: 0,
      attachmentBytes: 0,
      tagCount: 0,
      internalNoteLinkCount: 0,
      externalNoteLinkCount: 0,
    });
    await pool.query(`UPDATE notes SET version = 8 WHERE id = $1`, [SOURCE_NOTE_B]);
    await assert.rejects(
      operations.beginStaging({ actorUserId: ACTOR, idempotencyKey: staleStageKey }),
      (error: any) => error?.code === "NOTE_TRANSFER_PLAN_STALE",
    );
    const staleStageState = await pool.query(
      `SELECT operation.status, COUNT(manifest."sourceAttachmentId")::int AS manifest_count
         FROM note_transfer_operations operation
         LEFT JOIN note_transfer_staged_attachments manifest
           ON manifest."operationId" = operation.id
        WHERE operation.id = $1
        GROUP BY operation.status`,
      [staleStagePrepared.id],
    );
    assert.equal(staleStageState.rows[0].status, "prepared");
    assert.equal(staleStageState.rows[0].manifest_count, 0);
    await pool.query(`UPDATE notes SET version = 7 WHERE id = $1`, [SOURCE_NOTE_B]);
'''
    replace_once(
        path,
        '''    assert.equal(loaded.id, prepared.id);
    assert.equal(loaded.reused, false);
''',
        '''    assert.equal(loaded.id, prepared.id);
    assert.equal(loaded.reused, false);
''' + staging_tests,
        "runtime staging tests",
    )
    replace_once(
        path,
        '''    const operations = createNoteTransferOperationRepository(adapter);
    await assert.rejects(
''',
        '''    await assert.rejects(
''',
        "remove duplicate operation repository",
    )


def patch_health_metadata() -> None:
    path = Path("backend/src/index.postgres-runtime.ts")
    replace_once(
        path,
        '''        "POST /api/note-transfers/prepare",
        "GET /api/note-transfers/operations/:idempotencyKey",
''',
        '''        "POST /api/note-transfers/prepare",
        "POST /api/note-transfers/operations/:idempotencyKey/staging",
        "GET /api/note-transfers/operations/:idempotencyKey",
''',
        "health staging route",
    )
    replace_once(
        path,
        '''        "note-transfer durable idempotency, source-version snapshots and transactional preparation",
''',
        '''        "note-transfer durable idempotency, source-version snapshots and transactional preparation",
        "note-transfer prepared-to-staging CAS and recoverable attachment manifests",
''',
        "health staging capability",
    )
    replace_once(
        path,
        '''        "note-transfer staged attachment copy, atomic target commit and move deletion (#249)",
''',
        '''        "note-transfer physical attachment copy, atomic target commit and move deletion (#249)",
''',
        "health pending capability",
    )
    replace_once(
        path,
        '''console.warn("[db] Notes, durable note-transfer planning and knowledge-tree routes are PostgreSQL-safe; production cutover remains disabled until the remaining PostgreSQL phases complete");
''',
        '''console.warn("[db] Notes, durable note-transfer planning/staging and knowledge-tree routes are PostgreSQL-safe; production cutover remains disabled until the remaining PostgreSQL phases complete");
''',
        "runtime startup warning",
    )


def patch_runtime_workflow() -> None:
    path = Path(".github/workflows/pg-runtime.yml")
    replace_once(
        path,
        '''          test -f dist/postgres/migrations/0016_note_transfer_operations.sql
''',
        '''          test -f dist/postgres/migrations/0016_note_transfer_operations.sql &&
          test -f dist/postgres/migrations/0017_note_transfer_staging_manifest.sql
''',
        "bundle migration 0017",
    )
    replace_once(
        path,
        '''              "POST /api/note-transfers/prepare",
              "GET /api/note-transfers/operations/:idempotencyKey",
''',
        '''              "POST /api/note-transfers/prepare",
              "POST /api/note-transfers/operations/:idempotencyKey/staging",
              "GET /api/note-transfers/operations/:idempotencyKey",
''',
        "smoke staging route",
    )
    replace_once(
        path,
        '''              "note-transfer durable idempotency, source-version snapshots and transactional preparation",
''',
        '''              "note-transfer durable idempotency, source-version snapshots and transactional preparation",
              "note-transfer prepared-to-staging CAS and recoverable attachment manifests",
''',
        "smoke staging capability",
    )
    replace_once(
        path,
        '''              "note-transfer copy/move transaction and staged attachment commit (#249)",
''',
        '''              "note-transfer copy/move transaction and staged attachment commit (#249)",
              "note-transfer staged attachment copy, atomic target commit and move deletion (#249)",
''',
        "smoke stale pending capability",
    )


def main() -> None:
    write_migration()
    patch_repository()
    patch_route()
    patch_migration_test()
    patch_runtime_test()
    patch_health_metadata()
    patch_runtime_workflow()


if __name__ == "__main__":
    main()
