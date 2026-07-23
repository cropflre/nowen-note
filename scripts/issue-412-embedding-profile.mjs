import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(path, before, after, label) {
  const source = readFileSync(path, "utf8");
  if (source.includes(after)) return;
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, got ${count}`);
  writeFileSync(path, source.replace(before, after));
}

replaceOnce(
  "backend/src/services/ai-client.ts",
  `  ai_model: string;\n  ai_embedding_url: string;`,
  `  ai_model: string;\n  ai_embedding_profile_id: string;\n  ai_embedding_url: string;`,
  "AISettings embedding profile field",
);

replaceOnce(
  "backend/src/routes/ai.ts",
  `  if (body.ai_model !== undefined) entries.push({ key: "ai_model", value: body.ai_model });\n  if (body.ai_embedding_url !== undefined) entries.push({ key: "ai_embedding_url", value: body.ai_embedding_url.replace(/\\/+$/, "") });`,
  `  if (body.ai_model !== undefined) entries.push({ key: "ai_model", value: body.ai_model });\n  if (body.ai_embedding_profile_id !== undefined) entries.push({ key: "ai_embedding_profile_id", value: body.ai_embedding_profile_id.trim() });\n  if (body.ai_embedding_url !== undefined) entries.push({ key: "ai_embedding_url", value: body.ai_embedding_url.replace(/\\/+$/, "") });`,
  "AI settings route profile id",
);

replaceOnce(
  "backend/src/routes/ai-reliable.ts",
  `} from "../services/user-ai-settings";\n`,
  `} from "../services/user-ai-settings";\nimport { resolveEmbeddingConfig } from "../services/embedding-config";\n`,
  "reliable route embedding resolver import",
);

replaceOnce(
  "backend/src/routes/ai-reliable.ts",
  `  "ai_model",\n  "ai_embedding_url",`,
  `  "ai_model",\n  "ai_embedding_profile_id",\n  "ai_embedding_url",`,
  "reliable guarded profile key",
);

replaceOnce(
  "backend/src/routes/ai-reliable.ts",
  `  setUserAISettings(userId, ["ai_embedding_url", "ai_embedding_key", "ai_embedding_model"].map((key) => ({`,
  `  setUserAISettings(userId, ["ai_embedding_profile_id", "ai_embedding_url", "ai_embedding_key", "ai_embedding_model"].map((key) => ({`,
  "restore embedding profile backup",
);

replaceOnce(
  "backend/src/routes/ai-reliable.ts",
  `function publicStatus(scope: Scope) {\n  const settings = getUserAISettings(scope.userId);\n  return {\n    enabled: isUserManualAIEnabled(scope.userId),\n    provider: settings.ai_provider || null,\n    model: settings.ai_model || null,\n    apiHost: apiHost(settings.ai_api_url),\n    embeddingModel: settings.ai_embedding_model || null,\n    scope: {\n      workspaceId: scope.workspaceId,\n      notebookCount: scope.notebookIds?.length || null,\n    },\n    index: getIndexStatus(scope),\n  };\n}`,
  `function publicStatus(scope: Scope) {\n  const settings = getUserAISettings(scope.userId);\n  const embedding = resolveEmbeddingConfig(scope.userId);\n  return {\n    enabled: isUserManualAIEnabled(scope.userId),\n    provider: settings.ai_provider || null,\n    model: settings.ai_model || null,\n    apiHost: apiHost(settings.ai_api_url),\n    embeddingModel: settings.ai_embedding_model || null,\n    embedding: {\n      source: embedding.source,\n      profileId: embedding.profileId,\n      profileName: embedding.profileName,\n      errorCode: embedding.errorCode,\n      error: embedding.error,\n    },\n    scope: {\n      workspaceId: scope.workspaceId,\n      notebookCount: scope.notebookIds?.length || null,\n    },\n    index: getIndexStatus(scope),\n  };\n}`,
  "public embedding profile status",
);

replaceOnce(
  "backend/src/services/embedding-worker.ts",
  `import { getUserAISettings } from "./user-ai-settings";`,
  `import { resolveEmbeddingConfig, type EmbeddingConfig } from "./embedding-config";`,
  "embedding resolver import",
);

replaceOnce(
  "backend/src/services/embedding-worker.ts",
  `interface EmbeddingConfig {\n  url: string;            // 已规范化（去尾斜杠）\n  model: string;\n  apiKey: string;         // 可空（Ollama 等本地模型）\n  provider: string;       // 透传 ai_provider，用于潜在 provider-specific 适配\n}\n\nfunction readEmbeddingConfig(userId: string): EmbeddingConfig | null {\n  const settings = getUserAISettings(userId);\n  const model = settings.ai_embedding_model.trim();\n  if (!model) return null;\n\n  const embeddingUrl = settings.ai_embedding_url.trim();\n  const apiUrl = settings.ai_api_url.trim();\n  const url = (embeddingUrl || apiUrl).replace(/\\/+$/, "");\n  if (!url) return null;\n\n  const embeddingKey = settings.ai_embedding_key.trim();\n  const apiKey = embeddingKey || settings.ai_api_key.trim();\n  const provider = settings.ai_provider.trim();\n\n  // Ollama 是少数允许空 key 的 provider；其它 provider 一般必须给 key\n  if (!apiKey && provider !== "ollama") {\n    // 仍然返回配置，让 worker 尝试一次；如果接口确实需要 key 会以 401 失败标 failed\n    // 这样用户在 UI 上能看到具体错误，而不是"为啥 worker 一直不跑"\n  }\n\n  return { url, model, apiKey, provider };\n}\n`,
  ``,
  "remove legacy embedding config resolver",
);

replaceOnce(
  "backend/src/services/embedding-worker.ts",
  `    // 只领取已配置 embedding 模型的用户任务；URL 的默认/回退规则统一由\n    // readEmbeddingConfig 处理，避免队列与查询路径对同一配置得出不同结论。\n    const tasks = db.prepare(\`\n      SELECT q.noteId, q.userId, q.retries\n      FROM embedding_queue q\n      WHERE q.status = 'pending' AND q.retries < ?\n        AND EXISTS (\n          SELECT 1 FROM user_ai_settings model\n          WHERE model.userId = q.userId\n            AND model.key = 'ai_embedding_model'\n            AND trim(model.value) <> ''\n        )\n        AND (\n          EXISTS (\n            SELECT 1 FROM user_ai_settings embedding_url\n            WHERE embedding_url.userId = q.userId\n              AND embedding_url.key = 'ai_embedding_url'\n              AND trim(embedding_url.value) <> ''\n          )\n          OR EXISTS (\n            SELECT 1 FROM user_ai_settings api_url\n            WHERE api_url.userId = q.userId\n              AND api_url.key = 'ai_api_url'\n              AND trim(api_url.value) <> ''\n          )\n          OR NOT EXISTS (\n            SELECT 1 FROM user_ai_settings explicit_api_url\n            WHERE explicit_api_url.userId = q.userId\n              AND explicit_api_url.key = 'ai_api_url'\n          )\n        )\n      ORDER BY q.enqueuedAt ASC\n      LIMIT ?\n    \`).all(MAX_RETRIES, BATCH_SIZE) as Array<{ noteId: string; userId: string; retries: number }>;`,
  `    // The model row is the inexpensive SQL eligibility check. URL/key/profile resolution stays\n    // in one TypeScript resolver so fixed profiles, custom credentials and chat fallback agree.\n    const tasks = db.prepare(\`\n      SELECT q.noteId, q.userId, q.retries\n      FROM embedding_queue q\n      WHERE q.status = 'pending' AND q.retries < ?\n        AND EXISTS (\n          SELECT 1 FROM user_ai_settings model\n          WHERE model.userId = q.userId\n            AND model.key = 'ai_embedding_model'\n            AND trim(model.value) <> ''\n        )\n      ORDER BY q.enqueuedAt ASC\n      LIMIT ?\n    \`).all(MAX_RETRIES, BATCH_SIZE) as Array<{ noteId: string; userId: string; retries: number }>;`,
  "note queue eligibility",
);

replaceOnce(
  "backend/src/services/embedding-worker.ts",
  `    for (const task of tasks) {\n      const cfg = readEmbeddingConfig(task.userId);\n      if (!cfg) continue;\n      embeddingQueueRepository.markProcessing(task.noteId);`,
  `    for (const task of tasks) {\n      const resolution = resolveEmbeddingConfig(task.userId);\n      if (!resolution.config) {\n        embeddingQueueRepository.updateStatus(\n          task.noteId,\n          "failed",\n          MAX_RETRIES,\n          (resolution.error || "Embedding 配置不可用").slice(0, 500),\n        );\n        continue;\n      }\n      const cfg = resolution.config;\n      embeddingQueueRepository.markProcessing(task.noteId);`,
  "note queue profile resolution",
);

replaceOnce(
  "backend/src/services/embedding-worker.ts",
  `          WHERE q.status = 'pending' AND q.retries < ?\n            AND EXISTS (\n              SELECT 1 FROM user_ai_settings model\n              WHERE model.userId = q.userId\n                AND model.key = 'ai_embedding_model'\n                AND trim(model.value) <> ''\n            )\n            AND (\n              EXISTS (\n                SELECT 1 FROM user_ai_settings embedding_url\n                WHERE embedding_url.userId = q.userId\n                  AND embedding_url.key = 'ai_embedding_url'\n                  AND trim(embedding_url.value) <> ''\n              )\n              OR EXISTS (\n                SELECT 1 FROM user_ai_settings api_url\n                WHERE api_url.userId = q.userId\n                  AND api_url.key = 'ai_api_url'\n                  AND trim(api_url.value) <> ''\n              )\n              OR NOT EXISTS (\n                SELECT 1 FROM user_ai_settings explicit_api_url\n                WHERE explicit_api_url.userId = q.userId\n                  AND explicit_api_url.key = 'ai_api_url'\n              )\n            )\n          ORDER BY q.enqueuedAt ASC`,
  `          WHERE q.status = 'pending' AND q.retries < ?\n            AND EXISTS (\n              SELECT 1 FROM user_ai_settings model\n              WHERE model.userId = q.userId\n                AND model.key = 'ai_embedding_model'\n                AND trim(model.value) <> ''\n            )\n          ORDER BY q.enqueuedAt ASC`,
  "attachment queue eligibility",
);

replaceOnce(
  "backend/src/services/embedding-worker.ts",
  `    for (const task of tasks) {\n      const cfg = readEmbeddingConfig(task.userId);\n      if (!cfg) continue;\n      markProcessing.run(task.attachmentId);`,
  `    for (const task of tasks) {\n      const resolution = resolveEmbeddingConfig(task.userId);\n      if (!resolution.config) {\n        db.prepare(\n          \`UPDATE attachment_embedding_queue\n              SET status = 'failed', retries = ?, lastError = ?, updatedAt = datetime('now')\n            WHERE attachmentId = ?\`,\n        ).run(MAX_RETRIES, (resolution.error || "Embedding 配置不可用").slice(0, 500), task.attachmentId);\n        continue;\n      }\n      const cfg = resolution.config;\n      markProcessing.run(task.attachmentId);`,
  "attachment queue profile resolution",
);

replaceOnce(
  "backend/src/services/embedding-worker.ts",
  `  const cfg = readEmbeddingConfig(opts.userId);`,
  `  const resolution = resolveEmbeddingConfig(opts.userId);\n  const cfg = resolution.config;`,
  "embedding stats profile resolution",
);

replaceOnce(
  "backend/src/services/embedding-worker.ts",
  `  const cfg = readEmbeddingConfig(userId);\n  if (!cfg) return null;`,
  `  const cfg = resolveEmbeddingConfig(userId).config;\n  if (!cfg) return null;`,
  "query profile resolution",
);

replaceOnce(
  "frontend/src/lib/aiReliable.ts",
  `  embeddingModel: string | null;\n  scope: {`,
  `  embeddingModel: string | null;\n  embedding?: {\n    source: "chat" | "profile" | "custom";\n    profileId: string | null;\n    profileName: string | null;\n    errorCode: string | null;\n    error: string | null;\n  };\n  scope: {`,
  "frontend reliable embedding status",
);

replaceOnce(
  "backend/tests/user-ai-settings-isolation.test.ts",
  `    ai_model: "model-a",\n    ai_embedding_url: "",`,
  `    ai_model: "model-a",\n    ai_embedding_profile_id: "",\n    ai_embedding_url: "",`,
  "settings service expected profile id",
);

replaceOnce(
  "backend/tests/user-ai-settings-isolation.test.ts",
  `      ai_model: "route-a-model",\n    }),`,
  `      ai_model: "route-a-model",\n      ai_embedding_profile_id: "route-a-embedding-profile",\n    }),`,
  "settings route profile id input",
);

replaceOnce(
  "backend/tests/user-ai-settings-isolation.test.ts",
  `  assert.equal(userABody.ai_api_key_set, true);\n  assert.equal(userBBody.ai_api_url, "https://api.openai.com/v1");`,
  `  assert.equal(userABody.ai_api_key_set, true);\n  assert.equal(userABody.ai_embedding_profile_id, "route-a-embedding-profile");\n  assert.equal(userBBody.ai_embedding_profile_id, "");\n  assert.equal(userBBody.ai_api_url, "https://api.openai.com/v1");`,
  "settings route profile id assertions",
);

replaceOnce(
  "backend/tests/embedding-user-ai-settings.test.ts",
  `  schema.getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("embed-whitespace", "embed-whitespace", "hash");`,
  `  schema.getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("embed-whitespace", "embed-whitespace", "hash");\n  schema.getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("embed-profile", "embed-profile", "hash");`,
  "embedding profile test user",
);

replaceOnce(
  "backend/tests/embedding-user-ai-settings.test.ts",
  `test("blank embedding URL falls back after trimming", async () => {`,
  `test("embedQuery uses a fixed saved profile instead of the active chat credentials", async () => {\n  setUserAISettings("embed-profile", [\n    { key: "ai_provider", value: "deepseek" },\n    { key: "ai_api_url", value: "https://chat.example/v1" },\n    { key: "ai_api_key", value: "chat-key" },\n    { key: "ai_profiles_v1", value: JSON.stringify([{\n      id: "profile-fixed",\n      name: "Fixed",\n      provider: "openai",\n      apiUrl: "https://fixed.example/v1",\n      apiKey: "fixed-key",\n      model: "chat-only-model",\n    }]) },\n    { key: "ai_embedding_profile_id", value: "profile-fixed" },\n    { key: "ai_embedding_model", value: "fixed-embedding-model" },\n  ]);\n\n  let request: { url: string; authorization: string; model: string } | null = null;\n  const originalFetch = globalThis.fetch;\n  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {\n    request = {\n      url: String(input),\n      authorization: new Headers(init?.headers).get("authorization") || "",\n      model: JSON.parse(String(init?.body)).model,\n    };\n    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }), {\n      status: 200,\n      headers: { "content-type": "application/json" },\n    });\n  }) as typeof fetch;\n\n  try {\n    await embedQuery("embed-profile", "profile question");\n  } finally {\n    globalThis.fetch = originalFetch;\n  }\n\n  assert.deepEqual(request, {\n    url: "https://fixed.example/v1/embeddings",\n    authorization: "Bearer fixed-key",\n    model: "fixed-embedding-model",\n  });\n});\n\ntest("blank embedding URL falls back after trimming", async () => {`,
  "worker fixed profile test",
);

console.log("Issue #412 embedding profile patch applied.");
