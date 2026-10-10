import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ server: vi.fn(), token: vi.fn(), mobile: vi.fn() }));
vi.mock("../api", () => ({ getServerUrl: mocks.server }));
vi.mock("../authSession", () => ({ getAccessToken: mocks.token }));
vi.mock("../mobileLocalMode", () => ({ isMobileLocalMode: mocks.mobile, MOBILE_LOCAL_USER_ID: "android-local-user" }));
import { voiceMemoScope } from "../voiceMemo";

describe("voice draft ownership", () => {
  afterEach(() => { delete (window as Window & { nowenDesktop?: unknown }).nowenDesktop; vi.resetAllMocks(); });
  const user = (id: string) => mocks.token.mockReturnValue(`header.${btoa(JSON.stringify({ userId: id }))}.signature`);
  it("keeps local desktop drafts across backend port changes", () => {
    Object.assign(window, { nowenDesktop: { isDesktop: true } }); user("user-a");
    mocks.server.mockReturnValue("http://127.0.0.1:3100"); const first = voiceMemoScope();
    mocks.server.mockReturnValue("http://127.0.0.1:4200"); expect(voiceMemoScope()).toBe(first);
    user("user-b"); expect(voiceMemoScope()).not.toBe(first);
  });
  it("isolates remote servers and accounts", () => {
    user("user-a"); mocks.server.mockReturnValue("https://notes-a.example"); const first = voiceMemoScope();
    mocks.server.mockReturnValue("https://notes-b.example"); expect(voiceMemoScope()).not.toBe(first);
    mocks.server.mockReturnValue("https://notes-a.example"); user("user-b"); expect(voiceMemoScope()).not.toBe(first);
    mocks.token.mockReturnValue(""); expect(voiceMemoScope()).toBe("");
  });
  it("uses the offline mobile identity without a server token", () => {
    mocks.mobile.mockReturnValue(true); expect(voiceMemoScope()).toBe("mobile-local|android-local-user");
  });
});
