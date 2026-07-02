import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCalendarFeedSettings } from "../TaskCalendarFeedSettings";
import { api } from "@/lib/api";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const disabledFeed = {
  id: "feed-1",
  token: "token-1",
  enabled: false,
  includeCompleted: false,
  includeDescription: true,
  defaultAlarmMinutes: 30,
  lastAccessedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        "tasks.calendarFeed.title": "Calendar Subscription",
        "tasks.calendarFeed.enableAgain": "Enable subscription",
        "tasks.calendarFeed.disable": "Disable subscription",
        "tasks.calendarFeed.disabled": "Disabled",
      };
      return labels[key] || key;
    },
  }),
}));

vi.mock("@/lib/api", () => ({
  getBaseUrl: () => "http://note.nowen.cn/api",
  api: {
    taskCalendarFeed: {
      get: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      rotateToken: vi.fn(),
    },
  },
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

async function renderSettings() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<TaskCalendarFeedSettings />);
    await Promise.resolve();
  });
  return { host, root };
}

describe("TaskCalendarFeedSettings", () => {
  let root: Root | null = null;

  beforeEach(() => {
    vi.mocked(api.taskCalendarFeed.get).mockResolvedValue({ feed: disabledFeed });
    vi.mocked(api.taskCalendarFeed.update).mockResolvedValue({
      feed: { ...disabledFeed, enabled: true },
    });
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows an enable action for disabled feeds", async () => {
    const rendered = await renderSettings();
    root = rendered.root;

    await act(async () => {
      rendered.host.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(rendered.host.textContent).toContain("Disabled");
    expect(rendered.host.textContent).toContain("Enable subscription");
    expect(rendered.host.textContent).not.toContain("Disable subscription");

    const enableButton = Array.from(rendered.host.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Enable subscription"));
    await act(async () => {
      enableButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(api.taskCalendarFeed.update).toHaveBeenCalledWith({ enabled: true });
  });
});
