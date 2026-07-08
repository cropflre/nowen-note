import { describe, expect, it } from "vitest";
import { editedImageBlobToFile } from "../imageEditService";

describe("imageEditService", () => {
  it("uses png extension when the edited blob is png", () => {
    const file = editedImageBlobToFile(new Blob(["image"], { type: "image/png" }), "photo.jpg");

    expect(file.name).toBe("photo.png");
    expect(file.type).toBe("image/png");
  });

  it("uses jpg extension when the edited blob is jpeg", () => {
    const file = editedImageBlobToFile(new Blob(["image"], { type: "image/jpeg" }), "photo.png");

    expect(file.name).toBe("photo.jpg");
    expect(file.type).toBe("image/jpeg");
  });
});
