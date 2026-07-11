// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapServerProfiles,
  getActiveServerProfile,
  listServerProfiles,
  markServerProfileActive,
  removeServerProfile,
  upsertServerProfile,
} from "@/lib/serverProfiles";

function tokenFor(username: string): string {
  const payload = btoa(JSON.stringify({ username })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `header.${payload}.signature`;
}

describe("serverProfiles", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("migrates the current single-server setting into an active profile", () => {
    localStorage.setItem("nowen-server-url", "http://127.0.0.1:3001/");
    localStorage.setItem("nowen-token", tokenFor("alice"));

    const profiles = bootstrapServerProfiles();

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      serverUrl: "http://127.0.0.1:3001",
      kind: "local",
      username: "alice",
    });
    expect(getActiveServerProfile()?.id).toBe(profiles[0].id);
  });

  it("keeps multiple accounts on one host as distinct profiles", () => {
    const one = upsertServerProfile({
      name: "NAS Alice",
      serverUrl: "https://nas.example.com/api",
      kind: "nas",
      username: "alice",
      token: tokenFor("alice"),
    });
    const two = upsertServerProfile({
      name: "NAS Bob",
      serverUrl: "https://nas.example.com/",
      kind: "nas",
      username: "bob",
      token: tokenFor("bob"),
    });

    expect(listServerProfiles().map((profile) => profile.id)).toEqual([two.id, one.id]);
    markServerProfileActive(two.id);
    expect(getActiveServerProfile()?.username).toBe("bob");
  });

  it("deletes only the requested local configuration", () => {
    const one = upsertServerProfile({
      name: "Home",
      serverUrl: "https://home.example.com",
      username: "alice",
      token: tokenFor("alice"),
    });
    upsertServerProfile({
      name: "Office",
      serverUrl: "https://office.example.com",
      username: "alice",
      token: tokenFor("alice"),
    });

    removeServerProfile(one.id);

    expect(listServerProfiles()).toHaveLength(1);
    expect(listServerProfiles()[0].name).toBe("Office");
  });
});
