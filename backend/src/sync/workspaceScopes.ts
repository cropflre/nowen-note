import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import { SYNC_PERSONAL_SCOPE_KEY } from "./constants";
import type { SyncScopeDescriptor } from "./scope";
import type { SyncWorkspaceScopeRow } from "./types";

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table));
}

export function listWorkspaceScopeStates(
  db: Database.Database,
  profileId: string,
): SyncWorkspaceScopeRow[] {
  if (!tableExists(db, "sync_workspace_scopes")) return [];
  return db.prepare(`
    SELECT profileId, scopeKey, workspaceId, workspaceName, role, canWrite,
           accessFingerprint, accessStatus, updatedAt
    FROM sync_workspace_scopes
    WHERE profileId = ?
    ORDER BY CASE WHEN scopeKey = 'personal' THEN 0 ELSE 1 END, workspaceName, scopeKey
  `).all(profileId) as SyncWorkspaceScopeRow[];
}

/**
 * 用服务端最新清单刷新本地 Scope 状态。
 * 指纹变化只复位对应 Scope；从清单消失的 Workspace 进入撤权终态，
 * 本地业务数据、Outbox、Conflict 均保留。
 */
export function refreshWorkspaceScopeStates(
  db: Database.Database,
  profileId: string,
  descriptors: SyncScopeDescriptor[],
  localUserId?: string,
): SyncWorkspaceScopeRow[] {
  const incoming = new Set(descriptors.map((item) => item.scopeKey));
  const transaction = db.transaction(() => {
    for (const descriptor of descriptors) {
      if (descriptor.workspaceId && localUserId) {
        const remoteOwnerId = `sync-remote-${createHash("sha256")
          .update(`${profileId}:${descriptor.workspaceId}`).digest("hex").slice(0,24)}`;
        db.prepare(`INSERT OR IGNORE INTO users (id,username,passwordHash)
          VALUES (?,?,'!sync-remote-owner!')`).run(remoteOwnerId,remoteOwnerId);
        db.prepare(`INSERT INTO workspaces (id,name,description,icon,ownerId)
          VALUES (?,?,'同步工作区','🏢',?) ON CONFLICT(id) DO UPDATE SET name=excluded.name`)
          .run(descriptor.workspaceId,descriptor.workspaceName || descriptor.workspaceId,remoteOwnerId);
        db.prepare(`INSERT INTO workspace_members (workspaceId,userId,role)
          VALUES (?,?,?) ON CONFLICT(workspaceId,userId) DO UPDATE SET role=excluded.role`)
          .run(descriptor.workspaceId,localUserId,descriptor.role || "viewer");
      }
      const previous = db.prepare(`
        SELECT accessFingerprint, accessStatus
        FROM sync_workspace_scopes
        WHERE profileId = ? AND scopeKey = ?
      `).get(profileId, descriptor.scopeKey) as
        | { accessFingerprint: string; accessStatus: string }
        | undefined;
      const changed = !previous || previous.accessFingerprint !== descriptor.accessFingerprint;
      const status = changed ? "replan_required" : "active";
      db.prepare(`
        INSERT INTO sync_workspace_scopes (
          profileId, scopeKey, workspaceId, workspaceName, role, canWrite,
          accessFingerprint, accessStatus, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(profileId, scopeKey) DO UPDATE SET
          workspaceId = excluded.workspaceId,
          workspaceName = excluded.workspaceName,
          role = excluded.role,
          canWrite = excluded.canWrite,
          accessFingerprint = excluded.accessFingerprint,
          accessStatus = excluded.accessStatus,
          updatedAt = excluded.updatedAt
      `).run(
        profileId,
        descriptor.scopeKey,
        descriptor.workspaceId,
        descriptor.workspaceName,
        descriptor.role,
        descriptor.canWrite ? 1 : 0,
        descriptor.accessFingerprint,
        status,
      );
      if (changed) {
        db.prepare(`
          INSERT INTO sync_state (
            profileId, scopeKey, lastSequence, lastSyncAt, lastError,
            accessFingerprint, accessStatus, accessChangedAt
          ) VALUES (?, ?, 0, NULL, NULL, ?, 'replan_required', datetime('now'))
          ON CONFLICT(profileId, scopeKey) DO UPDATE SET
            lastSequence = 0,
            lastSyncAt = NULL,
            lastError = NULL,
            accessFingerprint = excluded.accessFingerprint,
            accessStatus = 'replan_required',
            accessChangedAt = excluded.accessChangedAt
        `).run(profileId, descriptor.scopeKey, descriptor.accessFingerprint);
      }
    }

    const existing = db.prepare(`
      SELECT scopeKey FROM sync_workspace_scopes
      WHERE profileId = ? AND scopeKey <> ?
    `).all(profileId, SYNC_PERSONAL_SCOPE_KEY) as Array<{ scopeKey: string }>;
    for (const row of existing) {
      if (incoming.has(row.scopeKey)) continue;
      markWorkspaceScopeRevoked(db,profileId,row.scopeKey,localUserId);
    }
  });
  transaction();
  return listWorkspaceScopeStates(db, profileId);
}

