import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Task } from "@/types";
import { TaskSaveNoteDialog } from "../TaskSaveNoteDialog";
const mocks = vi.hoisted(() => ({ getNotebooks:vi.fn(),saveTaskAsNote:vi.fn(),scope:"first-account" }));
vi.mock("@/lib/api",() => ({api:mocks}));
vi.mock("@/lib/offlineScope",() => ({getOfflineQueueStorageKey:() => mocks.scope}));
vi.mock("react-i18next",() => ({useTranslation:() => ({t:(key:string) => key})}));
let root: Root; let container: HTMLDivElement;
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
afterEach(async () => {if(root) await act(async () => root.unmount());container?.remove();vi.resetAllMocks();vi.unstubAllGlobals();mocks.scope="first-account";});
const task = {id:"task",workspaceId:null} as Task;
const draft = {title:"Current title",description:"Unsaved current draft"};
async function renderDialog(close = () => {}) {
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
  await act(async () => {root.render(<TaskSaveNoteDialog task={task} draft={draft} onClose={close} />);});
}
function button(text:string) {return [...container.querySelectorAll("button")].find((button) => button.textContent===text)!;}
it("saves the captured draft once and offers to open its independent note",async () => {
  mocks.getNotebooks.mockResolvedValue([{id:"readonly",name:"Read only",permission:"read"},{id:"folder",name:"Writable",permission:"manage"}]);
  let resolve: (note:unknown) => void = () => {};
  mocks.saveTaskAsNote.mockReturnValue(new Promise((finish) => {resolve=finish;}));
  const close=vi.fn();await renderDialog(close);
  expect(container.textContent).not.toContain("Read only");
  await act(async () => {button("tasks.lifecycle.saveNote").click();button("tasks.lifecycle.saveNote").click();});
  expect(mocks.saveTaskAsNote).toHaveBeenCalledTimes(1);
  expect(mocks.saveTaskAsNote).toHaveBeenCalledWith("task",expect.objectContaining({...draft,notebookId:"folder"}));
  await act(async () => {resolve({id:"note"});});
  const opened = vi.fn();window.addEventListener("nowen:open-note-link",opened,{once:true});
  await act(async () => button("tasks.lifecycle.openNote").click());
  expect(opened.mock.calls[0][0].detail.noteId).toBe("note");expect(close).toHaveBeenCalledTimes(1);
});
it("retries a failed save with the same request identity and keeps the draft",async () => {
  mocks.getNotebooks.mockResolvedValue([{id:"folder",name:"Writable"}]);
  mocks.saveTaskAsNote.mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce({id:"note"});
  await renderDialog();await act(async () => button("tasks.lifecycle.saveNote").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Connection lost");
  await act(async () => button("tasks.lifecycle.saveNote").click());
  expect(mocks.saveTaskAsNote).toHaveBeenCalledTimes(2);
  expect(mocks.saveTaskAsNote.mock.calls[0][1]).toEqual(mocks.saveTaskAsNote.mock.calls[1][1]);
});

it("refuses to send an old draft after switching account or server",async () => {
  mocks.getNotebooks.mockResolvedValue([{id:"folder",name:"Writable"}]);await renderDialog();
  mocks.scope="other-account";
  await act(async () => button("tasks.lifecycle.saveNote").click());
  expect(mocks.saveTaskAsNote).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("tasks.lifecycle.scopeChanged");
});

it("supports HTTP deployments whose crypto API has no randomUUID",async () => {
  vi.stubGlobal("crypto",{getRandomValues:(bytes:Uint8Array) => {bytes.fill(3);return bytes;}});
  mocks.getNotebooks.mockResolvedValue([{id:"folder",name:"Writable"}]);mocks.saveTaskAsNote.mockResolvedValue({id:"note"});
  await renderDialog();await act(async () => button("tasks.lifecycle.saveNote").click());
  expect(mocks.saveTaskAsNote.mock.calls[0][1].requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
