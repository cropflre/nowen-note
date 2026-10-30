import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useContextMenu } from "@/hooks/useContextMenu";
import type { Task, TaskProject } from "@/types";
import TaskContextMenu from "../TaskContextMenu";

vi.mock("@/store/AppContext", () => ({ useApp: () => ({ state: { notebooks: [] } }), useAppActions: () => ({}) }));
vi.mock("@/lib/api", () => ({ api: {} }));
vi.mock("@/lib/exportService", () => ({ exportSingleNote: vi.fn(), exportSingleNoteAsImage: vi.fn(), exportSingleNoteAsPDF: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));

const action = vi.fn();
const baseTask = { id: "task", title: "Target task", isCompleted: 0, priority: 2, parentId: null, projectId: "project" } as Task;
const projects = [{ id: "project", name: "Current project" }, { id: "other", name: "Other project" }] as TaskProject[];
function Harness({ task }: { task: Task }) {
  const { menu, menuRef, openMenu, closeMenu } = useContextMenu();
  return <>
    <button id="target" onContextMenu={event => openMenu(event, task.id, "task")}>Task</button>
    {menu.isOpen && <TaskContextMenu task={task} projects={projects} canArchive={task.isCompleted === 1} menu={menu} menuRef={menuRef} onAction={id => { action(id); closeMenu(); }} />}
  </>;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    return { length: this.closest(".sm\\:hidden") ? 0 : 1 } as DOMRectList;
  });
  action.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function open(task = baseTask) {
  await act(async () => root.render(<Harness task={task} />));
  await act(async () => { host.querySelector("#target")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })); });
}
function desktop() { return host.querySelector<HTMLElement>('[data-context-menu-id] > .hidden')!; }
function button(label: string, container: ParentNode = desktop()) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent === label)!;
}
async function choose(label: string, container?: ParentNode) {
  await act(async () => { button(label, container).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
}

it("offers completion and editing without allowing an incomplete tree to be archived", async () => {
  await open();
  expect(host.textContent).toContain("Target task");
  expect(document.activeElement).toBe(button("tasks.contextMenu.open"));
  expect(button("tasks.contextMenu.complete")).toBeDefined();
  expect(button("tasks.lifecycle.archive").disabled).toBe(true);
  await choose("tasks.contextMenu.complete");
  expect(action).toHaveBeenCalledOnce(); expect(action).toHaveBeenCalledWith("toggle");
  expect(host.querySelector("[data-context-menu-id]")).toBeNull();
});

it("uses the reopen action for a completed task and permits root-tree archiving", async () => {
  await open({ ...baseTask, isCompleted: 1 });
  expect(button("tasks.lifecycle.archive").disabled).toBe(false);
  await choose("tasks.contextMenu.reopen");
  expect(action).toHaveBeenCalledWith("toggle");
});

it("keeps archived tasks read-only while allowing details, note snapshots, restoration and deletion", async () => {
  await open({ ...baseTask, isCompleted: 1, archivedAt: "archived" });
  for (const label of ["tasks.contextMenu.reopen", "tasks.addChild", "tasks.priority", "tasks.contextMenu.moveProject"]) expect(button(label)).toBeUndefined();
  expect(button("tasks.lifecycle.saveNote")).toBeDefined();
  expect(button("tasks.deleteTask")).toBeDefined();
  await choose("tasks.lifecycle.restore"); expect(action).toHaveBeenCalledWith("restore");
});

it("does not offer a child-only archive operation", async () => {
  await open({ ...baseTask, isCompleted: 1, parentId: "parent" });
  expect(button("tasks.lifecycle.archive")).toBeUndefined();
});

it.each(["xlsx", "md"])("offers %s export for tasks, subtasks and archived subtasks", async format => {
  const label = format === "xlsx" ? "tasks.report.exportExcel" : "tasks.report.exportMarkdown";
  for (const task of [baseTask, { ...baseTask, parentId: "parent" }, { ...baseTask, parentId: "parent", archivedAt: "archived", isCompleted: 1 }]) {
    await open(task);
    await choose(label);
    expect(action).toHaveBeenLastCalledWith(`export:${format}`);
  }
});

it("opens the priority submenu and does not resubmit the existing priority", async () => {
  await open();
  await act(async () => button("tasks.priority").click());
  const submenu = document.querySelector<HTMLElement>("[data-context-menu-submenu]")!;
  expect(button("tasks.medium", submenu).disabled).toBe(true);
  await choose("tasks.high", submenu); expect(action).toHaveBeenCalledWith("priority:3");
});

it("routes project changes through the task menu rather than note movement", async () => {
  await open();
  await act(async () => button("tasks.contextMenu.moveProject").click());
  const submenu = document.querySelector<HTMLElement>("[data-context-menu-submenu]")!;
  expect(button("Current project", submenu).disabled).toBe(true);
  await choose("Other project", submenu); expect(action).toHaveBeenCalledWith("project:other");
});

it.each(["Enter", " "])("supports keyboard activation with %s", async key => {
  await open();
  await act(async () => { button("tasks.contextMenu.open").dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  expect(action).toHaveBeenCalledOnce(); expect(action).toHaveBeenCalledWith("open");
});

it.each(["escape", "outside"])("closes on %s without running an action", async event => {
  await open();
  await act(async () => {
    if (event === "escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  expect(host.querySelector("[data-context-menu-id]")).toBeNull(); expect(action).not.toHaveBeenCalled();
});
