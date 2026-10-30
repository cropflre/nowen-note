import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { DateBadge } from "../DateBadge";
import { TaskDetailPanel } from "../TaskDetailPanel";
import { getTaskDateKey } from "../taskDateUtils";
import { isTaskScheduled, getVisibleTaskBar } from "../taskGanttUtils";
import type { Task } from "@/types";
vi.mock("react-i18next",async(importOriginal)=>({...await importOriginal<typeof import("react-i18next")>(),useTranslation:()=>({t:(key:string)=>key,i18n:{language:"zh-CN",resolvedLanguage:"zh-CN"}})}));
const task={id:"bad-date",title:"Legacy monthly task",userId:"u",workspaceId:null,dueDate:"NaN-NaN-NaN",dueAt:"NaN-T00:00:00",startDate:null,description:"",priority:2,isCompleted:0,status:"todo",createdAt:"2026-10-13 03:17:47",updatedAt:"2026-10-13 03:17:47",repeatRule:"monthly",repeatInterval:1} as Task;
it("renders an invalid date badge alongside healthy tasks without crashing",()=>{
  let html="";expect(()=>{html=renderToStaticMarkup(<><DateBadge dateStr={task.dueDate} dueAt={task.dueAt}/><DateBadge dateStr="2026-10-20"/></>);}).not.toThrow();
  expect(html).toContain("taskRemoval.invalidDate");expect(html).not.toContain("NaN");
});
it("keeps the task detail panel accessible so a corrupt schedule can be repaired or deleted",()=>{
  expect(()=>renderToStaticMarkup(<TaskDetailPanel task={task} onClose={()=>{}} onUpdate={()=>{}} onDelete={()=>{}}/>)).not.toThrow();
});
it("does not send invalid dates into calendar or Gantt calculations",()=>{
  expect(getTaskDateKey(task)).toBeNull();expect(isTaskScheduled(task)).toBe(false);
  expect(getVisibleTaskBar(task,[new Date(2026,9,13)])).toBeNull();
});
