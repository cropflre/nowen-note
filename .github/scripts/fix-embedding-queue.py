from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8-sig")


def write(path: str, value: str) -> None:
    Path(path).write_text(value, encoding="utf-8")


def replace_once(source: str, old: str, new: str, path: str) -> str:
    if old not in source:
        raise SystemExit(f"{path}: missing anchor: {old[:120]!r}")
    return source.replace(old, new, 1)


vec_path = "backend/src/services/vec-store.ts"
vec = read(vec_path)
vec = replace_once(
    vec,
    "let currentDim: number | null = null; // 当前 vec0 表使用的维度；未建表时为 null\n",
    "let currentDim: number | null = null; // 当前 vec0 表使用的维度；未建表时为 null\nlet loadError: string | null = null; // 最近一次扩展加载错误，供状态页诊断\n",
    vec_path,
)
vec = replace_once(
    vec,
    "    return { loaded, dim: currentDim };\n",
    "    return { loaded, dim: currentDim, ...(loadError ? { error: loadError } : {}) };\n",
    vec_path,
)
vec = replace_once(
    vec,
    "    sqliteVec.load(db);\n    loaded = true;\n",
    "    sqliteVec.load(db);\n    loaded = true;\n    loadError = null;\n",
    vec_path,
)
vec = replace_once(
    vec,
    "    const msg = e?.message || String(e);\n    console.warn(\"[vec-store] sqlite-vec load failed, falling back to BM25-only:\", msg);\n",
    "    const msg = e?.message || String(e);\n    loadError = msg;\n    console.warn(\"[vec-store] sqlite-vec load failed, falling back to BM25-only:\", msg);\n",
    vec_path,
)
vec = replace_once(
    vec,
    "export function getVecDim(): number | null {\n  return currentDim;\n}\n",
    """export function getVecDim(): number | null {
  return currentDim;
}

export interface VecStoreStatus {
  loadAttempted: boolean;
  loaded: boolean;
  initialized: boolean;
  dim: number | null;
  error: string | null;
}

/** 提供给状态接口的只读运行时诊断，不触发重复加载。 */
export function getVecStoreStatus(): VecStoreStatus {
  return {
    loadAttempted,
    loaded,
    initialized: loaded && currentDim !== null,
    dim: currentDim,
    error: loadError,
  };
}
""",
    vec_path,
)
write(vec_path, vec)

worker_path = "backend/src/services/embedding-worker.ts"
worker = read(worker_path)
worker = replace_once(
    worker,
    "  getVecDim,\n  clearAllVectors,\n",
    "  getVecDim,\n  getVecStoreStatus,\n  clearAllVectors,\n",
    worker_path,
)
worker = replace_once(
    worker,
    "    if (tasks.length === 0) return;\n",
    "    if (tasks.length === 0) {\n      await tickAttachments();\n      return;\n    }\n",
    worker_path,
)
worker = replace_once(
    worker,
    "        await sleep(500);\n      }\n    }\n  } catch (e) {\n",
    "        await sleep(500);\n      }\n    }\n\n    await tickAttachments();\n  } catch (e) {\n",
    worker_path,
)
worker = replace_once(
    worker,
    "\n  // ---- 附件任务：与笔记任务同一个 tick，共享 BATCH_SIZE 的\"大轮询\"节奏 ----\n  // 放在 finally 之外的独立 try/catch：笔记分支出错不影响附件分支，反之亦然。\n  await tickAttachments();\n}\n",
    "\n}\n",
    worker_path,
)
recovery = """
/**
 * 恢复上一次进程退出时遗留的 processing 任务。
 *
 * 当前 worker 是单进程串行模型；新进程启动时不可能仍有合法的旧 worker 持有任务，
 * 因此可以安全地把全部 processing 原子退回 pending，且不增加 provider 失败重试次数。
 */
export function recoverInterruptedEmbeddingJobs(): { notes: number; attachments: number } {
  const db = getDb();
  let notes = 0;
  let attachments = 0;
  const tx = db.transaction(() => {
    notes = db.prepare(
      `UPDATE embedding_queue
          SET status = 'pending',
              lastError = 'recovered: worker restarted during processing',
              updatedAt = datetime('now')
        WHERE status = 'processing'`,
    ).run().changes;
    attachments = db.prepare(
      `UPDATE attachment_embedding_queue
          SET status = 'pending',
              lastError = 'recovered: worker restarted during processing',
              updatedAt = datetime('now')
        WHERE status = 'processing'`,
    ).run().changes;
  });
  tx();
  return { notes, attachments };
}

"""
worker = replace_once(
    worker,
    "/** 启动 worker（幂等）。在 index.ts 启动时调用一次即可。 */\nexport function startEmbeddingWorker(): void {\n  if (timer) return;\n  stopped = false;\n",
    recovery + "/** 启动 worker（幂等）。在 index.ts 启动时调用一次即可。 */\nexport function startEmbeddingWorker(): void {\n  if (timer) return;\n  stopped = false;\n  const recovered = recoverInterruptedEmbeddingJobs();\n  if (recovered.notes > 0 || recovered.attachments > 0) {\n    console.warn(`[embedding-worker] recovered interrupted jobs: notes=${recovered.notes}, attachments=${recovered.attachments}`);\n  }\n",
    worker_path,
)
worker = replace_once(
    worker,
    "  vecAvailable: boolean;\n  vecDim: number | null;\n",
    "  vecAvailable: boolean;\n  vecLoaded: boolean;\n  vecLoadAttempted: boolean;\n  vecError: string | null;\n  vecDim: number | null;\n",
    worker_path,
)
worker = replace_once(
    worker,
    "  const db = getDb();\n  const cfg = readEmbeddingConfig(opts.userId);\n\n  const conds: string[] = [];\n",
    "  const db = getDb();\n  const cfg = readEmbeddingConfig(opts.userId);\n  const vecStatus = getVecStoreStatus();\n\n  const conds: string[] = [];\n",
    worker_path,
)
worker = replace_once(
    worker,
    "    vecAvailable: isVecAvailable(),\n    vecDim: getVecDim(),\n",
    "    vecAvailable: vecStatus.initialized,\n    vecLoaded: vecStatus.loaded,\n    vecLoadAttempted: vecStatus.loadAttempted,\n    vecError: vecStatus.error,\n    vecDim: vecStatus.dim,\n",
    worker_path,
)
write(worker_path, worker)

