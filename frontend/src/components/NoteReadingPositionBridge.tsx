import React, { useEffect, useRef } from "react";
import { getServerUrl } from "@/lib/api";
import {
  noteReadingPositionKey,
  readNoteReadingPosition,
  resolveNoteReadingScrollTop,
  saveNoteReadingPosition,
} from "@/lib/noteReadingPosition";

type ReadingMode = "richtext" | "markdown" | "html";

function findReadingScroller(root: HTMLElement, mode: ReadingMode): HTMLElement | null {
  if (mode === "richtext") {
    return root.querySelector<HTMLElement>('[data-note-reading-scroll="richtext"]');
  }
  if (mode === "markdown") {
    // The CodeMirror viewport is independent of the preview viewport.
    // Prefer whichever visible pane the user is actually reading.
    const preview = root.querySelector<HTMLElement>(".nowen-md-preview");
    const source = root.querySelector<HTMLElement>(".cm-scroller");
    const visible = (el: HTMLElement | null): el is HTMLElement =>
      !!el && el.getClientRects().length > 0 && el.clientHeight > 0;
    return visible(preview) && !visible(source) ? preview : visible(source) ? source : visible(preview) ? preview : null;
  }
  return root.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]');
}

/**
 * Invisible companion of the note editor. The editor's scroll container is
 * mounted asynchronously (CodeMirror/Tiptap), so we resolve it after commit.
 */
export default function NoteReadingPositionBridge({
  noteId,
  userId,
  mode,
  paused = false,
}: {
  noteId: string;
  userId: string;
  mode: ReadingMode;
  paused?: boolean;
}) {
  const marker = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (paused) return;
    const host = marker.current?.closest<HTMLElement>("[data-note-id]");
    if (!host || !noteId || !userId) return;

    const key = noteReadingPositionKey(getServerUrl(), userId, noteId, mode);
    const saved = readNoteReadingPosition(key);
    let current: HTMLElement | null = null;
    let restored = !saved;
    let userInteracted = false;
    let cancelled = false;
    let raf = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let pendingTop = saved?.top ?? 0;

    const capturePosition = () => {
      if (!current || !restored || !userInteracted) return;
      pendingTop = current.scrollTop;
      saveNoteReadingPosition(key, pendingTop, current.scrollHeight, current.clientHeight);
    };
    const onScroll = (event: Event) => {
      if (event.target !== current || !restored) return;
      userInteracted = true;
      pendingTop = current!.scrollTop;
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => { flushTimer = null; capturePosition(); }, 250);
    };
    const onIntent = (event: Event) => {
      if (current && event.target instanceof Node && current.contains(event.target)) {
        // A deliberate gesture beats the stored position.
        userInteracted = true;
        restored = true;
      }
    };
    const tick = () => {
      if (cancelled) return;
      const next = findReadingScroller(host, mode);
      if (next && next !== current) {
        current = next;
        if (!userInteracted && saved) restored = false;
      }
      if (current && !restored && saved) {
        const max = Math.max(0, current.scrollHeight - current.clientHeight);
        // Wait for the editor content to finish mounting. Do not overwrite
        // an old bookmark with scrollTop=0 during the loading skeleton.
        if (max >= Math.min(saved.top, 4) || attempts >= 120) {
          current.scrollTop = resolveNoteReadingScrollTop(saved, current.scrollHeight, current.clientHeight);
          restored = true;
        }
      }
      attempts += 1;
      if (!restored && attempts < 121) raf = requestAnimationFrame(tick);
    };

    // scroll does not bubble; capture is necessary and restricted to its owner.
    host.addEventListener("scroll", onScroll, true);
    host.addEventListener("wheel", onIntent, { passive: true, capture: true });
    host.addEventListener("touchstart", onIntent, { passive: true, capture: true });
    host.addEventListener("pointerdown", onIntent, true);
    raf = requestAnimationFrame(tick);

    const onPageHide = () => capturePosition();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (flushTimer !== null) clearTimeout(flushTimer);
      capturePosition();
      window.removeEventListener("pagehide", onPageHide);
      host.removeEventListener("scroll", onScroll, true);
      host.removeEventListener("wheel", onIntent, true);
      host.removeEventListener("touchstart", onIntent, true);
      host.removeEventListener("pointerdown", onIntent, true);
    };
  }, [noteId, userId, mode, paused]);

  return <span ref={marker} hidden aria-hidden="true" data-note-reading-position-bridge="" />;
}
