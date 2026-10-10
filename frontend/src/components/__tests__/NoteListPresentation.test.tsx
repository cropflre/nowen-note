import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteCard, SortMenu, VirtualNoteList } from "../NoteList";
import type { NoteListItem } from "@/types";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/exportService", () => ({}));
vi.mock("framer-motion", () => ({
  motion: { div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown }>(({ initial, animate, exit, transition, ...props }, ref) => { void [initial, animate, exit, transition]; return <div ref={ref} {...props} />; }) },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const note: NoteListItem = {
  id: "note-0", userId: "qa", notebookId: "folder", workspaceId: null,
  title: "很长的中英文标题 Long title ".repeat(10), contentText: "正文摘要",
  isPinned: 0, isFavorite: 0, isLocked: 0, isArchived: 0, isTrashed: 0,
  version: 1, createdAt: "2026-09-28 10:00:00", updatedAt: "2026-09-28 10:00:00",
};
const source = readFileSync(path.resolve(__dirname, "../NoteList.tsx"), "utf8");

describe("NoteList compact cards and controls", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });
  const renderCard = (props: Partial<React.ComponentProps<typeof NoteCard>> = {}) => act(() => root.render(
    <NoteCard note={note} sidebarTextStyle="readable" isActive={false} isContextTarget={false}
      onClick={() => {}} onContextMenu={() => {}} showNoteTime notebookLabel="资料" notebookPath="项目 / 资料" {...props} />,
  ));

  it.each([220, 300])("constrains long-title cards at a %ipx list width and exposes full tooltips", (width) => {
    host.style.width = `${width}px`;
    renderCard();
    expect(document.querySelector("[data-note-list-card]")?.className).toContain("w-full min-w-0 max-w-full");
    expect(document.querySelector("h3")?.title).toBe(note.title);
    expect(document.querySelector("h3")?.className).toContain("line-clamp-1");
    expect(document.querySelector('[title="项目 / 资料"]')?.textContent).toBe("资料");
    expect(source).toContain("[&_[data-radix-scroll-area-viewport]>div]:!block");
    expect(source).toContain("[&_[data-radix-scroll-area-viewport]>div]:w-full");
  });
  it("renders one-line previews, compact type icons and right-aligned time", () => {
    renderCard({ note: { ...note, contentFormat: "markdown" } });
    expect(document.querySelector(".note-card-preview")?.className).toContain("line-clamp-1");
    expect(document.querySelector('[aria-label="note.format.markdown"] svg')).not.toBeNull();
    expect(document.querySelector("[data-note-list-card]")?.textContent).not.toContain("MD");
    expect(document.querySelector(".note-card-metadata .ml-auto")).not.toBeNull();
    expect((document.querySelector("[data-note-list-card]") as HTMLElement).style.height).toBe("76px");
  });
  it("uses title-only preference without previews or metadata", () => {
    renderCard({ titleOnly: true });
    expect(document.querySelector(".note-card-preview")).toBeNull();
    expect(document.querySelector(".note-card-metadata")).toBeNull();
    expect((document.querySelector("[data-note-list-card]") as HTMLElement).style.height).toBe("36px");
  });
  it("retains sanitized search snippets even with title-only preference", () => {
    const snippetHtml = '<mark>mindmap</mark> root((主题)) <script>alert(1)</script>';
    renderCard({ titleOnly: true, searchQuery: "mindmap", note: { ...note, snippetHtml, matchedField: "content" } });
    expect(document.querySelector(".note-card-preview mark")?.textContent).toBe("mindmap");
    expect(document.querySelector(".note-card-preview")?.textContent).toContain("root((主题))");
    expect(document.querySelector(".note-card-preview script")).toBeNull();
    expect(document.querySelector(".note-card-preview")?.className).toContain("line-clamp-2");
    expect(host.textContent).toContain("noteList.matchedContent");
  });
  it("preserves classic text and time visibility preferences", () => {
    renderCard({ sidebarTextStyle: "classic", showNoteTime: false });
    expect(document.querySelector(".note-card-preview")?.className).toContain("text-xs text-tx-tertiary");
    expect(document.querySelector(".note-card-metadata")?.className).toContain("text-[10px]");
    expect(document.querySelector(`[title="${note.updatedAt}"]`)).toBeNull();
  });
  it("only renders a hover grip when HTML manual dragging is available, preserving touch callbacks", () => {
    const touch = vi.fn();
    renderCard({ draggable: false, onTouchStart: touch });
    expect(document.querySelector(".lucide-grip-vertical")).toBeNull();
    act(() => document.querySelector("[data-note-list-card]")!.dispatchEvent(new Event("touchstart", { bubbles: true })));
    expect(touch).toHaveBeenCalledOnce();
    renderCard({ draggable: true });
    expect(document.querySelector(".lucide-grip-vertical")?.parentElement?.className).toContain("group-hover:opacity-70");
  });
  it("routes native desktop dragstart/drop events through a plain DOM surface (#814)", () => {
    const onDragStart = vi.fn((event: React.DragEvent) => {
      event.dataTransfer.setData("application/x-nowen-note", note.id);
    });
    const onDragOver = vi.fn((event: React.DragEvent) => { event.preventDefault(); });
    const onDrop = vi.fn();
    const onDragEnd = vi.fn();
    renderCard({ draggable: true, onDragStart, onDragOver, onDrop, onDragEnd });

    const animatedCard = document.querySelector<HTMLElement>("[data-note-list-card]")!;
    const nativeSurface = animatedCard.querySelector<HTMLElement>("[data-note-native-drag-surface='enabled']")!;
    expect(animatedCard.draggable).toBe(false);
    expect(nativeSurface.draggable).toBe(true);

    const payload = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      setData(type: string, value: string) { payload.set(type, value); },
      getData(type: string) { return payload.get(type) || ""; },
    };
    const send = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      act(() => { nativeSurface.dispatchEvent(event); });
    };
    send("dragstart");
    expect(onDragStart).toHaveBeenCalledOnce();
    expect(dataTransfer.getData("application/x-nowen-note")).toBe(note.id);
    send("dragover");
    expect(onDragOver).toHaveBeenCalledOnce();
    send("drop");
    expect(onDrop).toHaveBeenCalledOnce();
    send("dragend");
    expect(onDragEnd).toHaveBeenCalledOnce();
  });

  it("keeps important pin, favorite, lock and share indicators", () => {
    renderCard({ note: { ...note, isPinned: 1, isFavorite: 1, isLocked: 1 }, isShared: true });
    for (const icon of ["pin", "star", "lock", "share2"]) expect(document.querySelector(`.lucide-${icon}`)).not.toBeNull();
  });
  it("uses one responsive menu with preference checkboxes and a date-filter action", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const onChange = vi.fn(), onClose = vi.fn(), toggleTitle = vi.fn(), toggleTime = vi.fn(), toggleDividers = vi.fn(), calendar = vi.fn();
    act(() => root.render(<SortMenu value={{ by: "updatedAt", dir: "desc" }} onChange={onChange} onClose={onClose}
      anchorRef={{ current: anchor }} showNoteTime onToggleShowTime={toggleTime} titleOnly={false} onToggleTitleOnly={toggleTitle}
      showDividers={false} onToggleDividers={toggleDividers} onToggleCalendar={calendar} />));
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')];
    act(() => buttons.find((b) => b.textContent === "noteList.titleOnly")!.click());
    act(() => buttons.find((b) => b.textContent === "noteList.showUpdatedTime")!.click());
    expect(toggleTitle).toHaveBeenCalledOnce();
    expect(toggleTime).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menuitemcheckbox"][aria-checked="true"]')).not.toBeNull();
    act(() => buttons.find((b) => b.textContent?.includes("noteList.sortUpdatedAt"))!.click());
    expect(onChange).toHaveBeenCalledWith({ by: "updatedAt", dir: "asc" });
    act(() => buttons.find((b) => b.textContent === "noteList.dateFilter")!.click());
    expect(calendar).toHaveBeenCalledOnce();
    expect(source.match(/<SortMenu /g)).toHaveLength(1);
    const header = source.slice(source.indexOf("{/* Desktop Header */}"), source.indexOf("{/* 日历筛选面板 */}"));
    expect(header).toContain("flex-wrap");
    expect(header).toContain("data-note-list-desktop-header");
    expect(header).toContain("<SlidersHorizontal");
    expect(header).toContain("<span>{t(\"noteList.listOptions\")}</span>");
    expect(header).not.toContain('sortPref.by !== "manual"');
    expect(header).toContain('t("noteList.listOptions")');
    expect(header).toContain('onClick={() => setDateFilter(null)}');
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("noteList.displaySettings");
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("noteList.filters");
  });
  it("shares row height in virtual lists and clamps scroll when switching to titles only", () => {
    const notes = Array.from({ length: 200 }, (_, i) => ({ ...note, id: `note-${i}`, title: `笔记 ${i}` }));
    const renderVirtual = (titleOnly: boolean, searchQuery?: string) => act(() => root.render(
      <VirtualNoteList notes={notes} scrollScopeKey="same-folder" activeNoteId={undefined} menuState={{ isOpen: false, targetId: null }}
        sharedNoteIds={new Set()} selectedIds={new Set()} onSelectNote={() => {}} onContextMenu={() => {}}
        sidebarTextStyle="readable" titleOnly={titleOnly} searchQuery={searchQuery} />,
    ));
    renderVirtual(false);
    const viewport = document.querySelector<HTMLElement>('[data-note-list-scroll-viewport="virtual"]')!;
    expect((viewport.firstElementChild as HTMLElement).style.height).toBe("16000px");
    act(() => { viewport.scrollTop = 15000; viewport.dispatchEvent(new Event("scroll", { bubbles: true })); });
    renderVirtual(true);
    expect((viewport.firstElementChild as HTMLElement).style.height).toBe("8000px");
    expect(viewport.scrollTop).toBeLessThanOrEqual(8000);
    expect(document.querySelectorAll("[data-note-list-card]").length).toBeGreaterThan(0);
    expect((document.querySelector("[data-note-list-card]") as HTMLElement).style.height).toBe("36px");
    renderVirtual(true, "笔记");
    expect((viewport.firstElementChild as HTMLElement).style.height).toBe("24800px");
    expect((document.querySelector("[data-note-list-card]") as HTMLElement).style.height).toBe("120px");
  });
});