route_path = "backend/src/routes/ai-reliable.ts"
route = read(route_path)
route = replace_once(
    route,
    "  const stale = pending > 0 || processing > 0 || (\n    !!newest.at && (!lastIndexed.at || Date.parse(newest.at) > Date.parse(lastIndexed.at))\n  );\n  return {\n",
    """  const stale = pending > 0 || processing > 0 || (
    !!newest.at && (!lastIndexed.at || Date.parse(newest.at) > Date.parse(lastIndexed.at))
  );
  const vectorState = !stats.configured
    ? "not_configured"
    : stats.vecAvailable
      ? "ready"
      : !stats.vecLoaded
        ? "unavailable"
        : pending > 0 || processing > 0
          ? "initializing"
          : failed > 0
            ? "error"
            : "waiting";
  return {
""",
    route_path,
)
route = replace_once(
    route,
    "    vectorAvailable: stats.vecAvailable,\n    vectorDimension: stats.vecDim,\n    stale,\n",
    "    vectorAvailable: stats.vecAvailable,\n    vectorState,\n    vectorError: stats.vecError,\n    vectorDimension: stats.vecDim,\n    stale,\n",
    route_path,
)
write(route_path, route)

client_path = "frontend/src/lib/aiReliable.ts"
client = read(client_path)
client = replace_once(
    client,
    "    vectorAvailable: boolean;\n    vectorDimension: number | null;\n",
    "    vectorAvailable: boolean;\n    vectorState: \"not_configured\" | \"initializing\" | \"waiting\" | \"ready\" | \"unavailable\" | \"error\";\n    vectorError: string | null;\n    vectorDimension: number | null;\n",
    client_path,
)
write(client_path, client)

panel_path = "frontend/src/components/EmbeddingSettingsPanel.tsx"
panel = read(panel_path)
panel = replace_once(
    panel,
    "      ready: \"Ready\",\n      unavailable: \"Unavailable\",\n",
    "      ready: \"Ready\",\n      initializing: \"Initializing\",\n      waiting: \"Waiting for first vector\",\n      degraded: \"Keyword search only\",\n      engineError: \"Indexing error\",\n      engineNotConfigured: \"Not configured\",\n",
    panel_path,
)
panel = replace_once(
    panel,
    "    ready: \"可用\",\n    unavailable: \"不可用\",\n",
    "    ready: \"可用\",\n    initializing: \"初始化中\",\n    waiting: \"等待首个向量\",\n    degraded: \"仅关键词检索\",\n    engineError: \"索引任务异常\",\n    engineNotConfigured: \"未配置\",\n",
    panel_path,
)
panel = replace_once(
    panel,
    "  const index = status?.index;\n  const busy = loading || saving || rebuilding;\n\n  return (\n",
    """  const index = status?.index;
  const vectorState = index?.vectorState
    || (index?.vectorAvailable ? "ready" : index?.configured && queuedJobs > 0 ? "initializing" : "unavailable");
  const vectorLabel = vectorState === "ready"
    ? copy.ready
    : vectorState === "initializing"
      ? copy.initializing
      : vectorState === "waiting"
        ? copy.waiting
        : vectorState === "error"
          ? copy.engineError
          : vectorState === "not_configured"
            ? copy.engineNotConfigured
            : copy.degraded;
  const busy = loading || saving || rebuilding;

  return (
""",
    panel_path,
)
old_card = """            <div className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/60">
              <div className="text-[11px] text-zinc-500">{copy.vectorEngine}</div>
              <div className={cn(
                "mt-1 text-xs font-semibold",
                index?.vectorAvailable ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
              )}>
                {index?.vectorAvailable ? copy.ready : copy.unavailable}
                {index?.vectorDimension ? ` · ${index.vectorDimension} ${copy.dimension}` : ""}
              </div>
            </div>"""
