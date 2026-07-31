import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { EditorView } from "@codemirror/view";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Loader2,
  MessageCircle,
  MessageSquarePlus,
  Quote,
  Reply,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import type { Note, ShareComment, User } from "@/types";
import {
  buildTextCommentAnchor,
  compactAnchorQuote,
  parseTextCommentAnchor,
  resolveTextCommentAnchor,
  serializeTextCommentAnchor,
  type InlineCommentEditor,
  type TextCommentAnchor,
} from "@/lib/inlineCommentAnchor";
import {
  CLOSE_INLINE_COMMENT_PANEL_EVENT,
  OPEN_INLINE_COMMENT_PANEL_EVENT,
  type OpenInlineCommentPanelDetail,
} from "@/lib/inlineCommentEvents";

type SelectionDraft = {
  note: Note;
  anchor: TextCommentAnchor;
  top: number;
  left: number;
};

type EditorDocument = {
  editor: InlineCommentEditor;
  root: HTMLElement;
  text: string;
  view?: EditorView;
};

const TRACKING_PATCH = Symbol.for("nowen.inline-comments.api-tracking");
const COMMENT_HIGHLIGHT = "nowen-comment-anchor";
const ACTIVE_COMMENT_HIGHLIGHT = "nowen-comment-active";
const noteCache = new Map<string, Note>();
const noteListeners = new Set<(note: Note) => void>();
let latestTrackedNote: Note | null = null;

function publishTrackedNote(note: Note | null | undefined): void {
  if (!note?.id) return;
  noteCache.set(note.id, note);
  latestTrackedNote = note;
  noteListeners.forEach((listener) => listener(note));
}

function installNoteApiTracking(): void {
  const mutableApi = api as any;
  if (mutableApi[TRACKING_PATCH]) return;
  mutableApi[TRACKING_PATCH] = true;

  const originalGetNote = mutableApi.getNote?.bind(mutableApi);
  if (originalGetNote) {
    mutableApi.getNote = async (...args: unknown[]) => {
      const note = await originalGetNote(...args);
      publishTrackedNote(note);
      return note;
    };
  }

  const originalCreateNote = mutableApi.createNote?.bind(mutableApi);
  if (originalCreateNote) {
    mutableApi.createNote = async (...args: unknown[]) => {
      const note = await originalCreateNote(...args);
      publishTrackedNote(note);
      return note;
    };
  }

  const originalUpdateNote = mutableApi.updateNote?.bind(mutableApi);
  if (originalUpdateNote) {
    mutableApi.updateNote = async (...args: unknown[]) => {
      const note = await originalUpdateNote(...args);
      if (note?.id) {
        noteCache.set(note.id, note);
        if (latestTrackedNote?.id === note.id) publishTrackedNote(note);
      }
      return note;
    };
  }
}

function subscribeTrackedNote(listener: (note: Note) => void): () => void {
  noteListeners.add(listener);
  if (latestTrackedNote) listener(latestTrackedNote);
  return () => noteListeners.delete(listener);
}

function canCommentOnNote(note: Note | null): boolean {
  if (!note) return false;
  return note.permission == null
    || note.permission === "comment"
    || note.permission === "write"
    || note.permission === "manage";
}

function canManageComments(note: Note | null): boolean {
  return !!note && (note.permission == null || note.permission === "manage");
}

function noteMatchesEditor(note: Note, editor: InlineCommentEditor): boolean {
  const isMarkdown = note.contentFormat === "markdown";
  return editor === "markdown" ? isMarkdown : !isMarkdown;
}

function noteTextForEditor(note: Note, editor: InlineCommentEditor): string {
  return editor === "markdown" ? (note.content || "") : (note.contentText || "");
}

