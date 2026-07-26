import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  highlightSelectionMatches,
  searchKeymap,
} from "@codemirror/search";
import {
  bracketMatching,
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { AlertTriangle, Code2, Eye, FileText, Gauge, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import * as Y from "yjs";

import TagInput from "@/components/TagInput";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import type {
  NoteEditorHandle,
  NoteEditorProps,
} from "@/components/editors/types";
import { normalizeToMarkdown } from "@/lib/contentFormat";
import { internalMarkdownMarkerExtensions } from "@/lib/markdownInternalMarkers";
import { scrollMarkdownPreviewToPosition } from "@/lib/markdownPreviewOutline";
import {
  buildLargeMarkdownSearchText,
  computeSingleTextChange,
  formatLargeMarkdownSize,
} from "@/lib/largeMarkdownSafety";
import {
  applyMarkdownTaskCheckboxChange,
  getMarkdownTaskCheckboxChange,
} from "@/lib/markdownTasks";
import {
  createMarkdownAnalysisController,
  type MarkdownAnalysisController,
} from "@/lib/markdownAnalysisClient";
import type {
  MarkdownAnalysisResult,
  MarkdownAnalysisStats,
} from "@/lib/markdownAnalysis";
import {
  resolveEditorRuntimeDecision,
  type EditorRuntimeMode,
} from "@/lib/editorRuntimePolicy";
import { cn } from "@/lib/utils";

interface LargeMarkdownSafeEditorProps extends NoteEditorProps {
  onAIAssistant?: () => void;
}

const EMPTY_STATS: MarkdownAnalysisStats = {
  chars: 0,
  charsNoSpace: 0,
  words: 0,
};

const baseTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    fontSize: "14px",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    lineHeight: "1.65",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "14px 0 40px",
    caretColor: "var(--color-accent-primary, #3b82f6)",
  },
  ".cm-line": {
    padding: "0 14px",
  },
  ".cm-gutters": {
    border: "none",
    background: "transparent",
    color: "var(--color-tx-tertiary, #94a3b8)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "rgba(128, 128, 128, 0.05)",
  },
});

function isDarkMode(): boolean {
  return typeof document !== "undefined"
    && document.documentElement.classList.contains("dark");
}

function performanceExtensions(mode: EditorRuntimeMode) {
  if (mode === "lightweight-edit") return [];
  return [
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(defaultHighlightStyle),
    EditorView.lineWrapping,
  ];
}

/**
 * CodeMirror viewport editor for medium and large Markdown documents.
 *
 * CodeMirror owns the document and only paints the visible viewport. React never stores the full
 * Markdown string. Whole-document outline/statistics/search-text work is debounced and delegated
 * to a Worker. Emergency save/snapshot paths retain a bounded synchronous fallback so Worker
 * failures cannot lose user data.
 */
const LargeMarkdownSafeEditor = forwardRef<
  NoteEditorHandle,
  LargeMarkdownSafeEditorProps
