import { describe, expect, it } from "vitest";
import {
  buildAppPathUrl,
  resolveCurrentAppPathname,
} from "../appPathNavigation";

describe("app path navigation", () => {
  it.each([
    ["/issues", "https://note.example.com/nowen/", "/nowen/issues"],
    ["/issues/issue-one", "https://note.example.com/nowen/issues", "/nowen/issues/issue-one"],
    ["/", "https://note.example.com/nowen/issues/issue-one", "/nowen/"],
    ["/issues", "https://note.example.com/mindmaps/demo", "/issues"],
    ["/issues", "https://note.example.com/nowen/mindmaps/demo", "/nowen/issues"],
  ])("议题导航 %s 保留部署前缀", (appPath, currentHref, expected) => {
    expect(buildAppPathUrl(appPath, currentHref, false)).toBe(expected);
  });

  it.each([
    ["https://note.example.com/nowen/issues", "/issues"],
    ["https://note.example.com/nowen/issues/issue-one/", "/issues/issue-one/"],
    ["https://note.example.com/issues/issue-one", "/issues/issue-one"],
  ])("议题 URL %s 解析为应用路由", (href, expected) => {
    expect(resolveCurrentAppPathname(href, false)).toBe(expected);
  });

  it.each([
    ["file:///C:/Nowen/frontend/index.html?serverUrl=https%3A%2F%2Fnote.example.com%2Fnowen", false],
    ["https://localhost/?serverUrl=https%3A%2F%2Fnote.example.com%2Fnowen", true],
  ])("原生议题导航保留服务器参数 %s", (href, native) => {
    const url = buildAppPathUrl("/issues/issue-one", String(href), Boolean(native));
    expect(new URL(url).searchParams.get("serverUrl")).toBe("https://note.example.com/nowen");
    expect(resolveCurrentAppPathname(url, Boolean(native))).toBe("/issues/issue-one");
  });

  it("keeps normal web navigation paths unchanged", () => {
    expect(buildAppPathUrl("/public", "https://note.example.com/workspace", false)).toBe("/public");
    expect(resolveCurrentAppPathname("https://note.example.com/public/demo", false)).toBe("/public/demo");
  });

  it("stores desktop public routes on the existing file entry URL", () => {
    const nextUrl = buildAppPathUrl(
      "/public/demo-token",
      "file:///C:/Program%20Files/Nowen/frontend/index.html?serverUrl=http%3A%2F%2F127.0.0.1%3A3001",
      false,
    );
    const parsed = new URL(nextUrl);

    expect(parsed.pathname).toBe("/C:/Program%20Files/Nowen/frontend/index.html");
    expect(parsed.searchParams.get("serverUrl")).toBe("http://127.0.0.1:3001");
    expect(parsed.searchParams.get("nowenAppPath")).toBe("/public/demo-token");
    expect(resolveCurrentAppPathname(nextUrl, false)).toBe("/public/demo-token");
  });

  it("stores Capacitor public routes on the existing app entry URL", () => {
    const nextUrl = buildAppPathUrl(
      "/public/demo-token",
      "https://localhost/?serverUrl=http%3A%2F%2Fnote.example.com",
      true,
    );
    const parsed = new URL(nextUrl);

    expect(parsed.origin).toBe("https://localhost");
    expect(parsed.pathname).toBe("/");
    expect(parsed.searchParams.get("serverUrl")).toBe("http://note.example.com");
    expect(parsed.searchParams.get("nowenAppPath")).toBe("/public/demo-token");
    expect(resolveCurrentAppPathname(nextUrl, true)).toBe("/public/demo-token");
  });

  it("returns to the workspace without dropping the desktop server address", () => {
    const nextUrl = buildAppPathUrl(
      "/",
      "file:///opt/nowen/frontend/index.html?serverUrl=https%3A%2F%2Fnote.example.com&nowenAppPath=%2Fpublic",
      false,
    );
    const parsed = new URL(nextUrl);

    expect(parsed.pathname).toBe("/opt/nowen/frontend/index.html");
    expect(parsed.searchParams.get("serverUrl")).toBe("https://note.example.com");
    expect(parsed.searchParams.has("nowenAppPath")).toBe(false);
    expect(resolveCurrentAppPathname(nextUrl, false)).toBe("/");
  });
});
