import { describe, expect, it } from "vitest";
import { parseTaskQuickAdd } from "../taskSmartRecognition";
import {
  captureDescriptionFromText,
  captureTitleFromText,
  recognizedCaptureLabels,
  shouldApplySmartCapturePatch,
} from "../taskInboxCapture";

describe("task Inbox quick capture helpers", () => {
  it("uses the first non-empty selected line as the task title", () => {
    expect(captureTitleFromText("\n  Review release checklist  \nMore context"))
      .toBe("Review release checklist");
  });

  it("keeps long or multiline selected text as capture context", () => {
    expect(captureDescriptionFromText("One line")).toBe("");
    expect(captureDescriptionFromText("First line\nSecond line"))
      .toBe("First line\nSecond line");
    expect(captureDescriptionFromText("x".repeat(181))).toHaveLength(181);
  });

  it("shows the exact smart-date phrases recognized by the existing parser", () => {
    const input = "发布版本 明天晚上8点";
    const parsed = parseTaskQuickAdd(input, new Date(2026, 7, 2, 12, 0, 0));
    expect(recognizedCaptureLabels(input, parsed.recognizedRanges)).toEqual([
      "明天晚上8点",
    ]);
    expect(parsed.cleanTitle).toBe("发布版本");
  });

  it("does not silently strip recurrence syntax from the V1 capture endpoint", () => {
    const parsed = parseTaskQuickAdd(
      "每天早上8点站会",
      new Date(2026, 7, 2, 12, 0, 0),
    );
    expect(parsed.taskPatch.repeatRule).not.toBe("none");
    expect(shouldApplySmartCapturePatch(parsed)).toBe(false);
  });
});
