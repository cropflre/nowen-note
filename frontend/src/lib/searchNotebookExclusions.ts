import type { Notebook, SearchResult } from "@/types";

import { fetchWithAuthRefresh, getAccessToken } from "@/lib/authSession";
import { getBaseUrl, getCurrentWorkspace } from "@/lib/api.impl";

export const SEARCH_NOTEBOOK_EXCLUSIONS_CHANGED_EVENT = "nowen:search-notebook-exclusions-changed";

export type SearchNotebookExclusion = {
  userId: string;
  notebookId: string;
  includeDescendants: number | boolean;
  createdAt: string;
  updatedAt: string;
  name: string;
  icon: string | null;
  parentId: string | null;
};

export type SearchNotebookExclusionList = {
  direct: SearchNotebookExclusion[];
  directCount: number;
  effectiveNotebookCount: number;
};

export type SearchNotebookExclusionStatus =
  | { kind: "direct"; sourceNotebookId: string }
  | { kind: "inherited"; sourceNotebookId: string }
  | { kind: "included"; sourceNotebookId: null };

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessToken();
  const response = await fetchWithAuthRefresh(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  }, getBaseUrl());
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error || `HTTP ${response.status}`) as Error & { code?: string; status?: number };
    error.code = payload?.code;
    error.status = response.status;
    throw error;
  }
  return payload as T;
}

export async function listSearchNotebookExclusions(): Promise<SearchNotebookExclusionList> {
  return requestJson<SearchNotebookExclusionList>("/search/excluded-notebooks");
}

export async function excludeNotebookFromSearch(notebookId: string): Promise<void> {
  await requestJson(`/search/excluded-notebooks/${encodeURIComponent(notebookId)}`, {
    method: "PUT",
    body: JSON.stringify({ includeDescendants: true }),
  });
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SEARCH_NOTEBOOK_EXCLUSIONS_CHANGED_EVENT));
}

export async function includeNotebookInSearch(notebookId: string): Promise<void> {
  await requestJson(`/search/excluded-notebooks/${encodeURIComponent(notebookId)}`, {
    method: "DELETE",
  });
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SEARCH_NOTEBOOK_EXCLUSIONS_CHANGED_EVENT));
}

/** Explicit search-session override. Normal api.search() intentionally keeps the server default. */
export async function searchIncludingExcludedNotebooks(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, includeExcluded: "1" });
  const workspace = getCurrentWorkspace();
  if (workspace && workspace !== "personal") params.set("workspaceId", workspace);
  return requestJson<SearchResult[]>(`/search?${params.toString()}`, { signal });
}

export function resolveSearchNotebookExclusionStatus(
  notebookId: string,
  exclusions: readonly Pick<SearchNotebookExclusion, "notebookId" | "includeDescendants">[],
  notebooks: readonly Pick<Notebook, "id" | "parentId">[],
): SearchNotebookExclusionStatus {
  const rules = new Map(exclusions.map((row) => [row.notebookId, row]));
  if (rules.has(notebookId)) return { kind: "direct", sourceNotebookId: notebookId };

  const notebookById = new Map(notebooks.map((notebook) => [notebook.id, notebook]));
  const visited = new Set<string>();
  let cursor = notebookById.get(notebookId)?.parentId || null;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const rule = rules.get(cursor);
    if (rule && rule.includeDescendants !== false && Number(rule.includeDescendants) !== 0) {
      return { kind: "inherited", sourceNotebookId: cursor };
    }
    cursor = notebookById.get(cursor)?.parentId || null;
  }
  return { kind: "included", sourceNotebookId: null };
}
