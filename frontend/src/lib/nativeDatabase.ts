import { Capacitor } from "@capacitor/core";
import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from "@capacitor-community/sqlite";

export interface NativeDatabase {
  run(
    sql: string,
    values?: unknown[],
  ): Promise<{ changes: number; lastId?: number }>;
  query<T>(sql: string, values?: unknown[]): Promise<T[]>;
  transaction<T>(work: (tx: NativeDatabase) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface CachedDatabase {
  openPromise: Promise<NativeDatabaseImpl>;
  closePromise?: Promise<void>;
}

interface NativeDatabaseGlobalState {
  connection: SQLiteConnection;
  databases: Map<string, CachedDatabase>;
  lifecycleQueue: Promise<void>;
}

type NativeDatabaseGlobal = typeof globalThis & {
  __nowenNoteNativeDatabaseState?: NativeDatabaseGlobalState;
};

const SCHEMA_VERSION = 1;
const DATABASE_PREFIX = "nowen_local_";

const ENTITY_TYPE_CHECK = `
  'notebook', 'note', 'tag', 'note_tag', 'favorite', 'attachment',
  'task', 'task_reminder', 'diary', 'mindmap'
`;

const SCOPE_CHECK = `
  (scopeKey = 'personal' AND workspaceId IS NULL)
  OR (
    workspaceId IS NOT NULL
    AND workspaceId <> ''
    AND scopeKey = 'workspace:' || workspaceId
  )
`;

const SCHEMA_V1_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS notebooks (
    id TEXT NOT NULL,
    scopeKey TEXT NOT NULL DEFAULT 'personal',
    workspaceId TEXT,
    userId TEXT NOT NULL,
    parentId TEXT,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT NOT NULL DEFAULT '📒',
    color TEXT,
    sortOrder INTEGER NOT NULL DEFAULT 0,
    isExpanded INTEGER NOT NULL DEFAULT 1 CHECK (isExpanded IN (0, 1)),
    isDeleted INTEGER NOT NULL DEFAULT 0 CHECK (isDeleted IN (0, 1)),
    deletedAt TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (scopeKey, id),
    FOREIGN KEY (scopeKey, parentId)
      REFERENCES notebooks(scopeKey, id) ON DELETE CASCADE,
    CHECK (${SCOPE_CHECK})
  )`,
  `CREATE INDEX IF NOT EXISTS idx_native_notebooks_scope_parent
    ON notebooks(scopeKey, parentId, isDeleted, sortOrder)`,
  `CREATE INDEX IF NOT EXISTS idx_native_notebooks_workspace
    ON notebooks(workspaceId, updatedAt)`,

  `CREATE TABLE IF NOT EXISTS notes (
    id TEXT NOT NULL,
    scopeKey TEXT NOT NULL DEFAULT 'personal',
    workspaceId TEXT,
    userId TEXT NOT NULL,
    notebookId TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '无标题笔记',
    content TEXT NOT NULL DEFAULT '{}',
    contentText TEXT NOT NULL DEFAULT '',
    contentFormat TEXT NOT NULL DEFAULT 'tiptap-json',
    isPinned INTEGER NOT NULL DEFAULT 0 CHECK (isPinned IN (0, 1)),
    isFavorite INTEGER NOT NULL DEFAULT 0 CHECK (isFavorite IN (0, 1)),
    isLocked INTEGER NOT NULL DEFAULT 0 CHECK (isLocked IN (0, 1)),
    isArchived INTEGER NOT NULL DEFAULT 0 CHECK (isArchived IN (0, 1)),
    isTrashed INTEGER NOT NULL DEFAULT 0 CHECK (isTrashed IN (0, 1)),
    trashedAt TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    sortOrder INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (scopeKey, id),
    FOREIGN KEY (scopeKey, notebookId)
      REFERENCES notebooks(scopeKey, id) ON DELETE CASCADE,
    CHECK (${SCOPE_CHECK})
  )`,
  `CREATE INDEX IF NOT EXISTS idx_native_notes_scope_notebook
    ON notes(scopeKey, notebookId, isTrashed, isArchived, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_native_notes_scope_updated
    ON notes(scopeKey, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_native_notes_workspace
    ON notes(workspaceId, updatedAt)`,

  `CREATE TABLE IF NOT EXISTS tags (
    id TEXT NOT NULL,
    scopeKey TEXT NOT NULL DEFAULT 'personal',
    workspaceId TEXT,
    userId TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#58a6ff',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (scopeKey, id),
    UNIQUE (scopeKey, name),
    CHECK (${SCOPE_CHECK})
  )`,
  `CREATE INDEX IF NOT EXISTS idx_native_tags_workspace
    ON tags(workspaceId, name)`,

  `CREATE TABLE IF NOT EXISTS note_tags (
    scopeKey TEXT NOT NULL DEFAULT 'personal',
    workspaceId TEXT,
    noteId TEXT NOT NULL,
    tagId TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    PRIMARY KEY (scopeKey, noteId, tagId),
    FOREIGN KEY (scopeKey, noteId)
      REFERENCES notes(scopeKey, id) ON DELETE CASCADE,
    FOREIGN KEY (scopeKey, tagId)
      REFERENCES tags(scopeKey, id) ON DELETE CASCADE,
    CHECK (${SCOPE_CHECK})
  )`,
  `CREATE INDEX IF NOT EXISTS idx_native_note_tags_tag
    ON note_tags(scopeKey, tagId, noteId)`,

  `CREATE TABLE IF NOT EXISTS favorites (
    scopeKey TEXT NOT NULL DEFAULT 'personal',
    workspaceId TEXT,
    userId TEXT NOT NULL,
    noteId TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    PRIMARY KEY (scopeKey, userId, noteId),
    FOREIGN KEY (scopeKey, noteId)
      REFERENCES notes(scopeKey, id) ON DELETE CASCADE,
    CHECK (${SCOPE_CHECK})
  )`,
  `CREATE INDEX IF NOT EXISTS idx_native_favorites_scope_created
    ON favorites(scopeKey, createdAt)`,

  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT NOT NULL,
    scopeKey TEXT NOT NULL DEFAULT 'personal',
    workspaceId TEXT,
    noteId TEXT NOT NULL,
    userId TEXT NOT NULL,
    filename TEXT NOT NULL,
    mimeType TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    localPath TEXT,
    hash TEXT,
    available INTEGER NOT NULL DEFAULT 0 CHECK (available IN (0, 1)),
    transferStatus TEXT NOT NULL DEFAULT 'remote' CHECK (
      transferStatus IN (
        'local', 'pending_upload', 'uploading', 'uploaded',
        'remote', 'pending_download', 'downloading', 'ready', 'failed'
      )
    ),
    transferError TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (scopeKey, id),
    FOREIGN KEY (scopeKey, noteId)
      REFERENCES notes(scopeKey, id) ON DELETE CASCADE,
    CHECK (${SCOPE_CHECK}),
    CHECK (available = 0 OR localPath IS NOT NULL)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_native_attachments_scope_note
    ON attachments(scopeKey, noteId, createdAt)`,
  `CREATE INDEX IF NOT EXISTS idx_native_attachments_transfer
    ON attachments(transferStatus, updatedAt)`,
  `CREATE INDEX IF NOT EXISTS idx_native_attachments_hash
    ON attachments(hash) WHERE hash IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS sync_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    serverUrl TEXT NOT NULL,
    remoteUserId TEXT,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    authStatus TEXT NOT NULL DEFAULT 'ready' CHECK (
      authStatus IN ('ready', 'auth_required')
    ),
    bootstrapStatus TEXT NOT NULL DEFAULT 'pending' CHECK (
      bootstrapStatus IN (
        'pending', 'preparing', 'pulling', 'reconciling',
        'pushing', 'verifying', 'ready', 'failed'
      )
    ),
    bootstrapCursor TEXT,
    bootstrapSequence INTEGER,
    bootstrapError TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_native_sync_profiles_server_user
    ON sync_profiles(serverUrl, remoteUserId)
    WHERE remoteUserId IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_native_sync_profiles_single_active
    ON sync_profiles(enabled) WHERE enabled = 1`,

  `CREATE TABLE IF NOT EXISTS sync_devices (
    profileId TEXT NOT NULL,
    deviceId TEXT NOT NULL,
    deviceName TEXT,
    platform TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    lastSeenAt TEXT,
    PRIMARY KEY (profileId, deviceId),
    FOREIGN KEY (profileId) REFERENCES sync_profiles(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_native_sync_devices_device
    ON sync_devices(deviceId)`,

  `CREATE TABLE IF NOT EXISTS sync_state (
    profileId TEXT NOT NULL,
    scopeKey TEXT NOT NULL,
    lastSequence INTEGER NOT NULL DEFAULT 0,
    lastSyncAt TEXT,
    lastError TEXT,
    accessFingerprint TEXT,
    accessStatus TEXT NOT NULL DEFAULT 'active' CHECK (
      accessStatus IN ('active', 'replan_required', 'access_revoked')
    ),
    accessChangedAt TEXT,
    PRIMARY KEY (profileId, scopeKey),
    FOREIGN KEY (profileId) REFERENCES sync_profiles(id) ON DELETE CASCADE,
    CHECK (scopeKey = 'personal' OR (
      scopeKey LIKE 'workspace:%' AND length(scopeKey) > 10
    ))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_native_sync_state_access
    ON sync_state(profileId, accessStatus)`,

  `CREATE TABLE IF NOT EXISTS sync_outbox (
    id TEXT PRIMARY KEY,
    mutationId TEXT NOT NULL UNIQUE,
    profileId TEXT NOT NULL,
    deviceId TEXT NOT NULL,
    scopeKey TEXT NOT NULL,
    entityType TEXT NOT NULL CHECK (entityType IN (${ENTITY_TYPE_CHECK})),
    entityId TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
    baseVersion INTEGER,
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending', 'inflight', 'failed')
    ),
    retryCount INTEGER NOT NULL DEFAULT 0,
    lastAttemptAt TEXT,
    lastError TEXT,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (profileId, deviceId)
      REFERENCES sync_devices(profileId, deviceId) ON DELETE CASCADE,
    CHECK (scopeKey = 'personal' OR (
      scopeKey LIKE 'workspace:%' AND length(scopeKey) > 10
    ))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_native_sync_outbox_pending
    ON sync_outbox(profileId, scopeKey, status, createdAt)`,
  `CREATE INDEX IF NOT EXISTS idx_native_sync_outbox_entity
    ON sync_outbox(profileId, scopeKey, entityType, entityId, status)`,

  `CREATE TABLE IF NOT EXISTS sync_conflicts (
    id TEXT PRIMARY KEY,
    profileId TEXT NOT NULL,
    scopeKey TEXT NOT NULL,
    entityType TEXT NOT NULL CHECK (entityType IN (${ENTITY_TYPE_CHECK})),
    entityId TEXT NOT NULL,
    localVersion INTEGER,
    remoteVersion INTEGER,
    basePayload TEXT,
    localPayload TEXT,
    remotePayload TEXT,
    status TEXT NOT NULL DEFAULT 'unresolved' CHECK (
      status IN ('unresolved', 'resolved')
    ),
    createdAt TEXT NOT NULL,
    resolvedAt TEXT,
    FOREIGN KEY (profileId) REFERENCES sync_profiles(id) ON DELETE CASCADE,
    CHECK (scopeKey = 'personal' OR (
      scopeKey LIKE 'workspace:%' AND length(scopeKey) > 10
    ))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_native_sync_conflicts_unresolved
    ON sync_conflicts(profileId, scopeKey, status, createdAt)`,
  `CREATE INDEX IF NOT EXISTS idx_native_sync_conflicts_entity
    ON sync_conflicts(profileId, scopeKey, entityType, entityId)`,

  `CREATE TABLE IF NOT EXISTS sync_workspace_scopes (
    profileId TEXT NOT NULL,
    scopeKey TEXT NOT NULL,
    workspaceId TEXT NOT NULL,
    workspaceName TEXT NOT NULL,
    role TEXT NOT NULL CHECK (
      role IN ('owner', 'admin', 'editor', 'commenter', 'viewer')
    ),
    canWrite INTEGER NOT NULL DEFAULT 0 CHECK (canWrite IN (0, 1)),
    accessFingerprint TEXT NOT NULL,
    accessStatus TEXT NOT NULL DEFAULT 'active' CHECK (
      accessStatus IN ('active', 'replan_required', 'access_revoked')
    ),
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (profileId, scopeKey),
    FOREIGN KEY (profileId) REFERENCES sync_profiles(id) ON DELETE CASCADE,
    CHECK (workspaceId <> '' AND scopeKey = 'workspace:' || workspaceId)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_native_workspace_scopes_workspace
    ON sync_workspace_scopes(profileId, workspaceId)`,
  `CREATE INDEX IF NOT EXISTS idx_native_workspace_scopes_access
    ON sync_workspace_scopes(profileId, accessStatus)`,

  `CREATE TABLE IF NOT EXISTS native_runtime_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )`,
] as const;

function getGlobalState(): NativeDatabaseGlobalState {
  const root = globalThis as NativeDatabaseGlobal;
  if (!root.__nowenNoteNativeDatabaseState) {
    root.__nowenNoteNativeDatabaseState = {
      connection: new SQLiteConnection(CapacitorSQLite),
      databases: new Map(),
      lifecycleQueue: Promise.resolve(),
    };
  } else if (!root.__nowenNoteNativeDatabaseState.lifecycleQueue) {
    // HMR 可能保留旧版全局对象；清掉旧适配器缓存后复用插件连接字典。
    root.__nowenNoteNativeDatabaseState.databases.clear();
    root.__nowenNoteNativeDatabaseState.lifecycleQueue = Promise.resolve();
  }
  return root.__nowenNoteNativeDatabaseState;
}

function runConnectionLifecycle<T>(
  state: NativeDatabaseGlobalState,
  work: () => Promise<T>,
): Promise<T> {
  const scheduled = state.lifecycleQueue.then(work, work);
  state.lifecycleQueue = scheduled.then(
    () => undefined,
    () => undefined,
  );
  return scheduled;
}

async function hashAccountId(accountId: string): Promise<string> {
  const normalizedAccountId = accountId.trim();
  if (!normalizedAccountId) {
    throw new Error("无法打开原生数据库：accountId 不能为空");
  }

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("无法打开原生数据库：当前原生运行时不支持 SHA-256");
  }

  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalizedAccountId),
  );
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

class NativeDatabaseImpl implements NativeDatabase {
  private queue: Promise<void> = Promise.resolve();
  private transactionActive = false;
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly dbName: string,
    private readonly raw: SQLiteDBConnection,
    private readonly state: NativeDatabaseGlobalState,
    private readonly cacheEntry: CachedDatabase,
  ) {}

