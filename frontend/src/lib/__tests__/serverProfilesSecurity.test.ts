import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ getServerUrl: () => "" }));

import {
  bootstrapServerProfiles,
  listServerProfiles,
  upsertServerProfile,
} from "@/lib/serverProfiles";

describe("serverProfiles v2 metadata", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("migrates legacy profile metadata without persisting its token", () => {
    localStorage.setItem("nowen-server-profiles-v1", JSON.stringify([{
      id: "home-alice",
      name: "Home NAS",
      serverUrl: "http://nas.local:3001",
      username: "alice",
      displayName: "Alice",
      token: "secret-token",
      status: "online",
    }]));

    const profiles = bootstrapServerProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe("home-alice");
    const raw = localStorage.getItem("nowen-server-profiles-v2") || "";
    expect(raw).not.toContain("secret-token");
    expect(raw).not.toContain('"token"');
  });

  it("keeps two accounts on the same server as separate profiles", () => {
    upsertServerProfile({ id: "alice", name: "NAS Alice", serverUrl: "http://nas.local:3001", username: "alice" });
    upsertServerProfile({ id: "bob", name: "NAS Bob", serverUrl: "http://nas.local:3001", username: "bob" });
    expect(listServerProfiles().map((profile) => profile.username).sort()).toEqual(["alice", "bob"]);
  });

  it("strips unknown sensitive fields on every write", () => {
    upsertServerProfile({
      id: "unsafe",
      name: "Unsafe",
      serverUrl: "http://example.test",
      username: "user",
      ...({ token: "must-not-persist", password: "never" } as any),
    });
    const raw = localStorage.getItem("nowen-server-profiles-v2") || "";
    expect(raw).not.toContain("must-not-persist");
    expect(raw).not.toContain("never");
  });
});
