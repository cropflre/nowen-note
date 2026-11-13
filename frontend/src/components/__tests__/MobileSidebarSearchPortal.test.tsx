import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import MobileSidebarSearchPortal from "@/components/MobileSidebarSearchPortal";
import {
  MOBILE_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY,
  saveMobileKnowledgeTreeViewMode,
} from "@/lib/mobileKnowledgeTreeViewMode";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function ControlledSearch({ collapsed }: { collapsed: boolean }) {
  const [query, setQuery] = useState("Initial query");
  return (
    <div data-search-source="">
      <button type="button" onClick={() => setQuery("Updated query")}>Update query</button>
      <MobileSidebarSearchPortal collapsed={collapsed} mode="navigator">
        <input aria-label="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
      </MobileSidebarSearchPortal>
    </div>
  );
}

describe("mobile sidebar search placement", () => {
  let root: Root;
  let host: HTMLDivElement;
  let headerSlot: HTMLDivElement;

  beforeEach(() => {
    localStorage.removeItem(MOBILE_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY);
    host = document.createElement("div");
    headerSlot = document.createElement("div");
    headerSlot.setAttribute("data-mobile-sidebar-search-slot", "");
    document.body.append(headerSlot, host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    localStorage.removeItem(MOBILE_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY);
  });

  it("moves the controlled search between the header and expanded toolbar without losing its query", () => {
    act(() => root.render(<ControlledSearch collapsed />));
    expect(headerSlot.querySelectorAll("input")).toHaveLength(1);
    expect(host.querySelector("input")).toBeNull();

    act(() => host.querySelector("button")!.click());
    expect(headerSlot.querySelector("input")!.value).toBe("Updated query");

    act(() => root.render(<ControlledSearch collapsed={false} />));
    expect(headerSlot.querySelector("input")).toBeNull();
    expect(host.querySelector("input")!.value).toBe("Updated query");

    act(() => root.render(<ControlledSearch collapsed />));
    expect(headerSlot.querySelector("input")!.value).toBe("Updated query");
    expect(document.querySelectorAll("input")).toHaveLength(1);
  });

  it("lets only the active browsing mode own the header when both panels remain mounted", () => {
    act(() => root.render(
      <>
        <MobileSidebarSearchPortal collapsed mode="navigator"><input aria-label="Navigator search" /></MobileSidebarSearchPortal>
        <MobileSidebarSearchPortal collapsed mode="tree"><input aria-label="Tree search" /></MobileSidebarSearchPortal>
      </>,
    ));
    expect(headerSlot.querySelectorAll("input")).toHaveLength(1);
    expect(headerSlot.querySelector("input")!.getAttribute("aria-label")).toBe("Navigator search");

    act(() => saveMobileKnowledgeTreeViewMode("tree"));
    expect(headerSlot.querySelectorAll("input")).toHaveLength(1);
    expect(headerSlot.querySelector("input")!.getAttribute("aria-label")).toBe("Tree search");
    expect(host.querySelector("input")!.getAttribute("aria-label")).toBe("Navigator search");

    act(() => {
      localStorage.setItem(MOBILE_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY, "navigator");
      window.dispatchEvent(new StorageEvent("storage", { key: MOBILE_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY }));
    });
    expect(headerSlot.querySelectorAll("input")).toHaveLength(1);
    expect(headerSlot.querySelector("input")!.getAttribute("aria-label")).toBe("Navigator search");
  });

  it("leaves expanded and desktop searches in their original location", () => {
    act(() => root.render(
      <MobileSidebarSearchPortal collapsed={false} mode="tree"><input aria-label="Desktop search" /></MobileSidebarSearchPortal>,
    ));
    act(() => saveMobileKnowledgeTreeViewMode("tree"));
    expect(headerSlot.querySelector("input")).toBeNull();
    expect(host.querySelector("input")!.getAttribute("aria-label")).toBe("Desktop search");
  });
});