  async initialize(accountHash: string): Promise<void> {
    await this.enqueue(async () => {
      await this.raw.execute("PRAGMA foreign_keys = ON", false);
      await this.withImmediateTransaction(async () => {
        const versionRows = await this.raw.query("PRAGMA user_version");
        const version = Number(versionRows.values?.[0]?.user_version ?? 0);

        if (!Number.isInteger(version) || version < 0) {
          throw new Error(`原生数据库版本无效：${String(version)}`);
        }
        if (version > SCHEMA_VERSION) {
          throw new Error(
            `原生数据库版本 ${version} 高于当前支持版本 ${SCHEMA_VERSION}`,
          );
        }

        if (version === 0) {
          for (const statement of SCHEMA_V1_STATEMENTS) {
            await this.raw.execute(statement, false);
          }
          await this.raw.run(
            `INSERT INTO native_runtime_meta (key, value, updatedAt)
             VALUES ('accountHash', ?, datetime('now'))`,
            [accountHash],
            false,
          );
          // 只有所有 schema 和账户绑定元数据都成功后才推进版本号。
          await this.raw.execute(`PRAGMA user_version = ${SCHEMA_VERSION}`, false);
          return;
        }

        const binding = await this.raw.query(
          "SELECT value FROM native_runtime_meta WHERE key = 'accountHash'",
        );
        const boundHash = binding.values?.[0]?.value;
        if (typeof boundHash === "string" && boundHash !== accountHash) {
          throw new Error("原生数据库账户绑定不一致，已拒绝打开");
        }
        if (boundHash == null) {
          await this.raw.run(
            `INSERT INTO native_runtime_meta (key, value, updatedAt)
             VALUES ('accountHash', ?, datetime('now'))`,
            [accountHash],
            false,
          );
        }
      });
    });
  }

