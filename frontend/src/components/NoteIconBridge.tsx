import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SmilePlus } from "lucide-react";
import { api } from "@/lib/api";
import { getLatestContextMenuState } from "@/hooks/useContextMenu";
import { realtime } from "@/lib/realtime";
import { toast } from "@/lib/toast";
import { isImageIcon, splitImageIconText } from "@/lib/iconValue";
import {
  getCachedNoteIcon,
  primeNoteIcon,
  queueNoteIcons,
  refreshNoteIcons,
  subscribeNoteIcons,
} from "@/lib/noteIcons";
import NoteIconPickerModal from "@/components/NoteIconPickerModal";

const SNAPSHOT_LIMIT = 12;
const IMAGE_ICON_SKIP_SELECTOR = [
  "script",
  "style",
  "textarea",
  "input",
  "pre",
  "code",
  "[contenteditable='true']",
  ".ProseMirror",
  ".cm-editor",
  ".markdown-body",
  "[data-nowen-imported-image-icon]",
].join(",");

type SnapshotNote = {
  id: string;
  title: string;
  isLocked?: number;
  isTrashed?: number;
};

type NoteSnapshot = {
  notes: SnapshotNote[];
  capturedAt: number;
};

const snapshots: NoteSnapshot[] = [];
const snapshotListeners = new Set<() => void>();

function emitSnapshots(): void {
  for (const listener of snapshotListeners) {
    try { listener(); } catch { /* isolate UI subscribers */ }
  }
}

function captureSnapshot(rows: unknown): void {
  if (!Array.isArray(rows)) return;
  const notes = rows
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    .map((row) => ({
      id: typeof row.id === "string" ? row.id : "",
      title: typeof row.title === "string" ? row.title : "",
      isLocked: typeof row.isLocked === "number" ? row.isLocked : undefined,
      isTrashed: typeof row.isTrashed === "number" ? row.isTrashed : undefined,
    }))
    .filter((note) => note.id);
  if (notes.length === 0) return;

  const signature = notes.map((note) => note.id).join("|");
  const duplicateIndex = snapshots.findIndex(
    (snapshot) => snapshot.notes.map((note) => note.id).join("|") === signature,
  );
  if (duplicateIndex >= 0) snapshots.splice(duplicateIndex, 1);
  snapshots.unshift({ notes, capturedAt: Date.now() });
  if (snapshots.length > SNAPSHOT_LIMIT) snapshots.length = SNAPSHOT_LIMIT;
  emitSnapshots();
}

function subscribeSnapshots(listener: () => void): () => void {
  snapshotListeners.add(listener);
  return () => snapshotListeners.delete(listener);
}

// Capture recent NoteList/search responses without changing their public return types.
// The bridge then maps the visible title-card sequence back to stable note IDs.
const apiWithBridge = api as typeof api & { __noteIconBridgeInstalled?: boolean };
if (!apiWithBridge.__noteIconBridgeInstalled) {
  apiWithBridge.__noteIconBridgeInstalled = true;
  const apiAny = apiWithBridge as any;
  const originalGetNotes = apiAny.getNotes?.bind(apiAny);
  const originalSearch = apiAny.search?.bind(apiAny);

  if (originalGetNotes) {
    apiAny.getNotes = async (...args: unknown[]) => {
      const rows = await originalGetNotes(...args);
      captureSnapshot(rows);
      return rows;
    };
  }
  if (originalSearch) {
    apiAny.search = async (...args: unknown[]) => {
      const rows = await originalSearch(...args);
      captureSnapshot(rows);
      return rows;
    };
  }
}

function createImageIconElement(src: string): HTMLImageElement {
  const image = document.createElement("img");
  image.src = src;
  image.alt = "";
  image.draggable = false;
  image.setAttribute("aria-hidden", "true");
  image.setAttribute("data-nowen-imported-image-icon", "1");
  image.className = "inline-block h-[1em] w-[1em] shrink-0 object-contain align-[-0.125em]";
  return image;
}

function renderIconBadge(badge: HTMLElement, icon: string): void {
  if (isImageIcon(icon)) {
    const existingImage = badge.querySelector<HTMLImageElement>(":scope > img[data-nowen-imported-image-icon]");
    if (existingImage && badge.childNodes.length === 1 && existingImage.src === icon) return;
    badge.replaceChildren(createImageIconElement(icon));
    return;
  }
  if (badge.childNodes.length === 1 && badge.firstChild?.nodeType === Node.TEXT_NODE && badge.textContent === icon) return;
  badge.textContent = icon;
}

