import { describe, expect, it } from "vitest";
import {
  appendDownloadFlag,
  classifyMediaFile,
  formatMediaDuration,
  prepareMediaFiles,
} from "@/lib/mediaExperience";

describe("mobile media experience helpers", () => {
  it("classifies image and video files by MIME or extension", () => {
    expect(classifyMediaFile(new File(["x"], "photo.jpg", { type: "" }))).toBe("image");
    expect(classifyMediaFile(new File(["x"], "clip.MP4", { type: "application/octet-stream" }))).toBe("video");
    expect(classifyMediaFile(new File(["x"], "notes.txt", { type: "text/plain" }))).toBeNull();
  });

  it("preflights empty, unsupported and very large files", () => {
    const empty = new File([], "empty.png", { type: "image/png" });
    const unsupported = new File(["x"], "payload.bin", { type: "application/octet-stream" });
    const items = prepareMediaFiles([empty, unsupported]);

    expect(items[0].status).toBe("error");
    expect(items[0].error).toMatch(/文件为空/);
    expect(items[1].error).toMatch(/仅支持图片或视频/);
  });

  it("formats media duration and builds explicit download URLs", () => {
    expect(formatMediaDuration(65.9)).toBe("1:05");
    expect(formatMediaDuration(3661)).toBe("1:01:01");
    const url = appendDownloadFlag("/api/attachments/demo?inline=1&exp=1");
    expect(url).toContain("download=1");
    expect(url).not.toContain("inline=1");
    expect(url).toContain("exp=1");
  });
});
