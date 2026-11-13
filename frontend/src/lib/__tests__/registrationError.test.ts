import { afterEach, expect, it, vi } from "vitest";
import { registerAccount } from "../api.impl";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("DCC-006: a rejected registration preserves the server error and existing account tokens", async () => {
  localStorage.setItem("nowen-token", "existing-access");
  localStorage.setItem("nowen-refresh-token", "existing-refresh");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "该用户名已被占用" }), { status: 409 })));

  await expect(registerAccount({ username: "admin", password: "test-password" }, "https://notes.example.test"))
    .rejects.toMatchObject({ status: 409, message: "该用户名已被占用" });
  expect(fetch).toHaveBeenCalledWith("https://notes.example.test/api/auth/register", expect.objectContaining({
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }));
  expect(localStorage.getItem("nowen-token")).toBe("existing-access");
  expect(localStorage.getItem("nowen-refresh-token")).toBe("existing-refresh");
});