function reconcileImportedImageIconText(root: HTMLElement = document.body): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue || "";
    if (!text.includes("data:image/")) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest(IMAGE_ICON_SKIP_SELECTOR)) continue;
    if (!splitImageIconText(text).some((part) => part.type === "image")) continue;
    targets.push(node as Text);
  }

  for (const target of targets) {
    if (!target.isConnected) continue;
    const parts = splitImageIconText(target.nodeValue || "");
    if (!parts.some((part) => part.type === "image")) continue;
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      fragment.append(part.type === "image"
        ? createImageIconElement(part.value)
        : document.createTextNode(part.value));
    }
    target.replaceWith(fragment);
  }
}

function reconcileImportedImageIconMutations(records: MutationRecord[]): void {
  const roots = new Set<HTMLElement>();
  for (const record of records) {
    if (record.type === "characterData") {
      if ((record.target.nodeValue || "").includes("data:image/") && record.target.parentElement) {
        roots.add(record.target.parentElement);
      }
      continue;
    }
    for (const addedNode of Array.from(record.addedNodes)) {
      if (addedNode.nodeType === Node.TEXT_NODE) {
        if ((addedNode.nodeValue || "").includes("data:image/") && addedNode.parentElement) {
          roots.add(addedNode.parentElement);
        }
        continue;
      }
      if (addedNode instanceof HTMLElement && (addedNode.textContent || "").includes("data:image/")) {
        roots.add(addedNode);
      }
    }
  }
  for (const root of roots) reconcileImportedImageIconText(root);
}

function normalizeTitle(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function findBestVisibleNotes(titleElements: HTMLElement[]): SnapshotNote[] {
  if (titleElements.length === 0) return [];
  const visibleTitles = titleElements.map((element) => normalizeTitle(element.textContent));
  let best: { score: number; freshness: number; notes: SnapshotNote[] } | null = null;

  for (const snapshot of snapshots) {
    if (snapshot.notes.length < visibleTitles.length) continue;
    for (let start = 0; start <= snapshot.notes.length - visibleTitles.length; start += 1) {
      let score = 0;
      for (let index = 0; index < visibleTitles.length; index += 1) {
        if (normalizeTitle(snapshot.notes[start + index]?.title) === visibleTitles[index]) score += 1;
      }
      if (!best || score > best.score || (score === best.score && snapshot.capturedAt > best.freshness)) {
        best = {
          score,
          freshness: snapshot.capturedAt,
          notes: snapshot.notes.slice(start, start + visibleTitles.length),
        };
      }
    }
  }

  const requiredScore = Math.max(1, Math.ceil(visibleTitles.length * 0.6));
  return best && best.score >= requiredScore ? best.notes : [];
}

function resolveKnownNote(noteId: string): SnapshotNote | null {
  for (const snapshot of snapshots) {
    const note = snapshot.notes.find((item) => item.id === noteId);
    if (note) return note;
  }
  return null;
}

function findContextMenuRoot(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>("div.w-48.select-none"))
    .find((element) => element.style.position === "fixed" && element.style.zIndex === "100") || null;
}

function getMenuCopy(): { menu: string; locked: string } {
  const language = (localStorage.getItem("i18nextLng") || navigator.language || "").toLowerCase();
  return language.startsWith("zh")
    ? { menu: "设置图标", locked: "笔记已锁定，无法修改图标" }
    : { menu: "Set icon", locked: "This note is locked and its icon cannot be changed" };
}