  run(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ changes: number; lastId?: number }> {
    this.assertAcceptingWork();
    return this.enqueue(() => this.runDirect(sql, values));
  }

  query<T>(sql: string, values: unknown[] = []): Promise<T[]> {
    this.assertAcceptingWork();
    return this.enqueue(() => this.queryDirect<T>(sql, values));
  }

  transaction<T>(work: (tx: NativeDatabase) => Promise<T>): Promise<T> {
    this.assertAcceptingWork();
    return this.enqueue(async () => {
      const transactionView = this.createTransactionView();
      this.transactionActive = true;
      try {
        return await this.withImmediateTransaction(async () => {
          try {
            return await work(transactionView.database);
          } finally {
            transactionView.deactivate();
          }
        });
      } finally {
        transactionView.deactivate();
        this.transactionActive = false;
      }
    });
  }

  close(): Promise<void> {
    this.assertOuterHandleAvailable();
    if (this.closed) return Promise.resolve();
    if (this.closePromise) return this.closePromise;

    this.closing = true;
    const closeWork = this.enqueue(() =>
      runConnectionLifecycle(this.state, async () => {
        // 一致性重置后旧句柄可能已被新实例替代，不能误关新连接。
        if (this.state.databases.get(this.dbName) !== this.cacheEntry) return;
        await this.state.connection.closeConnection(this.dbName, false);
        this.state.databases.delete(this.dbName);
      }),
    );

    this.closePromise = closeWork.then(
      () => {
        this.closed = true;
        this.removeCacheEntry();
      },
      (error: unknown) => {
        this.closing = false;
        this.closePromise = undefined;
        this.cacheEntry.closePromise = undefined;
        throw error;
      },
    );
    this.cacheEntry.closePromise = this.closePromise;
    return this.closePromise;
  }