export function markWorkspaceScopeRevoked(
  db: Database.Database,
  profileId: string,
  scopeKey: string,
  localUserId?: string,
): void {
  db.prepare(`
    UPDATE sync_workspace_scopes
    SET accessStatus = 'access_revoked', canWrite = 0, updatedAt = datetime('now')
    WHERE profileId = ? AND scopeKey = ?
  `).run(profileId, scopeKey);
  db.prepare(`
    INSERT INTO sync_state (
      profileId, scopeKey, lastSequence, lastSyncAt, lastError, accessStatus, accessChangedAt
    ) VALUES (?, ?, 0, NULL, 'ACCESS_REVOKED', 'access_revoked', datetime('now'))
    ON CONFLICT(profileId, scopeKey) DO UPDATE SET
      lastError = 'ACCESS_REVOKED', accessStatus = 'access_revoked',
      accessChangedAt = datetime('now')
  `).run(profileId, scopeKey);
  if (localUserId) {
    const scope = db.prepare(`SELECT workspaceId FROM sync_workspace_scopes
      WHERE profileId=? AND scopeKey=?`).get(profileId,scopeKey) as {workspaceId:string|null}|undefined;
    if (scope?.workspaceId) {
      db.prepare("DELETE FROM workspace_members WHERE workspaceId=? AND userId=?")
        .run(scope.workspaceId,localUserId);
    }
  }
}

export function markWorkspaceScopeActive(
  db: Database.Database,
  profileId: string,
  scopeKey: string,
  accessFingerprint: string,
): void {
  db.prepare(`
    UPDATE sync_workspace_scopes
    SET accessStatus = 'active', accessFingerprint = ?, updatedAt = datetime('now')
    WHERE profileId = ? AND scopeKey = ?
  `).run(accessFingerprint, profileId, scopeKey);
  db.prepare(`
    UPDATE sync_state
    SET accessStatus = 'active', accessFingerprint = ?, accessChangedAt = datetime('now')
    WHERE profileId = ? AND scopeKey = ?
  `).run(accessFingerprint, profileId, scopeKey);
}

export function buildWorkspaceScopeExport(
  db: Database.Database,
  workspaceId: string,
): Record<string, unknown> {
  const rows = (table: string, sql: string, ...params: unknown[]) =>
    tableExists(db, table) ? db.prepare(sql).all(...params) : [];
  return {
    format: "nowen-workspace-recovery-v1",
    workspaceId,
    exportedAt: new Date().toISOString(),
    notebooks: rows("notebooks", "SELECT * FROM notebooks WHERE workspaceId = ?", workspaceId),
    notes: rows("notes", "SELECT * FROM notes WHERE workspaceId = ?", workspaceId),
    tags: rows("tags", "SELECT * FROM tags WHERE workspaceId = ?", workspaceId),
    noteTags: rows("note_tags", `
      SELECT nt.* FROM note_tags nt JOIN notes n ON n.id = nt.noteId
      WHERE n.workspaceId = ?
    `, workspaceId),
    favorites: rows("favorites", "SELECT * FROM favorites WHERE workspaceId = ?", workspaceId),
    attachments: rows("attachments", `
      SELECT a.* FROM attachments a JOIN notes n ON n.id = a.noteId
      WHERE n.workspaceId = ?
    `, workspaceId),
    tasks: rows("tasks", "SELECT * FROM tasks WHERE workspaceId = ?", workspaceId),
    taskReminders: rows("task_reminders", `
      SELECT r.* FROM task_reminders r JOIN tasks t ON t.id = r.taskId
      WHERE t.workspaceId = ?
    `, workspaceId),
    diaries: rows("diaries", "SELECT * FROM diaries WHERE workspaceId = ?", workspaceId),
    mindmaps: rows("mindmaps", "SELECT * FROM mindmaps WHERE workspaceId = ?", workspaceId),
  };
}