new_card = """            <div className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/60">
              <div className="text-[11px] text-zinc-500">{copy.vectorEngine}</div>
              <div className={cn(
                "mt-1 text-xs font-semibold",
                vectorState === "ready"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : vectorState === "initializing" || vectorState === "waiting"
                    ? "text-blue-600 dark:text-blue-400"
                    : vectorState === "not_configured"
                      ? "text-zinc-500 dark:text-zinc-400"
                      : "text-amber-600 dark:text-amber-400",
              )}>
                {vectorLabel}
                {index?.vectorDimension ? ` · ${index.vectorDimension} ${copy.dimension}` : ""}
              </div>
              {index?.vectorError && (
                <div className="mt-1 truncate text-[10px] text-amber-600/80 dark:text-amber-400/80" title={index.vectorError}>
                  {index.vectorError}
                </div>
              )}
            </div>"""
panel = replace_once(panel, old_card, new_card, panel_path)
write(panel_path, panel)

test_path = "backend/tests/embedding-user-ai-settings.test.ts"
test_source = read(test_path)
test_source = replace_once(
    test_source,
    "let stopEmbeddingWorker: typeof import(\"../src/services/embedding-worker\").stopEmbeddingWorker;\n",
    "let stopEmbeddingWorker: typeof import(\"../src/services/embedding-worker\").stopEmbeddingWorker;\nlet recoverInterruptedEmbeddingJobs: typeof import(\"../src/services/embedding-worker\").recoverInterruptedEmbeddingJobs;\n",
    test_path,
)
test_source = replace_once(
    test_source,
    "  stopEmbeddingWorker = worker.stopEmbeddingWorker;\n",
    "  stopEmbeddingWorker = worker.stopEmbeddingWorker;\n  recoverInterruptedEmbeddingJobs = worker.recoverInterruptedEmbeddingJobs;\n",
    test_path,
)
test_source += """

test("worker recovery requeues interrupted note and attachment jobs", () => {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("embed-recovery", "embed-recovery", "hash");
  db.prepare("INSERT OR IGNORE INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run("embed-recovery-notebook", "embed-recovery", "Recovery");
  db.prepare("INSERT OR IGNORE INTO notes (id, userId, notebookId, title, contentText) VALUES (?, ?, ?, ?, ?)")
    .run("embed-recovery-note", "embed-recovery", "embed-recovery-notebook", "Recovery title", "Recovery body is long enough");
  db.prepare("UPDATE embedding_queue SET status = 'processing' WHERE noteId = ?")
    .run("embed-recovery-note");
  db.prepare(`INSERT OR REPLACE INTO attachment_embedding_queue
    (attachmentId, userId, workspaceId, noteId, status, retries, enqueuedAt, updatedAt)
    VALUES (?, ?, NULL, ?, 'processing', 0, datetime('now'), datetime('now'))`)
    .run("embed-recovery-attachment", "embed-recovery", "embed-recovery-note");

  const recovered = recoverInterruptedEmbeddingJobs();
  assert.deepEqual(recovered, { notes: 1, attachments: 1 });
  assert.equal(
    (db.prepare("SELECT status FROM embedding_queue WHERE noteId = ?").get("embed-recovery-note") as { status: string }).status,
    "pending",
  );
  assert.equal(
    (db.prepare("SELECT status FROM attachment_embedding_queue WHERE attachmentId = ?").get("embed-recovery-attachment") as { status: string }).status,
    "pending",
  );
});

test("attachment polling remains inside the worker running guard", () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), "src/services/embedding-worker.ts"), "utf8");
  assert.doesNotMatch(source, /if \(tasks\.length === 0\) return;/);
  assert.match(source, /if \(tasks\.length === 0\) \{\s*await tickAttachments\(\);\s*return;/);
  const finalTick = source.indexOf("await tickAttachments();", source.indexOf("for (const task of tasks)"));
  const releaseGuard = source.indexOf("running = false", finalTick);
  assert.ok(finalTick >= 0 && releaseGuard > finalTick);
});
"""
write(test_path, test_source)

for path, forbidden in {
    worker_path: ["if (tasks.length === 0) return;"],
    panel_path: ["index?.vectorAvailable ? copy.ready : copy.unavailable"],
}.items():
    source = read(path)
    for token in forbidden:
        if token in source:
            raise SystemExit(f"{path}: forbidden remnant {token!r}")
