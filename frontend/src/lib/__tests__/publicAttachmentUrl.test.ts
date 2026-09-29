// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  buildPublicAttachmentUrl,
  resolvePublicAttachmentOrigin,
} from "@/lib/publicAttachmentUrl";

const signed = "http://192.168.1.20:3001/api/attachments/abc-123?exp=2000000000&sig=deadbeef&scope=v2.scope&w=240";

describe("publicAttachmentUrl", () => {
  it("prefers the dedicated file public origin", () => {
    expect(resolvePublicAttachmentOrigin({
      filePublicOrigin: "https://files.example.com",
      publicWebOrigin: "https://notes.example.com",
    })).toEqual({
      origin: "https://files.example.com",
      source: "file",
    });
  });

  it("falls back to the configured public web origin", () => {
    expect(resolvePublicAttachmentOrigin({
      filePublicOrigin: "",
      publicWebOrigin: "https://notes.example.com",
    })).toEqual({
      origin: "https://notes.example.com",
      source: "public-web",
    });
  });

  it("rebases only the delivery origin and preserves signed query params", () => {
    expect(buildPublicAttachmentUrl(signed, {
      filePublicOrigin: "https://files.example.com",
    })).toBe(
      "https://files.example.com/api/attachments/abc-123?exp=2000000000&sig=deadbeef&scope=v2.scope&w=240",
    );
  });

  it("supports a reverse-proxy path prefix without duplicating it", () => {
    expect(buildPublicAttachmentUrl(signed, {
      filePublicOrigin: "https://example.com/nowen",
    })).toBe(
      "https://example.com/nowen/api/attachments/abc-123?exp=2000000000&sig=deadbeef&scope=v2.scope&w=240",
    );

    expect(buildPublicAttachmentUrl(
      "http://lan.local/nowen/api/attachments/abc?exp=1&sig=x&scope=y",
      { filePublicOrigin: "https://example.com/nowen" },
    )).toBe(
      "https://example.com/nowen/api/attachments/abc?exp=1&sig=x&scope=y",
    );
  });

  it("keeps the resolved LAN/API URL unchanged when no public origin is configured", () => {
    expect(buildPublicAttachmentUrl(signed, {
      filePublicOrigin: "",
      publicWebOrigin: "",
    })).toBe(signed);
  });
});
