import { describe, expect, it } from "vitest";

import { extractNoteIdFromSignedAttachmentUrl } from "@/lib/attachmentSignedUrlRecovery";

function scopeUrl(scope: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(scope))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `https://notes.example.com/api/attachments/123e4567-e89b-42d3-a456-426614174216?exp=1999999999&sig=test&scope=${encodeURIComponent(`v2.${encoded}`)}`;
}

describe("signed attachment recovery", () => {
  it("extracts noteId from a v2 user scope", () => {
    expect(extractNoteIdFromSignedAttachmentUrl(scopeUrl({
      version: 2,
      kind: "user",
      subjectId: "user-1",
      noteId: "note-1",
      allowDownload: true,
    }))).toBe("note-1");
  });

  it("accepts share/publication scopes because the server still performs the real ACL check", () => {
    expect(extractNoteIdFromSignedAttachmentUrl(scopeUrl({
      version: 2,
      kind: "share",
      subjectId: "share-1",
      noteId: "note-share",
      allowDownload: false,
    }))).toBe("note-share");
    expect(extractNoteIdFromSignedAttachmentUrl(scopeUrl({
      version: 2,
      kind: "publication",
      subjectId: "pub-1",
      noteId: "note-pub",
      allowDownload: true,
    }))).toBe("note-pub");
  });

  it("rejects unsigned, malformed and unsupported scopes", () => {
    expect(extractNoteIdFromSignedAttachmentUrl("/api/attachments/123e4567-e89b-42d3-a456-426614174216")).toBeNull();
    expect(extractNoteIdFromSignedAttachmentUrl("https://notes.example.com/api/attachments/x?scope=v2.bad"))
      .toBeNull();
    expect(extractNoteIdFromSignedAttachmentUrl(scopeUrl({
      version: 1,
      kind: "user",
      subjectId: "user-1",
      noteId: "note-1",
    }))).toBeNull();
    expect(extractNoteIdFromSignedAttachmentUrl(scopeUrl({
      version: 2,
      kind: "unknown",
      subjectId: "user-1",
      noteId: "note-1",
    }))).toBeNull();
  });
});
