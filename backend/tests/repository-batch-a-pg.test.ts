import assert from "node:assert/strict";
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

  await pool.query(
    `INSERT INTO users (id, username, "passwordHash") VALUES ($1, $2, $3)`,
    [userId, userId, "hash"],
  );
  await pool.query(
    `INSERT INTO task_calendar_feeds (id, "userId", token) VALUES ($1, $2, $3)`,
    [feedId, userId, `${userId}-token`],
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

    assert.equal(await calendarExportTargetsRepository.deleteByIdAndUserAsync(targetId, userId), true);
    assert.equal(await aiCustomPromptsRepository.deleteByIdAndUserAsync(promptId, userId), true);
  } finally {
    await pool.query(`DELETE FROM calendar_export_targets WHERE id = $1`, [targetId]);
    await pool.query(`DELETE FROM ai_custom_prompts WHERE id = $1`, [promptId]);
    await pool.query(`DELETE FROM task_calendar_feeds WHERE id = $1`, [feedId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await runtime.resetDatabaseRuntimeForTests();
  }
});