function chooseNoteForSelection(anchor: TextCommentAnchor, documentText: string): Note | null {
  const candidates = Array.from(noteCache.values()).filter((note) => noteMatchesEditor(note, anchor.editor));
  if (latestTrackedNote && !candidates.some((note) => note.id === latestTrackedNote?.id)) {
    candidates.push(latestTrackedNote);
  }
  if (candidates.length === 0) return latestTrackedNote;

  const scored = candidates.map((note) => {
    const noteText = noteTextForEditor(note, anchor.editor);
    let score = 0;
    if (note.id === latestTrackedNote?.id) score += 8;
    if (noteText.includes(anchor.quote)) score += 30;
    if (noteText.length && documentText.length) {
      const ratio = Math.min(noteText.length, documentText.length) / Math.max(noteText.length, documentText.length);
      score += ratio * 6;
    }
    return { note, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.note || latestTrackedNote;
}

function findEditorRoot(target: Node | null): HTMLElement | null {
  if (!(target instanceof Element)) return target?.parentElement?.closest?.(".ProseMirror, .cm-content") || null;
  return target.closest<HTMLElement>(".ProseMirror, .cm-content");
}

function getCodeMirrorView(root: HTMLElement): EditorView | null {
  try {
    return EditorView.findFromDOM(root);
  } catch {
    return null;
  }
}

function getEditorDocument(root: HTMLElement): EditorDocument | null {
  if (root.classList.contains("cm-content")) {
    const view = getCodeMirrorView(root);
    if (!view) return null;
    return {
      editor: "markdown",
      root,
      text: view.state.doc.toString(),
      view,
    };
  }
  return {
    editor: "tiptap",
    root,
    text: root.textContent || "",
  };
}

function getTextOffset(root: HTMLElement, container: Node, offset: number): number {
  try {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(container, offset);
    return range.toString().length;
  } catch {
    return 0;
  }
}

function createDomRange(root: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let consumed = 0;
  let startNode: Text | null = null;
  let endNode: Text | null = null;
  let startOffset = 0;
  let endOffset = 0;

  while (node) {
    const textNode = node as Text;
    const length = textNode.data.length;
    if (!startNode && start <= consumed + length) {
      startNode = textNode;
      startOffset = Math.max(0, Math.min(length, start - consumed));
    }
    if (end <= consumed + length) {
      endNode = textNode;
      endOffset = Math.max(0, Math.min(length, end - consumed));
      break;
    }
    consumed += length;
    node = walker.nextNode();
  }

  if (!startNode) return null;
  if (!endNode) {
    endNode = startNode;
    endOffset = startNode.data.length;
  }
  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  } catch {
    return null;
  }
}

function readSelectionDraft(): SelectionDraft | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const root = findEditorRoot(range.commonAncestorContainer);
  if (!root) return null;
  const documentInfo = getEditorDocument(root);
  if (!documentInfo) return null;

  let start = 0;
  let end = 0;
  if (documentInfo.editor === "markdown" && documentInfo.view) {
    const main = documentInfo.view.state.selection.main;
    start = main.from;
    end = main.to;
  } else {
    start = getTextOffset(root, range.startContainer, range.startOffset);
    end = getTextOffset(root, range.endContainer, range.endOffset);
  }
  if (end < start) [start, end] = [end, start];

  const anchor = buildTextCommentAnchor({
    editor: documentInfo.editor,
    documentText: documentInfo.text,
    start,
    end,
  });
  if (!anchor) return null;
  const note = chooseNoteForSelection(anchor, documentInfo.text);
  if (!note || !canCommentOnNote(note)) return null;

  const rect = range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return null;
  const left = Math.max(8, Math.min(window.innerWidth - 48, rect.right + 8));
  const top = Math.max(8, Math.min(window.innerHeight - 48, rect.top - 42));
  return { note, anchor, top, left };
}

function resolveAnchorInDocument(documentInfo: EditorDocument, anchor: TextCommentAnchor) {
  return resolveTextCommentAnchor(documentInfo.text, anchor);
}

function editorDocuments(editor?: InlineCommentEditor): EditorDocument[] {
  const selector = editor === "markdown"
    ? ".cm-content"
    : editor === "tiptap"
      ? ".ProseMirror"
      : ".ProseMirror, .cm-content";
  return Array.from(document.querySelectorAll<HTMLElement>(selector))
    .map(getEditorDocument)
    .filter((value): value is EditorDocument => !!value);
}

function clearCommentHighlights(): void {
  const highlights = (CSS as any)?.highlights;
  highlights?.delete?.(COMMENT_HIGHLIGHT);
  highlights?.delete?.(ACTIVE_COMMENT_HIGHLIGHT);
}

function renderCommentHighlights(comments: ShareComment[], activeCommentId: string | null): void {
  const highlights = (CSS as any)?.highlights;
  const HighlightCtor = (window as any).Highlight;
  if (!highlights || !HighlightCtor) return;

  const normalRanges: Range[] = [];
  const activeRanges: Range[] = [];
  const topLevel = comments.filter((comment) => !comment.parentId && !comment.isResolved);
  for (const comment of topLevel) {
    const anchor = parseTextCommentAnchor(comment.anchorData);
    if (!anchor) continue;
    for (const documentInfo of editorDocuments(anchor.editor)) {
      const resolved = resolveAnchorInDocument(documentInfo, anchor);
      if (!resolved) continue;
      let range: Range | null = null;
      if (documentInfo.editor === "markdown" && documentInfo.view) {
        try {
          const startDom = documentInfo.view.domAtPos(resolved.start);
          const endDom = documentInfo.view.domAtPos(resolved.end);
          range = document.createRange();
          range.setStart(startDom.node, startDom.offset);
          range.setEnd(endDom.node, endDom.offset);
        } catch {
          range = null;
        }
      } else {
        range = createDomRange(documentInfo.root, resolved.start, resolved.end);
      }
      if (!range) continue;
      (comment.id === activeCommentId ? activeRanges : normalRanges).push(range);
    }
  }

  highlights.delete(COMMENT_HIGHLIGHT);
  highlights.delete(ACTIVE_COMMENT_HIGHLIGHT);
  if (normalRanges.length) highlights.set(COMMENT_HIGHLIGHT, new HighlightCtor(...normalRanges));
  if (activeRanges.length) highlights.set(ACTIVE_COMMENT_HIGHLIGHT, new HighlightCtor(...activeRanges));
}

function caretOffsetFromPoint(documentInfo: EditorDocument, x: number, y: number): number | null {
  if (documentInfo.editor === "markdown" && documentInfo.view) {
    try {
      return documentInfo.view.posAtCoords({ x, y });
    } catch {
      return null;
    }
  }

  const doc = document as any;
  const caret = typeof doc.caretPositionFromPoint === "function"
    ? doc.caretPositionFromPoint(x, y)
    : typeof doc.caretRangeFromPoint === "function"
      ? doc.caretRangeFromPoint(x, y)
      : null;
  if (!caret) return null;
  const node = caret.offsetNode || caret.startContainer;
  const offset = caret.offset ?? caret.startOffset;
  if (!node || !documentInfo.root.contains(node)) return null;
  return getTextOffset(documentInfo.root, node, offset);
}

function focusCommentAnchor(comment: ShareComment): boolean {
  const anchor = parseTextCommentAnchor(comment.anchorData);
  if (!anchor) return false;
  for (const documentInfo of editorDocuments(anchor.editor)) {
    const resolved = resolveAnchorInDocument(documentInfo, anchor);
    if (!resolved) continue;
    if (documentInfo.editor === "markdown" && documentInfo.view) {
      try {
        documentInfo.view.dispatch({
          selection: { anchor: resolved.start, head: resolved.end },
          effects: EditorView.scrollIntoView(resolved.start, { y: "center" }),
        });
        documentInfo.view.focus();
        return true;
      } catch {
        continue;
      }
    }
    const range = createDomRange(documentInfo.root, resolved.start, resolved.end);
    if (!range) continue;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const element = range.startContainer.parentElement;
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
    return true;
  }
  return false;
}

function formatCommentTime(value: string): string {
  const date = new Date(value);
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return date.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function CommentThread({
  comment,
  replies,
  active,
  currentUser,
  canManage,
  onActivate,
  onReply,
  onDelete,
  onResolve,
}: {
  comment: ShareComment;
  replies: ShareComment[];
  active: boolean;
  currentUser: User | null;
  canManage: boolean;
  onActivate: (comment: ShareComment) => void;
  onReply: (comment: ShareComment) => void;
  onDelete: (comment: ShareComment) => void;
  onResolve: (comment: ShareComment) => void;
}) {
  const anchor = parseTextCommentAnchor(comment.anchorData);
  const canDelete = canManage || (!!currentUser && comment.userId === currentUser.id);
  return (
    <article
      className={cn(
        "rounded-xl border bg-app-surface p-3 transition-colors",
        active ? "border-amber-400/70 shadow-sm" : "border-app-border",
        !!comment.isResolved && "opacity-60",
      )}
      data-comment-thread-id={comment.id}
    >
      {anchor && (
        <button
          type="button"
          onClick={() => onActivate(comment)}
          className="mb-2 flex w-full items-start gap-2 rounded-lg border-l-2 border-amber-400 bg-amber-400/8 px-2.5 py-2 text-left text-xs text-tx-secondary hover:bg-amber-400/12"
          title={anchor.quote}
        >
          <Quote size={13} className="mt-0.5 shrink-0 text-amber-500" />
          <span className="line-clamp-2 leading-5">{compactAnchorQuote(anchor, 140)}</span>
        </button>
      )}

      <div className="flex items-center gap-2">
        <div className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
          comment.isGuest
            ? "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200"
            : "bg-accent-primary/15 text-accent-primary",
        )}>
          {((comment.displayName || comment.username || "?")[0] || "?").toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-tx-primary">
            {comment.displayName || comment.username || "匿名"}
          </div>
          <div className="text-[10px] text-tx-tertiary">{formatCommentTime(comment.createdAt)}</div>
        </div>
        <div className="flex items-center gap-0.5">
          {canManage && (
            <button
              type="button"
              onClick={() => onResolve(comment)}
              className="rounded-md p-1.5 text-tx-tertiary hover:bg-green-500/10 hover:text-green-500"
              title={comment.isResolved ? "重新打开" : "标记为已解决"}
            >
              {comment.isResolved ? <CheckCircle2 size={14} /> : <Circle size={14} />}
            </button>
          )}
          <button
            type="button"
            onClick={() => onReply(comment)}
            className="rounded-md p-1.5 text-tx-tertiary hover:bg-accent-primary/10 hover:text-accent-primary"
            title="回复"
          >
            <Reply size={14} />
          </button>
          {canDelete && (
            <button
              type="button"
              onClick={() => onDelete(comment)}
              className="rounded-md p-1.5 text-tx-tertiary hover:bg-red-500/10 hover:text-red-500"
              title="删除"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-tx-secondary">{comment.content}</p>

      {replies.length > 0 && (
        <div className="mt-3 space-y-2 border-l-2 border-app-border pl-3">
          {replies.map((reply) => {
            const canDeleteReply = canManage || (!!currentUser && reply.userId === currentUser.id);
            return (
              <div key={reply.id} className="rounded-lg bg-app-hover/60 px-2.5 py-2">
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="font-medium text-tx-primary">{reply.displayName || reply.username || "匿名"}</span>
                  <span className="text-tx-tertiary">{formatCommentTime(reply.createdAt)}</span>
                  {canDeleteReply && (
                    <button
                      type="button"
                      onClick={() => onDelete(reply)}
                      className="ml-auto rounded p-1 text-tx-tertiary hover:text-red-500"
                      title="删除回复"
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-tx-secondary">{reply.content}</p>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

export default function InlineCommentBridge() {
  const { t } = useTranslation();
  const [currentNote, setCurrentNote] = useState<Note | null>(() => latestTrackedNote);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [comments, setComments] = useState<ShareComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<TextCommentAnchor | null>(null);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<ShareComment | null>(null);
  const [composer, setComposer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const externalCloseRef = useRef<(() => void) | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const loadRequestRef = useRef(0);

  useEffect(() => {
    installNoteApiTracking();
    return subscribeTrackedNote(setCurrentNote);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then((user) => { if (!cancelled) setCurrentUser(user); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const loadComments = useCallback(async (noteId: string, quiet = false) => {
    const requestId = ++loadRequestRef.current;
    if (!quiet) setCommentsLoading(true);
    try {
      const data = await api.getNoteComments(noteId);
      if (requestId === loadRequestRef.current) setComments(data);
    } catch (error: any) {
      if (!quiet) toast.error(error?.message || "加载评论失败");
    } finally {
      if (!quiet && requestId === loadRequestRef.current) setCommentsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!currentNote?.id) {
      setComments([]);
      return;
    }
    setActiveCommentId(null);
    setReplyTo(null);
    setPendingAnchor(null);
    void loadComments(currentNote.id);
  }, [currentNote?.id, loadComments]);

  useEffect(() => {
    if (!panelOpen || !currentNote?.id) return;
    const timer = window.setInterval(() => void loadComments(currentNote.id, true), 10_000);
    const onFocus = () => void loadComments(currentNote.id, true);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [currentNote?.id, loadComments, panelOpen]);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setPendingAnchor(null);
    setReplyTo(null);
    setComposer("");
    setActiveCommentId(null);
    clearCommentHighlights();
    const callback = externalCloseRef.current;
    externalCloseRef.current = null;
    callback?.();
  }, []);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenInlineCommentPanelDetail>).detail;
      if (!detail?.noteId) return;
      externalCloseRef.current = detail.onClose || null;
      setPendingAnchor(detail.anchor || null);
      setPanelOpen(true);
      setSelectionDraft(null);
      api.getNote(detail.noteId)
        .then((note) => {
          publishTrackedNote(note);
          setCurrentNote(note);
          void loadComments(note.id);
        })
        .catch((error: any) => toast.error(error?.message || "无法打开评论"));
      window.setTimeout(() => textareaRef.current?.focus(), 120);
    };
    const onClose = () => closePanel();
    window.addEventListener(OPEN_INLINE_COMMENT_PANEL_EVENT, onOpen as EventListener);
    window.addEventListener(CLOSE_INLINE_COMMENT_PANEL_EVENT, onClose);
    return () => {
      window.removeEventListener(OPEN_INLINE_COMMENT_PANEL_EVENT, onOpen as EventListener);
      window.removeEventListener(CLOSE_INLINE_COMMENT_PANEL_EVENT, onClose);
    };
  }, [closePanel, loadComments]);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setSelectionDraft(readSelectionDraft()));
    };
    const hideOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest("[data-inline-comment-ui]")) return;
      if (!findEditorRoot(event.target as Node | null)) setSelectionDraft(null);
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("mouseup", update);
    document.addEventListener("keyup", update);
    document.addEventListener("pointerdown", hideOnPointerDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("mouseup", update);
      document.removeEventListener("keyup", update);
      document.removeEventListener("pointerdown", hideOnPointerDown);
    };
  }, []);

  useEffect(() => {
    let frame = 0;
    const render = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => renderCommentHighlights(comments, activeCommentId));
    };
    render();
    window.addEventListener("resize", render);
    document.addEventListener("scroll", render, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", render);
      document.removeEventListener("scroll", render, true);
      clearCommentHighlights();
    };
  }, [activeCommentId, comments]);

  useEffect(() => {
    const onPointerUp = (event: PointerEvent) => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const root = findEditorRoot(event.target as Node | null);
      if (!root || comments.length === 0) return;
      const documentInfo = getEditorDocument(root);
      if (!documentInfo) return;
      const offset = caretOffsetFromPoint(documentInfo, event.clientX, event.clientY);
      if (offset == null) return;
      const hit = comments.find((comment) => {
        if (comment.parentId || comment.isResolved) return false;
        const anchor = parseTextCommentAnchor(comment.anchorData);
        if (!anchor || anchor.editor !== documentInfo.editor) return false;
        const resolved = resolveAnchorInDocument(documentInfo, anchor);
        return !!resolved && offset >= resolved.start && offset <= resolved.end;
      });
      if (!hit) return;
      setActiveCommentId(hit.id);
      setPanelOpen(true);
      setPendingAnchor(null);
      window.setTimeout(() => {
        document.querySelector(`[data-comment-thread-id="${hit.id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 80);
    };
    document.addEventListener("pointerup", onPointerUp);
    return () => document.removeEventListener("pointerup", onPointerUp);
  }, [comments]);

  const openFromSelection = useCallback(() => {
    if (!selectionDraft) return;
    publishTrackedNote(selectionDraft.note);
    setCurrentNote(selectionDraft.note);
    setPendingAnchor(selectionDraft.anchor);
    setReplyTo(null);
    setComposer("");
    setPanelOpen(true);
    setSelectionDraft(null);
    window.setTimeout(() => textareaRef.current?.focus(), 100);
  }, [selectionDraft]);

  const activateThread = useCallback((comment: ShareComment) => {
    setActiveCommentId(comment.id);
    setPanelOpen(true);
    const located = focusCommentAnchor(comment);
    if (!located) toast.warning("原文已修改，无法定位该批注");
  }, []);

  const submitComment = useCallback(async () => {
    const note = currentNote;
    const content = composer.trim();
    if (!note || !content || submitting || !canCommentOnNote(note)) return;
    setSubmitting(true);
    try {
      const created = await api.addNoteComment(note.id, {
        content,
        parentId: replyTo?.id,
        anchorData: !replyTo && pendingAnchor ? serializeTextCommentAnchor(pendingAnchor) : undefined,
      });
      setComments((items) => [...items, created]);
      setComposer("");
      setReplyTo(null);
      if (!created.parentId) {
        setPendingAnchor(null);
        setActiveCommentId(created.id);
      }
      toast.success(replyTo ? "回复已发送" : pendingAnchor ? "批注已添加" : "评论已添加");
    } catch (error: any) {
      toast.error(error?.message || "评论发送失败");
    } finally {
      setSubmitting(false);
    }
  }, [composer, currentNote, pendingAnchor, replyTo, submitting]);

  const deleteComment = useCallback(async (comment: ShareComment) => {
    if (!currentNote) return;
    try {
      await api.deleteNoteComment(currentNote.id, comment.id);
      await loadComments(currentNote.id, true);
      if (activeCommentId === comment.id) setActiveCommentId(null);
      toast.success("评论已删除");
    } catch (error: any) {
      toast.error(error?.message || "删除失败");
    }
  }, [activeCommentId, currentNote, loadComments]);

  const toggleResolved = useCallback(async (comment: ShareComment) => {
    if (!currentNote) return;
    try {
      const updated = await api.toggleCommentResolved(currentNote.id, comment.id);
      setComments((items) => items.map((item) => item.id === updated.id ? updated : item));
    } catch (error: any) {
      toast.error(error?.message || "更新状态失败");
    }
  }, [currentNote]);

  const topComments = useMemo(() => comments.filter((comment) => !comment.parentId), [comments]);
  const visibleComments = useMemo(
    () => topComments.filter((comment) => showResolved || !comment.isResolved),
    [showResolved, topComments],
  );
  const unresolvedCount = topComments.filter((comment) => !comment.isResolved).length;
  const canComment = canCommentOnNote(currentNote);
  const canManage = canManageComments(currentNote);

  return createPortal(
    <>
      {selectionDraft && (
        <button
          type="button"
          data-inline-comment-ui
          onMouseDown={(event) => event.preventDefault()}
          onClick={openFromSelection}
          className="fixed z-[88] flex h-9 w-9 items-center justify-center rounded-lg border border-app-border bg-app-elevated text-accent-primary shadow-lg transition-transform hover:scale-105 hover:bg-app-hover"
          style={{ top: selectionDraft.top, left: selectionDraft.left }}
          title={t("comments.addInline", { defaultValue: "添加批注" })}
          aria-label={t("comments.addInline", { defaultValue: "添加批注" })}
        >
          <MessageSquarePlus size={17} />
        </button>
      )}

      {!panelOpen && currentNote && (canComment || unresolvedCount > 0) && (
        <button
          type="button"
          data-inline-comment-ui
          onClick={() => {
            setPendingAnchor(null);
            setReplyTo(null);
            setPanelOpen(true);
          }}
          className="nowen-inline-comment-rail fixed right-3 top-1/2 z-[58] hidden -translate-y-1/2 items-center gap-1.5 rounded-full border border-app-border bg-app-elevated px-2.5 py-2 text-xs text-tx-secondary shadow-md hover:bg-app-hover md:flex"
          title={t("comments.openPanel", { defaultValue: "评论与批注" })}
        >
          <MessageCircle size={16} className="text-accent-primary" />
          {unresolvedCount > 0 && <span className="tabular-nums">{unresolvedCount}</span>}
        </button>
      )}

      {panelOpen && (
        <div className="fixed inset-0 z-[89] pointer-events-none" data-inline-comment-ui>
          <button
            type="button"
            className="absolute inset-0 pointer-events-auto bg-black/20 md:hidden"
            onClick={closePanel}
            aria-label="关闭评论面板"
          />
          <aside className="nowen-inline-comment-panel pointer-events-auto absolute inset-y-0 right-0 flex w-full flex-col border-l border-app-border bg-app-elevated shadow-2xl sm:w-[390px]">
            <header className="flex items-center gap-3 border-b border-app-border px-4 py-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-primary/10 text-accent-primary">
                <MessageCircle size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold text-tx-primary">评论与批注</h2>
                <p className="truncate text-[11px] text-tx-tertiary">
                  {currentNote?.title || "当前笔记"} · {unresolvedCount} 条未解决
                </p>
              </div>
              <button
                type="button"
                onClick={closePanel}
                className="rounded-lg p-2 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
                aria-label="关闭"
              >
                <X size={17} />
              </button>
            </header>

            <div className="flex items-center justify-between border-b border-app-border px-4 py-2">
              <span className="text-xs text-tx-tertiary">{topComments.length} 个讨论</span>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-tx-secondary">
                <input
                  type="checkbox"
                  checked={showResolved}
                  onChange={(event) => setShowResolved(event.target.checked)}
                  className="accent-accent-primary"
                />
                显示已解决
              </label>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-3">
              {commentsLoading ? (
                <div className="flex h-40 items-center justify-center text-tx-tertiary">
                  <Loader2 size={20} className="animate-spin" />
                </div>
              ) : visibleComments.length === 0 ? (
                <div className="flex h-52 flex-col items-center justify-center text-center">
                  <MessageCircle size={30} className="mb-3 text-tx-tertiary/30" />
                  <p className="text-sm text-tx-secondary">暂无评论</p>
                  <p className="mt-1 max-w-56 text-xs leading-5 text-tx-tertiary">
                    选中正文后点击批注按钮，或在下方添加整篇笔记评论。
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {visibleComments.map((comment) => (
                    <CommentThread
                      key={comment.id}
                      comment={comment}
                      replies={comments.filter((reply) => reply.parentId === comment.id)}
                      active={activeCommentId === comment.id}
                      currentUser={currentUser}
                      canManage={canManage}
                      onActivate={activateThread}
                      onReply={(target) => {
                        setReplyTo(target);
                        setPendingAnchor(null);
                        window.setTimeout(() => textareaRef.current?.focus(), 0);
                      }}
                      onDelete={deleteComment}
                      onResolve={toggleResolved}
                    />
                  ))}
                </div>
              )}
            </div>

            {canComment ? (
              <footer className="border-t border-app-border bg-app-surface/80 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
                {replyTo && (
                  <div className="mb-2 flex items-center gap-2 rounded-lg bg-app-hover px-2.5 py-1.5 text-xs text-tx-secondary">
                    <Reply size={13} />
                    <span className="min-w-0 flex-1 truncate">回复 {replyTo.displayName || replyTo.username || "评论"}</span>
                    <button type="button" onClick={() => setReplyTo(null)} className="rounded p-1 hover:bg-app-active">
                      <X size={12} />
                    </button>
                  </div>
                )}
                {!replyTo && pendingAnchor && (
                  <div className="mb-2 rounded-lg border-l-2 border-amber-400 bg-amber-400/8 px-2.5 py-2 text-xs text-tx-secondary">
                    <div className="mb-1 flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
                      <Quote size={12} />
                      批注选中文字
                    </div>
                    <p className="line-clamp-2 leading-5">{compactAnchorQuote(pendingAnchor, 160)}</p>
                    <button type="button" onClick={() => setPendingAnchor(null)} className="mt-1 text-[11px] text-tx-tertiary hover:text-tx-primary">
                      改为整篇评论
                    </button>
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <textarea
                    ref={textareaRef}
                    value={composer}
                    onChange={(event) => setComposer(event.target.value)}
                    onKeyDown={(event) => {
                      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                        event.preventDefault();
                        void submitComment();
                      }
                    }}
                    rows={3}
                    maxLength={1000}
                    placeholder={replyTo ? "输入回复…" : pendingAnchor ? "输入批注…" : "输入评论…"}
                    className="min-h-[72px] flex-1 resize-none rounded-xl border border-app-border bg-app-bg px-3 py-2 text-sm text-tx-primary outline-none placeholder:text-tx-tertiary focus:border-accent-primary/60"
                  />
                  <button
                    type="button"
                    disabled={!composer.trim() || submitting}
                    onClick={() => void submitComment()}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-primary text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                    title="发送（Ctrl+Enter）"
                  >
                    {submitting ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  </button>
                </div>
              </footer>
            ) : (
              <footer className="flex items-center gap-2 border-t border-app-border px-4 py-3 text-xs text-tx-tertiary">
                <AlertTriangle size={14} />
                当前权限仅允许查看评论
              </footer>
            )}
          </aside>
        </div>
      )}
    </>,
    document.body,
  );
}
