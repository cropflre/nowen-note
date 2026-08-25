import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api.impl", () => ({ getBaseUrl: () => "/api" }));

import { automationApi } from "@/lib/automationApi";
import { pluginApi } from "@/lib/pluginApi";

describe("extension API paths", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => new Response(
      JSON.stringify(String(input).includes("/ecosystem/catalog") ? { extensions: [] } : []),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("does not duplicate the API prefix for plugin requests", async () => {
    await pluginApi.list();
    await pluginApi.getDeveloperMode();
    await pluginApi.registryCatalog("official-v2");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/plugins",
      "/api/plugins/developer-mode",
      "/api/plugins/ecosystem/catalog?source=official-v2",
    ]);
  });

  it("does not duplicate the API prefix for automation requests", async () => {
    await automationApi.list();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/automations",
      expect.any(Object),
    );
  });

  it("maps the signed V2 index to marketplace cards", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      extensions: [{
        id: "nowenlab.example",
        publisher: "nowenlab",
        name: "Example",
        versions: [{ version: "1.2.0" }, { version: "1.10.0" }],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(pluginApi.registryCatalog()).resolves.toMatchObject([{
      id: "nowenlab.example",
      latestVersion: "1.10.0",
    }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/plugins/ecosystem/catalog?source=official-v2",
      expect.any(Object),
    );
  });
});
