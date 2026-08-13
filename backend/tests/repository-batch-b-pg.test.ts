import assert from "node:assert/strict";
import test from "node:test";

const databaseUrl = process.env.TEST_PG_DATABASE_URL;
const skip = !databaseUrl;

test("PG Batch B repositories use the runtime adapter", { skip }, async () => {
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

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const userId = `pg-batch-b-user-${suffix}`;
  const projectId = `pg-batch-b-project-${suffix}`;
  const taskA = `pg-batch-b-task-a-${suffix}`;
  const taskB = `pg-batch-b-task-b-${suffix}`;
  const dependencyId = `pg-batch-b-dependency-${suffix}`;

  await pool.query(
    `INSERT INTO users (id, username, "passwordHash") VALUES ($1, $2, $3)`,
    [userId, userId, "hash"],
  );

  try {
    const { userAISettingsRepository } = await import("../src/repositories/userAISettingsRepository");
    await userAISettingsRepository.setManyAsync(userId, [
      { key: "provider", value: "openai" },
      { key: "model", value: "gpt-test" },
    ]);

    assert.deepEqual(
      (await userAISettingsRepository.getManyAsync(userId, ["provider", "model"]))
        .map(({ key, value }) => ({ key, value })),
      [
        { key: "model", value: "gpt-test" },
        { key: "provider", value: "openai" },
      ],
    );

    await userAISettingsRepository.setAsync(userId, "model", "gpt-updated");
    assert.equal((await userAISettingsRepository.getAsync(userId, "model"))?.value, "gpt-updated");
    await userAISettingsRepository.deleteManyAsync(userId, ["provider"]);
    assert.equal(await userAISettingsRepository.getAsync(userId, "provider"), undefined);

    const { taskProjectsRepository } = await import("../src/repositories/taskProjectsRepository");
    await taskProjectsRepository.createAsync({
      id: projectId,
      userId,
      workspaceId: null,
      name: "PG project",
      icon: null,
      color: null,
      sortOrder: 10,
    });

    await pool.query(
      `INSERT INTO tasks (id, "userId", title, "projectId", "isCompleted")
       VALUES ($1, $3, 'Task A', $2, false), ($4, $3, 'Task B', $2, true)`,
      [taskA, projectId, userId, taskB],
    );

    const projects = await taskProjectsRepository.listByUserAsync(userId, null);
    const project = projects.find((item) => item.id === projectId);
    assert.ok(project);
    assert.equal(project.taskCount, 2);
    assert.equal(project.completedCount, 1);
    assert.equal(project.progress, 50);
    assert.equal(typeof project.taskCount, "number");
    assert.equal(typeof project.progress, "number");

    await taskProjectsRepository.updateAsync(projectId, {
      name: "Updated PG project",
      icon: "folder",
      color: "#123456",
      sortOrder: 20,
    });
    await taskProjectsRepository.updateSortOrderAsync([{ id: projectId, sortOrder: 3 }]);
    const updatedProject = await taskProjectsRepository.getByIdWithStatsAsync(projectId);
    assert.equal(updatedProject?.name, "Updated PG project");
    assert.equal(updatedProject?.sortOrder, 3);
    assert.equal(updatedProject?.taskCount, 2);

    const { taskDependenciesRepository } = await import("../src/repositories/taskDependenciesRepository");
    await taskDependenciesRepository.createAsync({
      id: dependencyId,
      userId,
      workspaceId: null,
      predecessorTaskId: taskA,
      successorTaskId: taskB,
      type: "finish_to_start",
    });

    assert.equal(await taskDependenciesRepository.existsAsync(taskA, taskB, "finish_to_start"), true);
    assert.deepEqual(await taskDependenciesRepository.listSuccessorsAsync(taskA), [taskB]);
    assert.equal((await taskDependenciesRepository.listByTaskAsync(taskB, userId, null)).length, 1);

    await taskDependenciesRepository.deleteByTaskIdsAsync([taskA]);
    assert.equal(await taskDependenciesRepository.existsAsync(taskA, taskB, "finish_to_start"), false);

    await taskProjectsRepository.deleteAsync(projectId);
    assert.equal(await taskProjectsRepository.getByIdAsync(projectId), undefined);
    const detachedTasks = await pool.query(
      `SELECT id, "projectId" FROM tasks WHERE id = ANY($1::text[]) ORDER BY id`,
      [[taskA, taskB]],
    );
    assert.deepEqual(detachedTasks.rows.map((row) => row.projectId), [null, null]);
  } finally {
    await pool.query(`DELETE FROM task_dependencies WHERE id = $1`, [dependencyId]);
    await pool.query(`DELETE FROM tasks WHERE id = ANY($1::text[])`, [[taskA, taskB]]);
    await pool.query(`DELETE FROM task_projects WHERE id = $1`, [projectId]);
    await pool.query(`DELETE FROM user_ai_settings WHERE "userId" = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await runtime.resetDatabaseRuntimeForTests();
  }
});
