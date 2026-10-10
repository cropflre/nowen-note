import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Task } from "@/types";
import { TaskDetailPanel } from "../TaskDetailPanel";

const previousTimezone = process.env.TZ;

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

beforeAll(() => {
  process.env.TZ = "Asia/Shanghai";
});

afterAll(() => {
  if (previousTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = previousTimezone;
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

    expect(html).toContain("2026-08-28 10:54");
    expect(html).not.toContain("2026-08-28 02:54");
  });
});
