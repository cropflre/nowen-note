import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskQuickAdd } from "../TaskQuickAdd";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({
  api: {
    taskAttachments: {
      upload: vi.fn(),
      remove: vi.fn(),
    },
  },
}));

function QuickAddHarness({ value, onSubmit = vi.fn().mockResolvedValue(true) }: { value: string; onSubmit?: (ids: string[], manual: import("../taskQuickAddDraft").TaskQuickAddManualMeta) => Promise<boolean> }) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [title, setTitle] = React.useState(value);
  return (
    <TaskQuickAdd
      value={title}
      onChange={setTitle}
      onSubmit={onSubmit}
      inputRef={inputRef}
    />
  );
}

describe("TaskQuickAdd", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T10:00:00"));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps manual fields after failure and resets them after success", async () => {
    const submit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await act(async () => { root.render(<QuickAddHarness value="开会" onSubmit={submit} />); });
    const dateButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "tasks.dueDate")!;
    await act(async () => { dateButton.click(); });
    const dateInput = host.querySelector<HTMLInputElement>("input[type='date']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(dateInput, "2026-07-10");
      dateInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const add = host.querySelector<HTMLButtonElement>("[aria-label='tasks.add']")!;
    await act(async () => { add.click(); });
    expect(submit).toHaveBeenLastCalledWith([], { dueDate: "2026-07-10" });
    expect(dateInput.value).toBe("2026-07-10");
    await act(async () => { add.click(); });
    expect(host.textContent).not.toContain("2026-07-10");
    expect(host.querySelector("input[type='date']")).toBeNull();
  });

  it("disables reminders without a deadline and rejects invalid custom offsets", async () => {
    await act(async () => { root.render(<QuickAddHarness value="开会" />); });
    await act(async () => { Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "tasks.reminder.title")!.click(); });
    expect(host.textContent).toContain("tasks.reminder.needDueDate");
    expect(host.querySelector<HTMLInputElement>("input[type='checkbox']")!.disabled).toBe(true);
    await act(async () => {
      const title = host.querySelector<HTMLInputElement>("[aria-label='tasks.newTask']")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "明天晚上8点 开会");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const custom = host.querySelector<HTMLInputElement>("input[type='number']")!;
    const addCustom = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "tasks.reminder.addCustom")!;
    for (const value of ["0", "-1", "1.5", "525601", ""]) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(custom, value);
        custom.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(addCustom.disabled).toBe(true);
    }
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(custom, "90");
      custom.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(addCustom.disabled).toBe(false);
    await act(async () => { addCustom.click(); });
    expect(Array.from(host.querySelectorAll<HTMLInputElement>("input[type='checkbox']")).filter((input) => input.checked)).toHaveLength(2);
  });

  it.each(["明天12:50提醒我上班", "  明天12:50提醒我上班"])("highlights recognized quick-add tokens in %s", async (value) => {
    await act(async () => {
      root.render(<QuickAddHarness value={value} />);
    });

    const tokens = Array.from(host.querySelectorAll<HTMLElement>("[data-recognized-token='true']"));
    expect(tokens.map((token) => token.textContent)).toEqual(["明天12:50提醒我"]);
    expect(tokens[0].className).toContain("text-accent-primary");
  });

  it("highlights recognized repeat tokens", async () => {
    await act(async () => {
      root.render(<QuickAddHarness value="每个工作日 写日报" />);
    });

    const tokens = Array.from(host.querySelectorAll<HTMLElement>("[data-recognized-token='true']"));
    expect(tokens.map((token) => token.textContent)).toEqual(["每个工作日"]);
  });

  it("highlights recognized English tokens", async () => {
    await act(async () => {
      root.render(<QuickAddHarness value="tomorrow 12:50 remind me to work" />);
    });

    const tokens = Array.from(host.querySelectorAll<HTMLElement>("[data-recognized-token='true']"));
    expect(tokens.map((token) => token.textContent)).toEqual(["tomorrow", "12:50", "remind me to"]);
  });
});
