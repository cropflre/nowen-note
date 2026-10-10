// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const MAP_ID = "11111111-1111-4111-8111-111111111111";
vi.mock("../MindMapEditor", () => ({
  default: (props: { documentMode?: boolean; routeMindMapId?: string | null }) => (
    <div data-testid="lazy-map" data-document-mode={String(props.documentMode)}>
      {props.routeMindMapId}
    </div>
  ),
}));

import LazyMindMapEditorRuntime from "@/components/LazyMindMapEditorRuntime";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("forwards the routed document props through the lazy editor boundary", async () => {
  await act(async () => {
    root.render(<LazyMindMapEditorRuntime documentMode routeMindMapId={MAP_ID} />);
    await Promise.resolve();
  });
  const editor = host.querySelector('[data-testid="lazy-map"]');
  expect(editor?.getAttribute("data-document-mode")).toBe("true");
  expect(editor?.textContent).toBe(MAP_ID);
});
