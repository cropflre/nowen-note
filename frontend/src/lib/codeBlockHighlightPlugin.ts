import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  getActiveEditorRuntimeState,
  isActiveEditorCapabilityEnabled,
} from "@/lib/editorRuntimeStore";

type LowlightNode = {
  value?: string;
  children?: LowlightNode[];
  properties?: { className?: string[] | string };
};

type LowlightResult = { children?: LowlightNode[]; value?: LowlightNode[] };

export type LowlightLike = {
  highlight: (language: string, code: string) => unknown;
  highlightAuto: (code: string) => unknown;
  listLanguages: () => string[];
  registered?: (language: string) => boolean;
};

type HighlightSegment = {
  from: number;
  to: number;
  classes: string;
};

type AutoTask = {
  key: string;
  pos: number;
  language: string;
  code: string;
};

type HighlightPluginState = {
  decorations: DecorationSet;
  pending: AutoTask[];
};

type AutoResult = {
  task: AutoTask;
  segments: HighlightSegment[];
};

type ViewportRange = { from: number; to: number };
type RuntimeRefresh = { runtimeRefresh: true };
type ViewportRefresh = { viewportRefresh: true; range: ViewportRange | null };

const PLAIN_TEXT_LANGUAGES = new Set(["text", "plaintext", "plain", "txt"]);
const NON_LOWLIGHT_LANGUAGES = new Set(["mermaid"]);
const AUTO_LANGUAGE = "auto";
const DEFAULT_AUTO_SYNC_MAX_CHARACTERS = 2_000;
const DEFAULT_CACHE_ENTRIES = 200;
const DEFAULT_VIEWPORT_CHARACTER_MARGIN = 12_000;
const HIGHLIGHT_DIAGNOSTICS_ENABLED = import.meta.env.MODE === "test" || import.meta.env.VITE_PHASE_A_PERF === "1";

export function isPlainTextLanguage(language: string | null | undefined): boolean {
  return PLAIN_TEXT_LANGUAGES.has((language || "").toLowerCase());
}

function parseHighlightNodes(nodes: LowlightNode[], inheritedClasses: string[] = [], offset = 0): {
  segments: HighlightSegment[];
  offset: number;
} {
  const segments: HighlightSegment[] = [];
  let currentOffset = offset;

  for (const node of nodes) {
    const rawClasses = node.properties?.className;
    const nodeClasses = Array.isArray(rawClasses)
      ? rawClasses
      : typeof rawClasses === "string"
        ? rawClasses.split(/\s+/).filter(Boolean)
        : [];
    const classes = [...inheritedClasses, ...nodeClasses];

    if (node.children) {
      const parsed = parseHighlightNodes(node.children, classes, currentOffset);
      segments.push(...parsed.segments);
      currentOffset = parsed.offset;
      continue;
    }

    const text = node.value || "";
    const nextOffset = currentOffset + text.length;
    if (classes.length && nextOffset > currentOffset) {
      segments.push({ from: currentOffset, to: nextOffset, classes: classes.join(" ") });
    }
    currentOffset = nextOffset;
  }

  return { segments, offset: currentOffset };
}

function toSegments(result: unknown): HighlightSegment[] {
  const tree = result as LowlightResult;
  return parseHighlightNodes(tree.children || tree.value || []).segments;
}

function codeBlocks(
  doc: ProseMirrorNode,
  name: string,
  range: ViewportRange | null,
): Array<{ node: ProseMirrorNode; pos: number }> {
  const blocks: Array<{ node: ProseMirrorNode; pos: number }> = [];
  const collect = (node: ProseMirrorNode, pos: number) => {
    if (node.type.name !== name) return true;
    blocks.push({ node, pos });
    return false;
  };

  if (range) {
    const from = Math.max(0, Math.min(doc.content.size, range.from));
    const to = Math.max(from, Math.min(doc.content.size, range.to));
    if (to > from) doc.nodesBetween(from, to, collect);
  } else {
    doc.descendants(collect);
  }
  return blocks;
}

function normalizedLanguage(node: ProseMirrorNode, defaultLanguage?: string | null): string {
  return String(node.attrs.language || defaultLanguage || AUTO_LANGUAGE).toLowerCase();
}

function cacheKey(mode: "explicit" | "auto", language: string, code: string): string {
  return `${mode}\u0000${language}\u0000${code}`;
}

function taskEquals(left: AutoTask, right: AutoTask): boolean {
  return left.key === right.key && left.pos === right.pos && left.language === right.language && left.code === right.code;
}

