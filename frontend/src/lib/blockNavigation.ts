import { getBaseUrl } from "@/lib/api.impl";
import { parseInternalNoteHref } from "@/lib/noteLinkSyntax";

const STORAGE_KEY = "nowen.pendingBlockNavigation";
const EVENT_NAME = "nowen:block-navigation";
const OPEN_EVENT = "nowen:open-note-link";
let openSequence = 0;

export interface BlockNavigationRequest {
  noteId: string;
  blockId: string;
  createdAt: number;
}

interface ResolvedBlockLinkPayload {
  note?: { id?: string };
  block?: { blockId?: string } | null;
  redirect?: {
    redirected?: boolean;
    fromNoteId?: string;
    fromBlockId?: string;
    toNoteId?: string;
    toBlockId?: string | null;
    hops?: number;
  };
}

function clearPendingBlockNavigation(): void {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
}

export function requestBlockNavigation(noteId: string, blockId: string): void {
  const request: BlockNavigationRequest = { noteId, blockId, createdAt: Date.now() };
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(request)); } catch {}
  window.dispatchEvent(new CustomEvent<BlockNavigationRequest>(EVENT_NAME, { detail: request }));
}

export function consumeBlockNavigation(noteId: string): BlockNavigationRequest | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const request = JSON.parse(raw) as BlockNavigationRequest;
    if (request.noteId !== noteId || Date.now() - request.createdAt > 30_000) return null;
    sessionStorage.removeItem(STORAGE_KEY);
    return request;
  } catch {
    return null;
  }
}

export function subscribeBlockNavigation(listener: (request: BlockNavigationRequest) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<BlockNavigationRequest>).detail);
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

async function resolveBlockLink(
  href: string,
  fallback: { noteId: string; blockId: string },
): Promise<{ noteId: string; blockId: string | null; redirected: boolean }> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 10_000);
  const token = localStorage.getItem("nowen-token");
  try {
    const response = await fetch(
      `${getBaseUrl()}/blocks/resolve?link=${encodeURIComponent(href)}`,
      {
        signal: controller.signal,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      },
    );
    if (!response.ok) return { ...fallback, redirected: false };
    const payload = await response.json().catch(() => ({})) as ResolvedBlockLinkPayload;
    const noteId = typeof payload.note?.id === "string" ? payload.note.id : fallback.noteId;
    const blockId = typeof payload.block?.blockId === "string"
      ? payload.block.blockId
      : payload.redirect?.redirected
        ? null
        : fallback.blockId;
    return { noteId, blockId, redirected: payload.redirect?.redirected === true };
  } catch {
    return { ...fallback, redirected: false };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function dispatchOpen(detail: { noteId: string; blockId: string | null; href: string; redirected?: boolean }): void {
  if (detail.blockId) requestBlockNavigation(detail.noteId, detail.blockId);
  else clearPendingBlockNavigation();
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail }));
}

export function openInternalNoteLink(href: string): boolean {
  const parsed = parseInternalNoteHref(href);
  if (!parsed) return false;
  const sequence = ++openSequence;

  if (!parsed.blockId) {
    dispatchOpen({ ...parsed, href, redirected: false });
    return true;
  }

  void resolveBlockLink(href, { noteId: parsed.noteId, blockId: parsed.blockId })
    .then((resolved) => {
      if (sequence !== openSequence) return;
      dispatchOpen({ ...resolved, href });
    });
  return true;
}

export function subscribeOpenInternalNoteLink(
  listener: (detail: { noteId: string; blockId: string | null; href: string; redirected?: boolean }) => void,
): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<any>).detail);
  window.addEventListener(OPEN_EVENT, handler);
  return () => window.removeEventListener(OPEN_EVENT, handler);
}
