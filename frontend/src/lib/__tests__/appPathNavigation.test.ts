import { describe, expect, it } from "vitest";
import {
  buildAppPathUrl,
  resolveCurrentAppPathname,
} from "../appPathNavigation";

describe("app path navigation", () => {
  it("keeps normal web navigation paths unchanged", () => {
    expect(buildAppPathUrl("/public", "https://note.example.com/workspace")).toBe("/public");
    expect(resolveCurrentAppPathname("https://note.example.com/public/demo")).toBe("/public/demo");
  });

  it("stores desktop public routes on the existing file entry URL", () => {
    const nextUrl = buildAppPathUrl(
      "/public/demo-token",
      "file:///C:/Program%20Files/Nowen/frontend/index.html?serverUrl=http%3A%2F%2F127.0.0.1%3A3001",
    );
    const parsed = new URL(nextUrl);

    expect(parsed.pathname).toBe("/C:/Program%20Files/Nowen/frontend/index.html");
    expect(parsed.searchParams.get("serverUrl")).toBe("http://127.0.0.1:3001");
    expect(parsed.searchParams.get("nowenAppPath")).toBe("/public/demo-token");
    expect(resolveCurrentAppPathname(nextUrl)).toBe("/public/demo-token");
  });

  it("returns to the workspace without dropping the desktop server address", () => {
    const nextUrl = buildAppPathUrl(
      "/",
      "file:///opt/nowen/frontend/index.html?serverUrl=https%3A%2F%2Fnote.example.com&nowenAppPath=%2Fpublic",
    );
    const parsed = new URL(nextUrl);

    expect(parsed.pathname).toBe("/opt/nowen/frontend/index.html");
    expect(parsed.searchParams.get("serverUrl")).toBe("https://note.example.com");
    expect(parsed.searchParams.has("nowenAppPath")).toBe(false);
    expect(resolveCurrentAppPathname(nextUrl)).toBe("/");
  });
});
