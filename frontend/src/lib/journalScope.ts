import { api, getCurrentWorkspace } from "@/lib/api";

export type JournalScope =
  | { kind: "personal"; workspaceId: null; key: "personal"; label: "个人日记" }
  | { kind: "workspace"; workspaceId: string; key: string; label: "工作区日记" };

export interface ScopedJournalResult {
  id: string;
  title: string;
  existed: boolean;
  canWrite: boolean;
  workspaceId: string | null;
  scope: "personal" | "workspace";
  [key: string]: unknown;
}

export interface JournalScopeDependencies {
  getCurrentWorkspace: () => string;
  getOrCreatePersonal: (dateKey: string) => Promise<Record<string, any>>;
  getOrCreateWorkspace: (workspaceId: string, dateKey: string) => Promise<Record<string, any>>;
  checkPersonal: (dateKey: string) => Promise<Record<string, any>>;
  checkWorkspace: (workspaceId: string, dateKey: string) => Promise<Record<string, any>>;
}

const DEFAULT_DEPENDENCIES: JournalScopeDependencies = {
  getCurrentWorkspace,
  getOrCreatePersonal: (dateKey) => api.journals.getOrCreateToday(dateKey),
  getOrCreateWorkspace: (workspaceId, dateKey) => api.journals.getOrCreateWorkspace(workspaceId, dateKey),
  checkPersonal: (dateKey) => api.journals.checkToday(dateKey),
  checkWorkspace: (workspaceId, dateKey) => api.journals.checkWorkspace(workspaceId, dateKey),
};

function depsWith(overrides: Partial<JournalScopeDependencies> = {}): JournalScopeDependencies {
  return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

export function resolveJournalScope(workspaceId = getCurrentWorkspace()): JournalScope {
  if (!workspaceId || workspaceId === "personal") {
    return { kind: "personal", workspaceId: null, key: "personal", label: "个人日记" };
  }
  return {
    kind: "workspace",
    workspaceId,
    key: `workspace:${workspaceId}`,
    label: "工作区日记",
  };
}

export async function getOrCreateJournalForScope(
  dateKey: string,
  scope = resolveJournalScope(),
  overrides: Partial<JournalScopeDependencies> = {},
): Promise<ScopedJournalResult> {
  const deps = depsWith(overrides);
  if (scope.kind === "workspace") {
    const result = await deps.getOrCreateWorkspace(scope.workspaceId, dateKey);
    return {
      ...result,
      id: String(result.id),
      title: String(result.title || dateKey),
      existed: result.existed === true,
      canWrite: result.canWrite !== false,
      workspaceId: scope.workspaceId,
      scope: "workspace",
    };
  }
  const result = await deps.getOrCreatePersonal(dateKey);
  return {
    ...result,
    id: String(result.id),
    title: String(result.title || dateKey),
    existed: result.existed === true,
    canWrite: true,
    workspaceId: null,
    scope: "personal",
  };
}

export async function checkJournalForScope(
  dateKey: string,
  scope = resolveJournalScope(),
  overrides: Partial<JournalScopeDependencies> = {},
): Promise<Record<string, any> & {
  exists: boolean;
  noteId: string | null;
  canWrite: boolean;
  scope: "personal" | "workspace";
}> {
  const deps = depsWith(overrides);
  if (scope.kind === "workspace") {
    const result = await deps.checkWorkspace(scope.workspaceId, dateKey);
    return {
      ...result,
      exists: result.exists === true,
      noteId: result.noteId ? String(result.noteId) : null,
      canWrite: result.canWrite !== false,
      scope: "workspace",
    };
  }
  const result = await deps.checkPersonal(dateKey);
  return {
    ...result,
    exists: result.exists === true,
    noteId: result.noteId ? String(result.noteId) : null,
    canWrite: true,
    scope: "personal",
  };
}

export function scopedJournalToastMessage(
  result: Pick<ScopedJournalResult, "existed" | "scope">,
  dateKey: string,
): string {
  if (result.scope === "workspace") {
    return result.existed
      ? `已链接工作区 ${dateKey} 日记`
      : `已创建并链接工作区 ${dateKey} 日记`;
  }
  return result.existed
    ? `已链接 ${dateKey} 日记`
    : `已创建并链接 ${dateKey} 日记`;
}
