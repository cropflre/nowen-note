// @vitest-environment jsdom

import React, { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { Node } from "@tiptap/core";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

// ProseMirror needs React NodeViews to exist synchronously once the editor is
// initialized. The editor itself must not be constructed during React render.
const FixtureNode = Node.create({
  name: "fixtureNode",
  group: "block",
  atom: true,
  parseHTML: () => [{ tag: "div[data-fixture-node]" }],
  renderHTML: () => ["div", { "data-fixture-node": "" }],
  addNodeView() {
    return ReactNodeViewRenderer(() => (
      <NodeViewWrapper data-testid="tiptap-fixture-node">React NodeView</NodeViewWrapper>
    ));
  },
});

function EditorFixture({ noteId }: { noteId: string }) {
  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    extensions: [StarterKit, FixtureNode],
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: noteId }] },
        { type: "fixtureNode" },
      ],
    },
  }, [noteId]);
  return <EditorContent editor={editor} data-testid="fixture-editor" />;
}

describe("Tiptap first-mount flushSync regression", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.restoreAllMocks();
  });

  it("keeps the production editor's initialization deferred and toolbar updates scheduled", () => {
    const source = readFileSync(resolve(process.cwd(), "src/components/TiptapEditor.tsx"), "utf8");
    expect(source).toMatch(/useEditor\(\{\s*(?:\/\/[\s\S]*?\n\s*)*immediatelyRender:\s*false,/);
    expect(source).toContain("shouldRerenderOnTransaction: false");
    const toolbarSync = source.slice(
      source.indexOf("const syncActiveListType ="),
      source.indexOf("const [showAI,"),
    );
    expect(toolbarSync).toContain("queueMicrotask(() =>");
    expect(toolbarSync).toContain("currentEditor?.isDestroyed");
    expect(toolbarSync).toContain("setActiveListType(next)");
  });

  it("mounts and switches a React NodeView document without a render-phase flushSync warning", async () => {
    const warnings: string[] = [];
    const oldError = console.error;
    const oldWarn = console.warn;
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
      if (!args.some((value) => String(value).includes("flushSync"))) oldError(...args);
    });
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
      if (!args.some((value) => String(value).includes("flushSync"))) oldWarn(...args);
    });

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<EditorFixture key="note-a" noteId="First note" />);
    });
    expect(host.textContent).toContain("First note");
    expect(host.querySelector('[data-testid="tiptap-fixture-node"]')).not.toBeNull();

    await act(async () => {
      root?.render(<EditorFixture key="note-b" noteId="Second note" />);
    });
    expect(host.textContent).toContain("Second note");
    expect(host.textContent).not.toContain("First note");
    expect(host.querySelector('[data-testid="tiptap-fixture-node"]')).not.toBeNull();
    expect(warnings.filter((warning) => warning.includes("flushSync"))).toEqual([]);
  });
});
