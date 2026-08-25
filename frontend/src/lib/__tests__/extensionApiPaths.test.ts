import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api.impl", () => ({ getBaseUrl: () => "/api" }));

import { automationApi } from "@/lib/automationApi";
import { pluginApi } from "@/lib/pluginApi";

describe("extension API paths", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("does not duplicate the API prefix for plugin requests", async () => {
    await pluginApi.list();
    await pluginApi.getDeveloperMode();
    await pluginApi.registryCatalog("official");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/plugins",
      "/api/plugins/developer-mode",
      "/api/plugins/registry/catalog?source=official",
    ]);
  });

  it("does not duplicate the API prefix for automation requests", async () => {
    await automationApi.list();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/automations",
      expect.any(Object),
    );
  });
});
