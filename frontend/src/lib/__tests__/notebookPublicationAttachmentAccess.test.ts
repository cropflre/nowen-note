import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const publicationApiSource = readFileSync(
  path.resolve(__dirname, "../notebookPublicationApi.ts"),
  "utf8",
);
const publicationBackendSource = readFileSync(
  path.resolve(__dirname, "../../../../backend/src/runtime/notebook-publication.ts"),
  "utf8",
);

describe("public notebook attachment access", () => {
  it("registers publication-scoped attachment URLs before rendering a public note", () => {
    expect(publicationApiSource).toContain(
      'import { registerAttachmentAccessUrls } from "@/lib/noteAttachmentAccessBridge";',
    );
    expect(publicationApiSource).toContain(
      "registerAttachmentAccessUrls(note.attachmentUrls, `${apiBase()}${path}`);",
    );
  });

  it("keeps publication attachment signing on the backend instead of exposing bare attachment URLs", () => {
    expect(publicationBackendSource).toContain("createPublicationAttachmentScope");
    expect(publicationBackendSource).toContain("const attachmentUrls = attachmentUrlsForNote(c, p, noteId);");
    expect(publicationBackendSource).toContain("attachmentUrls,");
  });
});
