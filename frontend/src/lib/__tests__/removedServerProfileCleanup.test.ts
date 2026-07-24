import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRemovedServerProfiles } from "@/lib/removedServerProfileCleanup";

describe("遗留服务器资料清理", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("只删除多服务器专用键", async () => {
    localStorage.setItem("nowen-server-profiles-v2", "[]");
    localStorage.setItem("nowen-active-server-profile-v2", "old");
    localStorage.setItem("nowen-server-profiles-v1", "[]");
    localStorage.setItem("nowen-active-server-profile-v1", "old");
    localStorage.setItem("nowen-cloud-login-records-v1", "[]");
    localStorage.setItem("nowen-profile-credential-index-v1", JSON.stringify(["old"]));
    sessionStorage.setItem("nowen-pending-profile-reauth-v1", "old");
    localStorage.setItem("nowen-server-url", "http://127.0.0.1:3001");
    localStorage.setItem("nowen-token", "token");

    await cleanupRemovedServerProfiles({ isNativePlatform: () => false });

    expect(localStorage.getItem("nowen-server-profiles-v2")).toBeNull();
    expect(localStorage.getItem("nowen-active-server-profile-v2")).toBeNull();
    expect(localStorage.getItem("nowen-server-profiles-v1")).toBeNull();
    expect(localStorage.getItem("nowen-active-server-profile-v1")).toBeNull();
    expect(localStorage.getItem("nowen-cloud-login-records-v1")).toBeNull();
    expect(localStorage.getItem("nowen-profile-credential-index-v1")).toBeNull();
    expect(sessionStorage.getItem("nowen-pending-profile-reauth-v1")).toBeNull();
    expect(localStorage.getItem("nowen-server-url")).toBe("http://127.0.0.1:3001");
    expect(localStorage.getItem("nowen-token")).toBe("token");
  });

  it("Android 安全存储删除失败时保留索引供下次重试", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    localStorage.setItem("nowen-profile-credential-index-v1", JSON.stringify(["one", "two"]));
    const removeSecureItem = vi.fn(async (key: string) => {
      if (key.includes("two")) throw new Error("remove failed");
    });

    await cleanupRemovedServerProfiles({ isNativePlatform: () => true, removeSecureItem });

    expect(removeSecureItem).toHaveBeenCalledWith("serverAccount.one.v1");
    expect(removeSecureItem).toHaveBeenCalledWith("serverAccount.two.v1");
    expect(localStorage.getItem("nowen-profile-credential-index-v1")).toBe(JSON.stringify(["one", "two"]));
  });
});
