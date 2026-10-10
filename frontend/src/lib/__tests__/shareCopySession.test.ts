import { describe, expect, it } from "vitest";
import { ShareCopySession, formatShareWithPassword } from "@/lib/shareCopySession";

const protectedShare = {
  id: "share-a", shareToken: "token-a", hasPassword: true, credentialVersion: 1,
};
describe("share copy with access password (session only)", () => {
  it("copies a stable human-readable text and trims only the submitted credential", () => {
    const memory = new ShareCopySession();
    memory.remember(protectedShare, "  abc123  ");
    expect(memory.get(protectedShare)).toBe("abc123");
    expect(formatShareWithPassword("第一行\n第二行", "https://example.com/share/token-a",
      memory.get(protectedShare)!, { note:"笔记：",link:"分享链接：",password:"访问密码：" }))
      .toBe("笔记：第一行 第二行\n分享链接：https://example.com/share/token-a\n访问密码：abc123");
  });
  it("never retrieves an existing share password without a successful explicit input", () => {
    const memory = new ShareCopySession();
    expect(memory.get(protectedShare)).toBeNull();
    memory.remember(protectedShare, "");
    expect(memory.get(protectedShare)).toBeNull();
    expect(memory.get({ ...protectedShare, id:"other-share" })).toBeNull();
  });
  it("invalidates when token or server credential version changes", () => {
    const memory = new ShareCopySession();
    memory.remember(protectedShare, "abc123");
    expect(memory.get({ ...protectedShare, credentialVersion:2 })).toBeNull();
    expect(memory.get(protectedShare)).toBeNull();
    memory.remember(protectedShare, "abc123");
    expect(memory.get({ ...protectedShare, shareToken:"token-rotated" })).toBeNull();
    memory.remember(protectedShare, "abc123");
    expect(memory.get({ ...protectedShare, hasPassword:false })).toBeNull();
  });
  it("clears all secrets on dialog close and individual secrets on revoke", () => {
    const memory = new ShareCopySession();
    const other={ ...protectedShare, id:"share-b" };
    memory.remember(protectedShare,"abc123");
    memory.remember(other,"def456");
    memory.forget(protectedShare.id);
    expect(memory.get(protectedShare)).toBeNull();
    expect(memory.get(other)).toBe("def456");
    memory.clear();
    expect(memory.get(other)).toBeNull();
  });
  it("does not remember unverified or passwordless server responses", () => {
    const memory = new ShareCopySession();
    memory.remember({ ...protectedShare, credentialVersion:undefined }, "abc123");
    expect(memory.get(protectedShare)).toBeNull();
    memory.remember({ ...protectedShare, hasPassword:false }, "abc123");
    expect(memory.get(protectedShare)).toBeNull();
  });
});
