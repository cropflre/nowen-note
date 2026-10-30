import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Task } from "@/types";
import { TaskRecurrenceDeleteDialog } from "../TaskRecurrenceDeleteDialog";
const mocks = vi.hoisted(() => ({getTasks:vi.fn(),scope:"account-a"}));
vi.mock("@/lib/api",()=>({api:mocks}));
vi.mock("@/lib/offlineScope",()=>({getOfflineQueueStorageKey:()=>mocks.scope}));
vi.mock("react-i18next",()=>{
  const t=(key:string,options?:{count:number})=>key==="taskRemoval.range"?`range:${options?.count}`:key;
  return {useTranslation:()=>({t})};
});
let root:Root;let container:HTMLDivElement;
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
afterEach(async()=>{if(root) await act(async()=>root.unmount());container?.remove();vi.clearAllMocks();mocks.scope="account-a";});
const task = {id:"next",title:"Daily",workspaceId:null,repeatRule:"daily",repeatGroupId:"root"} as Task;
async function renderDialog(confirm=vi.fn(),close=vi.fn()){
  mocks.getTasks.mockResolvedValue([{...task,id:"root",repeatGroupId:null,isCompleted:1,archivedAt:"archive"},task,{...task,id:"child",repeatGroupId:null,parentId:"next"}]);
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
  await act(async()=>{root.render(<TaskRecurrenceDeleteDialog task={task} onConfirm={confirm} onClose={close}/>);});
  return {confirm,close};
}
function confirmButton(){return container.querySelectorAll("button")[1];}
it("shows three choices and includes archived history and subtasks in the series range",async()=>{
  const {confirm}=await renderDialog();
  expect(container.querySelectorAll("input")).toHaveLength(3);
  expect(container.textContent).toContain("range:2");
  await act(async()=>{container.querySelector<HTMLInputElement>('input[value="series"]')!.click();});
  expect(container.textContent).toContain("range:3");
  expect(container.textContent).toContain("taskRemoval.seriesWarning");
  await act(async()=>{confirmButton().click();});expect(confirm).toHaveBeenCalledWith("series");
});
it("stops recurrence without requesting deletion and blocks duplicate submits",async()=>{
  let finish:()=>void=()=>{};const confirm=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
  await renderDialog(confirm);await act(async()=>{container.querySelector<HTMLInputElement>('input[value="stop"]')!.click();});
  await act(async()=>{confirmButton().click();confirmButton().click();});
  expect(confirm).toHaveBeenCalledOnce();expect(confirm).toHaveBeenCalledWith("stop");
  await act(async()=>{finish();});
});
it("keeps failed intent visible for retry and rejects a changed account",async()=>{
  const confirm=vi.fn().mockRejectedValue(new Error("Network unavailable"));const {close}=await renderDialog(confirm);
  await act(async()=>{confirmButton().click();});expect(close).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Network unavailable");
  mocks.scope="account-b";await act(async()=>{confirmButton().click();});expect(confirm).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("tasks.lifecycle.scopeChanged");
});
