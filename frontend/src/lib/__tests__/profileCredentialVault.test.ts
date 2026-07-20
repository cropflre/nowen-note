import { beforeEach, describe, expect, it } from "vitest";
import {
  loadProfileCredential,
  saveProfileCredential,
} from "@/lib/profileCredentialVault";

describe("profileCredentialVault web downgrade", () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as any).nowenDesktop;
  });

  it("never writes password or token to ordinary web storage", async () => {
    const result = await saveProfileCredential({
      profileId: "web-profile",
      serverUrl: "https://notes.example.com",
      username: "alice",
      token: "secret-token",
      password: "secret-password",
      autoLogin: true,
    });
    expect(result).toMatchObject({ ok: true, encrypted: false, persisted: false });
    expect(await loadProfileCredential("web-profile")).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain("secret-token");
    expect(JSON.stringify(localStorage)).not.toContain("secret-password");
  });
});
