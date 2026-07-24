import { afterEach, describe, expect, it, vi } from "vitest";
import {
  areIssue210SelectionsEqual,
  installIssue210SignoffRuntime,
  isIssue210NoteSaveRequest,
  type Issue210SelectionSnapshot,
} from "@/lib/issue210Signoff";

describe("issue 210 sign-off runtime", () => {
  const originalFetch = window.fetch;
  const originalPerformanceObserver = globalThis.PerformanceObserver;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

  afterEach(() => {
    localStorage.removeItem("nowen.issue210.signoff");
    window.fetch = originalFetch;
    globalThis.PerformanceObserver = originalPerformanceObserver;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    delete window.__NOWEN_ISSUE_210_SIGNOFF__;
    delete window.__NOWEN_ISSUE_210_SIGNOFF_INSTALLED__;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("matches only note content save endpoints", () => {
    expect(isIssue210NoteSaveRequest("/api/notes/note-1", "PUT")).toBe(true);
    expect(isIssue210NoteSaveRequest("/api/notes/note-1/blocks", "PATCH")).toBe(true);
    expect(isIssue210NoteSaveRequest("/api/notes/note-1", "GET")).toBe(false);
    expect(isIssue210NoteSaveRequest("/api/notebooks/note-1", "PUT")).toBe(false);
  });

  it("compares selection paths and offsets exactly", () => {
    const selection: Issue210SelectionSnapshot = {
      anchorPath: "0.1",
      anchorOffset: 4,
      focusPath: "0.1",
      focusOffset: 4,
    };
    expect(areIssue210SelectionsEqual(selection, { ...selection })).toBe(true);
    expect(areIssue210SelectionsEqual(selection, { ...selection, focusOffset: 5 })).toBe(false);
    expect(areIssue210SelectionsEqual(null, null)).toBe(true);
    expect(areIssue210SelectionsEqual(selection, null)).toBe(false);
  });

  it("records editor instance, selection and layout stability around a save", async () => {
    localStorage.setItem("nowen.issue210.signoff", "1");
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    }) as typeof requestAnimationFrame;
    globalThis.PerformanceObserver = class {
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    } as unknown as typeof PerformanceObserver;

    const editor = document.createElement("div");
    editor.className = "ProseMirror";
    editor.contentEditable = "true";
    editor.dataset.noteId = "note-1";
    const text = document.createTextNode("hello world");
    editor.appendChild(text);
    document.body.appendChild(editor);
    editor.focus();
    const range = document.createRange();
    range.setStart(text, 5);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    window.fetch = vi.fn(async () => new Response(null, { status: 200 })) as typeof window.fetch;
    const runtime = installIssue210SignoffRuntime();
    expect(runtime).not.toBeNull();

    await window.fetch("/api/notes/note-1", { method: "PUT" });
    const snapshot = runtime!.snapshot();
    expect(snapshot.platform).toBe("web");
    expect(snapshot.saveSamples).toHaveLength(1);
    expect(snapshot.saveSamples[0]).toMatchObject({
      status: 200,
      instanceStable: true,
      selectionStable: true,
    });
    expect(snapshot.saveSamples[0].before.editorInstanceId).toBe(
      snapshot.saveSamples[0].after.editorInstanceId,
    );
  });
});
