import React, { useMemo } from "react";
import DOMPurify from "dompurify";

import { MarkdownPreview } from "@/components/MarkdownPreview";
import { NoteLinkPreviewAnchor } from "@/components/NoteLinkPreview";
import { openInternalNoteLink } from "@/lib/blockNavigation";
import { resolveAttachmentUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Note } from "@/types";

type TiptapMark = {
  type?: string;
  attrs?: Record<string, unknown> | null;
};

type TiptapNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown> | null;
  marks?: TiptapMark[];
  content?: TiptapNode[];
};

interface DailyJournalContentPreviewProps {
  note: Note;
  onOpenEditor: () => void;
  className?: string;
}

const INTERACTIVE_SELECTOR = "a,button,input,textarea,select,summary,[role='button'],img,video,audio";
const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function resolveContentFormat(note: Note): "markdown" | "tiptap-json" | "html" | "text" {
  const declared = String(note.contentFormat || "").toLowerCase();
  if (declared === "markdown" || declared === "md") return "markdown";
  if (declared === "tiptap-json") return "tiptap-json";
  if (declared === "html") return "html";

  const content = String(note.content || "").trim();
  if (!content) return "text";
  if (content.startsWith("{")) {
    try {
      const parsed = JSON.parse(content) as TiptapNode;
      if (parsed?.type === "doc" || Array.isArray(parsed?.content)) return "tiptap-json";
    } catch {
      // Fall through to Markdown/plain text detection.
    }
  }
  if (/^(?:<!doctype\s+html|<html\b|<[a-z][^>]*>)/i.test(content)) return "html";
  return "markdown";
}

function isSafeExternalHref(href: string): boolean {
  if (!href) return false;
  if (href.startsWith("#") || href.startsWith("/") || href.startsWith("./") || href.startsWith("../")) {
    return true;
  }
  try {
    return SAFE_EXTERNAL_PROTOCOLS.has(new URL(href, window.location.href).protocol);
  } catch {
    return false;
  }
}

function titleModeForMark(mark: TiptapMark): "auto" | "alias" {
  const attrs = mark.attrs || {};
  const explicit = attrs.titleMode ?? attrs["data-nowen-title-mode"];
  if (explicit === "alias") return "alias";
  const rel = String(attrs.rel || "");
  return rel.includes("nowen-title-alias") ? "alias" : "auto";
}

function PreviewAnchor({
  href,
  titleMode = "alias",
  children,
}: {
  href: string;
  titleMode?: "auto" | "alias";
  children: React.ReactNode;
}) {
  if (href.startsWith("note:")) {
    return (
      <NoteLinkPreviewAnchor href={href} titleMode={titleMode}>
        {children}
      </NoteLinkPreviewAnchor>
    );
  }
  if (!isSafeExternalHref(href)) return <>{children}</>;
  const external = !href.startsWith("#");
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      className="text-accent-primary underline decoration-accent-primary/35 underline-offset-2 hover:decoration-accent-primary"
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </a>
  );
}

function applyTextMarks(node: TiptapNode, key: React.Key): React.ReactNode {
  let result: React.ReactNode = node.text || "";
  const marks = Array.isArray(node.marks) ? node.marks : [];

  marks.forEach((mark, index) => {
    const markKey = `${String(key)}-mark-${index}`;
    const attrs = mark.attrs || {};
    switch (mark.type) {
      case "link": {
        const href = typeof attrs.href === "string" ? attrs.href : "";
        result = href ? (
          <PreviewAnchor key={markKey} href={href} titleMode={titleModeForMark(mark)}>
            {result}
          </PreviewAnchor>
        ) : result;
        break;
      }
      case "bold":
      case "strong":
        result = <strong key={markKey} className="font-semibold text-tx-primary">{result}</strong>;
        break;
      case "italic":
      case "em":
        result = <em key={markKey}>{result}</em>;
        break;
      case "strike":
        result = <s key={markKey} className="text-tx-tertiary">{result}</s>;
        break;
      case "underline":
        result = <u key={markKey} className="underline-offset-2">{result}</u>;
        break;
      case "code":
        result = <code key={markKey} className="rounded bg-app-hover px-1 py-0.5 font-mono text-[0.9em] text-accent-primary">{result}</code>;
        break;
      case "highlight":
        result = <mark key={markKey} className="rounded bg-yellow-200/70 px-0.5 text-inherit dark:bg-yellow-700/45">{result}</mark>;
        break;
      case "textStyle": {
        const color = typeof attrs.color === "string" ? attrs.color : undefined;
        const fontSize = typeof attrs.fontSize === "string" ? attrs.fontSize : undefined;
        result = <span key={markKey} style={{ color, fontSize }}>{result}</span>;
        break;
      }
      default:
        break;
    }
  });

  return result;
}

