import type { Notebook } from "@/types";

export function resolveExternalDropNotebookId(
  selectedNotebookId: string | null,
  notebooks: readonly Pick<Notebook, "id">[],
): string | null {
  return selectedNotebookId ?? notebooks[0]?.id ?? null;
}
