import React, { useCallback, useEffect, useRef } from "react";

import { api } from "@/lib/api";
import { canWriteNote } from "@/lib/notePermissions";
import {
  findTitleDuplicateMatch,
  type TitleDuplicateCandidate,
} from "@/lib/titleDuplicateAssist";
import { useApp } from "@/store/AppContext";
import type { Note } from "@/types";

type TitleField = HTMLTextAreaElement | HTMLInputElement;

type Session = {
  field: TitleField;
  noteId: string;
  notebookId: string;
  composing: boolean;
};

type Mirror = {
  root: HTMLDivElement;
  text: HTMLDivElement;
  prefix: HTMLSpanElement;
  suffix: HTMLSpanElement;
  inlineColor: string;
  inlineCaretColor: string;
  inlineTextFillColor: string;
};

function resolveTitleField(root: HTMLElement, target: EventTarget | null): TitleField | null {
  if (target instanceof HTMLTextAreaElement && root.contains(target)) {
    if (target.closest("[data-mobile-editor-title], [data-markdown-mobile-title]")) return target;
  }

  // LargeMarkdownSafeEditor 目前保留独立的单行标题 input。它没有 data-title 属性，
  // 但所在编辑器一定带 data-large-markdown-source / preview，且标题拥有唯一的大标题 class。
  if (target instanceof HTMLInputElement && root.contains(target)) {
    const largeMarkdownMounted = !!root.querySelector(
      "[data-large-markdown-source], [data-large-markdown-preview]",
    );
    if (
      largeMarkdownMounted
      && target.classList.contains("text-2xl")
      && target.classList.contains("font-bold")
      && target.classList.contains("text-tx-primary")
    ) {
      return target;
    }
  }

  return null;
}

function canAssistTitle(field: TitleField, note: Note | null): note is Note {
  return !!note
    && !field.disabled
    && !field.readOnly
    && !note.isLocked
    && !note.isTrashed
    && canWriteNote(note);
}

function copyTypography(field: TitleField, textLayer: HTMLDivElement): void {
  const style = window.getComputedStyle(field);
  Object.assign(textLayer.style, {
    boxSizing: style.boxSizing,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontStyle: style.fontStyle,
    fontWeight: style.fontWeight,
    fontVariant: style.fontVariant,
    fontStretch: style.fontStretch,
    fontKerning: style.fontKerning,
    fontFeatureSettings: style.fontFeatureSettings,
    fontVariationSettings: style.fontVariationSettings,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    wordSpacing: style.wordSpacing,
    textAlign: style.textAlign,
    textTransform: style.textTransform,
    textIndent: style.textIndent,
    direction: style.direction,
    unicodeBidi: style.unicodeBidi,
    writingMode: style.writingMode,
    tabSize: style.tabSize,
    paddingTop: style.paddingTop,
    paddingRight: style.paddingRight,
    paddingBottom: style.paddingBottom,
    paddingLeft: style.paddingLeft,
    borderTopWidth: style.borderTopWidth,
    borderRightWidth: style.borderRightWidth,
    borderBottomWidth: style.borderBottomWidth,
    borderLeftWidth: style.borderLeftWidth,
    borderStyle: "solid",
    borderColor: "transparent",
    color: style.color,
  });

  if (field instanceof HTMLTextAreaElement) {
    Object.assign(textLayer.style, {
      width: "100%",
      minHeight: "100%",
      whiteSpace: style.whiteSpace || "pre-wrap",
      overflowWrap: style.overflowWrap || "break-word",
      wordBreak: style.wordBreak || "normal",
    });
  } else {
    Object.assign(textLayer.style, {
      width: "max-content",
      minWidth: `${Math.max(field.scrollWidth, field.clientWidth)}px`,
      height: "100%",
      whiteSpace: "pre",
      overflowWrap: "normal",
      wordBreak: "normal",
    });
  }
}

