import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { format } from "date-fns";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@/types";
import { TaskDetailPanel } from "../TaskDetailPanel";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { resolvedLanguage: "zh-CN", language: "zh-CN" },
    }),
  };
});

describe("TaskDetailPanel created time", () => {
  it("renders a timezone-less SQLite UTC timestamp in the browser timezone", () => {
    const task: Task = {
      id: "task-753",
      userId: "user-1",
      workspaceId: null,
      title: "Issue 753",
      description: "",
      isCompleted: 0,
      priority: 2,
      dueDate: null,
      dueAt: null,
      noteId: null,
      parentId: null,
      sortOrder: 0,
      projectId: null,
      status: "todo",
      createdAt: "2026-08-28 02:54:00",
      updatedAt: "2026-08-28 02:54:00",
    };

    const html = renderToStaticMarkup(
      <TaskDetailPanel
        task={task}
        onClose={() => {}}
        onUpdate={() => {}}
        onDelete={() => {}}
      />,
    );

    const localCreatedAt = format(new Date("2026-08-28T02:54:00Z"), "yyyy-MM-dd HH:mm");
    expect(html).toContain(localCreatedAt);
  });
});
