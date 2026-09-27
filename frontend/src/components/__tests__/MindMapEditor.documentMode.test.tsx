// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MAP_ID = "11111111-1111-4111-8111-111111111111";
const { getMindMap, getMindMaps, listTree, createTree } = vi.hoisted(() => ({
  getMindMap: vi.fn(),
  getMindMaps: vi.fn(),
  listTree: vi.fn(),
  createTree: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { getMindMap, getMindMaps },
  getCurrentWorkspace: () => null,
}));
vi.mock("@/lib/knowledgeTreeApi", () => ({ knowledgeTreeApi: { list: listTree, create: createTree } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh" } }) }));

import MindMapCenter from "@/components/MindMapEditor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class {
  observe() {}
  disconnect() {}
});

describe("MindMapCenter document mode", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    getMindMaps.mockResolvedValue([]);
    listTree.mockResolvedValue({ nodes: [] });
    createTree.mockResolvedValue({ resourceId: MAP_ID });
    getMindMap.mockResolvedValue({
      id: MAP_ID,
      title: "项目脑图",
      data: JSON.stringify({ root: { id: "root", text: "项目脑图", children: [] } }),
      updatedAt: "2026-09-26 10:00:00",
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("opens a routed map as the main canvas without the separate map list", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MindMapCenter documentMode routeMindMapId={MAP_ID} onRequestClose={onClose} />);
      await Promise.resolve();
    });

    expect(getMindMap).toHaveBeenCalledWith(MAP_ID);
    expect(host.querySelector("h1")?.textContent).toBe("项目脑图");
    expect(host.querySelector("h2")?.textContent).not.toBe("mindMap.title");
    await act(async () => {
      (host.querySelector('[aria-label="关闭思维导图"]') as HTMLButtonElement).click();
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows one full-width overview instead of a separate folder list on the module route", async () => {
    await act(async () => {
      root.render(<MindMapCenter routeMindMapId={null} />);
      await Promise.resolve();
    });
    expect(host.querySelector("h1")?.textContent).toBe("全部脑图");
    expect(host.textContent).not.toContain("新建文件夹");
    expect(host.textContent).not.toContain("未分类");
  });

  it("returns from a document canvas to the overview without stale content", async () => {
    await act(async () => {
      root.render(<MindMapCenter documentMode routeMindMapId={MAP_ID} />);
      await Promise.resolve();
    });
    expect(host.querySelector("h1")?.textContent).toBe("项目脑图");

    await act(async () => {
      root.render(<MindMapCenter routeMindMapId={null} />);
      await Promise.resolve();
    });
    expect(host.querySelector("h1")?.textContent).toBe("全部脑图");
    expect(host.textContent).not.toContain("项目脑图");
  });

  it("creates a new map in the selected unified-tree directory", async () => {
    listTree.mockResolvedValue({ nodes: [{
      id: "notebook:project", parentId: null, nodeType: "folder", resourceType: "notebook",
      title: "项目", access: { capabilities: { canCreate: true } },
    }] });
    await act(async () => {
      root.render(<MindMapCenter routeMindMapId={null} />);
      await Promise.resolve();
    });
    await act(async () => {
      const select = host.querySelector("#mindmap-create-location") as HTMLSelectElement;
      select.value = "notebook:project";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      (Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("新建脑图")) as HTMLButtonElement).click();
    });
    await act(async () => {
      (Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("mindMap.templateBlank")) as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(createTree).toHaveBeenCalledWith({ parentId: "notebook:project", nodeType: "mindmap", title: "mindMap.untitled" });
  });

  it("does not offer to create a new map while a document route is loading", async () => {
    getMindMap.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      root.render(<MindMapCenter documentMode routeMindMapId={MAP_ID} />);
      await Promise.resolve();
    });
    expect(host.textContent).toContain("common.loading");
    expect(host.textContent).not.toContain("mindMap.create");
  });
});
