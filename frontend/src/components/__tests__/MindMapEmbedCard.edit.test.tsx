// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MAP_ID = "11111111-1111-4111-8111-111111111111";
const { loadDocumentMindMap } = vi.hoisted(() => ({
  loadDocumentMindMap: vi.fn(),
}));

vi.mock("@/lib/documentMindMapRuntime", () => ({
  DOCUMENT_MINDMAP_CHANGED_EVENT: "nowen:mindmap-changed",
  invalidateDocumentMindMapCache: vi.fn(async () => {}),
  loadDocumentMindMap,
}));

vi.mock("@/components/MindMapEditor", () => ({
  default: (props: any) => (
    <div
      data-testid="embedded-native-mindmap-editor"
      data-map-id={props.embeddedMindMapId}
      data-embedded={String(Boolean(props.embeddedMode))}
    >
      native editor
    </div>
  ),
}));

import MindMapEmbedCard from "@/components/MindMapEmbedCard";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function map(canEdit: boolean) {
  return {
    id: MAP_ID,
    userId: "owner",
    workspaceId: null,
    title: "产品脑图",
    data: JSON.stringify({
      root: {
        id: "root",
        text: "产品",
        children: [{ id: "child", text: "文档内编辑", children: [] }],
      },
    }),
    createdAt: "2026-09-24 10:00:00",
    updatedAt: "2026-09-24 10:00:00",
    canEdit,
  };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("MindMapEmbedCard embedded editor", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    loadDocumentMindMap.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });

  it("offers the native in-document editor only when the source map is editable", async () => {
    loadDocumentMindMap.mockResolvedValue({
      map: map(true),
      source: "network",
    });

    await act(async () => {
      root.render(<MindMapEmbedCard href={`mindmap:${MAP_ID}`} />);
    });
    await flushEffects();

    const editButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("文档内编辑"),
    ) as HTMLButtonElement | undefined;
    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton?.click();
      await Promise.resolve();
    });
    await flushEffects();

    const dialog = document.querySelector('[data-document-mindmap-editor-dialog="true"]');
    expect(dialog).not.toBeNull();
    const editor = document.querySelector('[data-testid="embedded-native-mindmap-editor"]');
    expect(editor?.getAttribute("data-map-id")).toBe(MAP_ID);
    expect(editor?.getAttribute("data-embedded")).toBe("true");
  });

  it("keeps read-only collaborators in preview mode", async () => {
    loadDocumentMindMap.mockResolvedValue({
      map: map(false),
      source: "network",
    });

    await act(async () => {
      root.render(<MindMapEmbedCard href={`mindmap:${MAP_ID}`} />);
    });
    await flushEffects();

    expect(
      Array.from(host.querySelectorAll("button")).some(
        (button) => button.textContent?.includes("文档内编辑"),
      ),
    ).toBe(false);
    expect(host.textContent).toContain("打开编辑器");
  });
});