function rangesEqual(left: ViewportRange | null, right: ViewportRange | null): boolean {
  return left === right || (!!left && !!right && left.from === right.from && left.to === right.to);
}

function findScrollableAncestor(element: HTMLElement): HTMLElement | null {
  if (typeof window === "undefined") return null;
  let current = element.parentElement;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    if (/(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`)) return current;
    current = current.parentElement;
  }
  return null;
}

export type CodeBlockHighlightPluginOptions = {
  name: string;
  lowlight: LowlightLike;
  defaultLanguage?: string | null;
  autoSyncMaxCharacters?: number;
  cacheEntries?: number;
  viewportCharacterMargin?: number;
  onDiagnostic?: (event: HighlightDiagnosticEvent, detail: Record<string, number | string | boolean>) => void;
};

export type HighlightDiagnosticEvent =
  | "highlight-task-created"
  | "highlight-task-cancelled"
  | "highlight-task-executed"
  | "highlight-task-stale"
  | "highlight-task-applied"
  | "highlight-queue-depth"
  | "highlight-viewport-range";

/**
 * Incremental lowlight decorations for Tiptap code blocks.
 *
 * Normal documents keep exact cached highlighting. Viewport-optimized documents only traverse the
 * visible scroll window plus a character margin, so cost no longer grows linearly with every code
 * block in the note. Lightweight mode returns an empty DecorationSet before traversing the document.
 */
export function createCodeBlockHighlightPlugin({
  name,
  lowlight,
  defaultLanguage,
  autoSyncMaxCharacters = DEFAULT_AUTO_SYNC_MAX_CHARACTERS,
  cacheEntries = DEFAULT_CACHE_ENTRIES,
  viewportCharacterMargin = DEFAULT_VIEWPORT_CHARACTER_MARGIN,
  onDiagnostic,
}: CodeBlockHighlightPluginOptions): Plugin<HighlightPluginState> {
  const pluginKey = new PluginKey<HighlightPluginState>("nowenCodeBlockHighlight");
  const cache = new Map<string, HighlightSegment[]>();
  let currentView: EditorView | null = null;
  let activeViewport: ViewportRange | null = null;
  const report = HIGHLIGHT_DIAGNOSTICS_ENABLED ? onDiagnostic : undefined;

  const getCached = (key: string): HighlightSegment[] | undefined => {
    const value = cache.get(key);
    if (!value) return undefined;
    cache.delete(key);
    cache.set(key, value);
    return value;
  };

  const setCached = (key: string, value: HighlightSegment[]) => {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > cacheEntries) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const isExplicitLanguage = (language: string) => (
    language !== AUTO_LANGUAGE && (
      lowlight.listLanguages().includes(language) || lowlight.registered?.(language) === true
    )
  );

  const usesViewportHighlighting = () => (
    getActiveEditorRuntimeState().decision.mode === "viewport-optimized"
  );

  const emptyState = (): HighlightPluginState => ({
    decorations: DecorationSet.empty,
    pending: [],
  });

  const build = (doc: ProseMirrorNode): HighlightPluginState => {
    if (!isActiveEditorCapabilityEnabled("syntax-highlight")) return emptyState();
    if (usesViewportHighlighting() && !activeViewport) return emptyState();

    const decorations: Decoration[] = [];
    const pendingByKey = new Map<string, AutoTask>();
    const range = usesViewportHighlighting() ? activeViewport : null;

    for (const block of codeBlocks(doc, name, range)) {
      const language = normalizedLanguage(block.node, defaultLanguage);
      const code = block.node.textContent;
      let segments: HighlightSegment[] | undefined;

      if (isPlainTextLanguage(language) || NON_LOWLIGHT_LANGUAGES.has(language)) {
        segments = [];
      } else if (isExplicitLanguage(language)) {
        const key = cacheKey("explicit", language, code);
        segments = getCached(key);
        if (!segments) {
          try {
            segments = toSegments(lowlight.highlight(language, code));
          } catch {
            segments = [];
          }
          setCached(key, segments);
        }
      } else {
        const key = cacheKey("auto", AUTO_LANGUAGE, code);
        segments = getCached(key);
        const shouldDefer = currentView?.composing === true || code.length > autoSyncMaxCharacters;
        if (!segments && !shouldDefer) {
          try {
            segments = toSegments(lowlight.highlightAuto(code));
          } catch {
            segments = [];
          }
          setCached(key, segments);
        } else if (!segments) {
          pendingByKey.set(key, { key, pos: block.pos, language, code });
          segments = [];
        }
      }

      for (const segment of segments) {
        decorations.push(Decoration.inline(
          block.pos + 1 + segment.from,
          block.pos + 1 + segment.to,
          { class: segment.classes },
        ));
      }
    }

    return {
      decorations: DecorationSet.create(doc, decorations),
      pending: [...pendingByKey.values()],
    };
  };

  const plugin = new Plugin<HighlightPluginState>({
    key: pluginKey,
    state: {
      init: (_, state) => build(state.doc),
      apply: (transaction, previous) => {
        const result = transaction.getMeta(pluginKey) as AutoResult | RuntimeRefresh | ViewportRefresh | undefined;
        if (result && "viewportRefresh" in result) {
          activeViewport = result.range;
          return build(transaction.doc);
        }
        if (result && "runtimeRefresh" in result) {
          if (!usesViewportHighlighting()) activeViewport = null;
          return build(transaction.doc);
        }
        if (result && "task" in result) {
          const node = transaction.doc.nodeAt(result.task.pos);
          if (
            node?.type.name === name &&
            node.textContent === result.task.code &&
            normalizedLanguage(node, defaultLanguage) === result.task.language
          ) {
            setCached(result.task.key, result.segments);
            return build(transaction.doc);
          }
          return previous;
        }
        if (transaction.docChanged) {
          if (activeViewport) {
            activeViewport = {
              from: transaction.mapping.map(activeViewport.from, -1),
              to: transaction.mapping.map(activeViewport.to, 1),
            };
          }
          return build(transaction.doc);
        }
        return {
          decorations: previous.decorations.map(transaction.mapping, transaction.doc),
          pending: previous.pending,
        };
      },
    },
    props: {
      decorations(state) {
        return pluginKey.getState(state)?.decorations;
      },
    },
    view(view) {
      currentView = view;
      const scheduled = new Map<string, { cancel: () => void; task: AutoTask }>();
      const scrollContainer = findScrollableAncestor(view.dom);
      const scrollTarget: HTMLElement | Window = scrollContainer || window;
      let viewportFrame = 0;
      const requestFrame = (callback: FrameRequestCallback): number => (
        typeof window.requestAnimationFrame === "function"
          ? window.requestAnimationFrame(callback)
          : window.setTimeout(() => callback(performance.now()), 16)
      );
      const cancelFrame = (handle: number) => {
        if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(handle);
        else window.clearTimeout(handle);
      };

      const reportQueueDepth = () => report?.("highlight-queue-depth", { depth: scheduled.size });

      const cancelMissingTasks = (pending: AutoTask[]) => {
        for (const [key, item] of scheduled) {
          if (pending.some((task) => taskEquals(task, item.task))) continue;
          item.cancel();
          scheduled.delete(key);
          report?.("highlight-task-cancelled", {
            pos: item.task.pos,
            codeLength: item.task.code.length,
          });
          reportQueueDepth();
        }
      };

      const schedulePending = () => {
        if (view.isDestroyed) return;
        const pending = pluginKey.getState(view.state)?.pending || [];
        cancelMissingTasks(pending);
        if (view.composing || !isActiveEditorCapabilityEnabled("syntax-highlight")) return;

        for (const task of pending) {
          if (scheduled.has(task.key)) continue;
          let cancelled = false;
          let cancel: () => void;
          const run = () => {
            scheduled.delete(task.key);
            reportQueueDepth();
            if (cancelled || view.isDestroyed || view.composing || !isActiveEditorCapabilityEnabled("syntax-highlight")) {
              schedulePending();
              return;
            }
            const active = pluginKey.getState(view.state)?.pending.some((candidate) => taskEquals(candidate, task));
            if (!active) {
              report?.("highlight-task-stale", { pos: task.pos, codeLength: task.code.length });
              return;
            }
            let segments: HighlightSegment[];
            const startedAt = performance.now();
            try {
              segments = toSegments(lowlight.highlightAuto(task.code));
            } catch {
              segments = [];
            }
            report?.("highlight-task-executed", {
              pos: task.pos,
              codeLength: task.code.length,
              durationMs: performance.now() - startedAt,
            });
            const stillActive = pluginKey.getState(view.state)?.pending.some((candidate) => taskEquals(candidate, task));
            if (!stillActive || view.isDestroyed) {
              report?.("highlight-task-stale", { pos: task.pos, codeLength: task.code.length });
              return;
            }
            view.dispatch(view.state.tr.setMeta(pluginKey, { task, segments } satisfies AutoResult));
            report?.("highlight-task-applied", { pos: task.pos, codeLength: task.code.length });
          };

          if (typeof window.requestIdleCallback === "function") {
            const handle = window.requestIdleCallback(run, { timeout: 1_000 });
            cancel = () => {
              cancelled = true;
              window.cancelIdleCallback(handle);
            };
          } else {
            const handle = window.setTimeout(run, 250);
            cancel = () => {
              cancelled = true;
              window.clearTimeout(handle);
            };
          }
          scheduled.set(task.key, { cancel, task });
          report?.("highlight-task-created", { pos: task.pos, codeLength: task.code.length });
          reportQueueDepth();
        }
      };

      const resolveViewportRange = (): ViewportRange | null => {
        if (!usesViewportHighlighting() || view.isDestroyed) return null;
        const docSize = view.state.doc.content.size;
        const fallbackFrom = view.state.selection.from;
        const fallbackTo = view.state.selection.to;
        let visibleFrom = fallbackFrom;
        let visibleTo = fallbackTo;

        try {
          const editorRect = view.dom.getBoundingClientRect();
          const viewportRect = scrollContainer?.getBoundingClientRect() || {
            top: 0,
            bottom: window.innerHeight,
            left: 0,
            right: window.innerWidth,
          };
          const top = Math.max(editorRect.top + 1, viewportRect.top + 1);
          const bottom = Math.min(editorRect.bottom - 1, viewportRect.bottom - 1);
          const left = Math.max(editorRect.left + 1, viewportRect.left + 1);
          if (bottom > top) {
            visibleFrom = view.posAtCoords({ left, top })?.pos ?? fallbackFrom;
            visibleTo = view.posAtCoords({ left, top: bottom })?.pos ?? fallbackTo;
          }
        } catch {
          // jsdom, hidden panes and detached editor transitions may not support coordinate lookup.
        }

        const from = Math.max(0, Math.min(visibleFrom, visibleTo) - viewportCharacterMargin);
        const to = Math.min(docSize, Math.max(visibleFrom, visibleTo) + viewportCharacterMargin);
        return { from, to: Math.max(from, to) };
      };

      const refreshViewport = (force = false) => {
        if (view.isDestroyed) return;
        const next = resolveViewportRange();
        if (!force && rangesEqual(activeViewport, next)) return;
        view.dispatch(view.state.tr.setMeta(pluginKey, {
          viewportRefresh: true,
          range: next,
        } satisfies ViewportRefresh));
        report?.("highlight-viewport-range", {
          from: next?.from ?? 0,
          to: next?.to ?? 0,
          characters: next ? next.to - next.from : 0,
        });
      };

      const scheduleViewportRefresh = () => {
        if (!usesViewportHighlighting() || view.isDestroyed) return;
        if (viewportFrame) cancelFrame(viewportFrame);
        viewportFrame = requestFrame(() => {
          viewportFrame = 0;
          refreshViewport();
          schedulePending();
        });
      };

      const handleCompositionEnd = () => window.queueMicrotask(schedulePending);
      const handleRuntimeChange = () => {
        if (view.isDestroyed) return;
        if (usesViewportHighlighting()) {
          refreshViewport(true);
        } else {
          activeViewport = null;
          view.dispatch(view.state.tr.setMeta(pluginKey, { runtimeRefresh: true } satisfies RuntimeRefresh));
        }
        schedulePending();
      };
      const handleScroll = () => scheduleViewportRefresh();
      const handleResize = () => scheduleViewportRefresh();

      view.dom.addEventListener("compositionend", handleCompositionEnd);
      scrollTarget.addEventListener("scroll", handleScroll, { passive: true });
      window.addEventListener("resize", handleResize);
      window.addEventListener("nowen:editor-runtime-change", handleRuntimeChange);

      if (usesViewportHighlighting()) {
        window.queueMicrotask(() => refreshViewport(true));
      } else {
        schedulePending();
      }

      return {
        update() {
          schedulePending();
          scheduleViewportRefresh();
        },
        destroy() {
          view.dom.removeEventListener("compositionend", handleCompositionEnd);
          scrollTarget.removeEventListener("scroll", handleScroll);
          window.removeEventListener("resize", handleResize);
          window.removeEventListener("nowen:editor-runtime-change", handleRuntimeChange);
          if (viewportFrame) cancelFrame(viewportFrame);
          for (const item of scheduled.values()) {
            item.cancel();
            report?.("highlight-task-cancelled", {
              pos: item.task.pos,
              codeLength: item.task.code.length,
              destroyed: true,
            });
          }
          scheduled.clear();
          reportQueueDepth();
          activeViewport = null;
          if (currentView === view) currentView = null;
        },
      };
    },
  });

  return plugin;
}
