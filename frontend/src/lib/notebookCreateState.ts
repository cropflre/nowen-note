import type { Notebook } from "@/types";

export type NotebookCreateStatus = "pending" | "confirmed" | "failed";

export type NotebookCreateOperation = {
  operationId: string;
  tempId: string;
  parentId: string | null;
  workspaceId: string;
  name: string;
  status: NotebookCreateStatus;
  submitted: boolean;
  serverId?: string;
  serverName?: string;
  serverNotebook?: Notebook;
  error?: string;
};

export type NotebookCreateState = Record<string, NotebookCreateOperation>;

export type NotebookCreateAction =
  | { type: "start"; operation: NotebookCreateOperation }
  | { type: "name"; operationId: string; name: string }
  | { type: "submit"; operationId: string; name: string }
  | { type: "pending"; operationId: string }
  | { type: "confirm"; operationId: string; notebook: Notebook }
  | { type: "fail"; operationId: string; error: string }
  | { type: "finish" | "cancel"; operationId: string };

export const EMPTY_NOTEBOOK_CREATE_STATE: NotebookCreateState = {};
export const TEMP_NOTEBOOK_ID_PREFIX = "temp-notebook:";

export function isTemporaryNotebookId(id: string | null | undefined): boolean {
  return !!id?.startsWith(TEMP_NOTEBOOK_ID_PREFIX);
}

export function withoutTemporaryNotebooks(notebooks: Notebook[]): Notebook[] {
  return notebooks.filter((notebook) => !isTemporaryNotebookId(notebook.id));
}

export function mergeAuthoritativeNotebooks(
  current: Notebook[],
  authoritative: Notebook[],
): Notebook[] {
  return [
    ...authoritative,
    ...current.filter(
      (notebook) => isTemporaryNotebookId(notebook.id)
        && !authoritative.some((incoming) => incoming.id === notebook.id),
    ),
  ];
}

export function replaceOptimisticNotebook(
  notebooks: Notebook[],
  temporaryId: string,
  serverNotebook: Notebook,
): Notebook[] {
  const temporaryExists = notebooks.some((notebook) => notebook.id === temporaryId);
  const serverExists = notebooks.some(
    (notebook) => notebook.id === serverNotebook.id && notebook.id !== temporaryId,
  );
  if (!temporaryExists) return serverExists ? notebooks : [...notebooks, serverNotebook];
  return notebooks.flatMap((notebook) => {
    if (notebook.id === temporaryId) return serverExists ? [] : [serverNotebook];
    return [notebook];
  });
}

export type CancelledNotebookCleanupFailure = {
  operationId: string;
  notebookId: string;
  status?: number;
  error: unknown;
};

export async function cleanupCancelledNotebook(
  operationId: string,
  notebookId: string,
  deleteNotebook: (id: string) => Promise<unknown>,
  onFailure: (failure: CancelledNotebookCleanupFailure) => void,
): Promise<"deleted" | "not-found" | "failed"> {
  try {
    await deleteNotebook(notebookId);
    return "deleted";
  } catch (error: unknown) {
    const rawStatus = error && typeof error === "object"
      ? (error as { status?: unknown }).status
      : undefined;
    const status = typeof rawStatus === "number" ? rawStatus : undefined;
    if (status === 404) return "not-found";
    onFailure({ operationId, notebookId, status, error });
    return "failed";
  }
}

export function notebookCreateReducer(
  state: NotebookCreateState,
  action: NotebookCreateAction,
): NotebookCreateState {
  if (action.type === "start") {
    return { ...state, [action.operation.operationId]: action.operation };
  }
  if (action.type === "finish" || action.type === "cancel") {
    if (!state[action.operationId]) return state;
    const next = { ...state };
    delete next[action.operationId];
    return next;
  }
  const current = state[action.operationId];
  if (!current) return state;
  switch (action.type) {
    case "name":
      return { ...state, [action.operationId]: { ...current, name: action.name } };
    case "submit":
      return {
        ...state,
        [action.operationId]: { ...current, name: action.name, submitted: true },
      };
    case "pending":
      return {
        ...state,
        [action.operationId]: { ...current, status: "pending", error: undefined },
      };
    case "confirm":
      return {
        ...state,
        [action.operationId]: {
          ...current,
          status: "confirmed",
          serverId: action.notebook.id,
          serverName: action.notebook.name,
          serverNotebook: action.notebook,
          error: undefined,
        },
      };
    case "fail":
      return {
        ...state,
        [action.operationId]: { ...current, status: "failed", error: action.error },
      };
  }
}

export function findNotebookCreateOperation(
  state: NotebookCreateState,
  notebookId: string,
): NotebookCreateOperation | undefined {
  return Object.values(state).find(
    (operation) => operation.tempId === notebookId || operation.serverId === notebookId,
  );
}

export function createOptimisticNotebook(
  operation: NotebookCreateOperation,
  icon: string,
  now = new Date().toISOString(),
): Notebook {
  return {
    id: operation.tempId,
    userId: "",
    workspaceId: operation.workspaceId === "personal" ? null : operation.workspaceId,
    parentId: operation.parentId,
    name: operation.name,
    description: null,
    icon,
    color: null,
    sortOrder: 0,
    isExpanded: 0,
    createdAt: now,
    updatedAt: now,
    noteCount: 0,
  };
}
