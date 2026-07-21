const INSTALL_KEY = Symbol.for("nowen.task-list-node-view-identity");

interface TaskListIdentityState {
  observer: MutationObserver | null;
  start: () => void;
}

type TaskListIdentityWindow = Window & {
  [INSTALL_KEY]?: TaskListIdentityState;
};

function matchingElements(root: ParentNode, selector: string): Element[] {
  const matches: Element[] = [];
  if (root instanceof Element && root.matches(selector)) matches.push(root);
  matches.push(...Array.from(root.querySelectorAll(selector)));
  return matches;
}

/**
 * Tiptap 3 renders TaskItem through a custom NodeView. The NodeView applies the
 * configured `.task-item` class, but unlike renderHTML it may omit the canonical
 * `data-type="taskItem"` identity. Restore the identity so editor CSS and DOM
 * integrations can distinguish task items from ordinary unordered-list items.
 */
export function normalizeTaskListNodeViewIdentity(root: ParentNode): number {
  let changed = 0;

  for (const list of matchingElements(root, "ul.task-list")) {
    if (list.getAttribute("data-type") === "taskList") continue;
    list.setAttribute("data-type", "taskList");
    changed += 1;
  }

  for (const item of matchingElements(root, "li.task-item")) {
    if (item.getAttribute("data-type") === "taskItem") continue;
    item.setAttribute("data-type", "taskItem");
    changed += 1;
  }

  return changed;
}

/** Install one lightweight process-wide compatibility observer before React mounts. */
export function installTaskListNodeViewIdentity(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const targetWindow = window as TaskListIdentityWindow;
  if (targetWindow[INSTALL_KEY]) return;

  const state: TaskListIdentityState = {
    observer: null,
    start: () => {
      if (!document.body || state.observer) return;
      normalizeTaskListNodeViewIdentity(document.body);

      state.observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "attributes") {
            if (record.target instanceof Element) {
              normalizeTaskListNodeViewIdentity(record.target);
            }
            continue;
          }

          for (const node of Array.from(record.addedNodes)) {
            if (node instanceof Element) normalizeTaskListNodeViewIdentity(node);
          }
        }
      });

      state.observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["class"],
      });
    },
  };

  targetWindow[INSTALL_KEY] = state;

  if (document.body) {
    state.start();
  } else {
    document.addEventListener("DOMContentLoaded", state.start, { once: true });
  }
}
