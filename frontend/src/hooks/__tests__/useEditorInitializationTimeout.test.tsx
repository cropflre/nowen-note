// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useEditorInitializationTimeout } from "@/hooks/useEditorInitializationTimeout";
import { resolveEditorRuntimeDecision } from "@/lib/editorRuntimePolicy";
import {
  clearActiveEditorRuntimeDecision,
  getActiveEditorRuntimeState,
  setActiveEditorRuntimeDecision,
} from "@/lib/editorRuntimeStore";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let currentReady: ((scrollTo: (pos: number) => void) => void) | null = null;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function richText(length: number): string {
  return `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"${"x".repeat(length)}"}]}]}`;
}

function setDecision(noteId: string, length = 1_000): void {
  setActiveEditorRuntimeDecision(noteId, resolveEditorRuntimeDecision({
    content: richText(length),
    contentFormat: "tiptap-json",
  }));
}

function Harness({
  noteId,
  onEditorReady,
}: {
  noteId: string;
  onEditorReady?: (scrollTo: (pos: number) => void) => void;
}) {
  currentReady = useEditorInitializationTimeout({
    noteId,
    engine: "tiptap",
    onEditorReady,
    timeoutMs: 100,
  });
  return null;
}

async function renderHarness(
  noteId: string,
  onEditorReady?: (scrollTo: (pos: number) => void) => void,
): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(
    <Harness noteId={noteId} onEditorReady={onEditorReady} />,
  ));
}

beforeEach(() => {
  vi.useFakeTimers();
  clearActiveEditorRuntimeDecision();
  currentReady = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  currentReady = null;
  clearActiveEditorRuntimeDecision();
  vi.useRealTimers();
});

describe("useEditorInitializationTimeout", () => {
  it("downgrades an active normal editor to viewport optimization after the budget", async () => {
    setDecision("note-timeout");
    await renderHarness("note-timeout");

    await act(async () => vi.advanceTimersByTime(101));

    const decision = getActiveEditorRuntimeState().decision;
    expect(decision.mode).toBe("viewport-optimized");
    expect(decision.reasons).toContain("initialization-timeout");
    expect(decision.capabilities.editable).toBe(true);
  });

  it("cancels the downgrade when the editor reports ready first", async () => {
    const onEditorReady = vi.fn();
    setDecision("note-ready");
    await renderHarness("note-ready", onEditorReady);

    const scrollTo = vi.fn();
    await act(async () => currentReady?.(scrollTo));
    await act(async () => vi.advanceTimersByTime(101));

    expect(onEditorReady).toHaveBeenCalledWith(scrollTo);
    expect(getActiveEditorRuntimeState().decision.mode).toBe("normal");
  });

  it("does not let a stale timer downgrade the next active note", async () => {
    setDecision("note-old");
    await renderHarness("note-old");
    setDecision("note-new");

    await act(async () => vi.advanceTimersByTime(101));

    const current = getActiveEditorRuntimeState();
    expect(current.noteId).toBe("note-new");
    expect(current.decision.mode).toBe("normal");
    expect(current.decision.reasons).not.toContain("initialization-timeout");
  });

  it("does not further downgrade a document already classified for viewport optimization", async () => {
    setDecision("note-viewport", 120_000);
    await renderHarness("note-viewport");

    await act(async () => vi.advanceTimersByTime(101));

    const decision = getActiveEditorRuntimeState().decision;
    expect(decision.mode).toBe("viewport-optimized");
    expect(decision.reasons).not.toContain("initialization-timeout");
  });
});
