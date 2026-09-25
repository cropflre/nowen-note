import { describe, expect, it } from "vitest";
import { safeLoginRequestTarget } from "../loginRequestDiagnostics";

describe("safeLoginRequestTarget", () => {
  it("keeps the API path but removes URL credentials, query tokens and fragments", () => {
    expect(safeLoginRequestTarget("https://user:password@example.test/proxy/api/auth/login?token=secret#private"))
      .toBe("https://example.test/proxy/api/auth/login");
  });

  it("handles a same-origin login endpoint", () => {
    expect(safeLoginRequestTarget("/api/auth/login?token=secret"))
      .toBe(`${window.location.origin}/api/auth/login`);
  });
});
