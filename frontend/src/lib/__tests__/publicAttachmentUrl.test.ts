// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { resolvePublicAttachmentOrigin } from "@/lib/publicAttachmentUrl";

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
});
