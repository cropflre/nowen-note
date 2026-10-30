// @vitest-environment jsdom
import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskProject } from "@/types";
import en from "@/i18n/locales/en.json";
import zh from "@/i18n/locales/zh-CN.json";

const mocks = vi.hoisted(() => ({ getTasks: vi.fn(), getTaskProjects: vi.fn(), save: vi.fn(), nativeSave: vi.fn(), native: false, scope: "personal" }));
vi.mock("@/lib/api", () => ({ api: mocks }));
vi.mock("@/lib/offlineScope", () => ({ getOfflineQueueStorageKey: () => mocks.scope }));
vi.mock("@/lib/taskDataTransferArchive", () => ({ saveTaskTransferBlob: mocks.save }));
vi.mock("@/lib/nativeImageSave", () => ({ isAndroidNative: () => mocks.native, saveBlobToSystemFile: mocks.nativeSave }));
import { buildTaskExcel, buildTaskMarkdown, exportTaskReport, taskReportRows } from "@/lib/taskReportExport";

const translate = (locale: typeof en | typeof zh) => (key: string): string => key.split(".").reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], locale) as string;
const t = translate(en);
const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id, title: id, description: "", userId: "user", workspaceId: null, isCompleted: 0, priority: 2,
  dueDate: null, dueAt: null, noteId: null, parentId: null, projectId: "project", status: "todo", sortOrder: 0,
  createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z", ...patch,
});
const projects: TaskProject[] = [{ id: "project", name: "Release", icon: "", color: "", userId: "user", workspaceId: null, sortOrder: 0, createdAt: "", updatedAt: "" }];
const tasks = [
  task("root", { title: "发布 🚀", status: "doing", description: "First line\n\n**完整描述** & <details>\n![image](/api/task-attachments/image)", dueDate: "2026-10-15", dueAt: "2026-10-15T18:30" }),
  task("done", { parentId: "root", isCompleted: 1, status: "done", completedAt: "2026-10-14T08:00:00Z" }),
  task("branch", { parentId: "root", status: "blocked" }),
  task("leaf-done", { parentId: "branch", isCompleted: 1, status: "done" }),
  task("leaf-pending", { parentId: "branch" }),
  task("archived", { isCompleted: 1, status: "done", archivedAt: "2026-10-14T09:00:00Z" }),
];

async function worksheet(blob: Blob) {
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject; reader.readAsArrayBuffer(blob); });
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  return { xml, document: new DOMParser().parseFromString(xml, "application/xml") };
}

async function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob); });
}

beforeEach(() => { vi.clearAllMocks(); mocks.native = false; mocks.scope = "personal"; mocks.getTasks.mockResolvedValue(tasks); mocks.getTaskProjects.mockResolvedValue(projects); });

