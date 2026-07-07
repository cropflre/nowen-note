import type { Notebook } from "@/types";

export type NotebookExpandedState = 0 | 1;

export function getNotebookExpansionChanges(notebooks: Notebook[], expanded: NotebookExpandedState) {
  return {
    changed: notebooks.filter((notebook) => notebook.isExpanded !== expanded),
    nextNotebooks: notebooks.map((notebook) => (
      notebook.isExpanded === expanded ? notebook : { ...notebook, isExpanded: expanded }
    )),
  };
}

export function getNextNotebookExpansionState(notebooks: Notebook[]): NotebookExpandedState {
  return notebooks.some((notebook) => notebook.isExpanded === 1) ? 0 : 1;
}
