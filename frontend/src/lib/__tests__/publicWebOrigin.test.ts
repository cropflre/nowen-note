import { afterEach, describe, expect, it } from "vitest";
import {
  buildPublicWebUrl,
  isLikelyProtectedGatewayOrigin,
  normalizePublicWebOrigin,
  resolvePublicWebOrigin,
  setRuntimePublicWebOrigin,
} from "../publicWebOrigin";

afterEach(() => {
  setRuntimePublicWebOrigin("", "current");
});

describe("publicWebOrigin", () => {
  it("normalizes safe HTTP origins and rejects credential/query variants", () => {
    expect(normalizePublicWebOrigin("https://note.example.com/base///")).toBe("https://note.example.com/base");
    expect(normalizePublicWebOrigin("https://user:pass@note.example.com")).toBe("");
    expect(normalizePublicWebOrigin("https://note.example.com/?token=secret")).toBe("");
    expect(normalizePublicWebOrigin("javascript:alert(1)")).toBe("");
  });

  it("prefers a runtime administrator origin over build and current origins", () => {
    const resolved = resolvePublicWebOrigin({
      runtimeOrigin: "https://public.example.com",
      runtimeSource: "settings",
      buildOrigin: "https://build.example.com",
      currentOrigin: "https://private.fnos.net",
    });

    expect(resolved).toMatchObject({
      origin: "https://public.example.com",
      source: "settings",
      usesCurrentOrigin: false,
      requiresAnonymousCheck: false,
    });
    expect(buildPublicWebUrl("share/token", {
      runtimeOrigin: resolved.origin,
      runtimeSource: resolved.source,
      buildOrigin: "https://build.example.com",
      currentOrigin: "https://private.fnos.net",
    })).toBe("https://public.example.com/share/token");
  });

  it("uses a runtime environment origin without requiring a frontend rebuild", () => {
    expect(resolvePublicWebOrigin({
      runtimeOrigin: "https://runtime.example.com",
      runtimeSource: "environment",
      currentOrigin: "https://private.example.com",
      buildOrigin: "",
    })).toMatchObject({
      origin: "https://runtime.example.com",
      source: "environment",
      requiresAnonymousCheck: false,
    });
  });

  it("publishes the runtime origin to link builders without a component context", () => {
    setRuntimePublicWebOrigin("https://public.example.com", "environment");
    expect(buildPublicWebUrl("/notebook-share/invite", {
      buildOrigin: "",
      currentOrigin: "https://private.fnos.net",
    })).toBe("https://public.example.com/notebook-share/invite");
    expect(buildPublicWebUrl("/public/notebook", {
      buildOrigin: "",
      currentOrigin: "https://private.fnos.net",
    })).toBe("https://public.example.com/public/notebook");
  });

  it("falls back to the build origin before the current browser origin", () => {
    expect(resolvePublicWebOrigin({
      runtimeOrigin: "",
      buildOrigin: "https://build.example.com",
      currentOrigin: "https://current.example.com",
    })).toMatchObject({
      origin: "https://build.example.com",
      source: "build",
      usesCurrentOrigin: false,
    });
  });

  it("marks current-origin fallback as requiring anonymous verification", () => {
    expect(resolvePublicWebOrigin({
      runtimeOrigin: "",
      buildOrigin: "",
      currentOrigin: "https://intranet.example.com",
    })).toMatchObject({
      source: "current",
      usesCurrentOrigin: true,
      requiresAnonymousCheck: true,
    });
  });

  it("recognizes FN Connect origins as likely protected gateways", () => {
    expect(isLikelyProtectedGatewayOrigin("https://nowen-note.abcd.fnos.net")).toBe(true);
    expect(resolvePublicWebOrigin({
      runtimeOrigin: "https://nowen-note.abcd.fnos.net",
      runtimeSource: "environment",
      currentOrigin: "https://local.example.com",
    })).toMatchObject({
      isLikelyProtectedGateway: true,
      requiresAnonymousCheck: true,
    });
  });
});