  private assertAcceptingWork(): void {
    this.assertOuterHandleAvailable();
    if (this.closed) throw new Error("原生数据库连接已关闭");
    if (this.closing) throw new Error("原生数据库连接正在关闭");
  }

  private assertOuterHandleAvailable(): void {
    if (this.transactionActive) {
      throw new Error(
        "原生数据库事务执行期间不能使用外层句柄；请改用事务回调传入的 tx",
      );
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const scheduled = this.queue.then(work, work);
    this.queue = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }

  private async runDirect(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ changes: number; lastId?: number }> {
    const result = await this.raw.run(sql, values, false);
    const changes = result.changes?.changes ?? 0;
    const lastId = result.changes?.lastId;
    return lastId == null ? { changes } : { changes, lastId };
  }

  private async queryDirect<T>(
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.raw.query(sql, values);
    return (result.values ?? []) as T[];
  }

  private createTransactionView(): {
    database: NativeDatabase;
    deactivate: () => void;
  } {
    let active = true;
    const assertActive = () => {
      if (!active) {
        throw new Error(
          "原生数据库事务视图已失效；只能在 transaction 回调执行期间使用 tx",
        );
      }
    };

    return {
      database: {
        run: (sql, values = []) => {
          assertActive();
          return this.runDirect(sql, values);
        },
        query: <T>(sql: string, values: unknown[] = []) => {
          assertActive();
          return this.queryDirect<T>(sql, values);
        },
        transaction: async () => {
          assertActive();
          throw new Error("原生数据库不支持嵌套事务；请继续使用当前 tx");
        },
        close: async () => {
          assertActive();
          throw new Error("不能从事务视图关闭原生数据库");
        },
      },
      deactivate: () => {
        active = false;
      },
    };
  }

  private async withImmediateTransaction<T>(work: () => Promise<T>): Promise<T> {
    let transactionStarted = false;
    try {
      await this.raw.execute("BEGIN IMMEDIATE", false);
      transactionStarted = true;
      const result = await work();
      await this.raw.execute("COMMIT", false);
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await this.raw.execute("ROLLBACK", false);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "原生数据库事务失败，且回滚未成功",
          );
        }
      }
      throw error;
    }
  }

  private removeCacheEntry(): void {
    if (this.state.databases.get(this.dbName) === this.cacheEntry) {
      this.state.databases.delete(this.dbName);
    }
  }
}

