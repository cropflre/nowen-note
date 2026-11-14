import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn(), confirm: vi.fn() }));
vi.mock("@/lib/noteTemplatesApi", () => ({ noteTemplatesApi: { list: mocks.list, remove: mocks.remove } }));
vi.mock("@/components/ui/confirm", () => ({ confirm: mocks.confirm }));
vi.mock("@/components/PluginNoteTemplatePickerSection", () => ({ default: () => <div data-plugin-templates="" /> }));

import i18n from "@/i18n";
import NoteTemplatePickerDialog from "@/components/NoteTemplatePickerDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const template = {
  id: "smt-template", workspaceId: "SMT", name: "产品测试记录", canDelete: false,
  contentFormat: "markdown", attachmentCount: 1, updatedAt: "2026-11-13T00:00:00Z",
};

describe("NoteTemplatePickerDialog", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    vi.clearAllMocks();
    mocks.list.mockResolvedValue({ templates: [template] });
    mocks.remove.mockResolvedValue({ success: true });
    mocks.confirm.mockResolvedValue(true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("updates an open dialog when the language changes without changing template data", async () => {
    await act(async () => root.render(<NoteTemplatePickerDialog open mode="manage" onClose={vi.fn()} />));
    expect(document.querySelector("h2")?.textContent).toBe("模板管理");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(document.querySelector("h2")?.textContent).toBe("Manage templates");
    expect(document.body.textContent).toContain(template.name);
    expect(document.body.textContent).toContain("Updated");
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(document.querySelector("h2")?.textContent).toBe("模板管理");
  });

  it("loads templates for the selected shared folder and creates only the chosen template", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    await act(async () => root.render(<NoteTemplatePickerDialog open parentId="shared-folder" onClose={close} onCreate={create} />));
    expect(mocks.list).toHaveBeenCalledWith({ parentId: "shared-folder", workspaceId: undefined });
    expect(document.querySelector('[aria-label^="删除模板"]')).toBeNull();
    const pick = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes(template.name))!;
    await act(async () => pick.click());
    expect(create).toHaveBeenCalledWith(template.id);
    expect(close).toHaveBeenCalledOnce();
  });

  it("manages permitted templates without a document creation action and deletes in the template workspace", async () => {
    mocks.list.mockResolvedValue({ templates: [{ ...template, canDelete: true }] });
    await act(async () => root.render(<NoteTemplatePickerDialog open mode="manage" onClose={vi.fn()} />));
    expect(document.querySelector("h2")?.textContent).toBe("模板管理");
    expect(document.querySelector("[data-plugin-templates]")).toBeNull();
    expect([...document.querySelectorAll("button")].some((button) => button.textContent?.includes(template.name))).toBe(false);
    await act(async () => (document.querySelector('[aria-label^="删除模板"]') as HTMLButtonElement).click());
    expect(mocks.remove).toHaveBeenCalledWith(template.id, "SMT");
    expect(document.body.textContent).not.toContain(template.name);
  });

  it("shows permission failures without claiming the space has no templates", async () => {
    mocks.list.mockRejectedValue(new Error("无权访问该工作区的模板"));
    await act(async () => root.render(<NoteTemplatePickerDialog open parentId="readonly-folder" onClose={vi.fn()} onCreate={vi.fn()} />));
    expect(document.body.textContent).toContain("无权访问该工作区的模板");
    expect(document.body.textContent).not.toContain("暂无模板");
    expect(document.body.textContent).not.toContain(template.name);
  });

  it("does not let a late response from another directory replace the current templates", async () => {
    let release!: (value: { templates: typeof template[] }) => void;
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const close = vi.fn();
    const create = vi.fn();
    await act(async () => root.render(<NoteTemplatePickerDialog open parentId="old-folder" onClose={close} onCreate={create} />));
    mocks.list.mockResolvedValueOnce({ templates: [{ ...template, name: "当前目录模板" }] });
    await act(async () => root.render(<NoteTemplatePickerDialog open parentId="current-folder" onClose={close} onCreate={create} />));
    await act(async () => release({ templates: [template] }));
    expect(document.body.textContent).toContain("当前目录模板");
    expect(document.body.textContent).not.toContain(template.name);
  });
});