describe("task reports (#836)", () => {
  it("exports hierarchy, all lifecycle states and the same recursive progress as the UI", () => {
    const rows = taskReportRows(tasks, projects, t);
    expect(rows.map(row => row.id)).toEqual(tasks.map(row => row.id));
    expect(rows[0]).toMatchObject({ progress: 75, completedChildren: 1, totalChildren: 2, status: "In Progress", project: "Release", dueAt: "2026-10-15T18:30" });
    expect(rows[2]).toMatchObject({ progress: 50, status: "Blocked" });
    expect(rows[3]).toMatchObject({ path: "发布 🚀 / branch / leaf-done", depth: 2 });
    expect(rows[5]).toMatchObject({ status: "Archived", archivedAt: "2026-10-14T09:00:00Z" });
    expect(tasks[0].description).toContain("**完整描述**");
  });

  it("writes readable Markdown checkboxes, nested tasks and complete multiline descriptions", () => {
    const md = buildTaskMarkdown(tasks, projects, translate(zh));
    expect(md).toContain("# 任务报告");
    expect(md).toContain("- [ ] **发布 🚀**");
    expect(md).toContain("  - [x] **done**");
    expect(md).toContain("    - [ ] **leaf\\-pending**");
    expect(md).toContain("75%");
    expect(md).toContain("  **完整描述** & <details>");
    expect(md).toContain("  ![image](/api/task-attachments/image)");
    expect(md).toContain("已归档");
  });

  it("escapes Markdown syntax in titles while preserving description formatting", () => {
    expect(buildTaskMarkdown([task("id", { title: "[x] <script>\n# heading", description: "```js\nconst x = 1;\n```" })], [], t)).toContain("**\\[x\\] \\<script\\> \\# heading**");
  });

  it("creates a real Excel workbook with Unicode, multiline descriptions and literal formula-looking text", async () => {
    const { document, xml } = await worksheet(await buildTaskExcel([...tasks, task("formula", { title: '=HYPERLINK("https://example.com")' })], projects, t));
    expect(document.querySelector("parsererror")).toBeNull();
    expect(document.querySelector('c[r="E2"] t')?.textContent).toBe("发布 🚀");
    expect(document.querySelector('c[r="F2"] t')?.textContent).toBe("In Progress");
    expect(document.querySelector('c[r="G2"] v')?.textContent).toBe("75");
    expect(document.querySelector('c[r="J2"] t')?.textContent).toBe(tasks[0].description);
    expect(xml).toContain("HYPERLINK");
    expect(document.querySelectorAll("f")).toHaveLength(0);
  });

  it("does not apply the editable sheet's 1000-row or 20000-character truncation", async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => task(`task-${index}`));
    rows[1000].description = "完整".repeat(11000);
    const { document } = await worksheet(await buildTaskExcel(rows, [], t));
    expect(document.querySelectorAll("row")).toHaveLength(1002);
    expect(document.querySelector('c[r="J1002"] t')?.textContent).toBe(rows[1000].description);
  });

  it("rejects Excel cell overflow rather than losing content, while Markdown keeps the full text", async () => {
    const rows = [task("long", { description: "x".repeat(32768) })];
    await expect(buildTaskExcel(rows, [], t)).rejects.toThrow("32767");
    expect(buildTaskMarkdown(rows, [], t)).toContain(rows[0].description);
  });

  it("supports empty spaces and orphan tasks without losing tasks", async () => {
    expect(taskReportRows([task("orphan", { parentId: "missing" })], [], t)).toHaveLength(1);
    expect((await worksheet(await buildTaskExcel([], [], t))).document.querySelectorAll("row")).toHaveLength(1);
    expect(buildTaskMarkdown([], [], t)).toContain("# Task report");
  });

  it.each(["xlsx", "md"] as const)("reads current-space history and uses the shared file delivery for %s", async format => {
    await exportTaskReport(format, t);
    expect(mocks.getTasks).toHaveBeenCalledWith("history");
    expect(mocks.save).toHaveBeenCalledWith(expect.any(Blob), expect.stringMatching(new RegExp(`\\.${format}$`)));
  });

  it("does not deliver a report after the account or workspace changes during collection", async () => {
    mocks.getTasks.mockImplementation(async () => { mocks.scope = "team"; return tasks; });
    await expect(exportTaskReport("md", t)).rejects.toThrow("changed");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each(["xlsx", "md"] as const)("uses Android's system file picker for %s", async format => {
    mocks.native = true;
    await exportTaskReport(format, t);
    expect(mocks.nativeSave).toHaveBeenCalledWith({ blob: expect.any(Blob), fileName: expect.stringMatching(new RegExp(`\\.${format}$`)), mimeType: format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/markdown" });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("reports read failures without delivering an incomplete report", async () => {
    mocks.getTaskProjects.mockRejectedValue(new Error("offline"));
    await expect(exportTaskReport("md", t)).rejects.toThrow("offline");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each(["root", "branch", "leaf-done", "archived"])("exports only the selected task %s and its full descendants to Markdown", async id => {
    await exportTaskReport("md", t, id);
    const [blob, filename] = mocks.save.mock.calls[0];
    const text = await blobText(blob);
    expect(filename).toContain(`nowen-task-${id}-`);
    expect(text).toContain(t("tasks.report.subtreeScope"));
    expect(text).not.toContain(t("tasks.report.scope"));
    const exportedTitles = Array.from(text.matchAll(/- \[[ x]\] \*\*(.*?)\*\*/g), match => match[1].replace(/\\/g, ""));
    expect(exportedTitles).toEqual(id === "root" ? ["发布 🚀", "done", "branch", "leaf-done", "leaf-pending"] : id === "branch" ? ["branch", "leaf-done", "leaf-pending"] : [id]);
    expect(text).toContain(id === "root" ? "75%" : id === "branch" ? "50%" : "100%");
  });

  it("exports a child subtree to Excel without its parent or siblings", async () => {
    await exportTaskReport("xlsx", t, "branch");
    const { document } = await worksheet(mocks.save.mock.calls[0][0]);
    expect(document.querySelectorAll("row")).toHaveLength(4);
    expect(document.querySelector('c[r="E2"] t')?.textContent).toBe("branch");
    expect(document.querySelector('c[r="G2"] v')?.textContent).toBe("50");
    expect(document.querySelector('c[r="C3"] t')?.textContent).toBe("branch / leaf-done");
    expect(document.documentElement.textContent).not.toContain("发布 🚀");
    expect(document.documentElement.textContent).not.toContain("archived");
  });

  it("does not fall back to exporting the entire space when a selected task is missing", async () => {
    await expect(exportTaskReport("md", t, "deleted")).rejects.toThrow("unavailable");
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
