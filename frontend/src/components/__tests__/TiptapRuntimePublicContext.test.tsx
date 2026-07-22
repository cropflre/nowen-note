// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../TiptapEditor", async () => {
  const ReactModule = await import("react");
  const Base = ReactModule.forwardRef((props: any, ref) => {
    ReactModule.useImperativeHandle(ref, () => ({
      flushSave: vi.fn(),
      getSnapshot: () => null,
      isReady: () => true,
    }));
    return ReactModule.createElement("div", {
      "data-public-tiptap": "",
      "data-guest": String(Boolean(props.isGuest)),
    });
  });
  Base.displayName = "MockPublicTiptapEditor";
  return { default: Base };
});

import TiptapEditorRuntime from "../TiptapEditorRuntime";
import { resolveEditorRuntimeDecision } from "@/lib/editorRuntimePolicy";
import {
  clearActiveEditorRuntimeDecision,
  setActiveEditorRuntimeDecision,
} from "@/lib/editorRuntimeStore";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function publicNote(id: string) {
  return {
    id,
    title: "Public note",
    content: JSON.stringify({
      type: "doc",
      content: [{
        type: "paragraph",
        attrs: { blockId: "blk_public00" },
        content: [{ type: "text", text: "x".repeat(400_000) }],
      }],
    }),
    contentText: "Public",
    contentFormat: "tiptap-json",
    version: 1,
    updatedAt: "2026-07-22T10:00:00.000Z",
    notebookId: "",
    isLocked: false,
    isTrashed: false,
  } as any;
}

afterEach(() => {
  clearActiveEditorRuntimeDecision();
  document.body.innerHTML = "";
});

describe("public Tiptap runtime context isolation", () => {
  it("mounts an optimized guest editor without AppProvider", async () => {
    const note = publicNote("public-note");
    setActiveEditorRuntimeDecision(note.id, resolveEditorRuntimeDecision({
      content: note.content,
      contentFormat: "tiptap-json",
    }));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <TiptapEditorRuntime
            note={note}
            onUpdate={vi.fn()}
            editable
            isGuest
          />,
        );
      });
      expect(host.querySelector("[data-public-tiptap]")).not.toBeNull();
      expect(host.querySelector("[data-public-tiptap]")?.getAttribute("data-guest")).toBe("true");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("mounts presentation mode without AppProvider", async () => {
    const note = publicNote("presentation-note");
    setActiveEditorRuntimeDecision(note.id, resolveEditorRuntimeDecision({
      content: note.content,
      contentFormat: "tiptap-json",
    }));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <TiptapEditorRuntime
            note={note}
            onUpdate={vi.fn()}
            editable={false}
            presentationMode
          />,
        );
      });
      expect(host.querySelector("[data-public-tiptap]")).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
