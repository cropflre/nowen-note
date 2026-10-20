// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { attachments: { upload: mocks.upload } }, getServerUrl: () => "" }));
vi.mock("@/lib/toast", () => ({ toast: {} }));
import { uploadImage, uploadPhotoSelection } from "../imageUploadService";

describe("Markdown image upload URLs", () => {
  const imageUrl = "https://files.example/api/attachments/123e4567-e89b-42d3-a456-426614174216/image.png";
  beforeEach(() => {
    mocks.upload.mockResolvedValue({ id: "image-id", url: "/api/attachments/image-id", imageUrl, filename: "wrong.jpg", mimeType: "image/png", category: "image" });
  });
  it("inserts the server's absolute URL with the real image extension in Markdown", async () => {
    const result = await uploadImage({ file: new File(["png"], "wrong.jpg"), filename: "wrong.jpg", noteId: "note", source: "markdown" });
    expect(result.url).toBe(imageUrl);
  });
  it("preserves canonical attachment references for rich text", async () => {
    const result = await uploadImage({ file: new File(["png"], "wrong.jpg"), filename: "wrong.jpg", noteId: "note", source: "editor" });
    expect(result.url).toBe("/api/attachments/image-id");
  });
  it("also uses the named image URL for Markdown photo selection", async () => {
    expect(await uploadPhotoSelection("note", [new File(["png"], "photo.png", { type: "image/png" })], "markdown"))
      .toEqual([{ url: imageUrl, filename: "wrong.jpg" }]);
  });
});