function renderTiptapNode(node: TiptapNode, path: string): React.ReactNode {
  const attrs = node.attrs || {};
  const children = Array.isArray(node.content)
    ? node.content.map((child, index) => renderTiptapNode(child, `${path}.${index}`))
    : null;

  switch (node.type) {
    case "doc":
      return <React.Fragment key={path}>{children}</React.Fragment>;
    case "text":
      return <React.Fragment key={path}>{applyTextMarks(node, path)}</React.Fragment>;
    case "paragraph":
      return <p key={path} className="my-2 min-h-[1.5em] leading-7 text-tx-secondary">{children}</p>;
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(attrs.level) || 2));
      const Heading = `h${level}` as keyof React.JSX.IntrinsicElements;
      return <Heading key={path} className="mb-2 mt-4 font-semibold leading-snug text-tx-primary">{children}</Heading>;
    }
    case "bulletList":
      return <ul key={path} className="my-2 list-disc space-y-1 pl-6 text-tx-secondary">{children}</ul>;
    case "orderedList":
      return <ol key={path} start={Number(attrs.start) || 1} className="my-2 list-decimal space-y-1 pl-6 text-tx-secondary">{children}</ol>;
    case "listItem":
      return <li key={path} className="pl-1 leading-7">{children}</li>;
    case "taskList":
      return <ul key={path} className="my-2 list-none space-y-1 pl-0 text-tx-secondary">{children}</ul>;
    case "taskItem":
      return (
        <li key={path} className="flex items-start gap-2 leading-7">
          <input type="checkbox" checked={attrs.checked === true} readOnly className="mt-1.5 h-4 w-4 shrink-0 accent-accent-primary" />
          <div className="min-w-0 flex-1 [&>p]:my-0">{children}</div>
        </li>
      );
    case "blockquote":
      return <blockquote key={path} className="my-3 border-l-4 border-accent-primary/40 bg-app-hover/35 px-4 py-2 text-tx-secondary">{children}</blockquote>;
    case "codeBlock":
      return <pre key={path} className="my-3 overflow-x-auto rounded-lg bg-app-hover p-3 text-xs leading-6 text-tx-primary"><code>{children}</code></pre>;
    case "hardBreak":
      return <br key={path} />;
    case "horizontalRule":
      return <hr key={path} className="my-4 border-app-border" />;
    case "image": {
      const src = typeof attrs.src === "string" ? resolveAttachmentUrl(attrs.src) : "";
      if (!src) return null;
      return (
        <img
          key={path}
          src={src}
          alt={typeof attrs.alt === "string" ? attrs.alt : ""}
          loading="lazy"
          className="my-3 max-h-56 max-w-full rounded-lg border border-app-border object-contain"
        />
      );
    }
    case "mention":
      return <span key={path} className="rounded bg-accent-primary/10 px-1 text-accent-primary">@{String(attrs.label || attrs.id || "用户")}</span>;
    default:
      return <React.Fragment key={path}>{children}</React.Fragment>;
  }
}

function TiptapJournalPreview({ content, fallback }: { content: string; fallback: string }) {
  const document = useMemo(() => {
    try {
      const parsed = JSON.parse(content) as TiptapNode;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }, [content]);

  if (!document) {
    return <p className="whitespace-pre-wrap text-sm leading-7 text-tx-secondary">{fallback}</p>;
  }
  return <div className="text-sm">{renderTiptapNode(document, "doc")}</div>;
}

function sanitizeJournalHtml(content: string): string {
  const clean = DOMPurify.sanitize(content, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target", "rel", "data-nowen-title-mode"],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|note):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  });
  if (typeof document === "undefined") return clean;

  const template = document.createElement("template");
  template.innerHTML = clean;
  template.content.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
    const href = anchor.getAttribute("href") || "";
    if (href.startsWith("note:")) {
      anchor.classList.add("text-accent-primary", "underline", "underline-offset-2");
      return;
    }
    if (!isSafeExternalHref(href)) {
      anchor.removeAttribute("href");
      return;
    }
    anchor.classList.add("text-accent-primary", "underline", "underline-offset-2");
    if (!href.startsWith("#")) {
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
    }
  });
  return template.innerHTML;
}

export default function DailyJournalContentPreview({
  note,
  onOpenEditor,
  className,
}: DailyJournalContentPreviewProps) {
  const format = useMemo(() => resolveContentFormat(note), [note.content, note.contentFormat]);
  const safeHtml = useMemo(
    () => format === "html" ? sanitizeJournalHtml(note.content || "") : "",
    [format, note.content],
  );

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (anchor) {
      const href = anchor.getAttribute("href") || "";
      if (href.startsWith("note:")) {
        event.preventDefault();
        event.stopPropagation();
        openInternalNoteLink(href);
      }
      return;
    }
    if (target?.closest?.(INTERACTIVE_SELECTOR)) return;
    onOpenEditor();
  };

  return (
    <div
      data-daily-journal-content-preview=""
      className={cn(
        "relative max-h-[320px] min-h-[130px] overflow-hidden px-5 py-5",
        "after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-8 after:bg-gradient-to-t after:from-app-surface after:to-transparent",
        className,
      )}
      onClick={handleClick}
    >
      {format === "markdown" ? (
        <MarkdownPreview
          markdown={note.content || note.contentText || ""}
          compact
          className="!max-w-none !overflow-hidden !p-0 text-sm [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_p]:my-2"
        />
      ) : format === "tiptap-json" ? (
        <TiptapJournalPreview content={note.content || ""} fallback={note.contentText || ""} />
      ) : format === "html" ? (
        <div
          className="prose prose-sm max-w-none text-tx-secondary prose-a:text-accent-primary prose-p:my-2 dark:prose-invert"
          dangerouslySetInnerHTML={{ __html: safeHtml }}
        />
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-7 text-tx-secondary">{note.contentText || note.content || ""}</p>
      )}
    </div>
  );
}

export { resolveContentFormat, renderTiptapNode };
