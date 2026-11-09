// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "@/i18n/locales/zh-CN.json";

const mocks = vi.hoisted(() => ({
  adminListUsers: vi.fn(),
  getRegisterConfig: vi.fn(),
  adminResetUserPassword: vi.fn(),
  requestSudoToken: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: {
    adminListUsers: mocks.adminListUsers,
    getRegisterConfig: mocks.getRegisterConfig,
    adminResetUserPassword: mocks.adminResetUserPassword,
    requestSudoToken: mocks.requestSudoToken,
  },
}));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }));
vi.mock("@/i18n", () => ({ default: { language: "zh-CN", t: (key: string) => key } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values: Record<string, unknown> = {}) => {
  let text = String(key.split(".").reduce((value: unknown, part) => (value as Record<string, unknown>)?.[part], zh) || key);
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{{${name}}}`, String(value));
  return text;
} }) }));
import UserManagement from "../UserManagement";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const text = zh.userManagement;
const admin = { id: "admin-1", username: "boss", role: "admin", isDisabled: 0 };
const member = { id: "member-1", username: "alice", role: "user", isDisabled: 0 };

describe("admin password reset", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async () => {
    await act(async () => { root.render(<UserManagement currentUserId={admin.id} />); });
    // 用户列表在 200ms 防抖后加载。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
  };
  const resetButton = (username: string) => {
    const row = [...host.querySelectorAll("li")].find((item) => item.textContent?.includes(`@${username}`));
    expect(row).toBeDefined();
    return row!.querySelector<HTMLButtonElement>(`button[title="${text.resetPassword}"]`)!;
  };
  const passwordInputs = () => [...host.querySelectorAll<HTMLInputElement>('input[type="password"]')];
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const click = async (button: HTMLButtonElement) => { await act(async () => { button.click(); }); };
  const buttonWithText = (label: string) => {
    const button = [...host.querySelectorAll("button")].reverse().find((item) => item.textContent?.trim() === label);
    expect(button).toBeDefined();
    return button!;
  };
  const submitNewPassword = async (password: string) => {
    await click(resetButton("alice"));
    const [newPassword, confirm] = passwordInputs();
    await type(newPassword, password);
    await type(confirm, password);
    await click(buttonWithText(text.confirmReset));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adminListUsers.mockResolvedValue([admin, member]);
    mocks.getRegisterConfig.mockResolvedValue({ allowRegistration: true });
    mocks.adminResetUserPassword.mockResolvedValue({ success: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("resets another user's password with only the new password and its confirmation", async () => {
    await render();
    await submitNewPassword("alice-new-pass");

    expect(mocks.adminResetUserPassword).toHaveBeenCalledTimes(1);
    expect(mocks.adminResetUserPassword.mock.calls[0].slice(0, 2)).toEqual(["member-1", "alice-new-pass"]);
    expect(mocks.adminResetUserPassword.mock.calls[0][2]).toBeUndefined();
    expect(mocks.requestSudoToken).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain(text.sudoTitle);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(text.passwordResetSuccess);
  });

  it("asks for the current password only when an older server still requires it", async () => {
    mocks.adminResetUserPassword
      .mockRejectedValueOnce(Object.assign(new Error("该操作需要二次密码验证"), { code: "SUDO_REQUIRED", status: 403 }))
      .mockResolvedValueOnce({ success: true });
    mocks.requestSudoToken.mockResolvedValue({ sudoToken: "sudo-1", expiresIn: 300 });
    await render();
    await submitNewPassword("alice-new-pass");

    expect(mocks.adminResetUserPassword.mock.calls[0][2]).toBeUndefined();
    expect(host.textContent).toContain(text.sudoTitle);
    await type(passwordInputs().at(-1)!, "boss-current-pass");
    await click(buttonWithText(text.sudoConfirm));

    expect(mocks.requestSudoToken).toHaveBeenCalledWith("boss-current-pass");
    expect(mocks.adminResetUserPassword).toHaveBeenLastCalledWith("member-1", "alice-new-pass", "sudo-1");
    expect(mocks.toastSuccess).toHaveBeenCalledWith(text.passwordResetSuccess);
  });

  it("does not offer a reset for the signed-in admin's own account", async () => {
    await render();

    expect(resetButton("boss").disabled).toBe(true);
    expect(resetButton("alice").disabled).toBe(false);
  });
});
