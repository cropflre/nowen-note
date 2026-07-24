// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../EditorPane", () => ({
  default: () => <div data-testid="editor-pane" />,
}));

vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: { activeNote: null, notebooks: [] } }),
  useAppActions: () => ({}),
}));

import EditorPaneRuntime from "../EditorPaneRuntime";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("EditorPaneRuntime layout", () => {
  it("keeps the wrapped editor inside a shrinkable flex viewport", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      await act(async () => root.render(<EditorPaneRuntime />));

      const shell = host.firstElementChild;
      expect(shell).not.toBeNull();
      expect([...shell!.classList]).toEqual(expect.arrayContaining([
        "flex",
        "h-full",
        "min-h-0",
        "flex-col",
        "overflow-hidden",
      ]));
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
