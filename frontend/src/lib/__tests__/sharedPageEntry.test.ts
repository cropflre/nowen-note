import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ renderShare: vi.fn(), loadApp: vi.fn() }));
vi.mock("../../sharedPage", () => ({ renderSharedPage: mocks.renderShare }));

describe("public share entry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("../../main", () => { mocks.loadApp(); return {}; });
  });
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    delete (window as Window & { nowenDesktop?: unknown }).nowenDesktop;
  });

  it.each(["/share/abc_-123", "/nowen/share/abc_-123"])("loads %s without starting the workspace", async (path) => {
    window.history.replaceState(null, "", path);
    await import("../../entry");
    await vi.waitFor(() => expect(mocks.renderShare).toHaveBeenCalledWith("abc_-123"));
    expect(mocks.loadApp).not.toHaveBeenCalled();
  });

  it.each(["/", "/login", "/public/demo", "/notebook-share/demo"])("preserves normal startup for %s", async (path) => {
    window.history.replaceState(null, "", path);
    await import("../../entry");
    await vi.waitFor(() => expect(mocks.loadApp).toHaveBeenCalledOnce());
    expect(mocks.renderShare).not.toHaveBeenCalled();
  });

  it("preserves native session and transport initialization on a share route", async () => {
    window.history.replaceState(null, "", "/share/abc_-123");
    (window as Window & { nowenDesktop?: unknown }).nowenDesktop = { isDesktop: true };
    await import("../../entry");
    await vi.waitFor(() => expect(mocks.loadApp).toHaveBeenCalledOnce());
    expect(mocks.renderShare).not.toHaveBeenCalled();
  });
});
