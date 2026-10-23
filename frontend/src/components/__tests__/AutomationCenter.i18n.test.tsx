import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import AutomationCenter from "../automation/AutomationCenter";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), runs: vi.fn(), actions: vi.fn() }));
vi.mock("@/lib/automationApi", () => ({ automationApi: mocks }));
vi.mock("@/lib/pluginApi", () => ({ pluginApi: { actions: mocks.actions } }));
vi.mock("../automation/TaskDigestSettings", () => ({ default: () => null }));

let root: Root;
let host: HTMLDivElement;
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find(node => node.textContent?.trim() === text);
  expect(button, text).toBeTruthy();
  await act(async () => { button!.click(); });
}
async function select(node: HTMLSelectElement, value: string) {
  await act(async () => { node.value = value; node.dispatchEvent(new Event("change", { bubbles: true })); });
}
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("zh-CN");
  mocks.list.mockResolvedValue([]);
  mocks.actions.mockResolvedValue([{ pluginId: "plugin", actionId: "notify", name: "Custom action" }]);
  mocks.create.mockResolvedValue({});
  mocks.runs.mockResolvedValue([{ id: "run", status: "completed", createdAt: "2026-10-20T00:00:00Z" }]);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  act(() => root.unmount()); host.remove();
  await i18n.changeLanguage("zh-CN");
});

describe("automation workflow translations", () => {
  it("translates event and step labels while saving their original identifiers", async () => {
    await act(async () => { root.render(<AutomationCenter />); });
    await click("新建流程");
    const events = host.querySelectorAll("select")[1];
    expect([...events.options].map(option => option.text)).toEqual([
      "笔记创建", "笔记更新", "任务创建", "任务完成", "附件创建", "日记创建", "思维导图创建",
    ]);
    await select(events, "task.completed");
    for (const label of ["执行动作", "条件判断", "延迟", "数据转换", "停止流程"]) await click(label);
    expect(host.textContent).not.toMatch(/note\.created|task\.completed/);
    await click("保存为停用状态");
    const payload = mocks.create.mock.calls[0][0];
    expect(payload.definition.trigger).toEqual({ type: "event", event: "task.completed" });
    expect(payload.definition.steps.map((step: { type: string }) => step.type)).toEqual(["action", "condition", "delay", "transform", "stop"]);
    expect(payload.definition.steps[0]).toMatchObject({ pluginId: "plugin", actionId: "notify" });
    expect(payload.definition.steps[1].if).toEqual({ left: "{{event.data.title}}", operator: "contains", right: "日报" });
  });

  it("updates an open dialog on language change and retains entered names", async () => {
    await act(async () => { root.render(<AutomationCenter />); });
    await click("新建流程");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(host.textContent).toContain("Create execution workflow");
    expect(host.querySelector("input")?.value).toBe("New note processing");
    expect([...host.querySelectorAll("select")[1].options].map(option => option.text)).toContain("Note created");
    await click("Action");
    const input = host.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "我的流程");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await i18n.changeLanguage("zh-CN");
    });
    expect(input.value).toBe("我的流程");
    await act(async () => { await i18n.changeLanguage("en"); });
    await select(host.querySelector("select")!, "schedule");
    expect(host.textContent).toContain("Time zone");
    await click("Save as disabled");
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ name: "我的流程", definition: { trigger: { type: "schedule", cron: "0 8 * * *" } } });
    expect(host.textContent).not.toMatch(/[\u3400-\u9fff]/);
  });

  it("translates existing workflow types and history without changing user content", async () => {
    mocks.list.mockResolvedValue([{ id: "workflow", name: "用户流程", enabled: false, triggerType: "event",
      definition: { steps: [{ id: "step", type: "delay", seconds: 60 }] } }]);
    await i18n.changeLanguage("en");
    await act(async () => { root.render(<AutomationCenter />); });
    expect(host.textContent).toContain("用户流程");
    expect(host.textContent).toContain("Nowen event");
    const history = host.querySelector<HTMLButtonElement>('button[aria-label="Run history"]');
    expect(history).toBeTruthy();
    await act(async () => { history!.click(); });
    expect(host.textContent).toContain("Delay");
    expect(host.textContent).toContain("Completed");
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(host.textContent).toContain("已完成");
    expect(host.textContent).toContain("延迟");
  });

  it("registers every dynamic trigger, step and run status label in both languages", () => {
    const groups = {
      triggers: ["event", "schedule", "webhook", "manual"],
      stepTypes: ["action", "condition", "delay", "transform", "stop"],
      statuses: ["queued", "running", "waiting", "completed", "failed", "cancelled", "interrupted"],
      events: ["note.created", "note.updated", "task.created", "task.completed", "attachment.created", "diary.created", "mindmap.created"],
    };
    for (const language of ["zh-CN", "en"]) {
      for (const [group, values] of Object.entries(groups)) {
        for (const value of values) {
          const label = i18n.getResource(language, "translation", `automation.${group}.${value}`);
          expect(typeof label).toBe("string");
          expect(label).not.toBe(value);
        }
      }
    }
  });
});
