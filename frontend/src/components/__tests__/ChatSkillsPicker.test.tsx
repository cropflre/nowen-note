// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), confirm: vi.fn(), scope: "account-a" }));
vi.mock("@/lib/api", () => ({ api: { aiPrompts: mocks } }));
vi.mock("@/lib/aiCollaboration", () => ({ collaborationScope: () => mocks.scope }));
vi.mock("@/components/ui/confirm", () => ({ confirm: mocks.confirm }));
import ChatSkillsPicker from "../aiCollaboration/ChatSkillsPicker";
import { consumeMobileBack } from "@/lib/mobileBackNavigation";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
const select = vi.fn();
const skill = { id: "review", name: "评审", prompt: "指出风险", usageCount: 0, lastUsedAt: null, createdAt: "", updatedAt: "" };
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const button = (text: string) => Array.from(document.querySelectorAll("button")).find(item => item.textContent === text)!;
const field = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
const dialog = () => document.querySelector('[role="dialog"]') as HTMLDivElement;
const openManager = async () => { await act(async () => button("管理 Skill").click()); };
const closeManager = async () => { await act(async () => dialog().querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click()); };
async function type(label: string, value: string) {
  const element = field(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(id: string) {
  await act(async () => { field("自定义 Skill").value = id; field("自定义 Skill").dispatchEvent(new Event("change", { bubbles: true })); });
}
async function mount(scope = mocks.scope) {
  await act(async () => root.render(<ChatSkillsPicker key={scope} scope={scope} onSelect={select} />)); await flush();
}
beforeEach(async () => {
  vi.clearAllMocks(); mocks.scope = "account-a"; await i18n.changeLanguage("zh-CN");
  mocks.list.mockResolvedValue({ items: [skill] }); mocks.confirm.mockResolvedValue(true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("creates, edits and deletes a Skill and can disable it for subsequent answers", async () => {
  const custom = { ...skill, id: "custom", name: "周报", prompt: "整理本周进展" };
  mocks.create.mockResolvedValue(custom); mocks.update.mockResolvedValue({ ...custom, prompt: "按项目整理" }); mocks.remove.mockResolvedValue({ ok: true });
  await mount(); expect(field("自定义 Skill").value).toBe("");
  await openManager();
  await type("Skill 名称", custom.name); await type("指令内容", custom.prompt);
  await act(async () => button("添加个人 Skill").click()); await flush();
  expect(mocks.create).toHaveBeenCalledWith({ name: custom.name, prompt: custom.prompt });
  await closeManager();
  await choose(custom.id); expect(select).toHaveBeenLastCalledWith(custom.id);
  await choose(""); expect(select).toHaveBeenLastCalledWith("");
  await choose(custom.id);
  await openManager();
  const row = Array.from(dialog().querySelectorAll("li")).find(item => item.textContent?.includes(custom.name))!;
  await act(async () => row.querySelector("button")!.click());
  await type("指令内容", "按项目整理");
  await act(async () => button("更新个人 Skill").click()); await flush();
  expect(mocks.update).toHaveBeenCalledWith(custom.id, { name: custom.name, prompt: "按项目整理" });
  await act(async () => Array.from(dialog().querySelectorAll("li")).find(item => item.textContent?.includes(custom.name))!.querySelectorAll("button")[1].click()); await flush();
  expect(mocks.remove).toHaveBeenCalledWith(custom.id);
  expect(select).toHaveBeenLastCalledWith("");
  expect(field("自定义 Skill").value).toBe("");
});

it("imports Markdown into an editable draft and keeps failed saves for retry", async () => {
  await mount(); await openManager(); mocks.create.mockRejectedValue(new Error("offline"));
  const file = new File(["# 写作规则\n\n简明表达"], "SKILL.md", { type: "text/markdown" });
  Object.defineProperty(file, "text", { value: async () => "# 写作规则\n\n简明表达" });
  const input = field("导入提示词文件");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true }))); await flush();
  expect(field("Skill 名称").value).toBe("写作规则");
  expect(field("指令内容").value).toBe("# 写作规则\n\n简明表达");
  expect(mocks.create).not.toHaveBeenCalled();
  await act(async () => button("添加个人 Skill").click()); await flush();
  expect(dialog().textContent).toContain("offline");
  expect(field("指令内容").value).toContain("简明表达");
});

it("reports import read errors and rejects oversized files without replacing the draft", async () => {
  await mount(); await openManager(); await type("指令内容", "original");
  const input = field("导入提示词文件");
  for (const file of [new File(["x".repeat(20001)], "large.md"), { size: 4001, text: async () => "x".repeat(4001) }, { size: 10, text: async () => { throw new Error("read failed"); } }]) {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true }))); await flush();
    expect(dialog().querySelector('[role="alert"]')).not.toBeNull();
    expect(field("指令内容").value).toBe("original");
  }
});

it("reloads saved Skills when reopened and exposes a retry for failed loading", async () => {
  mocks.list.mockRejectedValueOnce(new Error("unavailable")); await mount();
  expect(host.textContent).toContain("unavailable");
  await act(async () => button("重新加载 Skill").click()); await flush();
  expect(host.querySelector('option[value="review"]')?.textContent).toBe("评审");
  await act(async () => root.render(null)); await mount();
  expect(host.querySelector('option[value="review"]')?.textContent).toBe("评审");
});

it("discards late Skill lists after switching account (DCC-006)", async () => {
  let resolve!: (value: unknown) => void;
  mocks.list.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await mount(); mocks.scope = "account-b"; mocks.list.mockResolvedValue({ items: [] }); await mount();
  await act(async () => resolve({ items: [skill] })); await flush();
  expect(host.textContent).not.toContain("评审");
  expect(field("自定义 Skill").value).toBe("");
  expect(select).not.toHaveBeenCalled();
});

it("keeps the toolbar compact and manages Skills in a dialog without losing drafts on close", async () => {
  await mount();
  expect(host.querySelector("input, textarea, details")).toBeNull();
  expect(dialog().closest("[hidden]")).not.toBeNull();
  await openManager();
  expect(dialog().closest("[hidden]")).toBeNull();
  expect(document.activeElement).toBe(dialog());
  await type("Skill 名称", "未完成的草稿");
  await type("指令内容", "保留编辑");
  await act(async () => dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(dialog().closest("[hidden]")).not.toBeNull();
  expect(document.activeElement).toBe(button("管理 Skill"));
  await openManager(); expect(field("Skill 名称").value).toBe("未完成的草稿");
  expect(field("指令内容").value).toBe("保留编辑");
  await act(async () => dialog().parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  expect(dialog().closest("[hidden]")).not.toBeNull();
  await openManager(); await act(async () => { expect(consumeMobileBack()).toBe(true); });
  expect(dialog().closest("[hidden]")).not.toBeNull();
  expect(consumeMobileBack()).toBe(false);
});

it("keeps keyboard navigation inside the open dialog", async () => {
  await mount(); await openManager();
  const first = dialog().querySelector<HTMLButtonElement>("button")!;
  const last = field("导入提示词文件");
  first.focus();
  await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(last);
  await act(async () => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(first);
});
