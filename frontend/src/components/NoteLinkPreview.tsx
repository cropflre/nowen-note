import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, FileText, Loader2, Quote, ExternalLink } from "lucide-react";
import { api } from "@/lib/api";
import { openInternalNoteLink } from "@/lib/blockNavigation";

export interface ResolvedNoteLink {
  note: {
    id: string;
    title: string;
    notebookId: string;
    notebookName: string | null;
    version: number;
    updatedAt: string;
    excerpt: string;
    contentFormat: string;
  };
  block: null | {
    blockId: string;
    blockType: string;
    plainText: string;
  };
}

function useResolvedNoteLink(href: string | null) {
  const [state, setState] = useState<{ loading: boolean; data: ResolvedNoteLink | null; error: boolean }>({
    loading: false, data: null, error: false,
  });
  useEffect(() => {
    let alive = true;
    if (!href) {
      setState({ loading: false, data: null, error: false });
      return;
    }
    setState({ loading: true, data: null, error: false });
    api.resolveNoteLink(href).then(
      (data) => alive && setState({ loading: false, data, error: false }),
      () => alive && setState({ loading: false, data: null, error: true }),
    );
    return () => { alive = false; };
  }, [href]);
  return state;
}

export function NoteLinkPreviewCard({ href, compact = false }: { href: string; compact?: boolean }) {
  const state = useResolvedNoteLink(href);
  if (state.loading) return <div className="flex items-center gap-2 p-3 text-xs text-tx-tertiary"><Loader2 size={14} className="animate-spin" />加载引用…</div>;
  if (state.error || !state.data) {
    return <div className="flex items-center gap-2 p-3 text-xs text-amber-600 dark:text-amber-300"><AlertTriangle size={14} />目标不存在、已删除或无权访问</div>;
  }
  const { note, block } = state.data;
  return (
    <button type="button" onClick={() => openInternalNoteLink(href)} className="block w-full text-left">
      <div className="flex items-start gap-2 p-3">
        <FileText size={15} className="mt-0.5 shrink-0 text-accent-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <strong className="truncate text-sm text-tx-primary">{note.title || "无标题笔记"}</strong>
            <ExternalLink size={11} className="shrink-0 text-tx-tertiary" />
          </div>
          <div className="mt-0.5 text-[11px] text-tx-tertiary">{note.notebookName || "未知笔记本"}</div>
          {block ? (
            <div className="mt-2 rounded-md bg-app-hover px-2.5 py-2">
              <div className="mb-1 flex items-center gap-1 text-[10px] uppercase text-tx-tertiary"><Quote size={10} />{block.blockType}</div>
              <p className={compact ? "line-clamp-2 text-xs text-tx-secondary" : "line-clamp-3 text-xs leading-5 text-tx-secondary"}>{block.plainText || "空块"}</p>
            </div>
          ) : note.excerpt ? (
            <p className="mt-2 line-clamp-3 text-xs leading-5 text-tx-secondary">{note.excerpt}</p>
          ) : null}
        </div>
      </div>
    </button>
  );
}

export function NoteLinkHoverPreview({ root }: { root: HTMLElement | null }) {
  const [hover, setHover] = useState<{ href: string; top: number; left: number } | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!root) return;
    const open = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.('a[href^="note:"]') as HTMLAnchorElement | null;
      if (!anchor) return;
      if (closeTimer.current) clearTimeout(closeTimer.current);
      const rect = anchor.getBoundingClientRect();
      const width = 320;
      setHover({
        href: anchor.getAttribute("href") || "",
        top: Math.min(rect.bottom + 8, window.innerHeight - 220),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      });
    };
    const close = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.('a[href^="note:"]');
      if (!anchor) return;
      closeTimer.current = setTimeout(() => setHover(null), 160);
    };
    root.addEventListener("mouseover", open);
    root.addEventListener("mouseout", close);
    return () => {
      root.removeEventListener("mouseover", open);
      root.removeEventListener("mouseout", close);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, [root]);
  if (!hover) return null;
  return createPortal(
    <div
      className="fixed z-[120] w-80 overflow-hidden rounded-xl border border-app-border bg-app-elevated shadow-2xl"
      style={{ top: hover.top, left: hover.left }}
      onMouseEnter={() => closeTimer.current && clearTimeout(closeTimer.current)}
      onMouseLeave={() => setHover(null)}
    >
      <NoteLinkPreviewCard href={hover.href} />
    </div>,
    document.body,
  );
}

export function NoteLinkPreviewAnchor({
  href,
  titleMode,
  children,
}: {
  href: string;
  titleMode?: "auto" | "alias";
  children?: React.ReactNode;
}) {
  const state = useResolvedNoteLink(href);
  const label = titleMode === "auto" && state.data
    ? state.data.block
      ? `${state.data.note.title} > ${state.data.block.plainText.slice(0, 48)}`
      : state.data.note.title
    : children;
  const invalid = state.error;
  return (
    <span className="group relative inline-block">
      <a
        href={href}
        onClick={(event) => { event.preventDefault(); openInternalNoteLink(href); }}
        className={invalid ? "text-amber-600 underline decoration-dotted" : "text-accent-primary underline-offset-2 hover:underline"}
        title={invalid ? "目标不存在、已删除或无权访问" : undefined}
      >
        {state.loading && titleMode === "auto" ? "加载中…" : label}
      </a>
      <span className="pointer-events-none invisible absolute left-0 top-full z-[100] mt-2 w-80 overflow-hidden rounded-xl border border-app-border bg-app-elevated opacity-0 shadow-2xl transition group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100">
        <NoteLinkPreviewCard href={href} compact />
      </span>
    </span>
  );
}

export { parseInternalNoteHref } from "@/lib/noteLinkSyntax";
