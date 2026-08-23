import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loginSyncServer,
  setSyncLocalAdminAdapter,
  startSyncBootstrap,
  type SyncLocalAdminAdapter,
} from "@/lib/syncLocalApi";

afterEach(() => {
  setSyncLocalAdminAdapter(null);
});

describe("sync login client", () => {
  it("sends credentials only to the localhost sync login adapter", async () => {
    const adapter = vi.fn(async () => ({
      mode: "server",
      authorized: true,
      engineRunning: false,
      bootstrapRequired: true,
    }));
    setSyncLocalAdminAdapter(adapter as SyncLocalAdminAdapter);

    await loginSyncServer({
      serverUrl: "https://notes.example.com",
      username: "alice",
      password: "secret",
    });

    expect(adapter).toHaveBeenCalledWith("/settings/server/login", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        serverUrl: "https://notes.example.com",
        username: "alice",
        password: "secret",
      }),
    }));
  });

  it("starts the resumable bootstrap through the local adapter", async () => {
    const adapter = vi.fn(async () => ({ status: "ready", engineRunning: true }));
    setSyncLocalAdminAdapter(adapter as SyncLocalAdminAdapter);

    await startSyncBootstrap();

    expect(adapter).toHaveBeenCalledWith("/bootstrap", { method: "POST" });
  });
});
