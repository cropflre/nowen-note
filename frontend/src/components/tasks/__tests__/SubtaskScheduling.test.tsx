import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubtaskInput } from "../SubtaskInput";
import { TaskAIBreakdown } from "../TaskAIBreakdown";
import type { Task } from "@/types";

const mocks = vi.hoisted(() => ({ breakdown: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { aiBreakdownTask: mocks.breakdown, createTask: mocks.create } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh-CN" } }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;

async function fill(selector: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(selector);
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find(item => item.textContent?.includes(label) || item.getAttribute("aria-label") === label);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
beforeEach(() => {
  mocks.breakdown.mockResolvedValue({ subtasks: [{ title: "Child", priority: 2, dueDate: "2026-10-21", reason: "" }] });
  mocks.create.mockResolvedValue({ id: "child" });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); });

describe("subtask scheduling", () => {
  it("submits an inline subtask with a local deadline and supports date-only tasks", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<SubtaskInput parentId="parent" onSubmit={submit} onCancel={() => {}} />));
    await fill('input:not([type]), input[type="text"]', "Child");
    await fill('input[type="date"]', "2026-10-21");
    await fill('input[type="time"]', "09:30");
    await click("tasks.add");
    expect(submit).toHaveBeenLastCalledWith("Child", "parent", { dueDate: "2026-10-21", dueAt: "2026-10-21T09:30" });
    await fill('input:not([type]), input[type="text"]', "Date only");
    await fill('input[type="date"]', "2026-10-22");
    await click("tasks.add");
    expect(submit).toHaveBeenLastCalledWith("Date only", "parent", { dueDate: "2026-10-22", dueAt: null });
  });

  it("allows a concrete deadline on AI subtasks and clears time when the date is removed", async () => {
    await act(async () => root.render(<TaskAIBreakdown task={{ id: "parent", title: "Parent" } as Task} onCreated={() => {}} />));
    await click("tasks.aiBreakdown.button");
    await fill('input[type="time"]', "09:30");
    await click("tasks.aiBreakdown.createSelected");
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ parentId: "parent", dueDate: "2026-10-21", dueAt: "2026-10-21T09:30" }));
    await click("tasks.aiBreakdown.button");
    await fill('input[type="time"]', "10:30");
    await fill('input[type="date"]', "");
    await click("tasks.aiBreakdown.createSelected");
    expect(mocks.create).toHaveBeenLastCalledWith(expect.objectContaining({ dueDate: undefined, dueAt: undefined }));
  });
});
