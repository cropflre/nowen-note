import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NoteReadingPositionBridge from "../NoteReadingPositionBridge";
import {
  noteReadingPositionKey,
  readNoteReadingPosition,
  saveNoteReadingPosition,
} from "@/lib/noteReadingPosition";

vi.mock("@/lib/api", () => ({ getServerUrl: () => "https://notes.example" }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
let frames: FrameRequestCallback[];

function mount(noteId: string, mode: "richtext" | "markdown" = "richtext") {
  act(() => {
    root.render(
      <section data-note-id={noteId}>
        <div data-note-reading-scroll="richtext" className="reader" />
        {mode === "markdown" ? <div className="cm-scroller" /> : null}
        <NoteReadingPositionBridge noteId={noteId} userId="reader-user" mode={mode} />
      </section>,
    );
  });
  const scroller = host.querySelector<HTMLElement>(
    mode === "markdown" ? ".cm-scroller" : '[data-note-reading-scroll="richtext"]',
  )!;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 4000 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
  // jsdom has no layout; visible panes report zero client rects by default.
  Object.defineProperty(scroller, "getClientRects", { configurable: true, value: () => [{ width: 800, height: 600 }] });
  act(() => {
    for (let i = 0; i < 3 && frames.length; i++) {
      const batch = frames.splice(0);
      batch.forEach((callback) => callback(0));
    }
  });
  return scroller;
}

beforeEach(() => {
  localStorage.clear();
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Issue #817 reading position DOM integration", () => {
  it("restores rich-text viewport after re-opening the same note without modifying content", () => {
    const key = noteReadingPositionKey("https://notes.example", "reader-user", "note-a", "richtext");
    saveNoteReadingPosition(key, 1400, 4000, 600);
    const viewport = mount("note-a");
    expect(viewport.scrollTop).toBe(1400);
    expect(readNoteReadingPosition(key)?.top).toBe(1400);
  });

  it("tracks Markdown CodeMirror scrolling independently from other notes", async () => {
    vi.useFakeTimers();
    const aKey = noteReadingPositionKey("https://notes.example", "reader-user", "note-a", "markdown");
    const viewport = mount("note-a", "markdown");
    act(() => {
      viewport.scrollTop = 880;
      viewport.dispatchEvent(new Event("scroll"));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(readNoteReadingPosition(aKey)?.top).toBe(880);
    act(() => root.unmount());
    root = createRoot(host);
    mount("note-b", "markdown");
    const bKey = noteReadingPositionKey("https://notes.example", "reader-user", "note-b", "markdown");
    expect(readNoteReadingPosition(bKey)).toBeNull();
    expect(readNoteReadingPosition(aKey)?.top).toBe(880);
  });
});
