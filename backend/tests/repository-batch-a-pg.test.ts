import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const databaseUrl = process.env.TEST_PG_DATABASE_URL;
const skip = !databaseUrl;

test("PG Batch A repositories use the runtime adapter", { skip }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  const runtime = await import("../src/db/runtime");

  await runtime.resetDatabaseRuntimeForTests();
  await runtime.initializeDatabase({
    env: {
      ...process.env,
      DB_DRIVER: "postgres",
      DATABASE_URL: databaseUrl,
    },
    dependencies: {
      createPostgresPool: () => pool,
      logger: { log: () => undefined, warn: () => undefined },
    },
  });

  const { runPostgresMigrations } = await import("../src/db/postgres/migrations");
  await runPostgresMigrations();

  const userId = `pg-batch-a-${Date.now()}`;
  const feedId = `${userId}-feed`;
  const promptId = `${userId}-prompt`;
  const targetId = `${userId}-target`;
  const tokenId = `${userId}-api-token`;
  const usageDay = "2026-07-16";
  const notebookId = randomUUID();
  const noteId = randomUUID();
  const oldAttachmentId = randomUUID();
  const newAttachmentId = randomUUID();
  const oldTargetNoteId = randomUUID();
  const newTargetNoteId = randomUUID();
  const oldContentText = `附件 /api/attachments/${oldAttachmentId}，关联 note:${oldTargetNoteId}`;
  const normalizedContent = `附件 /api/attachments/${newAttachmentId}，关联 note:${newTargetNoteId}`;

  await pool.query(
    `INSERT INTO users (id, username, "passwordHash") VALUES ($1, $2, $3)`,
    [userId, userId, "hash"],
  );
  await pool.query(
    `INSERT INTO task_calendar_feeds (id, "userId", token) VALUES ($1, $2, $3)`,
    [feedId, userId, `${userId}-token`],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", name) VALUES ($1, $2, $3)`,
    [notebookId, userId, "Attachment reference PG"],
  );
  await pool.query(
    `INSERT INTO notes (id, "userId", "notebookId", title, content, "contentText", "contentFormat")
     VALUES ($1, $2, $3, $4, $5, $6, 'markdown')`,
    [noteId, userId, notebookId, "Attachment reference note", normalizedContent, oldContentText],
  );
  await pool.query(
    `INSERT INTO attachments (id, "noteId", "userId", filename, "mimeType", size, path)
     VALUES ($1, $2, $3, $4, 'text/plain', 1, $5),
            ($6, $2, $3, $7, 'text/plain', 1, $8)`,
    [
      oldAttachmentId,
      noteId,
      userId,
      "old.txt",
      `${oldAttachmentId}.txt`,
      newAttachmentId,
      "new.txt",
      `${newAttachmentId}.txt`,
    ],
  );
  await pool.query(
    `INSERT INTO attachment_references ("attachmentId", "noteId") VALUES ($1, $2)`,
    [oldAttachmentId, noteId],
  );

  try {
    const { aiCustomPromptsRepository } = await import("../src/repositories/aiCustomPromptsRepository");
    await aiCustomPromptsRepository.createAsync({
      id: promptId,
      userId,
      name: "PostgreSQL prompt",
      prompt: "Use the runtime adapter",
    });

    let prompt = await aiCustomPromptsRepository.getByIdAndUserAsync(promptId, userId);
    assert.ok(prompt);
    assert.equal(prompt.userId, userId);
    assert.equal(prompt.usageCount, 0);

    assert.equal(await aiCustomPromptsRepository.touchUsageAsync(promptId, userId), true);
    await aiCustomPromptsRepository.updateByIdAndUserAsync(promptId, userId, { name: "Updated prompt" });
    prompt = await aiCustomPromptsRepository.getByIdAndUserAsync(promptId, userId);
    assert.equal(prompt?.name, "Updated prompt");
    assert.equal(prompt?.usageCount, 1);

    const { calendarExportTargetsRepository } = await import("../src/repositories/calendarExportTargetsRepository");
    await calendarExportTargetsRepository.createAsync({
      id: targetId,
      userId,
      feedId,
      type: "webdav",
      enabled: true,
      name: "PG target",
      configJson: "{}",
    });

    let target = await calendarExportTargetsRepository.getByIdAndUserAsync(targetId, userId);
    assert.ok(target);
    assert.equal(target.enabled, true);

    await calendarExportTargetsRepository.updateByIdAndUserAsync(targetId, userId, {
      enabled: false,
      name: "Disabled target",
    });
    target = await calendarExportTargetsRepository.getByIdAndUserAsync(targetId, userId);
    assert.equal(target?.enabled, false);
    assert.equal(target?.name, "Disabled target");

    const { apiTokensRepository } = await import("../src/repositories/apiTokensRepository");
    await apiTokensRepository.createAsync({
      id: tokenId,
      userId,
      name: "PG API token",
      tokenHash: `${tokenId}-hash`,
      scopes: ["notes:read"],
      expiresAt: null,
    });

    const token = await apiTokensRepository.getByIdAndUserAsync(tokenId, userId);
    assert.equal(token?.userId, userId);
    await apiTokensRepository.recordUsageAsync(tokenId, usageDay);
    await apiTokensRepository.recordUsageAsync(tokenId, usageDay);
    assert.deepEqual(
      await apiTokensRepository.getDailyUsageAsync(userId, usageDay, usageDay),
      [{ day: usageDay, count: 2 }],
    );
    assert.equal(await apiTokensRepository.getPrevPeriodTotalAsync(userId, usageDay, usageDay), 2);

    await apiTokensRepository.revokeByIdAsync(tokenId);
    const revoked = await apiTokensRepository.getByIdAndUserAsync(tokenId, userId);
    assert.ok(revoked?.revokedAt);

    const { syncAttachmentReferencesForNoteAsync } = await import("../src/services/attachment-reference");
    const synced = await syncAttachmentReferencesForNoteAsync(noteId, normalizedContent);
    assert.deepEqual(synced, { added: 1, removed: 1 });

    const referenceRows = await pool.query(
      `SELECT "attachmentId" FROM attachment_references WHERE "noteId" = $1 ORDER BY "attachmentId"`,
      [noteId],
    );
    assert.deepEqual(referenceRows.rows.map((row) => row.attachmentId), [newAttachmentId]);

    const noteRow = await pool.query(
      `SELECT "contentText" FROM notes WHERE id = $1`,
      [noteId],
    );
    assert.equal(noteRow.rows[0]?.contentText, normalizedContent);

    const repeated = await syncAttachmentReferencesForNoteAsync(noteId, normalizedContent);
    assert.deepEqual(repeated, { added: 0, removed: 0 });

    assert.equal(await calendarExportTargetsRepository.deleteByIdAndUserAsync(targetId, userId), true);
    assert.equal(await aiCustomPromptsRepository.deleteByIdAndUserAsync(promptId, userId), true);
  } finally {
    await pool.query(`DELETE FROM attachment_references WHERE "noteId" = $1`, [noteId]);
    await pool.query(`DELETE FROM attachments WHERE "noteId" = $1`, [noteId]);
    await pool.query(`DELETE FROM notes WHERE id = $1`, [noteId]);
    await pool.query(`DELETE FROM notebooks WHERE id = $1`, [notebookId]);
    await pool.query(`DELETE FROM api_token_usage WHERE "tokenId" = $1`, [tokenId]);
    await pool.query(`DELETE FROM api_tokens WHERE id = $1`, [tokenId]);
    await pool.query(`DELETE FROM calendar_export_targets WHERE id = $1`, [targetId]);
    await pool.query(`DELETE FROM ai_custom_prompts WHERE id = $1`, [promptId]);
    await pool.query(`DELETE FROM task_calendar_feeds WHERE id = $1`, [feedId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await runtime.resetDatabaseRuntimeForTests();
  }
});