async function ensureConnectionsConsistent(
  state: NativeDatabaseGlobalState,
): Promise<void> {
  try {
    const result = await state.connection.checkConnectionsConsistency();
    if (result.result === true) return;
  } catch (error) {
    throw error;
  }

  // v8 会在返回 false 时清空 JS 连接字典并移除不一致的原生连接。
  state.databases.clear();
}

async function cleanupFailedConnection(
  state: NativeDatabaseGlobalState,
  dbName: string,
  raw?: SQLiteDBConnection,
): Promise<void> {
  try {
    if ((await state.connection.isConnection(dbName, false)).result === true) {
      await state.connection.closeConnection(dbName, false);
      return;
    }
  } catch {
    // 只继续清理当前 dbName，不影响其他账号的健康连接。
  }

  if (raw) {
    try {
      await raw.close();
    } catch {
      // 继续尝试通过连接管理器移除当前连接。
    }
  }

  try {
    if ((await state.connection.isConnection(dbName, false)).result === true) {
      await state.connection.closeConnection(dbName, false);
    }
  } catch {
    // v8 没有“只删 JS 字典项”的 API；禁止为一个坏连接关闭其他账号。
  }
}

async function createDatabase(
  dbName: string,
  accountHash: string,
  state: NativeDatabaseGlobalState,
  cacheEntry: CachedDatabase,
): Promise<NativeDatabaseImpl> {
  let raw: SQLiteDBConnection | undefined;
  try {
    const hasConnection = await state.connection.isConnection(dbName, false);
    raw = hasConnection.result
      ? await state.connection.retrieveConnection(dbName, false)
      : await state.connection.createConnection(
          dbName,
          false,
          "no-encryption",
          SCHEMA_VERSION,
          false,
        );

    const isOpen = await raw.isDBOpen();
    if (!isOpen.result) await raw.open();

    const database = new NativeDatabaseImpl(dbName, raw, state, cacheEntry);
    await database.initialize(accountHash);
    return database;
  } catch (error) {
    await cleanupFailedConnection(state, dbName, raw);
    throw error;
  }
}