function insertDynamic(
  db: Database.Database,
  table: string,
  row: Record<string, unknown>,
  overrides: Record<string, unknown>,
): void {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((item) => item.name)
    .filter((name) => Object.hasOwn(row, name) || Object.hasOwn(overrides, name));
  const values = columns.map((name) => Object.hasOwn(overrides, name) ? overrides[name] : row[name]);
  const quoted = columns.map((name) => `"${name.replaceAll('"', '""')}"`).join(", ");
  db.prepare(`INSERT INTO ${table} (${quoted}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...values);
}

/**
 * 将撤权 Workspace 的本地副本复制到 Personal。原数据不删除；所有引用换新 ID，
 * 新增行由现有 Outbox 触发器作为 Personal mutation 捕获。
 */
export function copyWorkspaceScopeToPersonal(
  db: Database.Database,
  workspaceId: string,
  userId: string,
): { notebooks: number; notes: number; attachments: number; tasks: number } {
  const notebookMap = new Map<string, string>();
  const noteMap = new Map<string, string>();
  const tagMap = new Map<string, string>();
  const taskMap = new Map<string, string>();
  const run = db.transaction(() => {
    const notebooks = db.prepare("SELECT * FROM notebooks WHERE workspaceId = ? ORDER BY parentId IS NOT NULL, createdAt")
      .all(workspaceId) as Array<Record<string, unknown>>;
    for (const row of notebooks) notebookMap.set(String(row.id), randomUUID());
    for (const row of notebooks) {
      insertDynamic(db, "notebooks", row, {
        id: notebookMap.get(String(row.id)), userId, workspaceId: null,
        parentId: row.parentId ? notebookMap.get(String(row.parentId)) ?? null : null,
        name: `${String(row.name || "工作区副本")}（本地副本）`,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    }

    const tags = db.prepare("SELECT * FROM tags WHERE workspaceId = ? ORDER BY createdAt")
      .all(workspaceId) as Array<Record<string, unknown>>;
    for (const row of tags) {
      const id = randomUUID();
      tagMap.set(String(row.id), id);
      insertDynamic(db, "tags", row, {
        id, userId, workspaceId: null,
        name: `${String(row.name || "标签")}（工作区副本 ${id.slice(0, 6)}）`,
        createdAt: new Date().toISOString(),
      });
    }

    const notes = db.prepare("SELECT * FROM notes WHERE workspaceId = ? ORDER BY createdAt")
      .all(workspaceId) as Array<Record<string, unknown>>;
    for (const row of notes) noteMap.set(String(row.id), randomUUID());
    for (const row of notes) {
      const notebookId = notebookMap.get(String(row.notebookId));
      if (!notebookId) continue;
      insertDynamic(db, "notes", row, {
        id: noteMap.get(String(row.id)), userId, notebookId, workspaceId: null,
        title: `${String(row.title || "无标题笔记")}（工作区副本）`,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    }

    const noteTags = db.prepare(`
      SELECT nt.* FROM note_tags nt JOIN notes n ON n.id = nt.noteId
      WHERE n.workspaceId = ?
    `).all(workspaceId) as Array<Record<string, unknown>>;
    for (const row of noteTags) {
      const noteId = noteMap.get(String(row.noteId));
      const tagId = tagMap.get(String(row.tagId));
      if (noteId && tagId) insertDynamic(db, "note_tags", row, { noteId, tagId });
    }

    const attachments = db.prepare(`
      SELECT a.* FROM attachments a JOIN notes n ON n.id = a.noteId
      WHERE n.workspaceId = ?
    `).all(workspaceId) as Array<Record<string, unknown>>;
    for (const row of attachments) {
      const noteId = noteMap.get(String(row.noteId));
      if (!noteId) continue;
      insertDynamic(db, "attachments", row, {
        id: randomUUID(), noteId, userId, createdAt: new Date().toISOString(),
      });
    }

    if (tableExists(db, "tasks")) {
      const tasks = db.prepare("SELECT * FROM tasks WHERE workspaceId = ? ORDER BY parentId IS NOT NULL, createdAt")
        .all(workspaceId) as Array<Record<string, unknown>>;
      for (const row of tasks) taskMap.set(String(row.id), randomUUID());
      for (const row of tasks) {
        insertDynamic(db, "tasks", row, {
          id: taskMap.get(String(row.id)), userId, workspaceId: null,
          noteId: row.noteId ? noteMap.get(String(row.noteId)) ?? null : null,
          parentId: row.parentId ? taskMap.get(String(row.parentId)) ?? null : null,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
      }
      if (tableExists(db, "task_reminders")) {
        const reminders = db.prepare(`
          SELECT r.* FROM task_reminders r JOIN tasks t ON t.id = r.taskId
          WHERE t.workspaceId = ?
        `).all(workspaceId) as Array<Record<string, unknown>>;
        for (const row of reminders) {
          const taskId = taskMap.get(String(row.taskId));
          if (taskId) insertDynamic(db, "task_reminders", row, {
            id: randomUUID(), taskId, userId, createdAt: new Date().toISOString(),
          });
        }
      }
    }

    for (const table of ["diaries", "mindmaps"] as const) {
      if (!tableExists(db, table)) continue;
      const rows = db.prepare(`SELECT * FROM ${table} WHERE workspaceId = ?`).all(workspaceId) as Array<Record<string, unknown>>;
      for (const row of rows) insertDynamic(db, table, row, {
        id: randomUUID(), userId, workspaceId: null,
        createdAt: new Date().toISOString(),
        ...(Object.hasOwn(row, "updatedAt") ? { updatedAt: new Date().toISOString() } : {}),
      });
    }
  });
  run();
  const attachmentCount = noteMap.size > 0
    ? Number((db.prepare(`
        SELECT COUNT(*) AS count FROM attachments WHERE userId = ?
          AND noteId IN (${[...noteMap.values()].map(() => "?").join(",")})
      `).get(userId, ...noteMap.values()) as { count: number } | undefined)?.count || 0)
    : 0;
  return {
    notebooks: notebookMap.size,
    notes: noteMap.size,
    attachments: attachmentCount,
    tasks: taskMap.size,
  };
}
