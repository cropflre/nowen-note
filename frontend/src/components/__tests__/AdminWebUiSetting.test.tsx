import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import AdminWebUiSetting from "../settings/AdminWebUiSetting";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("用户管理里的网页端访问开关", () => {
  let host: HTMLDivElement;
  let root: Root;
  const toggle = () => host.querySelector<HTMLInputElement>('[data-settings-section="web-ui-access"] input[role="switch"]')!;

  beforeAll(async () => { await i18n.changeLanguage("zh-CN"); });
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("waits for the server's value, then turns the web UI off", async () => {
    let answer!: (value: { web_ui_enabled: string }) => void;
    vi.spyOn(api, "getSiteSettings").mockReturnValue(new Promise((resolve) => { answer = resolve as typeof answer; }) as never);
    const update = vi.spyOn(api, "updateSiteSettings").mockResolvedValue({ web_ui_enabled: "false" } as never);
    await act(async () => root.render(<AdminWebUiSetting />));
    expect(host.textContent).toContain("关闭网页端页面");
    expect(host.textContent).toContain("管理员");
    expect(toggle().disabled).toBe(true);

    await act(async () => answer({ web_ui_enabled: "true" }));
    expect(toggle().disabled).toBe(false);
    expect(toggle().checked).toBe(false);
    await act(async () => toggle().click());
    expect(update).toHaveBeenCalledWith({ web_ui_enabled: false });
    expect(toggle().checked).toBe(true);
  });

  it("restores the previous value and says why when saving fails", async () => {
    vi.spyOn(api, "getSiteSettings").mockResolvedValue({ web_ui_enabled: "true" } as never);
    vi.spyOn(api, "updateSiteSettings").mockRejectedValue(new Error("需要管理员权限"));
    const error = vi.spyOn(toast, "error");
    await act(async () => root.render(<AdminWebUiSetting />));
    await act(async () => toggle().click());
    expect(toggle().checked).toBe(false);
    expect(error).toHaveBeenCalledWith("保存失败，已恢复原设置：需要管理员权限");
  });
});
