import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { isActiveEditorCapabilityEnabled } from "@/lib/editorRuntimeStore";

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

type RuntimeRefresh = { runtimeRefresh: true };

const PLAIN_TEXT_LANGUAGES = new Set(["text", "plaintext", "plain", "txt"]);
const NON_LOWLIGHT_LANGUAGES = new Set(["mermaid"]);
const AUTO_LANGUAGE = "auto";
const DEFAULT_AUTO_SYNC_MAX_CHARACTERS = 2_000;
const DEFAULT_CACHE_ENTRIES = 200;
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

function codeBlocks(doc: ProseMirrorNode, name: string): Array<{ node: ProseMirrorNode; pos: number }> {
  const blocks: Array<{ node: ProseMirrorNode; pos: number }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name === name) blocks.push({ node, pos });
  });
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

export type CodeBlockHighlightPluginOptions = {
  name: string;
  lowlight: LowlightLike;
  defaultLanguage?: string | null;
  autoSyncMaxCharacters?: number;
  cacheEntries?: number;
  onDiagnostic?: (event: HighlightDiagnosticEvent, detail: Record<string, number | string | boolean>) => void;
};

export type HighlightDiagnosticEvent =
  | "highlight-task-created"
  | "highlight-task-cancelled"
  | "highlight-task-executed"
  | "highlight-task-stale"
  | "highlight-task-applied"
  | "highlight-queue-depth";

/**
 * Incremental lowlight decorations for Tiptap code blocks.
 *
 * The upstream plugin re-highlights every code block after each edit inside any code block. This
 * plugin caches exact results and defers auto detection. In lightweight runtime mode it returns an
 * empty DecorationSet before traversing the document at all, keeping code editable without paying
 * the whole-document scan/highlight cost.
 */
export function createCodeBlockHighlightPlugin({
  name,
  lowlight,
  defaultLanguage,
  autoSyncMaxCharacters = DEFAULT_AUTO_SYNC_MAX_CHARACTERS,
  cacheEntries = DEFAULT_CACHE_ENTRIES,
  onDiagnostic,
}: CodeBlockHighlightPluginOptions): Plugin<HighlightPluginState> {
  const pluginKey = new PluginKey<HighlightPluginState>("nowenCodeBlockHighlight");
  const cache = new Map<string, HighlightSegment[]>();
  let currentView: EditorView | null = null;
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

  const emptyState = (): HighlightPluginState => ({
    decorations: DecorationSet.empty,
    pending: [],
  });

  const build = (doc: ProseMirrorNode): HighlightPluginState => {
    if (!isActiveEditorCapabilityEnabled("syntax-highlight")) return emptyState();

    const decorations: Decoration[] = [];
    const pendingByKey = new Map<string, AutoTask>();

    for (const block of codeBlocks(doc, name)) {
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
        const result = transaction.getMeta(pluginKey) as AutoResult | RuntimeRefresh | undefined;
        if (result && "runtimeRefresh" in result) return build(transaction.doc);
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
        if (transaction.docChanged) return build(transaction.doc);
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
            if (cancelled || view.composing || !isActiveEditorCapabilityEnabled("syntax-highlight")) {
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
            if (!stillActive) {
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

      const handleCompositionEnd = () => window.queueMicrotask(schedulePending);
      const handleRuntimeChange = () => {
        view.dispatch(view.state.tr.setMeta(pluginKey, { runtimeRefresh: true } satisfies RuntimeRefresh));
        schedulePending();
      };
      view.dom.addEventListener("compositionend", handleCompositionEnd);
      window.addEventListener("nowen:editor-runtime-change", handleRuntimeChange);
      schedulePending();

      return {
        update() {
          schedulePending();
        },
        destroy() {
          view.dom.removeEventListener("compositionend", handleCompositionEnd);
          window.removeEventListener("nowen:editor-runtime-change", handleRuntimeChange);
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
          if (currentView === view) currentView = null;
        },
      };
    },
  });

  return plugin;
}
