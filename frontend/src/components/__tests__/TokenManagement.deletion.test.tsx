import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), remove: vi.fn(), revoke: vi.fn(), confirm: vi.fn(),
  success: vi.fn(), error: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: { tokens: { list: mocks.list, remove: mocks.remove, revoke: mocks.revoke } },
  getBaseUrl: () => "/api",
}));
vi.mock("@/components/ui/confirm", () => ({ confirm: mocks.confirm }));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/components/TokenUsageStats", () => ({
  default: ({ refreshKey }: { refreshKey: string }) => <div data-usage-key={refreshKey} />,
}));

import TokenManagement from "../TokenManagement";

function token(id: string, revoked = false, expired = false) {
  return {
    id, name: `Token ${id}`, scopes: ["notes:read"], resourceMode: "unrestricted",
    notebookResources: [], createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null, lastUsedIp: null,
    revokedAt: revoked ? "2026-01-02T00:00:00Z" : null,
    expiresAt: expired ? "2000-01-01T00:00:00Z" : null,
  };
}

describe("revoked token deletion", () => {
  let host: HTMLDivElement;
  let root: Root;
  let rows: ReturnType<typeof token>[];

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    await i18n.changeLanguage("zh-CN");
    rows = [token("active"), token("expired", false, true), token("revoked", true)];
    mocks.list.mockImplementation(async () => ({ tokens: rows, availableScopes: ["notes:read"] }));
    mocks.confirm.mockResolvedValue(true);
    mocks.remove.mockImplementation(async (id: string) => {
      rows = rows.filter((item) => item.id !== id);
      return { success: true };
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<TokenManagement />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    await i18n.changeLanguage("zh-CN");
  });

  function button(label: string) {
    const matches = [...host.querySelectorAll("button")].filter((item) => item.textContent === label);
    expect(matches).toHaveLength(1);
    return matches[0];
  }

  it("shows deletion only for revoked tokens, retaining revoke actions for active and expired tokens", () => {
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.filter((item) => item.textContent === "删除")).toHaveLength(1);
    expect(buttons.filter((item) => item.textContent === "吊销")).toHaveLength(2);
  });

  it("confirms the permanent data impact, removes the row and refreshes usage", async () => {
    await act(async () => button("删除").click());
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: "删除已吊销的令牌？", danger: true, confirmText: "删除",
      description: "将永久删除「Token revoked」及其授权配置和使用统计，审计日志仍保留。此操作无法恢复。",
    }));
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith("revoked");
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Token revoked");
    expect(host.querySelector("[data-usage-key]")?.getAttribute("data-usage-key")).toBe("active,expired");
    expect(mocks.success).toHaveBeenCalledWith("令牌「Token revoked」已删除");
  });

  it("does not delete when confirmation is cancelled", async () => {
    mocks.confirm.mockResolvedValue(false);
    await act(async () => button("删除").click());
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Token revoked");
  });

  it("keeps the row and allows retry when the request fails", async () => {
    mocks.remove.mockRejectedValue(new Error("server unavailable"));
    await act(async () => button("删除").click());
    expect(host.textContent).toContain("Token revoked");
    expect(button("删除").disabled).toBe(false);
    expect(mocks.error).toHaveBeenCalledWith("server unavailable");
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("disables deletion during an in-flight request", async () => {
    let finish!: (value: { success: boolean }) => void;
    mocks.remove.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => button("删除").click());
    expect(button("删除中...").disabled).toBe(true);
    await act(async () => { rows = rows.filter((item) => item.id !== "revoked"); finish({ success: true }); });
    expect(host.textContent).not.toContain("Token revoked");
  });

  it("translates the deletion flow into English", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    await act(async () => button("Delete").click());
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: "Delete this revoked token?", confirmText: "Delete", cancelText: "Cancel",
      description: "Permanently delete “Token revoked”, its resource grants and usage statistics. Audit logs are retained. This cannot be undone.",
    }));
    expect(mocks.success).toHaveBeenCalledWith("Token “Token revoked” has been deleted");
  });
});