export default function NoteIconBridge() {
  const copy = useMemo(() => getMenuCopy(), []);
  const [menuHost, setMenuHost] = useState<HTMLElement | null>(null);
  const [menuNoteId, setMenuNoteId] = useState<string | null>(null);
  const [menuLocked, setMenuLocked] = useState(false);
  const [pickerNoteId, setPickerNoteId] = useState<string | null>(null);
  const [pickerLocked, setPickerLocked] = useState(false);
  const scheduledFrameRef = useRef<number | null>(null);

  const reconcileDom = useCallback(() => {
    if (scheduledFrameRef.current !== null) return;
    scheduledFrameRef.current = window.requestAnimationFrame(() => {
      scheduledFrameRef.current = null;

      const titleElements = Array.from(document.querySelectorAll<HTMLElement>(".note-card-title"));
      const visibleNotes = findBestVisibleNotes(titleElements);
      queueNoteIcons(visibleNotes.map((note) => note.id));

      titleElements.forEach((titleElement, index) => {
        const row = titleElement.parentElement;
        if (!row) return;
        const existingBadge = row.querySelector<HTMLElement>("[data-nowen-note-icon-badge]");
        const note = visibleNotes[index];

        if (!note) {
          if (existingBadge) existingBadge.remove();
          row.removeAttribute("data-nowen-note-id");
          return;
        }

        row.setAttribute("data-nowen-note-id", note.id);
        const icon = getCachedNoteIcon(note.id);
        if (!icon) {
          if (existingBadge) existingBadge.remove();
          return;
        }

        if (existingBadge) {
          renderIconBadge(existingBadge, icon);
          return;
        }

        const badge = document.createElement("span");
        badge.setAttribute("data-nowen-note-icon-badge", "1");
        badge.setAttribute("role", "img");
        badge.setAttribute("aria-label", copy.menu);
        badge.className = "shrink-0 text-base leading-none select-none";
        renderIconBadge(badge, icon);
        row.insertBefore(badge, titleElement);
      });

      const menuState = getLatestContextMenuState();
      const menuRoot = menuState.isOpen && menuState.targetType === "note"
        ? findContextMenuRoot()
        : null;
      if (!menuRoot || !menuState.targetId) {
        setMenuHost(null);
        setMenuNoteId(null);
        setMenuLocked(false);
        return;
      }

      const knownNote = resolveKnownNote(menuState.targetId);
      if (knownNote?.isTrashed === 1) {
        menuRoot.querySelector<HTMLElement>("[data-nowen-note-icon-menu-host]")?.remove();
        setMenuHost(null);
        setMenuNoteId(null);
        setMenuLocked(false);
        return;
      }

      let host = menuRoot.querySelector<HTMLElement>("[data-nowen-note-icon-menu-host]");
      if (!host) {
        host = document.createElement("div");
        host.setAttribute("data-nowen-note-icon-menu-host", "1");
        const header = menuRoot.firstElementChild as HTMLElement | null;
        if (header?.className.includes("border-b")) header.after(host);
        else menuRoot.prepend(host);
      }

      setMenuHost(host);
      setMenuNoteId(menuState.targetId);
      setMenuLocked(knownNote?.isLocked === 1);
    });
  }, [copy.menu]);

  useEffect(() => {
    reconcileImportedImageIconText();
    reconcileDom();
    const observer = new MutationObserver((records) => {
      reconcileImportedImageIconMutations(records);
      reconcileDom();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const unsubscribeSnapshots = subscribeSnapshots(reconcileDom);
    const unsubscribeIcons = subscribeNoteIcons(reconcileDom);
    window.addEventListener("resize", reconcileDom);
    window.addEventListener("scroll", reconcileDom, true);

    return () => {
      observer.disconnect();
      unsubscribeSnapshots();
      unsubscribeIcons();
      window.removeEventListener("resize", reconcileDom);
      window.removeEventListener("scroll", reconcileDom, true);
      if (scheduledFrameRef.current !== null) {
        window.cancelAnimationFrame(scheduledFrameRef.current);
      }
    };
  }, [reconcileDom]);

  useEffect(() => realtime.on("note:list-updated", (message: any) => {
    const note = message?.note;
    if (!note?.id || !Object.prototype.hasOwnProperty.call(note, "icon")) return;
    primeNoteIcon(note.id, note.icon);
  }), []);

  useEffect(() => {
    const handleFocus = () => {
      const visibleIds = Array.from(document.querySelectorAll<HTMLElement>("[data-nowen-note-id]"))
        .map((element) => element.dataset.nowenNoteId || "")
        .filter(Boolean);
      if (visibleIds.length > 0) void refreshNoteIcons(visibleIds);
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, []);

  const openPicker = useCallback((noteId: string, locked: boolean) => {
    if (locked) {
      toast.warning(copy.locked);
      return;
    }
    setPickerLocked(locked);
    setPickerNoteId(noteId);
  }, [copy.locked]);

  return (
    <>
      {menuHost && menuNoteId && createPortal(
        <button
          type="button"
          disabled={menuLocked}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openPicker(menuNoteId, menuLocked);
            window.setTimeout(() => {
              document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            }, 0);
          }}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 transition-colors duration-150 ease-out hover:bg-black/[0.04] dark:hover:bg-white/[0.06] hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="flex h-4 w-4 items-center justify-center">
            <SmilePlus size={14} />
          </span>
          {copy.menu}
        </button>,
        menuHost,
      )}

      <NoteIconPickerModal
        noteId={pickerNoteId}
        locked={pickerLocked}
        onClose={() => setPickerNoteId(null)}
        onSaved={reconcileDom}
      />
    </>
  );
}