/**
 * 共享标题重复提示运行时。
 *
 * 不接管 textarea/input 的 value，也不改现有 onInput / composition / Enter / Blur / 保存。
 * 编辑期间只做两件事：纯函数匹配 + pointer-events:none mirror 绘制，所以标题按键不会
 * set AppContext，也不会让 Tiptap / CodeMirror 因 duplicate UI 重渲染。
 */
export default function TitleDuplicateAssistBridge({
  rootRef,
}: {
  rootRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { state } = useApp();
  const activeNoteRef = useRef<Note | null>(state.activeNote);
  const cacheRef = useRef<Map<string, TitleDuplicateCandidate[]>>(new Map());
  const inflightRef = useRef<Map<string, Promise<TitleDuplicateCandidate[]>>>(new Map());
  const sessionRef = useRef<Session | null>(null);
  const mirrorRef = useRef<Mirror | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const layoutFrameRef = useRef<number | null>(null);

  activeNoteRef.current = state.activeNote;

  const clearMirror = useCallback(() => {
    if (layoutFrameRef.current !== null) {
      cancelAnimationFrame(layoutFrameRef.current);
      layoutFrameRef.current = null;
    }
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;

    const mirror = mirrorRef.current;
    const field = sessionRef.current?.field;
    if (mirror && field) {
      field.style.color = mirror.inlineColor;
      field.style.caretColor = mirror.inlineCaretColor;
      field.style.webkitTextFillColor = mirror.inlineTextFillColor;
    }
    mirror?.root.remove();
    mirrorRef.current = null;
  }, []);

  const syncMirrorLayout = useCallback(() => {
    const session = sessionRef.current;
    const mirror = mirrorRef.current;
    if (!session || !mirror) return;
    const field = session.field;
    if (!field.isConnected) {
      clearMirror();
      sessionRef.current = null;
      return;
    }

    const rect = field.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      mirror.root.style.display = "none";
      return;
    }

    mirror.root.style.display = "block";
    mirror.root.style.left = `${rect.left}px`;
    mirror.root.style.top = `${rect.top}px`;
    mirror.root.style.width = `${rect.width}px`;
    mirror.root.style.height = `${rect.height}px`;
    copyTypography(field, mirror.text);
    mirror.text.style.transform = `translate(${-field.scrollLeft}px, ${-field.scrollTop}px)`;
  }, [clearMirror]);

  const scheduleLayout = useCallback(() => {
    if (!mirrorRef.current || layoutFrameRef.current !== null) return;
    layoutFrameRef.current = requestAnimationFrame(() => {
      layoutFrameRef.current = null;
      syncMirrorLayout();
    });
  }, [syncMirrorLayout]);

  const ensureMirror = useCallback(() => {
    if (mirrorRef.current) return mirrorRef.current;
    const session = sessionRef.current;
    if (!session) return null;
    const field = session.field;
    const style = window.getComputedStyle(field);

    const root = document.createElement("div");
    root.dataset.titleDuplicateMirror = "";
    root.setAttribute("aria-hidden", "true");
    Object.assign(root.style, {
      position: "fixed",
      overflow: "hidden",
      pointerEvents: "none",
      background: "transparent",
      zIndex: "2147483000",
      margin: "0",
    });

    const text = document.createElement("div");
    Object.assign(text.style, { position: "absolute", left: "0", top: "0" });
    const prefix = document.createElement("span");
    prefix.className = "text-red-500 dark:text-red-400";
    const suffix = document.createElement("span");
    suffix.style.color = style.color;
    text.append(prefix, suffix);
    root.appendChild(text);
    document.body.appendChild(root);

    const mirror: Mirror = {
      root,
      text,
      prefix,
      suffix,
      inlineColor: field.style.color,
      inlineCaretColor: field.style.caretColor,
      inlineTextFillColor: field.style.webkitTextFillColor,
    };
    mirrorRef.current = mirror;

    field.style.color = "transparent";
    field.style.webkitTextFillColor = "transparent";
    field.style.caretColor = style.caretColor === "auto" ? style.color : style.caretColor;

    resizeObserverRef.current = new ResizeObserver(scheduleLayout);
    resizeObserverRef.current.observe(field);
    syncMirrorLayout();
    return mirror;
  }, [scheduleLayout, syncMirrorLayout]);

  const renderMatch = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.composing) return;
    const note = activeNoteRef.current;
    if (!note || note.id !== session.noteId || note.notebookId !== session.notebookId) {
      clearMirror();
      return;
    }

    const title = session.field.value;
    const match = findTitleDuplicateMatch({
      title,
      currentNoteId: session.noteId,
      currentNotebookId: session.notebookId,
      candidates: cacheRef.current.get(session.notebookId) || [],
    });
    if (!match) {
      clearMirror();
      return;
    }

    const mirror = ensureMirror();
    if (!mirror) return;
    mirror.prefix.textContent = title.slice(0, match.prefixLength);
    mirror.suffix.textContent = title.slice(match.prefixLength);
    scheduleLayout();
  }, [clearMirror, ensureMirror, scheduleLayout]);

  const loadCandidates = useCallback((notebookId: string, force = false) => {
    if (!force && cacheRef.current.has(notebookId)) {
      return Promise.resolve(cacheRef.current.get(notebookId)!);
    }
    const inflight = inflightRef.current.get(notebookId);
    if (inflight) return inflight;

    const request = api.getNotes({ notebookId, includeDescendants: "0" })
      .then((notes) => {
        const candidates = notes
          .filter((note) => note.notebookId === notebookId && !note.isTrashed)
          .map((note) => ({
            id: note.id,
            title: note.title || "",
            notebookId: note.notebookId,
            isTrashed: note.isTrashed,
          } satisfies TitleDuplicateCandidate));
        cacheRef.current.set(notebookId, candidates);
        return candidates;
      })
      .catch((error) => {
        console.warn("[title-duplicate-assist] failed to load notebook titles", error);
        return cacheRef.current.get(notebookId) || [];
      })
      .finally(() => inflightRef.current.delete(notebookId));

    inflightRef.current.set(notebookId, request);
    return request;
  }, []);

  const rememberEditedTitle = useCallback(() => {
    const session = sessionRef.current;
    const note = activeNoteRef.current;
    if (!session || !note || note.id !== session.noteId) return;
    const cached = cacheRef.current.get(session.notebookId);
    if (!cached) return;
    const next = cached.filter((candidate) => candidate.id !== session.noteId);
    if (!note.isTrashed) {
      next.push({
        id: session.noteId,
        title: session.field.value,
        notebookId: session.notebookId,
        isTrashed: 0,
      });
    }
    cacheRef.current.set(session.notebookId, next);
  }, []);

  const finishSession = useCallback((rememberTitle: boolean) => {
    const session = sessionRef.current;
    if (!session) return;
    if (rememberTitle && !session.composing) rememberEditedTitle();
    clearMirror();
    sessionRef.current = null;
  }, [clearMirror, rememberEditedTitle]);

  // state.notes 不是可靠候选源：搜索、标签、日期以及“本目录搜索”都会把它缩成子集。
  // 因此只在笔记本变化 / 明确列表刷新时，使用已有 notes list API 拉一次直属笔记并缓存。
  useEffect(() => {
    const note = state.activeNote;
    if (!note?.notebookId) return;
    void loadCandidates(note.notebookId, true).then(() => {
      if (sessionRef.current?.notebookId === note.notebookId) renderMatch();
    });
  }, [loadCandidates, renderMatch, state.activeNote?.notebookId, state.notesRefreshToken]);

  // 本机刚保存过的标题直接合并进已缓存候选；不会因为同笔记本内切换笔记而额外请求。
  useEffect(() => {
    const note = state.activeNote;
    if (!note?.notebookId) return;
    const cached = cacheRef.current.get(note.notebookId);
    if (!cached) return;
    const next = cached.filter((candidate) => candidate.id !== note.id);
    if (!note.isTrashed) {
      next.push({
        id: note.id,
        title: note.title || "",
        notebookId: note.notebookId,
        isTrashed: note.isTrashed,
      });
    }
    cacheRef.current.set(note.notebookId, next);
  }, [state.activeNote?.id, state.activeNote?.isTrashed, state.activeNote?.notebookId, state.activeNote?.title]);

  useEffect(() => {
    const note = state.activeNote;
    const session = sessionRef.current;
    if (
      !note
      || note.isLocked
      || note.isTrashed
      || !canWriteNote(note)
      || (session && (session.noteId !== note.id || session.notebookId !== note.notebookId))
    ) {
      finishSession(false);
    }
  }, [
    finishSession,
    state.activeNote?.id,
    state.activeNote?.isLocked,
    state.activeNote?.isTrashed,
    state.activeNote?.notebookId,
  ]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const startSession = (field: TitleField) => {
      const note = activeNoteRef.current;
      if (!canAssistTitle(field, note)) return;
      finishSession(false);
      sessionRef.current = {
        field,
        noteId: note.id,
        notebookId: note.notebookId,
        composing: false,
      };
      renderMatch();
      void loadCandidates(note.notebookId).then(() => {
        if (sessionRef.current?.field === field) renderMatch();
      });
    };

    const onFocusIn = (event: FocusEvent) => {
      const field = resolveTitleField(root, event.target);
      if (field) startSession(field);
    };
    const onInput = (event: Event) => {
      const session = sessionRef.current;
      if (session && event.target === session.field && !session.composing) renderMatch();
    };
    const onCompositionStart = (event: CompositionEvent) => {
      const session = sessionRef.current;
      if (!session || event.target !== session.field) return;
      session.composing = true;
      clearMirror();
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      const session = sessionRef.current;
      if (!session || event.target !== session.field) return;
      session.composing = false;
      queueMicrotask(renderMatch);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const session = sessionRef.current;
      if (!session || event.target !== session.field) return;
      if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229 && !session.composing) {
        // 只关视觉提示；不 preventDefault、不 blur、不等待 PUT，原 Enter 链路保持不变。
        finishSession(true);
      }
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.target === sessionRef.current?.field) finishSession(true);
    };
    const onScroll = (event: Event) => {
      if (event.target === sessionRef.current?.field) scheduleLayout();
    };

    root.addEventListener("focusin", onFocusIn, true);
    root.addEventListener("input", onInput, true);
    root.addEventListener("compositionstart", onCompositionStart, true);
    root.addEventListener("compositionend", onCompositionEnd, true);
    root.addEventListener("keydown", onKeyDown, true);
    root.addEventListener("focusout", onFocusOut, true);
    root.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", scheduleLayout);
    window.addEventListener("scroll", scheduleLayout, true);
    window.visualViewport?.addEventListener("resize", scheduleLayout);
    window.visualViewport?.addEventListener("scroll", scheduleLayout);

    const focused = resolveTitleField(root, document.activeElement);
    if (focused) startSession(focused);

    return () => {
      root.removeEventListener("focusin", onFocusIn, true);
      root.removeEventListener("input", onInput, true);
      root.removeEventListener("compositionstart", onCompositionStart, true);
      root.removeEventListener("compositionend", onCompositionEnd, true);
      root.removeEventListener("keydown", onKeyDown, true);
      root.removeEventListener("focusout", onFocusOut, true);
      root.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", scheduleLayout);
      window.removeEventListener("scroll", scheduleLayout, true);
      window.visualViewport?.removeEventListener("resize", scheduleLayout);
      window.visualViewport?.removeEventListener("scroll", scheduleLayout);
      finishSession(false);
    };
  }, [finishSession, loadCandidates, renderMatch, rootRef, scheduleLayout, clearMirror]);

  return null;
}
