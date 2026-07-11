// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  captureTwoFactorAuthResponse,
  classifyTwoFactorAuthEndpoint,
  clearTwoFactorLoginChallenge,
  deriveTwoFactorVerifyUrl,
  hasActiveTwoFactorLoginChallenge,
  readTwoFactorLoginChallenge,
  saveTwoFactorLoginChallenge,
} from "@/lib/twoFactorLoginChallenge";

describe("twoFactorLoginChallenge", () => {
  beforeEach(() => {
    clearTwoFactorLoginChallenge();
    sessionStorage.clear();
  });

  it("stores only a short-lived challenge in session storage", () => {
    const challenge = saveTwoFactorLoginChallenge({
      ticket: "ticket-123",
      username: "alice",
      verifyUrl: "https://notes.example.com/api/auth/2fa/verify",
      expiresInSeconds: 300,
    }, 1_000);

    expect(challenge).toMatchObject({
      ticket: "ticket-123",
      username: "alice",
      expiresAt: 301_000,
    });
    expect(readTwoFactorLoginChallenge(2_000)).toMatchObject({ ticket: "ticket-123" });
    expect(sessionStorage.getItem("nowen.twoFactorLoginChallenge")).not.toContain("password");
    expect(sessionStorage.getItem("nowen.twoFactorLoginChallenge")).not.toContain("code");
  });

  it("clears expired challenges instead of returning to an unusable second step", () => {
    saveTwoFactorLoginChallenge({
      ticket: "expired-ticket",
      username: "alice",
      verifyUrl: "/api/auth/2fa/verify",
      expiresInSeconds: 30,
    }, 10_000);

    expect(hasActiveTwoFactorLoginChallenge(39_999)).toBe(true);
    expect(readTwoFactorLoginChallenge(40_001)).toBeNull();
    expect(sessionStorage.getItem("nowen.twoFactorLoginChallenge")).toBeNull();
  });

  it("derives the verification endpoint for same-origin and remote deployments", () => {
    expect(deriveTwoFactorVerifyUrl("/api/auth/login")).toBe("/api/auth/2fa/verify");
    expect(deriveTwoFactorVerifyUrl("https://notes.example.com/nowen/api/auth/login"))
      .toBe("https://notes.example.com/nowen/api/auth/2fa/verify");
  });

  it("classifies only the two authentication endpoints", () => {
    expect(classifyTwoFactorAuthEndpoint("/api/auth/login")).toBe("login");
    expect(classifyTwoFactorAuthEndpoint("/api/auth/2fa/verify")).toBe("verify");
    expect(classifyTwoFactorAuthEndpoint("/api/auth/verify")).toBeNull();
    expect(classifyTwoFactorAuthEndpoint("/api/notes")).toBeNull();
  });

  it("captures a first-factor response and keeps it after an invalid code", () => {
    captureTwoFactorAuthResponse("login", "https://notes.example.com/api/auth/login", true, {
      requires2FA: true,
      ticket: "ticket-456",
      username: "bob",
      expiresIn: 300,
    });

    expect(readTwoFactorLoginChallenge()).toMatchObject({
      ticket: "ticket-456",
      username: "bob",
      verifyUrl: "https://notes.example.com/api/auth/2fa/verify",
    });

    captureTwoFactorAuthResponse("verify", "https://notes.example.com/api/auth/2fa/verify", false, {
      code: "TFA_INVALID_CODE",
    });
    expect(readTwoFactorLoginChallenge()).not.toBeNull();
  });

  it("clears the challenge after successful verification or expiry", () => {
    saveTwoFactorLoginChallenge({
      ticket: "ticket-789",
      verifyUrl: "/api/auth/2fa/verify",
    });
    captureTwoFactorAuthResponse("verify", "/api/auth/2fa/verify", true, {
      token: "login-token",
      user: { id: "u1" },
    });
    expect(readTwoFactorLoginChallenge()).toBeNull();

    saveTwoFactorLoginChallenge({
      ticket: "ticket-again",
      verifyUrl: "/api/auth/2fa/verify",
    });
    captureTwoFactorAuthResponse("verify", "/api/auth/2fa/verify", false, {
      code: "TFA_TICKET_EXPIRED",
    });
    expect(readTwoFactorLoginChallenge()).toBeNull();
  });
});
