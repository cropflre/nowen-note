import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { installMobileLocalAdvancedTaskBridge } from "@/lib/mobileLocalAdvancedTaskBridge";
import type { NativeDatabase } from "@/lib/nativeDatabase";
import type { Task } from "@/types";

interface ProjectRow {
  id: string;
  userId: string;
  name: string;
  icon: string;
  color: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface TemplateRow {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  items: string;
  createdAt: string;
  updatedAt: string;
}

function createFakeDb(): NativeDatabase {
  const projects: ProjectRow[] = [];
  const templates: TemplateRow[] = [];

  const db: NativeDatabase = {
    async run(sql, values = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("CREATE TABLE") || normalized.startsWith("CREATE INDEX")) {
        return { changes: 0 };
      }
      if (normalized.startsWith("INSERT INTO mobile_local_task_projects")) {
        const [id,userId,name,icon,color,createdAt,updatedAt] = values as string[];
        projects.push({ id,userId,name,icon,color,sortOrder:0,createdAt,updatedAt });
        return { changes: 1 };
      }
      if (normalized.startsWith("UPDATE mobile_local_task_projects SET")) {
        const [name,icon,color,sortOrder,updatedAt,id] = values as [string,string,string,number,string,string];
        const row = projects.find((item) => item.id === id);
        if (row) Object.assign(row,{name,icon,color,sortOrder,updatedAt});
        return { changes: row ? 1 : 0 };
      }
      if (normalized.startsWith("DELETE FROM mobile_local_task_projects")) {
        const id = String(values[0]);
        const index = projects.findIndex((item) => item.id === id);
        if (index >= 0) projects.splice(index,1);
        return { changes:index >= 0 ? 1 : 0 };
      }
      if (normalized.startsWith("UPDATE tasks SET projectId=NULL")) return { changes:0 };
      if (normalized.startsWith("INSERT INTO mobile_local_task_templates")) {
        const [id,userId,name,description,icon,color,items,createdAt,updatedAt] = values as [
          string,string,string,string|null,string|null,string|null,string,string,string,
        ];
        templates.push({id,userId,name,description,icon,color,items,createdAt,updatedAt});
        return { changes:1 };
      }
      if (normalized.startsWith("DELETE FROM mobile_local_task_templates")) {
        const id = String(values[0]);
        const index = templates.findIndex((item) => item.id === id);
        if (index >= 0) templates.splice(index,1);
        return { changes:index >= 0 ? 1 : 0 };
      }
      return { changes:0 };
    },
    async query<T>(sql, values = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.includes("FROM mobile_local_task_projects p WHERE p.id=?")) {
        const row = projects.find((item) => item.id === String(values[0]));
        return (row ? [{...row,taskCount:0,completedCount:0}] : []) as T[];
      }
      if (normalized.includes("FROM mobile_local_task_projects p ORDER BY")) {
        return projects.map((row) => ({...row,taskCount:0,completedCount:0})) as T[];
      }
      if (normalized.includes("FROM mobile_local_task_templates WHERE id=?")) {
        const row = templates.find((item) => item.id === String(values[0]));
        return (row ? [{...row}] : []) as T[];
      }
      if (normalized.includes("FROM mobile_local_task_templates ORDER BY")) {
        return templates.map((row) => ({...row})) as T[];
      }
      return [] as T[];
    },
    async transaction<T>(work: (tx: NativeDatabase) => Promise<T>) {
      return work(db);
    },
    async close() {},
  };
  return db;
}

let restore: (() => void) | null = null;
let originalCreateTask: typeof api.createTask;

afterEach(() => {
  restore?.();
  restore = null;
  if (originalCreateTask) (api as any).createTask = originalCreateTask;
  vi.restoreAllMocks();
});

describe("mobile local advanced task bridge", () => {
  it("persists project CRUD without any remote request", async () => {
    const db = createFakeDb();
    const fetchSpy = vi.spyOn(globalThis,"fetch");
    restore = installMobileLocalAdvancedTaskBridge(db,"android-local-user");

    const project = await api.createTaskProject({name:"离线项目",icon:"📦",color:"#123456"});
    expect(project).toMatchObject({name:"离线项目",icon:"📦",color:"#123456",taskCount:0});
    expect(await api.getTaskProjects()).toHaveLength(1);

    const updated = await api.updateTaskProject(project.id,{name:"离线项目 2",sortOrder:3});
    expect(updated).toMatchObject({name:"离线项目 2",sortOrder:3});

    await api.deleteTaskProject(project.id);
    expect(await api.getTaskProjects()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stores templates locally and applies them through the already-local task facade", async () => {
    const db = createFakeDb();
    const fetchSpy = vi.spyOn(globalThis,"fetch");
    originalCreateTask = api.createTask;
    const createdTasks: Task[] = [];
    (api as any).createTask = vi.fn(async (data: Partial<Task>) => {
      const task = {
        id:`task-${createdTasks.length + 1}`,
        userId:"android-local-user",
        workspaceId:null,
        title:data.title || "",
        description:data.description || "",
        isCompleted:0,
        priority:data.priority || 2,
        dueDate:data.dueDate || null,
        dueAt:data.dueAt || null,
        noteId:null,
        parentId:data.parentId || null,
        sortOrder:data.sortOrder || 0,
        projectId:data.projectId || null,
        status:"todo",
        createdAt:"2026-08-27T00:00:00.000Z",
        updatedAt:"2026-08-27T00:00:00.000Z",
      } as Task;
      createdTasks.push(task);
      return task;
    });
    restore = installMobileLocalAdvancedTaskBridge(db,"android-local-user");

    const template = await api.createTaskTemplate({
      name:"发布流程",
      items:[
        {title:"打包",priority:2,relativeDueDays:0,parentIndex:null,sortOrder:0},
        {title:"验证",priority:3,relativeDueDays:1,parentIndex:0,sortOrder:1},
      ],
    });
    expect((await api.getTaskTemplates())[0]).toMatchObject({name:"发布流程"});

    const result = await api.applyTaskTemplate(template.id,{baseDate:"2026-08-27"});
    expect(result.count).toBe(2);
    expect(result.createdTasks[0]).toMatchObject({title:"打包",dueDate:"2026-08-27"});
    expect(result.createdTasks[1]).toMatchObject({title:"验证",dueDate:"2026-08-28",parentId:"task-1"});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
