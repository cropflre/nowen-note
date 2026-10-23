import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TaskCalendarView } from "@/components/tasks/TaskCalendarView";
import SayCalendarView from "@/components/diary/SayCalendarView";
import { holidayCalendarStore } from "@/lib/holidayCalendarStore";
import type { Task } from "@/types";

vi.mock("@/lib/api", () => ({
  api: { getDiaryTimeline: vi.fn().mockResolvedValue({ items: [] }) },
  getCurrentWorkspace: () => "personal",
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });

it("shares the opt-in layer across calendars without changing task selection, dates, or drag targets", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 15, 12));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  await i18n.changeLanguage("zh-CN");
  holidayCalendarStore.setEnabled(false);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const select = vi.fn();
  const move = vi.fn();
  const task = { id: "task-848", title: "Holiday task", dueDate: "2026-10-01", dueAt: "2026-10-01T09:30:00", isCompleted: 0 } as Task;
  const original = { ...task };
  try {
    await act(async () => {
      root.render(<>
        <section id="tasks"><TaskCalendarView tasks={[task]} onSelect={select} onMoveTaskDate={move} /></section>
        <section id="moments"><SayCalendarView onClose={vi.fn()} onWriteEntry={vi.fn()} onLocateItem={vi.fn()} /></section>
      </>);
    });
    expect(host.querySelectorAll("[data-holiday-type]")).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    const switches = [...host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    await act(async () => switches[0].click());
    expect(switches.every((input) => input.checked)).toBe(true);
    for (const selector of ["[data-calendar-date='2026-10-01']", "button[aria-label='2026-10-01']"]) {
      expect(host.querySelector(selector)?.querySelector("[data-holiday-type='holiday']")?.getAttribute("aria-label")).toBe("国庆节 · 放假");
    }
    expect(host.querySelector("button[aria-label='2026-10-10'] [data-holiday-type='makeup-workday']")?.textContent).toContain("班");
    expect(host.querySelector("[data-calendar-date='2026-10-08'] [data-holiday-type]")).toBeNull();
    expect(host.textContent).toContain("更新未完成，继续使用可用数据。");
    const taskCard = host.querySelector<HTMLElement>("[data-task-context-id='task-848']")!;
    await act(async () => taskCard.click());
    expect(select).toHaveBeenCalledWith(task);
    expect(task).toEqual(original);
    const target = host.querySelector("[data-calendar-date='2026-10-10']")!;
    const drop = new Event("drop", { bubbles: true });
    Object.defineProperty(drop, "dataTransfer", { value: { getData: () => task.id } });
    await act(async () => target.dispatchEvent(drop));
    expect(move).toHaveBeenCalledWith(task.id, "2026-10-10");
    await act(async () => i18n.changeLanguage("en"));
    expect(host.querySelector("button[aria-label='2026-10-10'] [data-holiday-type]")?.getAttribute("aria-label")).toBe("National Day · Adjusted working day");
    expect(host.textContent).toContain("Mainland China public holidays");
    await act(async () => switches[1].click());
    expect(switches.every((input) => !input.checked)).toBe(true);
    expect(host.querySelectorAll("[data-holiday-type]")).toHaveLength(0);
    expect(task).toEqual(original);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