>(function LargeMarkdownSafeEditor(
  {
    note,
    onUpdate,
    onLocalUpdate,
    onTagsChange,
    onHeadingsChange,
    onEditorReady,
    editable = true,
    isGuest = false,
    searchQuery,
    yDoc,
  },
  forwardedRef,
) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const previewRootRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analysisTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analysisControllerRef = useRef<MarkdownAnalysisController | null>(null);
  const analysisRequestRef = useRef<{ requestId: number; version: number } | null>(null);
  const latestAnalysisRef = useRef<MarkdownAnalysisResult | null>(null);
  const latestAnalysisVersionRef = useRef(-1);
  const contentVersionRef = useRef(0);
  const dirtyRef = useRef(false);
  const isSettingContentRef = useRef(false);
  const lastNoteIdRef = useRef(note.id);
  const lastSyncedContentRef = useRef("");
  const localYOriginRef = useRef<object>({});
  const onUpdateRef = useRef(onUpdate);
  const onLocalUpdateRef = useRef(onLocalUpdate);
  const onHeadingsChangeRef = useRef(onHeadingsChange);
  const emitSaveRef = useRef<() => void>(() => {});
  const themeCompartmentRef = useRef(new Compartment());
  const editableCompartmentRef = useRef(new Compartment());
  const performanceCompartmentRef = useRef(new Compartment());
  const previewActiveRef = useRef(false);

  const [sourceCharacters, setSourceCharacters] = useState(0);
  const [stats, setStats] = useState<MarkdownAnalysisStats>(EMPTY_STATS);
  const [analysisPending, setAnalysisPending] = useState(true);
  const [previewMarkdown, setPreviewMarkdown] = useState<string | null>(null);

  previewActiveRef.current = previewMarkdown !== null;

  onUpdateRef.current = onUpdate;
  onLocalUpdateRef.current = onLocalUpdate;
  onHeadingsChangeRef.current = onHeadingsChange;

  const normalizedNoteContent = useMemo(
    () => normalizeToMarkdown(note.content, note.contentText),
    [note.content, note.contentText],
  );

  const initialMarkdown = useMemo(() => {
    if (!yDoc) return normalizedNoteContent;
    const collaborativeText = yDoc.getText("content").toString();
    return collaborativeText || normalizedNoteContent;
  }, [normalizedNoteContent, yDoc]);

  const runtimeDecision = useMemo(() => resolveEditorRuntimeDecision({
    content: initialMarkdown,
    contentFormat: "markdown",
  }), [initialMarkdown]);

  const scheduleAnalysis = useCallback((delay = 450) => {
    if (analysisTimerRef.current) globalThis.clearTimeout(analysisTimerRef.current);
    setAnalysisPending(true);
    analysisTimerRef.current = globalThis.setTimeout(() => {
      analysisTimerRef.current = null;
      const view = viewRef.current;
      const controller = analysisControllerRef.current;
      if (!view || !controller) return;
      const version = contentVersionRef.current;
      const requestId = controller.analyze(view.state.doc.toString());
      analysisRequestRef.current = { requestId, version };
    }, delay);
  }, []);

  useEffect(() => {
    const controller = createMarkdownAnalysisController({
      onResult: ({ requestId, result }) => {
        const request = analysisRequestRef.current;
        if (!request || request.requestId !== requestId) return;
        if (request.version !== contentVersionRef.current) return;
        latestAnalysisRef.current = result;
        latestAnalysisVersionRef.current = request.version;
        setStats(result.stats);
        setAnalysisPending(false);
        onHeadingsChangeRef.current?.(result.headings);
      },
      onError: (error) => {
        console.warn("[LargeMarkdownSafeEditor] background analysis failed; fallback scheduled", error);
      },
    });
    analysisControllerRef.current = controller;
    return () => {
      controller.destroy();
      if (analysisControllerRef.current === controller) analysisControllerRef.current = null;
    };
  }, []);

  const currentSearchText = useCallback((markdownText: string): string => {
    if (
      latestAnalysisVersionRef.current === contentVersionRef.current
      && latestAnalysisRef.current
    ) {
      return latestAnalysisRef.current.plainText;
    }
    return buildLargeMarkdownSearchText(markdownText);
  }, []);

  const emitSave = useCallback(() => {
    if (!dirtyRef.current) return;
    const view = viewRef.current;
    if (!view) return;

    const markdownText = view.state.doc.toString();
    const title = titleRef.current?.value || note.title;

    if (yDoc) {
      const yText = yDoc.getText("content");
      const previous = lastSyncedContentRef.current;
      const change = computeSingleTextChange(previous, markdownText);
      if (change) {
        yDoc.transact(() => {
          if (change.deleteCount > 0) yText.delete(change.from, change.deleteCount);
          if (change.insert) yText.insert(change.from, change.insert);
        }, localYOriginRef.current);
      }
      lastSyncedContentRef.current = markdownText;
    } else {
      onUpdateRef.current({
        title,
        content: markdownText,
        contentText: currentSearchText(markdownText),
        _noteId: note.id,
      });
    }

    dirtyRef.current = false;
  }, [currentSearchText, note.id, note.title, yDoc]);
  emitSaveRef.current = emitSave;

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) globalThis.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = globalThis.setTimeout(() => {
      saveTimerRef.current = null;
      emitSaveRef.current();
    }, 1_200);
  }, []);

  useImperativeHandle(forwardedRef, () => ({
    flushSave: () => {
      if (saveTimerRef.current) {
        globalThis.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      emitSaveRef.current();
    },
    discardPending: () => {
      if (saveTimerRef.current) {
        globalThis.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      dirtyRef.current = false;
    },
    getSnapshot: () => {
      const view = viewRef.current;
      if (!view) return null;
      const markdownText = view.state.doc.toString();
      return {
        content: markdownText,
        contentText: currentSearchText(markdownText),
      };
    },
    isReady: () => !!viewRef.current,
    appendMarkdown: (markdownText: string) => {
      const view = viewRef.current;
      if (!view || !editable) return false;
      view.dispatch({
        changes: { from: view.state.doc.length, insert: markdownText },
        selection: { anchor: view.state.doc.length + markdownText.length },
      });
      return true;
    },
  }), [currentSearchText, editable]);

  useEffect(() => {
    if (!hostRef.current || viewRef.current) return;

    lastSyncedContentRef.current = initialMarkdown;
    setSourceCharacters(initialMarkdown.length);

    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged || isSettingContentRef.current) return;
      onLocalUpdateRef.current?.({
        title: note.title,
        content: update.state.doc.toString(),
        _noteId: note.id,
      });
      contentVersionRef.current += 1;
      dirtyRef.current = true;
      latestAnalysisVersionRef.current = -1;
      setSourceCharacters(update.state.doc.length);
      scheduleSave();
      scheduleAnalysis();
    });

    const state = EditorState.create({
      doc: initialMarkdown,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        dropCursor(),
        highlightActiveLine(),
        bracketMatching(),
        highlightSelectionMatches(),
        baseTheme,
        themeCompartmentRef.current.of(isDarkMode() ? oneDark : []),
        editableCompartmentRef.current.of([
          EditorView.editable.of(editable),
          EditorState.readOnly.of(!editable),
        ]),
        performanceCompartmentRef.current.of(performanceExtensions(runtimeDecision.mode)),
        ...internalMarkdownMarkerExtensions,
        EditorView.contentAttributes.of({
          spellcheck: "false",
          autocapitalize: "off",
          autocorrect: "off",
          "aria-label": t("markdown.largeDocument.editorLabel", {
            defaultValue: "大文档 CodeMirror 视口编辑器",
          }),
        }),
        placeholder(t("tiptap.placeholder", { defaultValue: "开始写点什么..." })),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              if (saveTimerRef.current) globalThis.clearTimeout(saveTimerRef.current);
              saveTimerRef.current = null;
              emitSaveRef.current();
              return true;
            },
          },
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.domEventHandlers({
          blur: () => {
            if (dirtyRef.current) {
              if (saveTimerRef.current) globalThis.clearTimeout(saveTimerRef.current);
              saveTimerRef.current = null;
              emitSaveRef.current();
            }
            return false;
          },
        }),
        updateListener,
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    scheduleAnalysis(0);

    return () => {
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
    // The editor is mounted once; note/runtime changes are applied through compartments and effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartmentRef.current.reconfigure([
        EditorView.editable.of(editable),
        EditorState.readOnly.of(!editable),
      ]),
    });
  }, [editable]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: performanceCompartmentRef.current.reconfigure(
        performanceExtensions(runtimeDecision.mode),
      ),
    });
  }, [runtimeDecision.mode]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const applyTheme = () => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: themeCompartmentRef.current.reconfigure(isDarkMode() ? oneDark : []),
      });
    };
    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const noteChanged = lastNoteIdRef.current !== note.id;

    if (noteChanged) {
      if (saveTimerRef.current) globalThis.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      dirtyRef.current = false;
      lastNoteIdRef.current = note.id;
    }

    if (noteChanged || !dirtyRef.current) {
      const current = view.state.doc.toString();
      if (current !== initialMarkdown) {
        isSettingContentRef.current = true;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: initialMarkdown },
          selection: { anchor: 0 },
        });
        isSettingContentRef.current = false;
      }
      contentVersionRef.current += 1;
      latestAnalysisVersionRef.current = -1;
      lastSyncedContentRef.current = initialMarkdown;
      setSourceCharacters(initialMarkdown.length);
      scheduleAnalysis(0);
    }

    // 预览只在进入时取一次全文快照；切换笔记时必须替换旧快照，避免串文档。
    if (noteChanged && previewActiveRef.current) setPreviewMarkdown(initialMarkdown);

    if (titleRef.current && (noteChanged || document.activeElement !== titleRef.current)) {
      titleRef.current.value = note.title;
    }
  }, [initialMarkdown, note.id, note.title, scheduleAnalysis]);

  useEffect(() => {
    if (!yDoc) return;
    const yText = yDoc.getText("content");
    const handleRemoteUpdate = (event: Y.YTextEvent) => {
      if (event.transaction.origin === localYOriginRef.current || dirtyRef.current) return;
      const view = viewRef.current;
      if (!view) return;
      const markdownText = yText.toString();
      lastSyncedContentRef.current = markdownText;
      isSettingContentRef.current = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: markdownText },
      });
      isSettingContentRef.current = false;
      contentVersionRef.current += 1;
      latestAnalysisVersionRef.current = -1;
      setSourceCharacters(markdownText.length);
      scheduleAnalysis(0);
    };
    yText.observe(handleRemoteUpdate);
    return () => yText.unobserve(handleRemoteUpdate);
  }, [scheduleAnalysis, yDoc]);

  useEffect(() => {
    onEditorReady?.((position: number) => {
      if (previewActiveRef.current && previewRootRef.current) {
        scrollMarkdownPreviewToPosition(previewRootRef.current, position);
        return;
      }
      const view = viewRef.current;
      if (!view) return;
      const clamped = Math.max(0, Math.min(view.state.doc.length, position));
      view.dispatch({
        selection: { anchor: clamped },
        effects: EditorView.scrollIntoView(clamped, { y: "start", yMargin: 40 }),
      });
      view.focus();
    });
  }, [onEditorReady]);

  useEffect(() => {
    const query = searchQuery?.trim();
    const view = viewRef.current;
    if (!query || !view) return;
    const documentText = view.state.doc.toString();
    const index = documentText.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
    if (index < 0) return;
    view.dispatch({
      selection: { anchor: index, head: index + query.length },
      effects: EditorView.scrollIntoView(index, { y: "center" }),
    });
    view.focus();
  }, [note.id, searchQuery]);

  useEffect(() => () => {
    if (saveTimerRef.current) globalThis.clearTimeout(saveTimerRef.current);
    if (analysisTimerRef.current) globalThis.clearTimeout(analysisTimerRef.current);
  }, []);

  const handleTitleBlur = useCallback(() => {
    const title = titleRef.current?.value.trim() || note.title;
    if (title === note.title) return;
    onUpdateRef.current({ title, _noteId: note.id });
  }, [note.id, note.title]);

  const showPreview = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    setPreviewMarkdown(view.state.doc.toString());
  }, []);

  const showSource = useCallback(() => {
    setPreviewMarkdown(null);
    globalThis.requestAnimationFrame?.(() => viewRef.current?.focus());
  }, []);

  const handlePreviewTaskCheckboxChange = useCallback((taskIndex: number, checked: boolean) => {
    const view = viewRef.current;
    if (!view || !editable) return;
    const currentMarkdown = view.state.doc.toString();
    const change = getMarkdownTaskCheckboxChange(currentMarkdown, taskIndex, checked);
    if (!change) return;
    view.dispatch({ changes: { from: change.from, to: change.to, insert: change.insert } });
    setPreviewMarkdown(applyMarkdownTaskCheckboxChange(currentMarkdown, change));
  }, [editable]);

  const lightweight = runtimeDecision.mode === "lightweight-edit";
  const modeTitle = lightweight
    ? t("markdown.largeDocument.lightweightMode", { defaultValue: "大文档轻量编辑模式" })
    : t("markdown.largeDocument.viewportMode", { defaultValue: "大文档视口优化模式" });
  const modeDescription = lightweight
    ? t("markdown.largeDocument.lightweightModeDesc", {
        defaultValue: "已关闭语法高亮和实时预览；目录、字数和搜索文本在后台线程计算。正文仍可编辑并自动保存。",
      })
    : t("markdown.largeDocument.viewportModeDesc", {
        defaultValue: "CodeMirror 仅绘制可见区域，目录、字数和搜索文本在后台线程计算。",
      });

  return (
    <div className="flex h-full min-h-0 flex-col bg-app-bg">
      <div className={cn(
        "border-b px-4 py-3 md:px-8",
        lightweight
          ? "border-amber-300/60 bg-amber-500/10 text-amber-800 dark:border-amber-500/30 dark:text-amber-200"
          : "border-blue-300/60 bg-blue-500/8 text-blue-800 dark:border-blue-500/30 dark:text-blue-200",
      )}>
        <div className="flex items-start gap-2.5">
          {lightweight
            ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            : <Gauge className="mt-0.5 h-4 w-4 shrink-0" />}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
              <span>{modeTitle}</span>
              <span className="rounded-full border border-current/20 px-2 py-0.5 text-[10px] font-medium opacity-80">
                {formatLargeMarkdownSize(sourceCharacters || initialMarkdown.length)}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 opacity-90">{modeDescription}</p>
          </div>
        </div>
      </div>

      <div className="px-4 pb-2 pt-4 md:px-8 md:pt-6">
        <input
          ref={titleRef}
          defaultValue={note.title}
          onBlur={handleTitleBlur}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              viewRef.current?.focus();
            }
          }}
          readOnly={!editable}
          spellCheck={false}
          className="w-full bg-transparent text-2xl font-bold text-tx-primary outline-none placeholder:text-tx-tertiary/60 md:text-3xl"
          placeholder={t("tiptap.titlePlaceholder", { defaultValue: "无标题" })}
        />
        {!isGuest && (
          <div className="mt-2">
            <TagInput
              noteId={note.id}
              noteTags={note.tags || []}
              onTagsChange={onTagsChange}
            />
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-4 pb-2 md:px-8">
        <div className="mb-2 flex items-center gap-2 text-[11px] text-tx-tertiary">
          <span className="inline-flex items-center gap-1 rounded-md border border-app-border bg-app-surface px-2 py-1">
            <FileText size={12} />
            Markdown
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-300">
            <ShieldCheck size={12} />
            {t("markdown.largeDocument.viewportRendering", { defaultValue: "CodeMirror 视口渲染" })}
          </span>
          {analysisPending && (
            <span className="animate-pulse">
              {t("markdown.largeDocument.analyzing", { defaultValue: "后台分析中…" })}
            </span>
          )}
          <div className="ml-auto inline-flex rounded-md border border-app-border bg-app-surface p-0.5">
            <button
              type="button"
              aria-pressed={previewMarkdown === null}
              onClick={showSource}
              className={cn(
                "inline-flex items-center gap-1 rounded px-2 py-1 transition-colors",
                previewMarkdown === null ? "bg-app-hover text-tx-primary" : "hover:text-tx-primary",
              )}
            >
              <Code2 size={12} />
              {t("markdown.source", { defaultValue: "源代码" })}
            </button>
            <button
              type="button"
              aria-pressed={previewMarkdown !== null}
              onClick={showPreview}
              className={cn(
                "inline-flex items-center gap-1 rounded px-2 py-1 transition-colors",
                previewMarkdown !== null ? "bg-app-hover text-tx-primary" : "hover:text-tx-primary",
              )}
            >
              <Eye size={12} />
              {t("markdown.preview.title", { defaultValue: "预览" })}
            </button>
          </div>
        </div>

        <div
          ref={hostRef}
          data-large-markdown-source
          hidden={previewMarkdown !== null}
          className={cn(
            "min-h-0 flex-1 overflow-hidden rounded-xl border border-app-border bg-app-surface text-tx-primary",
            "focus-within:border-accent-primary/60 focus-within:ring-2 focus-within:ring-accent-primary/15",
            previewMarkdown !== null && "hidden",
            !editable && "opacity-90",
          )}
        />
        {previewMarkdown !== null && (
          <div
            data-large-markdown-preview
            className="min-h-0 flex-1 overflow-hidden rounded-xl border border-app-border bg-app-surface"
          >
            <MarkdownPreview
              markdown={previewMarkdown}
              containerRef={previewRootRef}
              className="h-full"
              onTaskCheckboxChange={editable ? handlePreviewTaskCheckboxChange : undefined}
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-app-border/60 px-4 py-1.5 text-[11px] text-tx-tertiary md:px-8">
        <span>
          {sourceCharacters.toLocaleString()} {t("tiptap.chars", { defaultValue: "字符" })}
        </span>
        <span className="opacity-60">·</span>
        <span>
          {stats.words.toLocaleString()} {t("tiptap.words", { defaultValue: "字词" })}
        </span>
        <span className="opacity-60">·</span>
        <span>
          {previewMarkdown === null
            ? t("markdown.largeDocument.sourceMode", { defaultValue: "源代码" })
            : t("markdown.largeDocument.snapshotPreview", { defaultValue: "快照预览" })}
        </span>
        <span className="ml-auto opacity-60">
          {yDoc
            ? t("markdown.largeDocument.collaborationDebounced", { defaultValue: "协作同步（节流）" })
            : t("markdown.largeDocument.autoSave", { defaultValue: "自动保存" })}
        </span>
      </div>
    </div>
  );
});

LargeMarkdownSafeEditor.displayName = "LargeMarkdownSafeEditor";

export default LargeMarkdownSafeEditor;