type OpenDecision =
  | { kind: "open"; openPromise: Promise<NativeDatabaseImpl> }
  | { kind: "close"; closePromise: Promise<void> }
  | {
      kind: "create";
      cacheEntry: CachedDatabase;
      resolve: (database: NativeDatabaseImpl) => void;
      reject: (error: unknown) => void;
    };

function createOpenDecision(): Extract<OpenDecision, { kind: "create" }> {
  let resolve!: (database: NativeDatabaseImpl) => void;
  let reject!: (error: unknown) => void;
  const openPromise = new Promise<NativeDatabaseImpl>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  // 创建任务会在生命周期队列内完成，先挂拒绝处理避免短暂未观察的 rejection。
  void openPromise.catch(() => undefined);
  return {
    kind: "create",
    cacheEntry: { openPromise },
    resolve,
    reject,
  };
}

export async function openNativeDatabase(accountId: string): Promise<NativeDatabase> {
  if (!Capacitor.isNativePlatform()) {
    throw new Error("原生数据库只能在 Android 或 iOS 运行时打开");
  }

  const accountHash = await hashAccountId(accountId);
  const dbName = `${DATABASE_PREFIX}${accountHash}`;
  const state = getGlobalState();

  while (true) {
    const decision = await runConnectionLifecycle<OpenDecision>(
      state,
      async () => {
        await ensureConnectionsConsistent(state);

        const cached = state.databases.get(dbName);
        if (cached?.closePromise) {
          return { kind: "close", closePromise: cached.closePromise };
        }
        if (cached) {
          return { kind: "open", openPromise: cached.openPromise };
        }

        const createDecision = createOpenDecision();
        state.databases.set(dbName, createDecision.cacheEntry);
        return createDecision;
      },
    );

    if (decision.kind === "close") {
      // close 自身也需要生命周期锁，必须释放当前临界区后再等待。
      await decision.closePromise;
      continue;
    }
    if (decision.kind === "open") {
      // 同 dbName single-flight：锁外等待唯一的 openPromise。
      return decision.openPromise;
    }

    await runConnectionLifecycle(state, async () => {
      if (state.databases.get(dbName) !== decision.cacheEntry) {
        decision.reject(new Error("原生数据库连接状态已变化，请重新打开"));
        return;
      }

      try {
        const database = await createDatabase(
          dbName,
          accountHash,
          state,
          decision.cacheEntry,
        );
        decision.resolve(database);
      } catch (error) {
        if (state.databases.get(dbName) === decision.cacheEntry) {
          state.databases.delete(dbName);
        }
        decision.reject(error);
      }
    });

    // 创建过程持有生命周期锁，但不在锁内等待自己登记的 openPromise。
    return decision.cacheEntry.openPromise;
  }
}
